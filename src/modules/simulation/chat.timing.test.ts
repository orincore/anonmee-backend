import { describe, expect, it } from "vitest";
import { betweenBubblesMs, bubbleCount, chimeInDelayMs, readThinkDelayMs } from "./chat.timing";

const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const runs = Array.from({ length: 500 }, (_, i) => i + 1);

describe("readThinkDelayMs", () => {
  it("is never instant and never longer than about 32 seconds", () => {
    for (const n of runs) {
      const d = readThinkDelayMs(60, seeded(n));
      expect(d).toBeGreaterThanOrEqual(2000 + 60 * 25 - 1);
      expect(d).toBeLessThanOrEqual(1500 + 9000 + 20_000);
    }
  });

  it("takes longer to read a long message than a short one", () => {
    const rng = () => 0.5;
    expect(readThinkDelayMs(300, rng)).toBeGreaterThan(readThinkDelayMs(5, rng));
  });

  it("is different every time, usually a few seconds, now and then a long gap", () => {
    const ds = runs.map((n) => readThinkDelayMs(40, seeded(n)));
    expect(new Set(ds).size).toBeGreaterThan(400);
    expect(ds.filter((d) => d < 13_000).length / ds.length).toBeGreaterThan(0.7);
    expect(ds.filter((d) => d > 15_000).length).toBeGreaterThan(20);
  });
});

describe("chimeInDelayMs", () => {
  it("staggers other voices by 2 to 16 seconds", () => {
    for (const n of runs) {
      const d = chimeInDelayMs(seeded(n));
      expect(d).toBeGreaterThanOrEqual(2000);
      expect(d).toBeLessThanOrEqual(16_500);
    }
  });
});

describe("bubbleCount", () => {
  const spread = (heat?: "friendly" | "flirty" | "explicit") => {
    const counts = { 1: 0, 2: 0, 3: 0 };
    for (let i = 0; i < 4000; i++) counts[bubbleCount(heat, seeded(i + 1))]++;
    return counts;
  };

  it("is usually one message, sometimes two, rarely three", () => {
    const c = spread("friendly");
    expect(c[1] / 4000).toBeGreaterThan(0.6);
    expect(c[1] / 4000).toBeLessThan(0.75);
    expect(c[2] / 4000).toBeGreaterThan(0.18);
    expect(c[3] / 4000).toBeGreaterThan(0.04);
    expect(c[3]).toBeLessThan(c[2]);
  });

  it("double-texts a bit more in flirty chats", () => {
    expect(spread("flirty")[1]).toBeLessThan(spread("friendly")[1]);
    expect(spread("explicit")[1]).toBeLessThan(spread("friendly")[1]);
  });

  it("never returns anything but one, two or three", () => {
    for (const r of [0, 0.5, 0.67, 0.68, 0.91, 0.92, 0.9999]) expect([1, 2, 3]).toContain(bubbleCount("friendly", () => r));
  });

  it("pauses about one to three seconds between messages", () => {
    for (let i = 0; i < 200; i++) {
      const d = betweenBubblesMs(seeded(i + 1));
      expect(d).toBeGreaterThanOrEqual(900);
      expect(d).toBeLessThanOrEqual(2700);
    }
  });
});
