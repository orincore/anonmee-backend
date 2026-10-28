import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EV } from "../../contracts";
import type { Chat, ChatSide } from "../chat/chat.store";
import { MatchSimulator } from "./match.simulator";
import { generateChatBubbles } from "./together.service";

vi.mock("./together.service", () => ({ generateChatBubbles: vi.fn() }));

import { SYSTEM_BOT_USER_ID } from "./persona.service";
import { isRowdy } from "./chat.quality";

// An id whose texting style is not "rowdy", so how much it tolerates depends only on its disposition.
const BOT_ID = Array.from({ length: 200 }, (_, i) => `00000000-0000-4000-a001-0000000007${String(i).padStart(2, "0")}`).find((id) => !isRowdy({ id }))!;
const user: ChatSide = { userId: "11111111-1111-1111-1111-111111111111", alias: "Real One 1", gender: "male", age: 24 };
const bot: ChatSide = { userId: BOT_ID, alias: "Kind Heron 21", gender: "female", age: 22 };
const bot_alias = "Kind Heron 21";
let persona: Record<string, unknown> = { id: BOT_ID, alias: bot.alias, gender: "female", age: 22, interests: [], vibe: "chill", disposition: "agreeable", quirk: "bubbly" };

/** A 1:1 chat with an AI user, with just enough fake plumbing around it to watch what gets sent and when. */
function setup(disposition: "agreeable" | "guarded" = "agreeable") {
  persona = { ...persona, disposition };
  const chat: Chat = { id: "chat-1", a: user, b: bot, endedAt: null };
  const log: { alias: string; text: string; at: number }[] = [];
  const store = new Map<string, string>();
  const zsets = new Map<string, Map<string, number>>();
  const emitted: [string, unknown][] = [];
  const chats = {
    get: async () => chat,
    since: async () => log.map((m, i) => ({ id: String(i), seq: i, roomId: chat.id, clientMsgId: String(i), gender: "male", age: 24, ...m })),
    append: async (_c: Chat, from: ChatSide, _id: string, text: string) => {
      log.push({ alias: from.alias, text, at: Date.now() });
      return { id: String(log.length), alias: from.alias, text };
    },
    evidenceFrom: async (_id: string, alias: string) => log.filter((m) => m.alias === alias).map((m) => m.text).join("\n---\n") || null,
    end: async () => true,
    activeChatId: async () => chat.id,
  };
  const redis = {
    get: async (k: string) => (k === `sim:chat:${chat.id}` ? JSON.stringify(persona) : store.get(k) ?? null),
    set: async (k: string, v: string) => void store.set(k, v),
    incr: async (k: string) => {
      const n = Number(store.get(k) ?? 0) + 1;
      store.set(k, String(n));
      return n;
    },
    expire: async () => 1,
    zadd: async (key: string, ..._rest: unknown[]) => {
      const score = Number(_rest[_rest.length - 2]);
      const member = String(_rest[_rest.length - 1]);
      const set = zsets.get(key) ?? new Map<string, number>();
      if (!set.has(member)) set.set(member, score); // NX
      zsets.set(key, set);
      return 1;
    },
    zrem: async (key: string, member: string) => void zsets.get(key)?.delete(member),
    zrangebyscore: async (key: string, _min: string, max: number) => [...(zsets.get(key) ?? [])].filter(([, sc]) => sc <= max).map(([m]) => m),
  };
  const io = { to: () => ({ emit: (ev: string, p: unknown) => void emitted.push([ev, p]) }), in: () => ({ fetchSockets: async () => [] }) };
  const reports: Record<string, unknown>[] = [];
  const db = {
    insert: () => ({ values: async (v: Record<string, unknown>) => void reports.push(v) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    execute: async () => undefined,
  };
  const sim = new MatchSimulator(db as never, redis as never, chats as never, io as never);
  const send = async (text: string) => {
    log.push({ alias: user.alias, text, at: Date.now() });
    await sim.handleUserMessage(chat, user, text);
  };
  const botMessages = () => log.filter((m) => m.alias === bot.alias);
  return { sim, chat, log, emitted, send, botMessages, reports, zsets };
}

describe("1:1 AI chat timing", () => {
  let random: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.mocked(generateChatBubbles).mockReset();
    vi.mocked(generateChatBubbles).mockResolvedValue(["haan bolo na"]);
  });
  afterEach(() => {
    random.mockRestore();
    vi.useRealTimers();
  });

  const run = async (ms: number) => {
    for (let t = 0; t < ms; t += 250) await vi.advanceTimersByTimeAsync(250);
  };

  it("never answers at once: a quiet gap and reading time come first", async () => {
    const { send, botMessages } = setup();
    void send("aaj ka din kaisa tha tumhara");
    await run(2000);
    expect(botMessages()).toHaveLength(0);
    expect(generateChatBubbles).not.toHaveBeenCalled(); // nothing is even written yet
    await run(20_000);
    expect(botMessages()).toHaveLength(1);
  });

  it("does not answer while the person is still typing, and answers once they stop", async () => {
    const { sim, chat, send, botMessages } = setup();
    void send("hi");
    // they keep typing for 15 seconds (a signal every 2 seconds)
    for (let t = 0; t < 15_000; t += 2000) {
      sim.noteTyping(chat, user.userId);
      await run(2000);
      expect(botMessages()).toHaveLength(0);
    }
    expect(generateChatBubbles).not.toHaveBeenCalled();
    await run(25_000); // they stop
    expect(botMessages()).toHaveLength(1);
  });

  it("when they send a second message while it is waiting, it answers both with one reply", async () => {
    const { send, log, botMessages } = setup();
    void send("hey");
    await run(2500);
    void send("kya kar rahe ho?");
    await run(40_000);
    expect(botMessages()).toHaveLength(1);
    expect(generateChatBubbles).toHaveBeenCalledTimes(1);
    const seen = vi.mocked(generateChatBubbles).mock.calls[0]![0].messages.map((m) => m.text);
    expect(seen).toEqual(["hey", "kya kar rahe ho?"]);
    expect(log[log.length - 1]!.alias).toBe(bot.alias);
  });

  it("drops a reply that went stale because they wrote more while it was being written", async () => {
    const { send, log, botMessages } = setup();
    let release!: () => void;
    vi.mocked(generateChatBubbles).mockImplementationOnce(() => new Promise((res) => (release = () => res(["purana jawab"]))));
    vi.mocked(generateChatBubbles).mockResolvedValue(["naya jawab"]);
    void send("kal milte hain kya");
    await run(20_000);
    expect(generateChatBubbles).toHaveBeenCalledTimes(1); // still being written
    void send("aur haan, thoda late aaunga"); // arrives while the model is working
    release();
    await run(40_000);
    const said = botMessages().map((m) => m.text);
    expect(said).toEqual(["naya jawab"]); // one answer, to everything, and the stale one never appeared
    expect(log.filter((m) => m.alias !== bot.alias)).toHaveLength(2);
  });

  it("usually sends one message per turn", async () => {
    vi.mocked(generateChatBubbles).mockResolvedValue(["pehla", "doosra", "teesra"]);
    const { send, botMessages } = setup();
    void send("hello"); // the usual roll
    await run(40_000);
    expect(botMessages().map((m) => m.text)).toEqual(["pehla"]);
  });

  it("sometimes sends a quick second or third text, each with its own typing indicator", async () => {
    vi.mocked(generateChatBubbles).mockResolvedValue(["pehla", "doosra", "teesra"]);
    random.mockReturnValue(0.95); // an unusual roll: three messages
    const { send, botMessages, emitted } = setup();
    void send("hello");
    await run(60_000);
    expect(botMessages().map((m) => m.text)).toEqual(["pehla", "doosra", "teesra"]);
    expect(vi.mocked(generateChatBubbles).mock.calls[0]![0].maxBubbles).toBe(3);
    const kinds = emitted.map(([ev]) => ev);
    expect(kinds.filter((k) => k === EV.chatTyping)).toHaveLength(3);
    // typing, message, typing, message, typing, message
    expect(kinds.filter((k) => k === EV.chatTyping || k === EV.chatMessage)).toEqual([
      EV.chatTyping, EV.chatMessage, EV.chatTyping, EV.chatMessage, EV.chatTyping, EV.chatMessage,
    ]);
  });

  it("leaves a human pause between the messages of one turn", async () => {
    vi.mocked(generateChatBubbles).mockResolvedValue(["pehla", "doosra"]);
    random.mockReturnValue(0.8);
    const { send, log } = setup();
    void send("hello");
    await run(60_000);
    const bot = log.filter((m) => m.alias === bot_alias);
    expect(bot).toHaveLength(2);
    expect(bot[1]!.at - bot[0]!.at).toBeGreaterThanOrEqual(2000); // pause plus typing time
  });

  it("stops after the first message if the person starts typing, and never talks over them", async () => {
    vi.mocked(generateChatBubbles).mockResolvedValue(["pehla", "doosra", "teesra"]);
    random.mockReturnValue(0.95);
    const { sim, chat, send, botMessages } = setup();
    void send("hello");
    // wait for the first message, then the person starts typing
    for (let t = 0; t < 60_000 && botMessages().length === 0; t += 250) await vi.advanceTimersByTimeAsync(250);
    expect(botMessages()).toHaveLength(1);
    sim.noteTyping(chat, user.userId);
    await run(20_000);
    expect(botMessages()).toHaveLength(1); // the rest of the turn was dropped
  });

  it("if they send something new between messages, the rest is dropped and the new message is answered", async () => {
    vi.mocked(generateChatBubbles).mockResolvedValueOnce(["pehla", "doosra", "teesra"]);
    vi.mocked(generateChatBubbles).mockResolvedValue(["naya jawab"]);
    random.mockReturnValue(0.95);
    const { send, botMessages } = setup();
    void send("hello");
    for (let t = 0; t < 60_000 && botMessages().length === 0; t += 250) await vi.advanceTimersByTimeAsync(250);
    expect(botMessages().map((m) => m.text)).toEqual(["pehla"]);
    random.mockReturnValue(0.5); // the next turn is an ordinary single message
    void send("ek minute ruko");
    await run(80_000);
    expect(botMessages().map((m) => m.text)).toEqual(["pehla", "naya jawab"]);
  });

  it("shows the typing indicator right before it sends, not while the person is typing", async () => {
    const { send, emitted } = setup();
    void send("kya haal");
    await run(40_000);
    const kinds = emitted.map(([ev]) => ev);
    expect(kinds.indexOf(EV.chatTyping)).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf(EV.chatTyping)).toBeLessThan(kinds.indexOf(EV.chatMessage));
  });

  it("a sequence of turns stays a two-way conversation: one answer after each message", async () => {
    const { send, botMessages } = setup();
    for (const text of ["hii", "kaise ho", "main theek hu, tum?"]) {
      void send(text);
      await run(40_000);
    }
    expect(botMessages()).toHaveLength(3);
  });

  describe("warnings, skip and report", () => {
    const abuse = ["tu chutiya hai", "tu pagal hai", "chup kar", "tu gandu hai"];

    const sendAll = async (send: (t: string) => Promise<void>, texts: string[]) => {
      for (const t of texts) {
        void send(t);
        await run(70_000);
      }
    };

    it("warns twice, then skips on the next offence", async () => {
      const { send, botMessages, emitted, reports } = setup("guarded");
      await sendAll(send, abuse.slice(0, 3));
      const stances = vi.mocked(generateChatBubbles).mock.calls.map((c) => c[0].stance);
      expect(stances).toContain("warning_first");
      expect(stances).toContain("warning_last");
      expect(stances.indexOf("warning_first")).toBeLessThan(stances.indexOf("warning_last"));
      expect(emitted.some(([ev]) => ev === EV.chatEnd)).toBe(false); // still here after two warnings
      expect(reports).toHaveLength(0);

      await sendAll(send, abuse.slice(3));
      const end = emitted.find(([ev]) => ev === EV.chatEnd)!;
      expect(end[1]).toMatchObject({ reason: "peer_skipped" });
      expect(botMessages().length).toBeGreaterThanOrEqual(3); // two warnings and a goodbye
    });

    it("files a report under the AI account with the reason, the warnings, and the person's messages", async () => {
      const { send, reports } = setup("guarded");
      await sendAll(send, abuse);
      expect(reports).toHaveLength(1);
      const r = reports[0]!;
      expect(r.reporterId).toBe(SYSTEM_BOT_USER_ID);
      expect(r.reportedId).toBe(user.userId);
      expect(r.roomId).toBe("chat-1");
      expect(String(r.reason)).toMatch(/^\[AI flagged\] Abusive language toward the AI user\. Warned 2 times/);
      expect(String(r.evidence)).toContain("tu gandu hai"); // the words that ended it
      expect(String(r.evidence)).toContain("tu chutiya hai");
    });

    it.each([
      ["main tujhe maar dunga", "Threatened to kill the AI user"],
      ["i will rape you", "Threatened to rape the AI user"],
      ["kill yourself", "Told the AI user to kill themselves"],
    ])("skips and reports a serious threat (%s) at once: no warning, no goodbye, marked SEVERE", async (threat, label) => {
      const { send, emitted, reports, botMessages } = setup("agreeable");
      await sendAll(send, [threat]);
      expect(emitted.find(([ev]) => ev === EV.chatEnd)![1]).toMatchObject({ reason: "peer_skipped" });
      expect(reports).toHaveLength(1);
      expect(String(reports[0]!.reason)).toContain("[AI flagged] SEVERE:");
      expect(String(reports[0]!.reason)).toContain(label);
      expect(reports[0]!.reporterId).toBe(SYSTEM_BOT_USER_ID);
      expect(String(reports[0]!.evidence)).toContain(threat); // the exact words are saved for staff
      expect(botMessages()).toHaveLength(0); // it does not engage with a violent person
      expect(vi.mocked(generateChatBubbles)).not.toHaveBeenCalled(); // and spends no tokens on them
    });

    it("a threat ends the chat even for the most tolerant AI user", async () => {
      const { send, emitted } = setup("agreeable");
      await sendAll(send, ["tujhe jaan se maar dalunga"]);
      expect(emitted.some(([ev]) => ev === EV.chatEnd)).toBe(true);
    });

    it("an agreeable AI user puts up with more before it warns", async () => {
      const { send } = setup("agreeable");
      await sendAll(send, abuse.slice(0, 2));
      expect(vi.mocked(generateChatBubbles).mock.calls.map((c) => c[0].stance)).not.toContain("warning_first");
    });

    it("never files a report for friendly banter", async () => {
      const { send, reports, emitted } = setup("guarded");
      await sendAll(send, ["bc kya mast din tha", "saale tu bhi na", "haha pagal hai tu"]);
      expect(reports).toHaveLength(0);
      expect(emitted.some(([ev]) => ev === EV.chatEnd)).toBe(false);
    });

    it("a warning is one clear message, even on a turn that would have had several", async () => {
      vi.mocked(generateChatBubbles).mockResolvedValue(["pehla", "doosra", "teesra"]);
      random.mockReturnValue(0.95);
      const { send } = setup("guarded");
      await sendAll(send, abuse.slice(0, 2));
      const warned = vi.mocked(generateChatBubbles).mock.calls.find((c) => c[0].stance === "warning_first")!;
      expect(warned[0].maxBubbles).toBe(1);
    });
  });

  describe("a message is never left unanswered", () => {
    it("remembers an unanswered message and forgets it once it is answered", async () => {
      const { send, zsets } = setup();
      void send("kya haal hai");
      await run(3000);
      expect([...(zsets.get("sim:pending") ?? new Map()).keys()]).toEqual(["chat-1"]); // waiting for an answer
      await run(40_000);
      expect(zsets.get("sim:pending")?.size ?? 0).toBe(0); // answered
    });

    it("answers a message that was left unanswered, for example after a restart", async () => {
      const { sim, log, zsets, botMessages } = setup();
      // The person wrote, then the server went away before anyone answered. Nothing is "in progress" now.
      log.push({ alias: user.alias, text: "arre kahan gayab ho gaye", at: Date.now() });
      zsets.set("sim:pending", new Map([["chat-1", Date.now()]]));
      sim.start();
      await run(30_000);
      expect(botMessages()).toHaveLength(0); // too soon to say it was forgotten
      await run(80_000);
      expect(botMessages()).toHaveLength(1);
      expect(zsets.get("sim:pending")?.size ?? 0).toBe(0);
      sim.stop();
    });

    it("frees a reply that has been stuck for ages and then answers", async () => {
      vi.mocked(generateChatBubbles).mockImplementationOnce(() => new Promise(() => {})); // the first request never comes back
      vi.mocked(generateChatBubbles).mockResolvedValue(["sorry, network slow tha"]);
      const { sim, send, botMessages } = setup();
      sim.start();
      void send("hello");
      await run(100_000);
      expect(botMessages()).toHaveLength(0); // still stuck
      await run(120_000);
      expect(botMessages().map((m) => m.text)).toEqual(["sorry, network slow tha"]);
      sim.stop();
    });

    it("a round that fails does not drop the message queued behind it", async () => {
      vi.mocked(generateChatBubbles).mockRejectedValueOnce(new Error("model exploded"));
      vi.mocked(generateChatBubbles).mockResolvedValue(["theek hu, tum batao"]);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const { send, botMessages } = setup();
      void send("hey");
      await run(25_000);
      void send("kaise ho");
      await run(90_000);
      expect(botMessages().map((m) => m.text)).toEqual(["theek hu, tum batao"]);
      errors.mockRestore();
    });

    it("does not answer twice when the sweeper sees a chat that is being answered", async () => {
      const { sim, send, botMessages } = setup();
      sim.start();
      void send("hii");
      await run(70_000);
      expect(botMessages()).toHaveLength(1); // answered
      await run(60_000); // the sweeper passes by a few times; nothing is pending, so nothing is sent
      expect(botMessages().filter((m) => m.text === "haan bolo na")).toHaveLength(1);
      expect(vi.mocked(generateChatBubbles)).toHaveBeenCalledTimes(1);
      sim.stop();
    });
  });
});
