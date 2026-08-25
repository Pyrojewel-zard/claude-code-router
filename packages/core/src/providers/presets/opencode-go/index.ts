import type { ProviderPreset } from "@ccr/core/providers/presets/types";

export const openCodeGoProviderPreset: ProviderPreset = {
  account: {
    connectors: [
      {
        auth: "provider-api-key",
        endpoint: "https://opencode.ai/zen/go/v1/usage",
        id: "opencode-go-usage",
        mapping: {
          meters: [
            {
              id: "opencode_go_rolling",
              kind: "quota",
              label: "5h quota",
              limit: 100,
              resetAt: ["$.usage.rolling.resetsAt", "$.rolling.resetsAt"],
              unit: "%",
              used: ["$.usage.rolling.percent", "$.rolling.percent"],
              window: "5h"
            },
            {
              id: "opencode_go_weekly",
              kind: "quota",
              label: "Weekly quota",
              limit: 100,
              resetAt: ["$.usage.weekly.resetsAt", "$.weekly.resetsAt"],
              unit: "%",
              used: ["$.usage.weekly.percent", "$.weekly.percent"],
              window: "weekly"
            },
            {
              id: "opencode_go_monthly",
              kind: "quota",
              label: "Monthly quota",
              limit: 100,
              resetAt: ["$.usage.monthly.resetsAt", "$.monthly.resetsAt"],
              unit: "%",
              used: ["$.usage.monthly.percent", "$.monthly.percent"],
              window: "monthly"
            }
          ]
        },
        type: "http-json"
      }
    ],
    enabled: true,
    refreshIntervalMs: 30_000
  },
  aliases: ["opencode go", "opencode-go", "opencode.ai go", "go"],
  defaultModels: [
    "grok-4.5",
    "gpt-5.6-luna",
    "glm-5.3",
    "glm-5.2",
    "glm-5.1",
    "kimi-k3",
    "kimi-k2.7-code",
    "kimi-k2.6",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "deepseek-v4-flash-vision-exp",
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "minimax-m3",
    "minimax-m2.7",
    "minimax-m2.5",
    "muse-spark-1.2-contributor",
    "qwen3.8-max",
    "qwen3.7-max",
    "qwen3.7-plus",
    "qwen3.6-plus",
    "hy3",
    "ox-alpha-free"
  ],
  endpoints: [
    {
      baseUrl: "https://opencode.ai/zen/go/v1",
      protocols: ["openai_responses", "openai_chat_completions", "anthropic_messages"]
    }
  ],
  id: "opencode-go",
  name: "OpenCode Go",
  officialApiKeyPatterns: [
    {
      source: "^sk-opencode-"
    }
  ],
  websiteUrl: "https://opencode.ai/docs/go"
};
