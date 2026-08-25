import { createHash } from "node:crypto";
import type { GatewayProviderConfig, ProviderCredentialConfig } from "@ccr/core/contracts/app";
import { fetchWithSystemProxy } from "@ccr/core/proxy/system-proxy-fetch";
import {
  providerCredentialApiKey,
  providerCredentialRuntimeId
} from "@ccr/core/providers/runtime-topology";

const openCodeGoUsageEndpoint = "https://opencode.ai/zen/go/v1/usage";
const openCodeGoUsageRefreshMs = 30_000;
const openCodeGoUsageHardStaleMs = 5 * 60_000;
const openCodeGoUsageTimeoutMs = 8_000;

type OpenCodeGoUsageWindow = {
  percent?: unknown;
  resetsAt?: unknown;
  reset_at?: unknown;
};

type OpenCodeGoUsageState = {
  blocked: boolean;
  score: number;
  updatedAtMs: number;
};

type OpenCodeGoUsageScore = {
  blocked: boolean;
  score: number;
  windows: number;
};

const usageCache = new Map<string, OpenCodeGoUsageState>();
const inFlightRefreshes = new Map<string, Promise<void>>();

export function openCodeGoAdaptiveCredentialState(
  provider: GatewayProviderConfig,
  credential: ProviderCredentialConfig
): { blocked: boolean; utilization: number } | undefined {
  if (!isOpenCodeGoProvider(provider)) {
    return undefined;
  }

  warmOpenCodeGoCredentialUsage(provider);

  const credentials = activeCredentials(provider);
  if (credentials.length === 0) {
    return undefined;
  }

  const now = Date.now();
  const states = credentials.map((candidate) => readUsableState(provider, candidate, now));
  if (states.some((state) => !state)) {
    // Keep CCR's normal priority/limit behavior until every enabled key has a
    // comparable usage snapshot. This avoids biasing toward a key simply
    // because another key has not finished its first quota request yet.
    return undefined;
  }

  const currentIndex = credentials.indexOf(credential);
  const current = currentIndex >= 0 ? states[currentIndex] : undefined;
  if (!current) {
    return undefined;
  }

  // CCR's existing candidate sorter spills across priorities once utilization
  // reaches 80%. Encode the remote quota score as an artificial utilization
  // >= 1 so the sorter naturally switches to utilization-first ordering without
  // changing the general routing executor. A larger burn-urgency score yields
  // a smaller utilization value and therefore a higher routing preference.
  const utilization = 1 + 1 / (1 + Math.max(0, current.score));
  return {
    blocked: current.blocked,
    utilization
  };
}

export function warmOpenCodeGoCredentialUsage(provider: GatewayProviderConfig): void {
  if (!isOpenCodeGoProvider(provider)) {
    return;
  }
  const now = Date.now();
  for (const credential of activeCredentials(provider)) {
    const key = usageCacheKey(provider, credential);
    const cached = usageCache.get(key);
    if (cached && now - cached.updatedAtMs < openCodeGoUsageRefreshMs) {
      continue;
    }
    if (inFlightRefreshes.has(key)) {
      continue;
    }

    const refresh: Promise<void> = refreshOpenCodeGoCredentialUsage(provider, credential, key)
      .catch(() => undefined)
      .then(() => undefined);
    inFlightRefreshes.set(key, refresh);
    void refresh.finally(() => {
      if (inFlightRefreshes.get(key) === refresh) {
        inFlightRefreshes.delete(key);
      }
    });
  }
}

export function openCodeGoUsageScoreForTest(payload: unknown, nowMs = Date.now()): OpenCodeGoUsageScore | undefined {
  return calculateUsageScore(payload, nowMs);
}

async function refreshOpenCodeGoCredentialUsage(
  provider: GatewayProviderConfig,
  credential: ProviderCredentialConfig,
  cacheKey: string
): Promise<void> {
  const apiKey = providerCredentialApiKey(credential);
  if (!apiKey) {
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), openCodeGoUsageTimeoutMs);
  try {
    const response = await fetchWithSystemProxy(openCodeGoUsageEndpoint, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "user-agent": "claude-code-router/opencode-go-usage"
      },
      method: "GET",
      signal: controller.signal
    });

    if (response.status === 401 || response.status === 403) {
      usageCache.set(cacheKey, {
        blocked: true,
        score: 0,
        updatedAtMs: Date.now()
      });
      return;
    }
    if (!response.ok) {
      return;
    }

    const payload = await response.json() as unknown;
    const scored = calculateUsageScore(payload, Date.now());
    if (!scored || scored.windows === 0) {
      return;
    }
    usageCache.set(cacheKey, {
      blocked: scored.blocked,
      score: scored.score,
      updatedAtMs: Date.now()
    });
  } finally {
    clearTimeout(timer);
  }
}

function calculateUsageScore(payload: unknown, nowMs: number): OpenCodeGoUsageScore | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const usage = isRecord(payload.usage) ? payload.usage : payload;
  const definitions = [
    { key: "rolling", fullWindowHours: 5, weight: 0.5 },
    { key: "weekly", fullWindowHours: 7 * 24, weight: 0.3 },
    { key: "monthly", fullWindowHours: 30 * 24, weight: 0.2 }
  ] as const;

  let weightedUrgency = 0;
  let totalWeight = 0;
  let windows = 0;
  let blocked = false;

  for (const definition of definitions) {
    const raw = usage[definition.key];
    if (!isRecord(raw)) {
      continue;
    }
    const window = raw as OpenCodeGoUsageWindow;
    const usedPercent = numberValue(window.percent);
    if (usedPercent === undefined) {
      continue;
    }

    const clampedUsed = Math.max(0, Math.min(100, usedPercent));
    const remainingRatio = Math.max(0, (100 - clampedUsed) / 100);
    blocked ||= clampedUsed >= 99.9;

    const resetAtMs = dateMs(window.resetsAt ?? window.reset_at);
    const fullWindowMs = definition.fullWindowHours * 60 * 60 * 1000;
    const remainingTimeFraction = resetAtMs && resetAtMs > nowMs
      ? Math.max(0.02, Math.min(1.5, (resetAtMs - nowMs) / fullWindowMs))
      : 1;

    // "Burn urgency": unused quota divided by the fraction of the quota window
    // that is left. A key with lots of quota but little time before reset gets
    // the highest score, which minimizes quota that expires unused.
    const urgency = remainingRatio / remainingTimeFraction;
    weightedUrgency += urgency * definition.weight;
    totalWeight += definition.weight;
    windows += 1;
  }

  if (windows === 0 || totalWeight <= 0) {
    return undefined;
  }

  return {
    blocked,
    score: weightedUrgency / totalWeight,
    windows
  };
}

function readUsableState(
  provider: GatewayProviderConfig,
  credential: ProviderCredentialConfig,
  nowMs: number
): OpenCodeGoUsageState | undefined {
  const state = usageCache.get(usageCacheKey(provider, credential));
  if (!state || nowMs - state.updatedAtMs > openCodeGoUsageHardStaleMs) {
    return undefined;
  }
  return state;
}

function activeCredentials(provider: GatewayProviderConfig): ProviderCredentialConfig[] {
  return (provider.credentials ?? []).filter((credential) =>
    credential.enabled !== false && Boolean(providerCredentialApiKey(credential))
  );
}

function usageCacheKey(provider: GatewayProviderConfig, credential: ProviderCredentialConfig): string {
  const apiKey = providerCredentialApiKey(credential);
  const apiKeyHash = apiKey ? createHash("sha256").update(apiKey).digest("hex").slice(0, 16) : "";
  return `${provider.name}::${providerCredentialRuntimeId(provider, credential)}::${apiKeyHash}`;
}

function isOpenCodeGoProvider(provider: GatewayProviderConfig): boolean {
  const urls = [
    provider.api_base_url,
    provider.baseUrl,
    provider.baseurl,
    ...(provider.capabilities ?? []).map((capability) => capability.baseUrl)
  ];
  return urls.some((value) => {
    if (!value?.trim()) {
      return false;
    }
    try {
      const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
      return url.hostname.toLowerCase() === "opencode.ai" &&
        /^\/zen\/go(?:\/|$)/i.test(url.pathname);
    } catch {
      return false;
    }
  });
}

function dateMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
