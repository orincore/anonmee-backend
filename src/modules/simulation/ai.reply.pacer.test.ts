import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplyPacer, TYPING_ACTIVE_MS } from "./ai.reply.pacer";
import { settleGapMs } from "./chat.timing";

describe("settleGapMs", () => {
  const mid = () => 0.5;
  it("waits longer after a very short message, shorter after a finished question", () => {
    expect(settleGapMs("hi", mid)).toBeGreaterThan(settleGapMs("aaj ka din kaisa tha tumhara", mid));
    expect(settleGapMs("kya kar rahe ho?", mid)).toBeLessThan(settleGapMs("kya kar rahe ho", mid));
  });
  it("waits longer when the message trails off", () => {
    expect(settleGapMs("main soch raha tha ki", mid)).toBeGreaterThan(settleGapMs("main soch raha tha yaar", mid));
    expect(settleGapMs("aur phir...", mid)).toBeGreaterThan(settleGapMs("aur phir kya hua", mid));
  });
  it("is never instant and never an eternity, and varies", () => {
    const gaps = Array.from({ length: 200 }, (_, i) => settleGapMs("kal milte hain", () => (i % 100) / 100));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1200);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(6000);
    expect(new Set(gaps).size).toBeGreaterThan(30);
  });
});

describe("ReplyPacer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Resolves with the time it took, in ms. */
  const timed = async (p: Promise<unknown>, advance: number) => {
    const t0 = Date.now();
    let done = false;
    void p.then(() => (done = true));
    for (let waited = 0; waited < advance && !done; waited += 100) await vi.advanceTimersByTimeAsync(100);
    return { done, took: Date.now() - t0 };
  };

  it("does not answer at once: it waits a quiet gap after the message", async () => {
    const pacer = new ReplyPacer(() => 0.5);
    pacer.noteMessage("c", "aaj ka din kaisa tha tumhara");
    const r = await timed(pacer.settle("c"), 20_000);
    expect(r.done).toBe(true);
    expect(r.took).toBeGreaterThanOrEqual(settleGapMs("aaj ka din kaisa tha tumhara", () => 0.5) - 100);
  });

  it("decides the quiet gap once per message, not again on every check", async () => {
    // The first draw is a long gap; every later draw would be a short one.
    let draws = 0;
    const pacer = new ReplyPacer(() => (draws++ === 0 ? 0.99 : 0));
    pacer.noteMessage("c", "hi");
    const long = settleGapMs("hi", () => 0.99);
    let done = false;
    void pacer.settle("c").then(() => (done = true));
    await vi.advanceTimersByTimeAsync(long - 1500);
    expect(done).toBe(false); // had it re-rolled, the short gap would have ended the wait already
    await vi.advanceTimersByTimeAsync(2500);
    expect(done).toBe(true);
  });

  it("keeps waiting while the person is typing, and answers after they stop", async () => {
    const pacer = new ReplyPacer(() => 0.5);
    pacer.noteMessage("c", "hi");
    let done = false;
    void pacer.settle("c").then(() => (done = true));
    // typing signals every 2s for 12 seconds
    for (let i = 0; i < 6; i++) {
      pacer.noteTyping("c");
      await vi.advanceTimersByTimeAsync(2000);
      expect(done).toBe(false);
    }
    await vi.advanceTimersByTimeAsync(TYPING_ACTIVE_MS + 6000);
    expect(done).toBe(true);
  });

  it("a second message starts the wait over", async () => {
    const pacer = new ReplyPacer(() => 0.5);
    pacer.noteMessage("c", "hi");
    let done = false;
    void pacer.settle("c").then(() => (done = true));
    await vi.advanceTimersByTimeAsync(2500);
    pacer.noteMessage("c", "kya kar rahe ho?");
    await vi.advanceTimersByTimeAsync(1500);
    expect(done).toBe(false); // the clock restarted at the new message
    await vi.advanceTimersByTimeAsync(8000);
    expect(done).toBe(true);
  });

  it("gives up after the cap, so someone typing for ages still gets an answer", async () => {
    const pacer = new ReplyPacer(() => 0.5);
    pacer.noteMessage("c", "hi");
    let done = false;
    void pacer.settle("c", 10_000).then(() => (done = true));
    for (let i = 0; i < 8; i++) {
      pacer.noteTyping("c");
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(done).toBe(true);
  });

  it("tells a late message from an old one", () => {
    const pacer = new ReplyPacer();
    pacer.noteMessage("c", "ek");
    const since = Date.now();
    expect(pacer.newerMessageSince("c", since)).toBe(false);
    vi.setSystemTime(Date.now() + 1000);
    pacer.noteMessage("c", "do");
    expect(pacer.newerMessageSince("c", since)).toBe(true);
  });

  it("chats do not affect each other, and forget clears one", () => {
    const pacer = new ReplyPacer();
    pacer.noteTyping("a");
    expect(pacer.isTyping("a")).toBe(true);
    expect(pacer.isTyping("b")).toBe(false);
    pacer.forget("a");
    expect(pacer.isTyping("a")).toBe(false);
  });
});
