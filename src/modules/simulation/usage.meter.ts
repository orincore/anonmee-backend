import type { RedisClient } from "../../lib/redis";
import { env } from "../../config/env";

/** Together AI list price for the model, USD per 1M tokens (checked 2026-10-28). Used for estimates only. */
export const PRICE = { input: 0.3, cachedInput: 0.006, output: 1.2 } as const;

export type UsageKind = "script" | "reply" | "chat";

export interface TokenUsage {
  prompt: number;
  completion: number;
  cached: number;
}

export interface DayUsage {
  day: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  byKind: Record<UsageKind, { calls: number; tokens: number }>;
}

const KINDS: UsageKind[] = ["script", "reply", "chat"];
const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
const redisKey = (day: string) => `bots:usage:${day}`;

/** Pure: what a set of token counts costs. Cached input is billed at the much lower cached rate. */
export function estimateCostUsd(u: TokenUsage): number {
  const fresh = Math.max(0, u.prompt - u.cached);
  return (fresh * PRICE.input + u.cached * PRICE.cachedInput + u.completion * PRICE.output) / 1e6;
}

/** Counts every model call by day and kind, and says when the daily budget is gone. */
export function createUsageMeter(budget: () => number = () => env.BOTS_DAILY_TOKEN_BUDGET) {
  let redis: RedisClient | null = null;
  let spentToday = 0; // local mirror so the budget check costs no round trip
  let spentDay = dayKey();
  let warned = false;

  const roll = () => {
    const today = dayKey();
    if (today !== spentDay) {
      spentDay = today;
      spentToday = 0;
      warned = false;
    }
  };

  return {
    attach(r: RedisClient) {
      redis = r;
      void r.hget(redisKey(dayKey()), "total").then((v) => {
        spentToday = Math.max(spentToday, Number(v ?? 0));
      }).catch(() => {});
    },

    /** False once today's budget is used up. Everything that calls the model checks this first. */
    budgetLeft(): boolean {
      roll();
      const limit = budget();
      return limit === 0 ? false : spentToday < limit;
    },

    record(kind: UsageKind, u: TokenUsage) {
      roll();
      const total = u.prompt + u.completion;
      spentToday += total;
      const limit = budget();
      if (!warned && limit > 0 && spentToday >= limit * 0.8) {
        warned = true;
        console.warn(`[bots] ${Math.round((spentToday / limit) * 100)}% of today's token budget used (${spentToday}/${limit})`);
      }
      if (!redis) return;
      const key = redisKey(spentDay);
      void redis
        .multi()
        .hincrby(key, "calls", 1)
        .hincrby(key, "prompt", u.prompt)
        .hincrby(key, "completion", u.completion)
        .hincrby(key, "cached", u.cached)
        .hincrby(key, "total", total)
        .hincrby(key, `calls:${kind}`, 1)
        .hincrby(key, `tokens:${kind}`, total)
        .expire(key, 40 * 86400)
        .exec()
        .catch(() => {});
    },

    /** Usage for the last `days` days, newest first, for the admin panel. */
    async report(days: number): Promise<{ budget: number; days: DayUsage[] }> {
      const out: DayUsage[] = [];
      for (let i = 0; i < days; i++) {
        const day = dayKey(new Date(Date.now() - i * 86_400_000));
        const h = redis ? await redis.hgetall(redisKey(day)) : {};
        const n = (k: string) => Number(h[k] ?? 0);
        const usage: TokenUsage = { prompt: n("prompt"), completion: n("completion"), cached: n("cached") };
        out.push({
          day,
          calls: n("calls"),
          promptTokens: usage.prompt,
          completionTokens: usage.completion,
          cachedTokens: usage.cached,
          totalTokens: n("total"),
          estimatedCostUsd: Math.round(estimateCostUsd(usage) * 10_000) / 10_000,
          byKind: Object.fromEntries(KINDS.map((k) => [k, { calls: n(`calls:${k}`), tokens: n(`tokens:${k}`) }])) as DayUsage["byKind"],
        });
      }
      return { budget: budget(), days: out };
    },
  };
}

/** One meter for the process: the model client and the admin route both use it. */
export const botUsage = createUsageMeter();
