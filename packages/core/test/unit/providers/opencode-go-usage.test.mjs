import assert from "node:assert/strict";
import test from "node:test";
import { openCodeGoUsageScoreForTest } from "@ccr/core/providers/opencode-go-usage.ts";

const now = Date.parse("2026-08-25T00:00:00Z");

function payload({ rolling, weekly, monthly }) {
  return {
    usage: {
      rolling,
      weekly,
      monthly
    }
  };
}

test("OpenCode Go quota score prefers unused quota that will reset sooner", () => {
  const urgent = openCodeGoUsageScoreForTest(payload({
    rolling: { percent: 20, resetsAt: "2026-08-25T01:00:00Z" },
    weekly: { percent: 50, resetsAt: "2026-08-28T00:00:00Z" },
    monthly: { percent: 50, resetsAt: "2026-09-10T00:00:00Z" }
  }), now);
  const relaxed = openCodeGoUsageScoreForTest(payload({
    rolling: { percent: 10, resetsAt: "2026-08-25T05:00:00Z" },
    weekly: { percent: 50, resetsAt: "2026-09-01T00:00:00Z" },
    monthly: { percent: 50, resetsAt: "2026-09-24T00:00:00Z" }
  }), now);

  assert.ok(urgent);
  assert.ok(relaxed);
  assert.ok(urgent.score > relaxed.score);
});

test("OpenCode Go quota score blocks a key when any quota window is exhausted", () => {
  const score = openCodeGoUsageScoreForTest(payload({
    rolling: { percent: 100, resetsAt: "2026-08-25T02:00:00Z" },
    weekly: { percent: 60, resetsAt: "2026-08-29T00:00:00Z" },
    monthly: { percent: 40, resetsAt: "2026-09-10T00:00:00Z" }
  }), now);

  assert.ok(score);
  assert.equal(score.blocked, true);
});

test("OpenCode Go quota parser accepts the legacy top-level usage envelope", () => {
  const score = openCodeGoUsageScoreForTest({
    rolling: { percent: 25, resetsAt: "2026-08-25T03:00:00Z" },
    weekly: { percent: 30, resetsAt: "2026-08-30T00:00:00Z" },
    monthly: { percent: 35, resetsAt: "2026-09-20T00:00:00Z" }
  }, now);

  assert.ok(score);
  assert.equal(score.windows, 3);
  assert.equal(score.blocked, false);
});
