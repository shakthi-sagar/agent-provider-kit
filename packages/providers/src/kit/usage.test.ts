import { describe, expect, it } from "vitest";

import { parseRateTable } from "../usage/usagePricing.ts";
import { createUsageTracker, turnTotals } from "./usage.ts";

const rates = parseRateTable({
  "claude-haiku-4-5": {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
    cache_read_input_token_cost: 1e-7,
    cache_creation_input_token_cost: 1.25e-6,
  },
});
const pricing = { status: "cached", fetchedAt: null } as const;

describe("kit usage", () => {
  it("splits cache reads and writes out of input tokens", () => {
    expect(
      turnTotals({
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: false,
        inputTokens: 1000,
        cachedInputTokens: 600,
        cacheCreationTokens: 100,
        outputTokens: 50,
        reasoningTokens: 10,
      }),
    ).toEqual({
      uncachedInputTokens: 300,
      cachedInputTokens: 600,
      cacheCreationTokens: 100,
      outputTokens: 50,
      reasoningTokens: 10,
    });
  });

  it("counts a re-sent turn once, prices known models and flags unknown ones", () => {
    const tracker = createUsageTracker();
    const totals = {
      uncachedInputTokens: 1000,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 100,
      reasoningTokens: 0,
    };
    tracker.record("turn-1", { instance: "claude", model: "claude-haiku-4-5", totals });
    tracker.record("turn-1", { instance: "claude", model: "claude-haiku-4-5", totals });
    tracker.record("turn-2", { instance: "acp", model: "mystery-model", totals });

    const report = tracker.report(rates, pricing);
    expect(report.total.turns).toBe(2);
    expect(report.total.outputTokens).toBe(200);
    expect(report.total.unpricedTurns).toBe(1);
    expect(report.byModel["claude-haiku-4-5"]?.costUsd).toBeCloseTo(1000 * 1e-6 + 100 * 5e-6);
    expect(report.byInstance["acp"]?.costUsd).toBe(0);
  });
});
