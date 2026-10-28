import { describe, expect, it } from "vitest";
import { botsMayRun } from "./bots.rules";
import { createUsageMeter, estimateCostUsd } from "./usage.meter";

const base = { enabled: true, budgetLeft: true, humansOnline: 1, maxHumans: 0 };

describe("botsMayRun", () => {
  it("stays off with nobody online and starts as soon as one person is", () => {
    expect(botsMayRun({ ...base, humansOnline: 0 })).toBe(false);
    expect(botsMayRun({ ...base, humansOnline: 1 })).toBe(true);
  });

  it("respects the kill switch and the budget", () => {
    expect(botsMayRun({ ...base, enabled: false })).toBe(false);
    expect(botsMayRun({ ...base, budgetLeft: false })).toBe(false);
  });

  it("can pause when plenty of real people keep each other busy", () => {
    expect(botsMayRun({ ...base, humansOnline: 2, maxHumans: 2 })).toBe(true);
    expect(botsMayRun({ ...base, humansOnline: 3, maxHumans: 2 })).toBe(false);
    expect(botsMayRun({ ...base, humansOnline: 500, maxHumans: 0 })).toBe(true);
  });
});

describe("usage meter", () => {
  it("prices cached input far below fresh input", () => {
    const fresh = estimateCostUsd({ prompt: 1_000_000, completion: 0, cached: 0 });
    const cached = estimateCostUsd({ prompt: 1_000_000, completion: 0, cached: 1_000_000 });
    expect(fresh).toBeCloseTo(0.3, 5);
    expect(cached).toBeCloseTo(0.006, 5);
    expect(estimateCostUsd({ prompt: 0, completion: 1_000_000, cached: 0 })).toBeCloseTo(1.2, 5);
  });

  it("stops at the daily budget and not before", () => {
    const meter = createUsageMeter(() => 1000);
    expect(meter.budgetLeft()).toBe(true);
    meter.record("reply", { prompt: 600, completion: 100, cached: 0 });
    expect(meter.budgetLeft()).toBe(true);
    meter.record("script", { prompt: 200, completion: 100, cached: 0 });
    expect(meter.budgetLeft()).toBe(false);
  });

  it("a budget of zero switches the AI off", () => {
    expect(createUsageMeter(() => 0).budgetLeft()).toBe(false);
  });
});
