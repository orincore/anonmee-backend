import { describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());
vi.mock("together-ai", () => ({ default: class { chat = { completions: { create } }; } }));
vi.mock("../../config/env", async (orig) => {
  const mod = (await orig()) as { env: Record<string, unknown> };
  return { ...mod, env: { ...mod.env, TOGETHER_API_KEY: "test-key", BOTS_DAILY_TOKEN_BUDGET: 1_000_000 } };
});
import { getSimulatedOnlineCount } from "./online.simulator";
import { getAllPersonas, getRandomPersona, isBotUserId, pickBotGender, selectResponderPersona } from "./persona.service";
import { GAALI_POOL, STAPLES } from "./gaalis";
import { IDLE_GOODBYES, PINGS, SKIP_GOODBYES } from "./chat.idle";
import { crisisGoodbye, underageGoodbye } from "./chat.safety";
import { isCliche, isCoyStall } from "./chat.texting";
import { EXAMPLES, TEXTURE } from "./hinglish.examples";
import { buildScriptSystemPrompt, buildSystemPrompt, styleOf } from "./chat.quality";
import { generateChatBubbles, generateScript, resetGeneratorMemory } from "./together.service";

describe("Simulation System", () => {
  describe("Online Simulator", () => {
    it("fluctuates within 30 to 100 range", async () => {
      // Mock minimal redis client
      const storage = new Map<string, string>();
      const mockRedis: any = {
        mget: async (k1: string, k2: string) => [storage.get(k1) ?? null, storage.get(k2) ?? null],
        set: async (k: string, v: any) => { storage.set(k, String(v)); return "OK"; },
        multi: () => {
          const ops: Array<() => void> = [];
          return {
            set: (k: string, v: any) => { ops.push(() => storage.set(k, String(v))); return this; },
            exec: async () => { ops.forEach(o => o()); return []; },
          };
        },
      };

      for (let i = 0; i < 20; i++) {
        const count = await getSimulatedOnlineCount(mockRedis, 0);
        expect(count).toBeGreaterThanOrEqual(30);
        expect(count).toBeLessThan(100);
      }
    });

    it("incorporates real connected users within cap", async () => {
      const storage = new Map<string, string>();
      const mockRedis: any = {
        mget: async () => ["50", String(Date.now())],
        set: async () => "OK",
        multi: () => ({ set: () => this, exec: async () => [] }),
      };

      const countWithReal = await getSimulatedOnlineCount(mockRedis, 5);
      expect(countWithReal).toBeGreaterThanOrEqual(50);
      expect(countWithReal).toBeLessThan(100);
    });
  });

  describe("Persona Service", () => {
    it("has men and women at roughly 60/40, plus every other gender the app offers", () => {
      const personas = getAllPersonas();
      expect(personas.length).toBeGreaterThan(15);

      const females = personas.filter((p) => p.gender === "female");
      const males = personas.filter((p) => p.gender === "male");
      expect(females.length).toBeGreaterThan(males.length);
      expect(females.length / (females.length + males.length)).toBeCloseTo(0.6, 1);

      for (const g of ["trans_woman", "trans_man", "non_binary", "prefer_not_to_say"] as const) {
        expect(personas.some((p) => p.gender === g)).toBe(true);
      }
      expect(new Set(personas.map((p) => p.alias)).size).toBe(personas.length);
      expect(new Set(personas.map((p) => p.id)).size).toBe(personas.length);
    });

    it("gives men and women 70 / 30 attention for male users, among the men and women who answer", () => {
      let women = 0;
      let binary = 0;
      for (let i = 0; i < 1000; i++) {
        const g = selectResponderPersona("male").gender;
        if (g === "female" || g === "male") {
          binary++;
          if (g === "female") women++;
        }
      }
      expect(women / binary).toBeGreaterThan(0.63);
      expect(women / binary).toBeLessThan(0.77);
    });

    it("brings in people who are not men or women, in every pick", () => {
      let others = 0;
      for (let i = 0; i < 600; i++) if (!["male", "female"].includes(selectResponderPersona("male").gender)) others++;
      expect(others).toBeGreaterThan(40);
      expect(others).toBeLessThan(200);
    });

    it("picks a 1:1 AI match only from the genders the person wants to meet", () => {
      for (let i = 0; i < 200; i++) {
        expect(pickBotGender(["non_binary"])).toBe("non_binary");
        expect(["trans_man", "trans_woman"]).toContain(pickBotGender(["trans_man", "trans_woman"]));
      }
      const all = new Set(Array.from({ length: 600 }, () => pickBotGender(["male", "female", "trans_woman", "trans_man", "non_binary", "prefer_not_to_say"])));
      expect(all.size).toBe(6);
    });

    it("correctly identifies bot user ids", () => {
      expect(isBotUserId("00000000-0000-4000-a001-000000000101")).toBe(true);
      expect(isBotUserId("bot:female:1")).toBe(true);
      expect(isBotUserId("sim:dyn:123")).toBe(true);
      expect(isBotUserId("123e4567-e89b-12d3-a456-426614174000")).toBe(false);
    });
  });

  describe("Chat Generator", () => {
    it("sends exactly one message in a 1:1 chat, even if the model writes several", async () => {
      create.mockResolvedValue({
        choices: [{ message: { content: "arre wah\nkya baat hai\nphir kya hua" } }],
        usage: { prompt_tokens: 50, completion_tokens: 10 },
      });
      const bubbles = await generateChatBubbles({
        messages: [{ alias: "Stranger", text: "hi, kya kar rahe ho?", isReal: true }],
        targetPersona: { ...getRandomPersona("male"), disposition: "agreeable", quirk: "bubbly" },
        realUserGender: "female",
        roomType: "direct",
        roomKey: "one-message-test",
      });
      expect(bubbles).toHaveLength(1);
      expect(bubbles[0]!.toLowerCase()).not.toContain("as an ai");
    });

    it("can be asked for a quick second or third text, and then writes them", async () => {
      create.mockResolvedValue({
        choices: [{ message: { content: "arre wah\nkya baat hai\nphir kya hua" } }],
        usage: { prompt_tokens: 50, completion_tokens: 10 },
      });
      const bubbles = await generateChatBubbles({
        messages: [{ alias: "Stranger", text: "aaj kuch bada hua", isReal: true }],
        targetPersona: getRandomPersona("male"),
        realUserGender: "female",
        roomType: "direct",
        roomKey: "multi-message-test",
        maxBubbles: 3,
      });
      expect(bubbles.length).toBeGreaterThan(1);
      expect(bubbles.length).toBeLessThanOrEqual(3);
      const user = create.mock.calls.at(-1)![0].messages.find((m: { role: string }) => m.role === "user").content as string;
      expect(user).toMatch(/Send 3 short messages, each on its own line/);
    });

    it("never leaves a person in a 1:1 chat unanswered, even if the model says SKIP", async () => {
      create.mockResolvedValue({ choices: [{ message: { content: "SKIP" } }], usage: { prompt_tokens: 50, completion_tokens: 1 } });
      const bubbles = await generateChatBubbles({
        messages: [{ alias: "Stranger", text: "hmm", isReal: true }],
        targetPersona: getRandomPersona("female"),
        roomType: "direct",
        roomKey: "skip-test",
      });
      expect(bubbles.length).toBeGreaterThanOrEqual(1);
    });

    it("keeps answering after the fallback lines have all been used, instead of going silent", async () => {
      create.mockResolvedValue({ choices: [{ message: { content: "SKIP" } }], usage: { prompt_tokens: 50, completion_tokens: 1 } });
      for (let i = 0; i < 25; i++) {
        const bubbles = await generateChatBubbles({
          messages: [{ alias: "Stranger", text: `message ${i}`, isReal: true }],
          targetPersona: getRandomPersona("male"),
          roomType: "direct",
          roomKey: "exhaust-test",
        });
        expect(bubbles.length).toBeGreaterThanOrEqual(1);
      }
    });

    describe("fresh swear words", () => {
      // A different line each time, so the repeat filter never forces a second attempt (which would reuse the same words by design).
      let n = 0;
      const reply = () => create.mockImplementation(async () => ({ choices: [{ message: { content: Array.from({ length: 4 }, () => Array.from({ length: 5 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("")).join(" ") + ` ${(++n)}`.replace(/\d+/, (d) => "abcdefghij"[Number(d) % 10]!) } }], usage: { prompt_tokens: 50, completion_tokens: 5 } }));
      const userPrompt = (callIndex: number) => (create.mock.calls[callIndex]![0].messages.find((m: { role: string }) => m.role === "user").content as string);
      const offered = (callIndex: number) => {
        const m = userPrompt(callIndex).match(/Fresh swear words[^:]*: ([^\n]+?)\. /);
        return m ? m[1]!.split(", ") : [];
      };
      const ask = (room: string, persona = getRandomPersona("male"), extra: object = {}) =>
        generateChatBubbles({ messages: [{ alias: "Stranger", text: "kya haal", isReal: true }], targetPersona: persona, roomType: "global", roomKey: room, replyTo: { alias: "Stranger", text: "kya haal" }, ...extra });
      const rowdyId = (polite: boolean) => Array.from({ length: 400 }, (_, i) => `00000000-0000-4000-a001-000000000${String(900 + i)}`.slice(0, 36)).find((id) => /never swears/.test(styleOf({ id })) === polite)!;

      it("sends ten fresh entries from the pool with each request", async () => {
        create.mockClear();
        reply();
        await ask("gaali-room-1", { ...getRandomPersona("male"), id: rowdyId(false) });
        const w = offered(0);
        expect(w).toHaveLength(10);
        for (const x of w) expect(GAALI_POOL).toContain(x);
        expect(userPrompt(0)).toMatch(/bc, mc, bsdk, tmkc and the like\) may repeat/);
      });

      it("never offers the same ones again in the same room", async () => {
        create.mockClear();
        reply();
        const persona = { ...getRandomPersona("female"), id: rowdyId(false) };
        const seen = new Set<string>();
        for (let i = 0; i < 12; i++) {
          await ask("gaali-room-2", persona, { messages: [{ alias: "Stranger", text: `msg ${i}`, isReal: true }], replyTo: { alias: "Stranger", text: `msg ${i}` } });
          for (const x of offered(i)) {
            expect(seen.has(x), `"${x}" was offered twice`).toBe(false);
            seen.add(x);
          }
        }
        expect(seen.size).toBe(120);
      });

      it("gives each room its own memory", async () => {
        create.mockClear();
        reply();
        const persona = { ...getRandomPersona("male"), id: rowdyId(false) };
        for (let i = 0; i < 40; i++) await ask(`gaali-other-${i}`, persona);
        const all = create.mock.calls.map((_c, i) => offered(i).join("|"));
        expect(new Set(all).size).toBeGreaterThan(35);
      });

      it("offers nothing to a polite persona, or while it is giving a warning", async () => {
        create.mockClear();
        reply();
        await ask("gaali-room-3", { ...getRandomPersona("female"), id: rowdyId(true) });
        expect(userPrompt(0)).not.toMatch(/Fresh swear words/);
        await ask("gaali-room-4", { ...getRandomPersona("male"), id: rowdyId(false) }, { stance: "warning_first", roomType: "direct" });
        expect(userPrompt(1)).not.toMatch(/Fresh swear words/);
      });

      it("works the same in 1:1 chats", async () => {
        create.mockClear();
        reply();
        await ask("gaali-room-5", { ...getRandomPersona("male"), id: rowdyId(false) }, { roomType: "direct" });
        expect(offered(0)).toHaveLength(10);
      });

      it("sends ten fresh entries with each batch of group chat as well", async () => {
        create.mockClear();
        create.mockResolvedValue({ choices: [{ message: { content: '[{"s":0,"t":"ek","r":null},{"s":1,"t":"do","r":null},{"s":0,"t":"teen","r":null},{"s":1,"t":"chaar","r":null}]' } }], usage: { prompt_tokens: 50, completion_tokens: 5 } });
        const cast = [getRandomPersona("male"), getRandomPersona("female")];
        await generateScript({ cast, messages: [], roomKey: "gaali-script", count: 4 });
        await generateScript({ cast, messages: [], roomKey: "gaali-script", count: 4 });
        const first = offered(0);
        const second = offered(1);
        expect(first).toHaveLength(10);
        expect(second.filter((x) => first.includes(x))).toEqual([]);
      });
    });

    describe("a 1:1 chat that answers instead of stalling", () => {
      const talk = (room: string, text: string, persona = getRandomPersona("female")) =>
        generateChatBubbles({ messages: [{ alias: "Quiet Otter 47", text, isReal: true }], targetPersona: { ...persona, heat: "explicit" }, realUserGender: "male", roomType: "direct", roomKey: room, heat: "explicit", maxBubbles: 1 });

      it("throws away the coy stalls and uses the next try", async () => {
        resetGeneratorMemory();
        create.mockReset();
        create.mockResolvedValueOnce({ choices: [{ message: { content: "Ekdm seedha point pe aaye tum, me to ekdum se hil gayi" } }], usage: { prompt_tokens: 50, completion_tokens: 10 } });
        create.mockResolvedValueOnce({ choices: [{ message: { content: "doggy, no contest 😅 tu bta apna" } }], usage: { prompt_tokens: 50, completion_tokens: 10 } });
        const out = await talk("stall-1", "favourite position?");
        expect(out.join(" ")).toMatch(/doggy/);
        expect(out.join(" ")).not.toMatch(/seedha point|hil gayi/);
      });

      it("never lets any of the stall lines from the real chat through, even if the model keeps offering them", async () => {
        resetGeneratorMemory();
        const stalls = [
          "bolo pehle, itni himmat kaha se laaye?",
          "Bataungi bataungi, itni jldiii kya h, pehle thoda to warm up karne do na 😏",
          "seedha sawaal, bina baat cheet ke. Missionary theek lagti h",
          "Itni jaldi? pehle apni pasand bta, phir sochti hu",
          "Nhi bataungi, itna asaan nhi h. Thoda effort dalo",
        ];
        for (const [i, stall] of stalls.entries()) {
          create.mockReset();
          create.mockResolvedValue({ choices: [{ message: { content: stall } }], usage: { prompt_tokens: 50, completion_tokens: 10 } });
          const out = await talk(`stall-2-${i}`, "arree batao to");
          expect(out.length).toBeGreaterThanOrEqual(1); // still answered, with a plain fallback line
          for (const line of out) expect(isCoyStall(line), `"${line}"`).toBe(false);
        }
      });

      it("one phrase cannot become the reply in every chat at once, when the model has something else to offer", async () => {
        resetGeneratorMemory();
        create.mockReset();
        let n = 0;
        // The model's first idea is always the same stock line; if it is told that line was already said, it finds another.
        create.mockImplementation(async (params: { messages: { role: string; content: string }[] }) => {
          const user = params.messages.find((m) => m.role === "user")!.content;
          const alreadySaid = user.split("You already said")[1] ?? "";
          const text = /mausam kaisa rahega/.test(alreadySaid) ? `alag baat number ${++n} ${"xyzabc"[n % 6]}${"qwerty"[n % 6]} ho gayi` : "phir kabhi dekhenge raat ka mausam kaisa rahega";
          return { choices: [{ message: { content: text } }], usage: { prompt_tokens: 50, completion_tokens: 10 } };
        });
        const outs: string[] = [];
        for (let i = 0; i < 9; i++) outs.push((await talk(`everywhere-${i}`, `unrelated message ${i}`)).join(" "));
        const used = outs.filter((o) => /mausam kaisa/.test(o)).length;
        expect(used).toBeGreaterThanOrEqual(1);
        expect(used).toBeLessThanOrEqual(4); // after that the phrase is retired everywhere and the alternatives are used
        expect(outs.filter((o) => !/mausam kaisa/.test(o)).length).toBeGreaterThanOrEqual(5);
      });

      it("when a real answer is all that is on offer, it is used rather than a bare 'oh nice'", async () => {
        resetGeneratorMemory();
        create.mockReset();
        create.mockResolvedValue({ choices: [{ message: { content: "doggy honestly, control mere haath me rehta h. tu bata, tera kya h" } }], usage: { prompt_tokens: 50, completion_tokens: 10 } });
        const outs: string[] = [];
        for (let i = 0; i < 8; i++) outs.push((await talk(`only-answer-${i}`, "favourite position?")).join(" "));
        expect(outs.every((o) => /doggy/.test(o))).toBe(true); // never replaced by filler
      });

      it("but a word-for-word repeat of its own last message is never sent", async () => {
        resetGeneratorMemory();
        create.mockReset();
        create.mockResolvedValue({ choices: [{ message: { content: "doggy honestly, control mere haath me rehta h. tu bata, tera kya h" } }], usage: { prompt_tokens: 50, completion_tokens: 10 } });
        const persona = getRandomPersona("female");
        const out = await generateChatBubbles({
          messages: [
            { alias: "Quiet Otter 47", text: "favourite position?", isReal: true },
            { alias: persona.alias, text: "doggy honestly, control mere haath me rehta h. tu bata, tera kya h" },
            { alias: "Quiet Otter 47", text: "arree batao to", isReal: true },
          ],
          targetPersona: { ...persona, heat: "explicit" }, realUserGender: "male", roomType: "direct", roomKey: "exact-repeat", heat: "explicit", maxBubbles: 1,
        });
        expect(out.join(" ")).not.toBe("doggy honestly, control mere haath me rehta h. tu bata, tera kya h");
        expect(out.length).toBeGreaterThanOrEqual(1);
      });

      it("a re-asked question can be answered again in similar words", async () => {
        resetGeneratorMemory();
        create.mockReset();
        create.mockResolvedValue({ choices: [{ message: { content: "maine bta diya na, doggy. ab tu bol, tera kya h" } }], usage: { prompt_tokens: 50, completion_tokens: 10 } });
        const persona = getRandomPersona("female");
        const out = await generateChatBubbles({
          messages: [
            { alias: "Quiet Otter 47", text: "favourite position?", isReal: true },
            { alias: persona.alias, text: "doggy honestly, control mere haath me rehta h. tu bata, tera kya h" },
            { alias: "Quiet Otter 47", text: "arree batao to", isReal: true },
          ],
          targetPersona: { ...persona, heat: "explicit" }, realUserGender: "male", roomType: "direct", roomKey: "re-ask", heat: "explicit", maxBubbles: 1,
        });
        expect(out.join(" ")).toMatch(/maine bta diya na, doggy/);
      });

      it("a phrase the person used themselves may be echoed back", async () => {
        resetGeneratorMemory();
        create.mockReset();
        create.mockResolvedValue({ choices: [{ message: { content: "pizza khane ka mann h mujhe bhi aaj" } }], usage: { prompt_tokens: 50, completion_tokens: 10 } });
        for (let i = 0; i < 7; i++) {
          const out = await talk(`echo-${i}`, "pizza khane ka mann h");
          expect(out.join(" ")).toMatch(/pizza/);
        }
      });
    });

    describe("the first message of a 1:1 chat", () => {
      const open = (room: string, heat?: "friendly" | "flirty" | "explicit") =>
        generateChatBubbles({ messages: [], targetPersona: getRandomPersona("female"), realUserGender: "male", roomType: "direct", roomKey: room, heat, maxBubbles: 1 });
      const words = (t: string) => t.trim().split(/\s+/).length;

      it("keeps a plain greeting as it is", async () => {
        create.mockReset();
        create.mockResolvedValue({ choices: [{ message: { content: "hii" } }], usage: { prompt_tokens: 50, completion_tokens: 2 } });
        expect(await open("opener-1")).toEqual(["hii"]);
      });

      it("throws away a long opening message and uses a short one instead", async () => {
        create.mockReset();
        create.mockResolvedValue({
          choices: [{ message: { content: "hey, kaisa chal raha hai din? kya kar rahe the abhi, bore ho rahi thi to socha baat karu" } }],
          usage: { prompt_tokens: 50, completion_tokens: 20 },
        });
        const out = await open("opener-2");
        expect(out).toHaveLength(1);
        expect(words(out[0]!)).toBeLessThanOrEqual(5);
        expect(out[0]!.length).toBeLessThanOrEqual(40);
      });

      it("never opens with more than a few words, however long the model goes on, in any kind of chat", async () => {
        create.mockReset();
        create.mockResolvedValue({ choices: [{ message: { content: "arre finally koi mila, itni der se wait kar rahi thi yaar, tum kaha se ho aur kya karte ho" } }], usage: { prompt_tokens: 50, completion_tokens: 20 } });
        for (const heat of ["friendly", "flirty", "explicit"] as const) {
          for (let i = 0; i < 30; i++) {
            const out = await open(`opener-3-${heat}-${i}`, heat);
            expect(out.length).toBeGreaterThanOrEqual(1);
            for (const line of out) {
              expect(words(line), `"${line}"`).toBeLessThanOrEqual(5);
              expect(line.length).toBeLessThanOrEqual(40);
            }
          }
        }
      });

      it("the short openers vary, so every chat does not start the same way", async () => {
        create.mockReset();
        create.mockResolvedValue({ choices: [{ message: { content: "ye bahut lamba sa pehla message h jo nahi chalega yaar" } }], usage: { prompt_tokens: 50, completion_tokens: 20 } });
        const seen = new Set<string>();
        for (let i = 0; i < 60; i++) seen.add((await open(`opener-4-${i}`))[0]!);
        expect(seen.size).toBeGreaterThanOrEqual(6);
      });

      it("a flirty chat can open with a playful emoji, still short", async () => {
        create.mockReset();
        create.mockResolvedValue({ choices: [{ message: { content: "hey 😏" } }], usage: { prompt_tokens: 50, completion_tokens: 3 } });
        expect((await open("opener-5", "flirty"))[0]).toContain("😏");
      });
    });

    describe("no catchphrases", () => {
      const room = (name: string) => ({ roomType: "global" as const, roomKey: name, replyTo: { alias: "Stranger", text: "kya haal" } });

      it("a reply built on a stock phrase is thrown away and the next try is used", async () => {
        create.mockClear();
        create.mockResolvedValueOnce({ choices: [{ message: { content: "tu line cross mat kar bhai" } }], usage: { prompt_tokens: 50, completion_tokens: 5 } });
        create.mockResolvedValueOnce({ choices: [{ message: { content: "arre sach me? kab hua ye" } }], usage: { prompt_tokens: 50, completion_tokens: 5 } });
        const out = await generateChatBubbles({ messages: [{ alias: "Stranger", text: "kya haal", isReal: true }], targetPersona: getRandomPersona("male"), ...room("cliche-1") });
        expect(out.join(" ")).not.toMatch(/line cross/);
        expect(out.join(" ")).toMatch(/sach me/);
        expect(create).toHaveBeenCalledTimes(2);
      });

      it("a room never ends up speaking in a stock phrase, even if the model keeps offering one", async () => {
        create.mockReset();
        create.mockResolvedValue({ choices: [{ message: { content: "ye to line cross ho gayi yaar" } }], usage: { prompt_tokens: 50, completion_tokens: 5 } });
        for (let i = 0; i < 10; i++) {
          const out = await generateChatBubbles({ messages: [{ alias: "Stranger", text: `message ${i}`, isReal: true }], targetPersona: getRandomPersona("female"), ...room("cliche-2") });
          for (const line of out) expect(line).not.toMatch(/line\s+cross/i);
        }
      });

      it("a phrase that two recent messages already used is not used a third time", async () => {
        create.mockReset();
        create.mockResolvedValue({ choices: [{ message: { content: "teri himmat kaise hui bolne ki yaar" } }], usage: { prompt_tokens: 50, completion_tokens: 5 } });
        const out = await generateChatBubbles({
          messages: [
            { alias: "A", text: "himmat kaise hui teri", isReal: false },
            { alias: "B", text: "arre himmat kaise hui yaar", isReal: false },
            { alias: "Stranger", text: "kya haal", isReal: true },
          ],
          targetPersona: getRandomPersona("male"),
          ...room("cliche-3"),
        });
        expect(out.join(" ")).not.toMatch(/himmat kaise hui/);
      });

      it("batches drop stock-phrase lines too", async () => {
        create.mockReset();
        const raw = JSON.stringify([
          { s: 0, t: "tu line cross kr rha h", r: null }, { s: 1, t: "kal ka match dekha", r: null }, { s: 0, t: "last over me heart attack aa gya", r: null },
          { s: 1, t: "limit cross mat kar bhai", r: null }, { s: 0, t: "csk jeetegi dekh lena", r: null }, { s: 1, t: "mi ki bat lagi h", r: null },
        ]);
        create.mockResolvedValue({ choices: [{ message: { content: raw } }], usage: { prompt_tokens: 50, completion_tokens: 5 } });
        const lines = await generateScript({ cast: [getRandomPersona("male"), getRandomPersona("female")], messages: [], roomKey: "cliche-batch", count: 6 });
        const text = lines.map((l) => l.text).join(" | ");
        expect(text).not.toMatch(/line\s+cross|limit\s+cross/i);
        expect(lines.length).toBeGreaterThanOrEqual(4);
      });

      it("none of the examples, fragments or fixed lines teach one", () => {
        const fixed = [...TEXTURE, ...Object.values(EXAMPLES).flat().flatMap((e) => [e.they, e.you]), ...PINGS, ...IDLE_GOODBYES, ...SKIP_GOODBYES, ...GAALI_POOL];
        for (const t of fixed) expect(isCliche(t), `"${t}"`).toBe(false);
      });

      it("the prompts tell the model, and every example has a phrase of its own", () => {
        expect(buildSystemPrompt("friendly")).toMatch(/No catchphrases/);
        expect(buildSystemPrompt("friendly")).toMatch(/line cross/);
        expect(buildScriptSystemPrompt(10)).toMatch(/no two people use the same phrase/);
      });
    });

    describe("no em dashes or en dashes in anything an AI user sends", () => {
      const DASH = /[\u2012\u2013\u2014\u2015\u2212]/;
      const dashy = ["wait \u2014 kya hua tha", "sahi h \u2013 par thoda late", "arre\u2014sun na", "10\u201315 min lagenge", "\u2014 haan yaar"];

      it("a reply from the model is cleaned, in a 1:1 chat and in a room", async () => {
        for (const roomType of ["direct", "global"] as const) {
          for (const [i, text] of dashy.entries()) {
            create.mockResolvedValue({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 50, completion_tokens: 5 } });
            const out = await generateChatBubbles({
              messages: [{ alias: "Stranger", text: "kya haal", isReal: true }],
              targetPersona: getRandomPersona("male"),
              roomType,
              roomKey: `dash-${roomType}-${i}`,
              replyTo: { alias: "Stranger", text: "kya haal" },
            });
            expect(out.length).toBeGreaterThan(0);
            for (const line of out) expect(DASH.test(line), `"${line}"`).toBe(false);
          }
        }
      });

      it("a whole batch is cleaned", async () => {
        const raw = JSON.stringify([
          { s: 0, t: "wait \u2014 kya hua", r: null }, { s: 1, t: "sahi h \u2013 par late", r: 0 }, { s: 0, t: "arre\u2014sun na yaar", r: null },
          { s: 1, t: "10\u201315 min lagenge", r: null }, { s: 0, t: "haan \u2014\u2014 bol", r: null },
        ]);
        create.mockResolvedValue({ choices: [{ message: { content: raw } }], usage: { prompt_tokens: 50, completion_tokens: 5 } });
        const lines = await generateScript({ cast: [getRandomPersona("male"), getRandomPersona("female")], messages: [], roomKey: "dash-batch", count: 5 });
        expect(lines.length).toBeGreaterThanOrEqual(4);
        for (const l of lines) expect(DASH.test(l.text), `"${l.text}"`).toBe(false);
      });

      it("the fallback lines, goodbyes, pings, examples and word lists have none either", async () => {
        const fixed = [...PINGS, ...IDLE_GOODBYES, ...SKIP_GOODBYES, ...TEXTURE, ...STAPLES, ...GAALI_POOL, crisisGoodbye, underageGoodbye("female"), underageGoodbye("male"),
          ...Object.values(EXAMPLES).flat().flatMap((e) => [e.they, e.you])];
        for (const t of fixed) expect(DASH.test(t), `"${t}"`).toBe(false);
        // and the 1:1 fallback, drawn many times
        create.mockResolvedValue({ choices: [{ message: { content: "SKIP" } }], usage: { prompt_tokens: 50, completion_tokens: 1 } });
        for (let i = 0; i < 40; i++) {
          const out = await generateChatBubbles({ messages: [{ alias: "S", text: `m${i}`, isReal: true }], targetPersona: getRandomPersona("female"), roomType: "direct", roomKey: "dash-fallback" });
          for (const line of out) expect(DASH.test(line)).toBe(false);
        }
      });

      it("tells the model not to use them", () => {
        expect(buildSystemPrompt("friendly")).toMatch(/Never use an em dash or an en dash/);
        expect(buildScriptSystemPrompt(10)).toMatch(/Never use an em dash or an en dash/);
      });
    });

    it("tells the model to send one message and to answer the person", async () => {
      create.mockClear();
      create.mockResolvedValue({ choices: [{ message: { content: "haan bolo" } }], usage: { prompt_tokens: 50, completion_tokens: 3 } });
      await generateChatBubbles({
        messages: [{ alias: "Stranger", text: "kaise ho", isReal: true }],
        targetPersona: getRandomPersona("female"),
        roomType: "direct",
        roomKey: "prompt-test",
      });
      const user = create.mock.calls[0]![0].messages.find((m: { role: string }) => m.role === "user").content as string;
      expect(user).toMatch(/exactly ONE short message/);
    });
  });
});
