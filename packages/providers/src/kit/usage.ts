// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off - Promise-side helper outside the Effect runtime.
// agent-provider-kit: running token and cost totals for one kit, built from each completed turn.
// T3's UsageService rebuilds history from transcripts; the kit only counts turns it ran itself.
import type { TurnTokenUsage, UsageTokenTotals } from "@t3tools/contracts";
import { EMPTY_TOTALS } from "@t3tools/provider-core/server/usage";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import { parseRateTable, priceUsage, type RateTable } from "../usage/usagePricing.ts";

export interface UsageTotals extends UsageTokenTotals {
  readonly turns: number;
  /** List-price estimate from LiteLLM rates; on subscription plans this is API-equivalent, not billed. */
  readonly costUsd: number;
  /** Turns whose model has no known price; their tokens count, their cost does not. */
  readonly unpricedTurns: number;
}

export interface UsageReport {
  readonly total: UsageTotals;
  readonly byInstance: Readonly<Record<string, UsageTotals>>;
  readonly byModel: Readonly<Record<string, UsageTotals>>;
  readonly pricing: { readonly status: "live" | "cached" | "unavailable"; readonly fetchedAt: string | null };
}

interface TurnRecord {
  readonly instance: string;
  readonly model: string;
  readonly totals: UsageTokenTotals;
}

/** TurnTokenUsage input includes cache reads and writes; UsageTokenTotals splits them out. */
export function turnTotals(usage: TurnTokenUsage): UsageTokenTotals {
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
  return {
    uncachedInputTokens: Math.max(0, (usage.inputTokens ?? 0) - cachedInputTokens - cacheCreationTokens),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens: usage.outputTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
  };
}

const EMPTY: UsageTotals = { ...EMPTY_TOTALS, turns: 0, costUsd: 0, unpricedTurns: 0 };

function add(sum: UsageTotals, totals: UsageTokenTotals, costUsd: number | null): UsageTotals {
  return {
    uncachedInputTokens: sum.uncachedInputTokens + totals.uncachedInputTokens,
    cachedInputTokens: sum.cachedInputTokens + totals.cachedInputTokens,
    cacheCreationTokens: sum.cacheCreationTokens + totals.cacheCreationTokens,
    outputTokens: sum.outputTokens + totals.outputTokens,
    reasoningTokens: sum.reasoningTokens + totals.reasoningTokens,
    turns: sum.turns + 1,
    costUsd: sum.costUsd + (costUsd ?? 0),
    unpricedTurns: sum.unpricedTurns + (costUsd === null ? 1 : 0),
  };
}

export function createUsageTracker() {
  // Keyed by provider turn id: providers re-send a turn's usage, and the latest copy wins.
  const turns = new Map<string, TurnRecord>();
  return {
    record: (turnId: string, record: TurnRecord) => void turns.set(turnId, record),
    report: (rates: RateTable, pricing: UsageReport["pricing"]): UsageReport => {
      let total = EMPTY;
      const byInstance: Record<string, UsageTotals> = {};
      const byModel: Record<string, UsageTotals> = {};
      for (const { instance, model, totals } of turns.values()) {
        const priced = priceUsage(rates, { model, totals, speed: "standard", reportedCostUsd: null });
        const cost = priced.costSource === "unpriced" ? null : priced.costUsd;
        total = add(total, totals, cost);
        byInstance[instance] = add(byInstance[instance] ?? EMPTY, totals, cost);
        byModel[model] = add(byModel[model] ?? EMPTY, totals, cost);
      }
      return { total, byInstance, byModel, pricing };
    },
  };
}

// Same rate source and refresh period as T3's UsageService.
const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const RATES_TTL_MS = 24 * 60 * 60 * 1000;

/** Fresh disk cache, else a download, else a stale cache, else no prices. Never throws. */
export async function loadRates(
  dir: string,
): Promise<{ readonly rates: RateTable; readonly pricing: UsageReport["pricing"] }> {
  const cachePath = NodePath.join(dir, "usage-model-rates.json");
  const cached = await NodeFS.readFile(cachePath, "utf8")
    .then((raw) => JSON.parse(raw) as { fetchedAtMs: number; document: unknown })
    .catch(() => null);
  const fromCache = (status: "cached") =>
    cached === null
      ? null
      : { rates: parseRateTable(cached.document), pricing: { status, fetchedAt: new Date(cached.fetchedAtMs).toISOString() } };
  if (cached !== null && Date.now() - cached.fetchedAtMs < RATES_TTL_MS) return fromCache("cached")!;
  try {
    const response = await fetch(LITELLM_RATES_URL, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const document: unknown = await response.json();
    const rates = parseRateTable(document);
    if (rates.size === 0) throw new Error("empty rate table");
    const fetchedAtMs = Date.now();
    await NodeFS.mkdir(dir, { recursive: true });
    await NodeFS.writeFile(cachePath, JSON.stringify({ fetchedAtMs, document }));
    return { rates, pricing: { status: "live", fetchedAt: new Date(fetchedAtMs).toISOString() } };
  } catch {
    return fromCache("cached") ?? { rates: new Map(), pricing: { status: "unavailable", fetchedAt: null } };
  }
}
