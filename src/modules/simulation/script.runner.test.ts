import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../contracts";
import { formsMismatch } from "./chat.gender";
import { parseScript } from "./chat.quality";
import { isRowdy } from "./chat.quality";
import { getAllPersonas } from "./persona.service";
import { nextGapMs, RoomScript, type RoomScriptHost } from "./script.runner";
import type { ScriptLine } from "./simulation.types";
import { generateScript } from "./together.service";

vi.mock("./together.service", () => ({ generateScript: vi.fn() }));

describe("parseScript", () => {
  const raw = JSON.stringify([
    { s: 0, t: "aaj bohot thak gaya yaar", r: null },
    { s: 1, t: "kya hua? office tha?", r: 0 },
    { s: 1, t: "chai pi lo", r: null },
    { s: 1, t: "ya sleep kar lo", r: null }, // third in a row from person 1
    { s: 9, t: "unknown speaker", r: null },
    { s: 0, t: "check www.spam.com", r: null },
    { s: 2, t: "haan yaar, kal exam bhi hai", r: 1 },
  ]);

  it("keeps valid lines, links replies to the kept line, and enforces turn taking", () => {
    const lines = parseScript(`\`\`\`json\n${raw}\n\`\`\``, 3);
    expect(lines.map((l) => l.text)).toEqual(["aaj bohot thak gaya yaar", "kya hua? office tha?", "chai pi lo", "haan yaar, kal exam bhi hai"]);
    expect(lines[1]!.replyTo).toBe(0);
    expect(lines[3]!.replyTo).toBe(1);
  });

  it("keeps the complete lines when the model output was cut off mid-array", () => {
    const cut = '[{"s":0,"t":"pehli baat yaar","r":null},{"s":1,"t":"doosri baat bhi sahi","r":0},{"s":2,"t":"teesri adhuri';
    expect(parseScript(cut, 3).map((l) => l.text)).toEqual(["pehli baat yaar", "doosri baat bhi sahi"]);
  });

  it("drops a line a persona says in the wrong gender's grammar and keeps reply links intact", () => {
    const raw = JSON.stringify([
      { s: 0, t: "main thak gayi yaar", r: null },
      { s: 1, t: "main bhi thak gayi", r: 0 }, // person 1 is a man: wrong forms
      { s: 2, t: "chal so ja fir", r: 0 },
    ]);
    const genders = ["female", "male", "male"] as const;
    const lines = parseScript(raw, 3, [], [], 10, (speaker, text) => formsMismatch(text, genders[speaker]!));
    expect(lines.map((l) => l.text)).toEqual(["main thak gayi yaar", "chal so ja fir"]);
    expect(lines[1]!.replyTo).toBe(0);
  });

  it("drops lines already said and survives broken output", () => {
    expect(parseScript(raw, 3, ["aaj bohot thak gaya yaar"]).map((l) => l.text)).not.toContain("aaj bohot thak gaya yaar");
    expect(parseScript("sorry I can't", 3)).toEqual([]);
    expect(parseScript("[{broken", 3)).toEqual([]);
  });
});

describe("nextGapMs", () => {
  const pace = { minGapMs: 3500, maxGapMs: 11000 };
  it("sends a double-text almost at once", () => {
    for (const r of [0, 0.5, 0.99]) expect(nextGapMs(pace, true, r)).toBeLessThan(2300);
  });
  it("mostly keeps a steady pace, sometimes answers quickly, now and then goes quiet", () => {
    expect(nextGapMs(pace, false, 0.05)).toBeGreaterThanOrEqual(14_000); // lull
    expect(nextGapMs(pace, false, 0.2)).toBeLessThan(pace.minGapMs); // quick exchange
    const steady = nextGapMs(pace, false, 0.66);
    expect(steady).toBeGreaterThanOrEqual(pace.minGapMs);
    expect(steady).toBeLessThanOrEqual(pace.maxGapMs);
    expect(nextGapMs(pace, false, 0.999)).toBeLessThanOrEqual(pace.maxGapMs);
  });
});

describe("RoomScript", () => {
  const cast = getAllPersonas().slice(0, 4);
  const batch = (tag: string): ScriptLine[] => Array.from({ length: 10 }, (_, i) => ({ speaker: i % 4, text: `${tag}${i}` }));
  let posted: string[];
  let history: ChatMessage[];
  let host: RoomScriptHost;
  let audience = true;
  const pace = { minGapMs: 1000, maxGapMs: 2000, humanGraceMs: 20_000 };

  let random: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    random = vi.spyOn(Math, "random").mockReturnValue(0.66); // start at ~4s, then one line every 1.5s (0.66 is the steady-pace branch of nextGapMs)
    posted = [];
    audience = true;
    history = [];
    vi.mocked(generateScript).mockReset();
    host = {
      roomKey: "t",
      pool: async () => cast,
      history: async () => history,
      isPersonaAlias: (a) => cast.some((p) => p.alias === a),
      hasAudience: async () => audience,
      say: async (_p, text) => {
        posted.push(text);
        return { id: `m-${text}` } as ChatMessage;
      },
    };
  });
  afterEach(() => {
    random.mockRestore();
    vi.useRealTimers();
  });

  it("posts a batch one line at a time, in order, and writes the next batch before the first runs out", async () => {
    vi.mocked(generateScript).mockImplementation(async () => batch(`b${vi.mocked(generateScript).mock.calls.length}-`));
    const script = new RoomScript(host, pace);
    script.start();
    await vi.advanceTimersByTimeAsync(5600); // ~4s start, 1.5s wait for the model, first line at ~5.5s
    expect(posted[0]).toBe("b1-0");
    expect(new Set(posted).size).toBe(posted.length);
    // 9 of 10 lines are out at 17s: the next batch must already be requested
    await vi.advanceTimersByTimeAsync(11_500);
    expect(posted.length).toBeLessThan(10);
    expect(generateScript).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(posted.slice(0, 10)).toEqual(batch("b1-").map((l) => l.text));
    expect(posted[10]).toBe("b2-0"); // seamless hand-over, nothing skipped
    script.stop();
  });

  it("discards the planned script when a real person speaks", async () => {
    vi.mocked(generateScript).mockImplementation(async () => batch(`b${vi.mocked(generateScript).mock.calls.length}-`));
    const script = new RoomScript(host, pace);
    script.start();
    await vi.advanceTimersByTimeAsync(9000);
    const before = posted.length;
    expect(before).toBeGreaterThan(0);
    script.interrupt();
    history = [{ alias: "A Real Person 1", at: Date.now(), text: "hello" } as ChatMessage];
    await vi.advanceTimersByTimeAsync(10_000);
    expect(posted.length).toBe(before); // quiet during the grace period
    history = [];
    await vi.advanceTimersByTimeAsync(20_000);
    expect(posted.slice(before).every((t) => !t.startsWith("b1-"))).toBe(true);
    expect(posted.length).toBeGreaterThan(before);
    script.stop();
  });

  it("makes no model calls and posts nothing while nobody is in the room, and starts when someone arrives", async () => {
    vi.mocked(generateScript).mockImplementation(async () => batch("w"));
    audience = false;
    const script = new RoomScript(host, pace);
    script.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(generateScript).not.toHaveBeenCalled();
    expect(posted).toEqual([]);

    audience = true;
    await vi.advanceTimersByTimeAsync(9000);
    expect(generateScript).toHaveBeenCalledTimes(1);
    expect(posted.length).toBeGreaterThan(0);
    script.stop();
  });

  it("drops what was planned when the last person leaves, and spends nothing after that", async () => {
    vi.mocked(generateScript).mockImplementation(async () => batch("l"));
    const script = new RoomScript(host, pace);
    script.start();
    await vi.advanceTimersByTimeAsync(9000);
    const calls = vi.mocked(generateScript).mock.calls.length;
    const sofar = posted.length;
    audience = false;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(posted.length).toBe(sofar);
    expect(vi.mocked(generateScript).mock.calls.length).toBe(calls);
    script.stop();
  });

  it("always puts a loud, swearing persona in the cast", async () => {
    const calm = getAllPersonas().filter((p) => !isRowdy(p)).slice(0, 6);
    const loud = getAllPersonas().find((p) => isRowdy(p))!;
    const seen: string[][] = [];
    vi.mocked(generateScript).mockImplementation(async (req) => {
      seen.push(req.cast.map((p) => p.id));
      return batch("c");
    });
    host.pool = async () => [...calm, loud];
    const script = new RoomScript(host, pace);
    script.start();
    await vi.advanceTimersByTimeAsync(8000);
    script.stop();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toContain(loud.id);
  });

  describe("a topic a real person raises is kept for 15 minutes", () => {
    const topic = "boss ne aaj sabke saamne mujhe daant diya office me";
    const calls = () => vi.mocked(generateScript).mock.calls.map((c) => ({ focus: c[0].focus, mode: c[0].focusMode }));
    const minutes = (n: number) => vi.advanceTimersByTimeAsync(n * 60_000);

    it("the first batches after it are about it: opened once, then kept going", async () => {
      vi.mocked(generateScript).mockImplementation(async () => batch("t"));
      const script = new RoomScript(host, pace);
      script.start();
      script.noteHuman(topic);
      await minutes(3);
      const seen = calls();
      expect(seen[0]).toEqual({ focus: topic, mode: "open" });
      expect(seen.slice(1).every((c) => c.focus === topic && c.mode === "stay")).toBe(true);
      expect(seen.length).toBeGreaterThan(1);
      script.stop();
    });

    it("more messages from the person do not change the subject", async () => {
      vi.mocked(generateScript).mockImplementation(async () => batch("t"));
      const script = new RoomScript(host, pace);
      script.start();
      script.noteHuman(topic);
      await minutes(1);
      for (const [i, reply] of ["haan yaar", "kya bola usne?", "mera boss bhi aisa hi h", "phir kya kiya tumne"].entries()) {
        script.noteHuman(reply);
        await minutes(1);
        expect(script.currentTopic(), `after message ${i + 1}`).toBe(topic);
      }
      expect(calls().every((c) => c.focus === topic)).toBe(true);
      script.stop();
    });

    it("still on it 14 minutes after the last time they spoke, gone after 15", async () => {
      vi.mocked(generateScript).mockImplementation(async () => batch("t"));
      const script = new RoomScript(host, pace);
      script.start();
      script.noteHuman(topic);
      await minutes(14);
      expect(script.currentTopic()).toBe(topic);
      await minutes(2);
      expect(script.currentTopic()).toBeNull();
      vi.mocked(generateScript).mockClear();
      await minutes(2);
      expect(calls().every((c) => c.focus === undefined)).toBe(true); // the room is free to drift again
      script.stop();
    });

    it("speaking about it again restarts the 15 minutes", async () => {
      vi.mocked(generateScript).mockImplementation(async () => batch("t"));
      const script = new RoomScript(host, pace);
      script.start();
      script.noteHuman(topic);
      await minutes(10);
      script.noteHuman("sach me bahut bura laga yaar");
      await minutes(10); // 20 minutes after the first message, 10 after the last
      expect(script.currentTopic()).toBe(topic);
      script.stop();
    });

    it("changes only when the person clearly changes the subject", async () => {
      vi.mocked(generateScript).mockImplementation(async () => batch("t"));
      const script = new RoomScript(host, pace);
      script.start();
      script.noteHuman(topic);
      await minutes(2);
      script.noteHuman("btw kal ka match dekha kya last over me kya hua tha");
      expect(script.currentTopic()).toContain("match");
      vi.mocked(generateScript).mockClear();
      await minutes(2);
      expect(calls()[0]).toEqual({ focus: expect.stringContaining("match"), mode: "open" }); // and the new topic is opened afresh
      script.stop();
    });

    it("drops what was planned when the person speaks, but keeps the topic", async () => {
      vi.mocked(generateScript).mockImplementation(async () => batch("t"));
      const script = new RoomScript(host, pace);
      script.start();
      await minutes(1);
      const before = posted.length;
      script.noteHuman(topic);
      expect(script.currentTopic()).toBe(topic);
      history = [{ alias: "A Real Person 1", at: Date.now(), text: topic } as ChatMessage];
      await vi.advanceTimersByTimeAsync(15_000); // quiet while they are answered
      expect(posted.length).toBe(before);
      script.stop();
    });
  });

  it("stays quiet, without errors, when the model returns nothing", async () => {
    vi.mocked(generateScript).mockResolvedValue([]);
    const script = new RoomScript(host, pace);
    script.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(posted).toEqual([]);
    script.stop();
  });
});
