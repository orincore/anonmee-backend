import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiChatGuard, type GuardActions } from "./ai.chat.guard";
import { closeAfterMs, pingAfterMs } from "./chat.idle";

describe("AiChatGuard idle handling", () => {
  let said: string[];
  let ended: string[];
  let active: boolean;
  let guard: AiChatGuard;

  beforeEach(() => {
    vi.useFakeTimers();
    said = [];
    ended = [];
    active = true;
    const actions: GuardActions = {
      isActive: async () => active,
      say: async (_id, text) => void said.push(text),
      end: async (id, reason) => void ended.push(`${id}:${reason}`),
    };
    guard = new AiChatGuard(actions, () => 0.5);
  });
  afterEach(() => vi.useRealTimers());

  const ping = pingAfterMs(() => 0.5);
  const close = closeAfterMs(() => 0.5);

  it("stays quiet while the person is still within their usual pause", async () => {
    guard.arm("c1");
    await vi.advanceTimersByTimeAsync(ping - 1000);
    expect(said).toEqual([]);
  });

  it("asks once whether they are there, then closes the chat after another silence", async () => {
    guard.arm("c1");
    await vi.advanceTimersByTimeAsync(ping + 100);
    expect(said).toHaveLength(1);
    expect(ended).toEqual([]);
    await vi.advanceTimersByTimeAsync(close + 100);
    expect(said).toHaveLength(2); // a goodbye before it leaves
    expect(ended).toEqual(["c1:idle"]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(said).toHaveLength(2); // nothing more, ever
  });

  it("any reply from the person starts the clock over, even after the ping", async () => {
    guard.arm("c1");
    await vi.advanceTimersByTimeAsync(ping + 100);
    expect(said).toHaveLength(1);
    guard.observe("c1", "haan yaar sorry", 6); // the person is back
    guard.arm("c1");
    await vi.advanceTimersByTimeAsync(ping - 1000); // a full fresh silence is needed before the next ping
    expect(ended).toEqual([]);
    expect(said).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(said).toHaveLength(2); // and only then does it ask again
    expect(ended).toEqual([]);
  });

  it("typing counts as being back, even after the ping", async () => {
    guard.arm("c1");
    await vi.advanceTimersByTimeAsync(ping + 100);
    expect(said).toHaveLength(1); // the ping
    guard.touch("c1"); // they start typing
    await vi.advanceTimersByTimeAsync(close + 100);
    expect(ended).toEqual([]); // the goodbye timer was replaced by a fresh silence clock
  });

  it("typing does not start a clock where none is running", async () => {
    guard.touch("never-armed");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(said).toEqual([]);
  });

  it("does nothing if the chat already ended some other way", async () => {
    guard.arm("c1");
    active = false;
    await vi.advanceTimersByTimeAsync(ping + 100);
    expect(said).toEqual([]);
    expect(ended).toEqual([]);
  });

  it("disarm stops everything", async () => {
    guard.arm("c1");
    guard.disarm("c1");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(said).toEqual([]);
  });

  it("watches each chat on its own", async () => {
    guard.arm("a");
    await vi.advanceTimersByTimeAsync(ping / 2);
    guard.arm("b");
    await vi.advanceTimersByTimeAsync(ping / 2 + 100);
    expect(said).toHaveLength(1); // only chat a has been quiet long enough
  });
});

describe("AiChatGuard hostility", () => {
  const guard = () => new AiChatGuard({ isActive: async () => true, say: async () => {}, end: async () => {} });
  type Seen = { skip: boolean; warn: 0 | 1 | 2 };
  const feed = (g: AiChatGuard, tolerance: number, texts: string[]): Seen[] => texts.map((t) => g.observe("c", t, tolerance));

  it("lets friendly banter and mild swearing pass without a warning", () => {
    const seen = feed(guard(), 4, ["hii kaise ho", "bc kya bakwaas movie thi", "saale mast baat bola", "haha pagal hai tu"]);
    expect(seen.every((s) => !s.skip && s.warn === 0)).toBe(true);
  });

  it("leaves at once for a threat, with no warning first", () => {
    const v = guard().observe("c", "main tujhe maar dunga", 6);
    expect(v.skip).toBe(true);
    expect(v.warn).toBe(0);
    expect(v.reason).toBe("threat_death");
  });

  it("warns twice, in order, and skips on the next offence", () => {
    const seen = feed(guard(), 4, ["tu chutiya hai", "tu pagal hai", "chup kar", "tu gandu hai"]);
    expect(seen.map((s) => s.warn)).toEqual([0, 1, 2, 0]);
    expect(seen.map((s) => s.skip)).toEqual([false, false, false, true]);
  });

  it("does not skip while the person behaves between the warnings", () => {
    const g = guard();
    const seen = [g.observe("c", "tu chutiya hai", 4), g.observe("c", "tu pagal hai", 4)];
    expect(seen[1]!.warn).toBe(1);
    expect(g.observe("c", "sorry yaar", 4).skip).toBe(false);
    expect(g.observe("c", "aur batao", 4).skip).toBe(false);
  });

  it("a person who fully calms down gets a clean slate", () => {
    const g = guard();
    feed(g, 4, ["tu chutiya hai", "tu pagal hai", "chup kar"]); // two warnings used
    for (const t of ["sorry", "chal chhod", "aur batao", "kya chal raha", "mast"]) g.observe("c", t, 4);
    const next = g.observe("c", "tu chutiya hai", 4);
    expect(next.skip).toBe(false);
  });

  it("spamming the same message is warned about, then skipped", () => {
    const seen = feed(guard(), 4, Array(8).fill("reply kar na reply kar na"));
    expect(seen.some((s) => s.warn === 1)).toBe(true);
    expect(seen.some((s) => s.warn === 2)).toBe(true);
    expect(seen.some((s) => s.skip)).toBe(true);
  });

  it("a more tolerant AI user warns later than a guarded one", () => {
    const tolerant = feed(guard(), 9, ["tu chutiya hai", "tu pagal hai", "chup kar"]);
    const guarded = feed(guard(), 3, ["tu chutiya hai", "tu pagal hai", "chup kar"]);
    expect(tolerant.every((s) => s.warn === 0)).toBe(true);
    expect(guarded.some((s) => s.warn === 1)).toBe(true);
  });

  it("keeps each chat's warnings to itself", () => {
    const g = guard();
    for (const t of ["tu chutiya hai", "tu pagal hai", "chup kar"]) g.observe("a", t, 4);
    expect(g.observe("b", "tu chutiya hai", 4)).toMatchObject({ skip: false, warn: 0 });
  });
});
