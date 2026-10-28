import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSimulatedOnlineCount, nextOnline, onlineStep, onlineTarget } from "./online.simulator";

/** A Redis that keeps just the two values the counter uses. */
function fakeRedis() {
  const kv = new Map<string, string>();
  return {
    mget: async (...keys: string[]) => keys.map((k) => kv.get(k) ?? null),
    set: async (k: string, v: unknown) => void kv.set(k, String(v)),
    multi: () => {
      const ops: [string, string][] = [];
      const chain = { set: (k: string, v: unknown) => (ops.push([k, String(v)]), chain), exec: async () => void ops.forEach(([k, v]) => kv.set(k, v)) };
      return chain;
    },
  };
}

describe("online count", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-29T16:00:00Z")); // 9:30 pm in India
  });
  afterEach(() => vi.useRealTimers());

  /** What a visitor would see over `ticks` refreshes, one every 4 seconds. */
  async function watch(ticks: number, real = 0) {
    const r = fakeRedis();
    const seen: number[] = [];
    for (let i = 0; i < ticks; i++) {
      seen.push(await getSimulatedOnlineCount(r as never, real));
      vi.setSystemTime(Date.now() + 4000);
    }
    return seen;
  }

  it("moves around a lot instead of hovering in a 10-wide band", async () => {
    const seen = await watch(900); // an hour
    expect(Math.max(...seen) - Math.min(...seen)).toBeGreaterThanOrEqual(35);
  });

  it("changes on nearly every refresh", async () => {
    const seen = await watch(300);
    const changes = seen.slice(1).filter((v, i) => v !== seen[i]).length;
    expect(changes / (seen.length - 1)).toBeGreaterThan(0.9);
  });

  it("never sits in a narrow band for two minutes", async () => {
    const seen = await watch(900);
    for (let i = 0; i + 30 <= seen.length; i += 5) {
      const w = seen.slice(i, i + 30);
      expect(Math.max(...w) - Math.min(...w), `window starting at refresh ${i}`).toBeGreaterThanOrEqual(5);
    }
  });

  it("makes real jumps now and then, but never an absurd one", async () => {
    const seen = await watch(900);
    const steps = seen.slice(1).map((v, i) => Math.abs(v - seen[i]!));
    expect(Math.max(...steps)).toBeGreaterThanOrEqual(8);
    expect(Math.max(...steps)).toBeLessThanOrEqual(16);
    expect(steps.filter((d) => d <= 2).length / steps.length).toBeGreaterThan(0.3); // and mostly small ones
  });

  it("always stays between 30 and 99, with or without real people connected", async () => {
    for (const real of [0, 3, 40, 500]) {
      const seen = await watch(300, real);
      expect(Math.min(...seen)).toBeGreaterThanOrEqual(30);
      expect(Math.max(...seen)).toBeLessThanOrEqual(99);
    }
  });

  it("spends the day around different levels: busier at night than in the morning", () => {
    const at = (iso: string) => onlineTarget(new Date(iso).getTime());
    // average over a few hours to cancel the waves
    const avg = (startIso: string) => Array.from({ length: 48 }, (_, i) => at(new Date(new Date(startIso).getTime() + i * 15 * 60_000).toISOString())).reduce((a, b) => a + b, 0) / 48;
    expect(avg("2026-10-29T15:00:00Z")).toBeGreaterThan(avg("2026-10-29T03:00:00Z")); // 8:30 pm IST vs 8:30 am IST
  });

  it("does not move on its own between refreshes that are too close together", async () => {
    const r = fakeRedis();
    const first = await getSimulatedOnlineCount(r as never, 0);
    vi.setSystemTime(Date.now() + 1000);
    expect(await getSimulatedOnlineCount(r as never, 0)).toBe(first);
  });

  it("onlineStep is heavy-tailed and nextOnline never stands still", () => {
    const steps = Array.from({ length: 4000 }, () => Math.abs(onlineStep()));
    expect(Math.max(...steps)).toBeGreaterThanOrEqual(10);
    expect(steps.filter((s) => s <= 2).length / steps.length).toBeGreaterThan(0.4);
    for (let i = 0; i < 500; i++) expect(nextOnline(60, Date.now(), () => 0.5)).not.toBe(60);
  });
});
