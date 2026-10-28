import { describe, expect, it } from "vitest";
import { greetingExamples, isShortGreeting, parseScript, reusesPhrase, answersBeforeAsked, asksGenericFavourite, isNonSequitur, personaBrief, TOPIC_SEEDS, humanize, styleOf, buildScriptUserPrompt, buildScriptSystemPrompt, buildSystemPrompt, buildUserPrompt, cleanBubbles, isRepetitive, labelHistory, pickMode } from "./chat.quality";
import { getAllPersonas } from "./persona.service";
import type { SimulationMessageContext } from "./simulation.types";

const persona = getAllPersonas()[0]!;
const ctx = (over: Partial<SimulationMessageContext>): SimulationMessageContext => ({ messages: [], targetPersona: persona, roomType: "global", ...over });

describe("isRepetitive", () => {
  it("catches exact, stretched and near-identical repeats", () => {
    const said = ["koi acha gaana batao mood fresh karne ke liye"];
    expect(isRepetitive("koi acha gaana batao mood fresh karne ke liye", said)).toBe(true);
    expect(isRepetitive("Koi acha gaanaaaa batao, mood fresh karne ke liye!!", said)).toBe(true);
    expect(isRepetitive("koi acha gaana batao yaar mood fresh karne ke liye", said)).toBe(true);
  });

  it("allows a genuinely different line", () => {
    expect(isRepetitive("kal ka match dekha kya", ["koi acha gaana batao mood fresh karne ke liye"])).toBe(false);
  });

  it("rejects a third line in a row that opens with the same word", () => {
    const said = ["haha sahi", "haha kya baat hai"];
    expect(isRepetitive("haha mujhe bhi", said)).toBe(true);
    expect(isRepetitive("mujhe bhi lagta hai", said)).toBe(false);
  });

  it("treats empty text as repetitive so it is never sent", () => {
    expect(isRepetitive("  !!  ", [])).toBe(true);
  });
});

describe("cleanBubbles", () => {
  it("strips labels, numbering, quotes and reasoning tags", () => {
    expect(cleanBubbles('<think>hmm</think>\nYou: "kal exam hai yaar"\n2) dar lag raha h')).toEqual(["kal exam hai yaar", "dar lag raha h"]);
  });

  it("returns nothing when the model says SKIP", () => {
    expect(cleanBubbles("SKIP")).toEqual([]);
    expect(cleanBubbles("kuch bhi\nskip")).toEqual([]);
  });

  it("drops links, phone numbers, AI boilerplate and any mention of a known alias", () => {
    const raw = ["visit www.site.com", "call 9876543210", "As an AI I cannot", "hey Velvet Fox 23 kya haal", "theek hu yaar"].join("\n");
    expect(cleanBubbles(raw, ["Velvet Fox 23"])).toEqual(["theek hu yaar"]);
  });

  it("drops a stray quote mark but keeps a balanced pair", () => {
    expect(cleanBubbles('haan" matlab accha tha ya bas haan?')).toEqual(["haan matlab accha tha ya bas haan?"]);
    expect(cleanBubbles('usne bola "chal nikal" aur chala gaya')).toEqual(['usne bola "chal nikal" aur chala gaya']);
  });

  it("keeps at most three lines", () => {
    expect(cleanBubbles("a1\nb2\nc3\nd4")).toHaveLength(3);
  });
});

describe("prompt building", () => {
  const messages = [
    { alias: "Neon Falcon 72", text: "aaj bohot thak gaya", isReal: true },
    { alias: persona.alias, text: "kya hua?" },
    { alias: "Quiet Wolf 18", text: "same yaar" },
  ];

  it("labels speakers so no alias reaches the model", () => {
    const lines = labelHistory(messages, persona.alias);
    expect(lines).toEqual(["Person A: aaj bohot thak gaya", "You: kya hua?", "Person B: same yaar"]);
    const prompt = buildUserPrompt(ctx({ messages }), [], "reply", "x");
    expect(prompt).not.toContain("Neon Falcon");
    expect(prompt).not.toContain("Quiet Wolf");
  });

  it("tells the model what to answer and what it already said", () => {
    const prompt = buildUserPrompt(ctx({ messages, replyTo: { alias: "Quiet Wolf 18", text: "same yaar" } }), ["kya hua?"], "reply", "x");
    expect(prompt).toContain('Reply directly to this message: "same yaar"');
    expect(prompt).toContain("- kya hua?");
  });

  it("picks the mode from the conversation", () => {
    expect(pickMode(ctx({}))).toBe("opener");
    expect(pickMode(ctx({ messages: messages.slice(0, 1) }))).toBe("reply");
    expect(pickMode(ctx({ messages: messages.slice(0, 2) }))).toBe("starter");
    expect(pickMode(ctx({ messages: messages.slice(0, 2), replyTo: { alias: "Neon Falcon 72", text: "hi" } }))).toBe("reply");
  });

  it("friendly chats get banter and swearing but nothing romantic", () => {
    const sys = buildSystemPrompt("friendly");
    expect(sys).toMatch(/Swearing/);
    expect(sys).toMatch(/never anything about anyone's religion or caste/i);
    expect(sys).not.toMatch(/Flirty and romantic/);
    expect(sys).not.toMatch(/signed up for sexting/);
  });

  it("flirty chats add romance, explicit chats add sexual chat with consent limits", () => {
    expect(buildSystemPrompt("flirty")).toMatch(/Flirty and romantic/);
    expect(buildSystemPrompt("flirty")).not.toMatch(/signed up for sexting/);
    const explicit = buildSystemPrompt("explicit");
    expect(explicit).toMatch(/signed up for sexting/);
    expect(explicit).toMatch(/If they say stop or no/);
    expect(explicit).toMatch(/Nothing involving minors/);
  });

  it("opted-in 1:1 chats are forward and start the heat; the opener flirts", () => {
    expect(buildSystemPrompt("explicit")).toMatch(/take the initiative/);
    const opener = buildUserPrompt(ctx({ roomType: "direct", heat: "explicit" }), [], "opener", "x");
    expect(opener).toMatch(/At most five words/);
    expect(opener).toMatch(/One playful emoji is fine/);
    const friendly = buildUserPrompt(ctx({ roomType: "direct", heat: "friendly" }), [], "opener", "x");
    expect(friendly).toMatch(/At most five words/);
    expect(friendly).not.toMatch(/One playful emoji/);
  });

  it("the batch writer asks for supporters and thirsty banter but keeps shared rooms non-explicit", () => {
    const sys = buildScriptSystemPrompt(10);
    expect(sys).toMatch(/back someone up or take their side/);
    expect(sys).toMatch(/describing sex acts is not/);
    expect(sys).not.toMatch(/signed up for sexting/);
  });

  it("shared rooms never get the explicit rules, even if asked for", () => {
    const shared = buildSystemPrompt("explicit", true);
    expect(shared).not.toMatch(/signed up for sexting/);
    expect(shared).toMatch(/nothing sexually explicit/);
    expect(buildScriptSystemPrompt(10, "explicit")).not.toMatch(/signed up for sexting/);
  });

  it("keeps the protective rules at every level", () => {
    for (const heat of ["friendly", "flirty", "explicit"] as const) {
      const sys = buildSystemPrompt(heat);
      expect(sys).toMatch(/No links/);
      expect(sys).toMatch(/sincerely asks.*AI/i);
      expect(sys).toMatch(/under 18/);
    }
  });
});

describe("lines that do not follow from the chat", () => {
  it("rejects the reported line: a generic favourite-chai quiz that answers a question nobody asked", () => {
    const bad = "😌 pehle tum batao, tumhari favourite chai kya h";
    const greeting = "hii";
    expect(isNonSequitur(bad, greeting)).toBe(true);
    expect(asksGenericFavourite(bad, greeting)).toBe(true);
    expect(answersBeforeAsked(bad, greeting)).toBe(true);
  });

  it("allows a favourites question when the person brought the subject up", () => {
    expect(asksGenericFavourite("tumhari favourite chai kaunsi h", "mujhe chai bahut pasand h")).toBe(false);
  });

  it("allows 'you first' when they really did ask something", () => {
    expect(answersBeforeAsked("pehle tum batao", "tumhara naam kya h?")).toBe(false);
    expect(answersBeforeAsked("pehle tum batao", "kya kar rahe ho")).toBe(false);
    expect(answersBeforeAsked("pehle tum batao", "mera din bura tha")).toBe(true);
  });

  it("leaves normal lines alone", () => {
    for (const l of ["kya hua bol na", "bc mood off h aaj", "tumse baat karke accha laga 😏", "favourite? mera to kuch bhi chalega"]) {
      expect(isNonSequitur(l, "aaj thak gaya")).toBe(false);
    }
  });

  it("the prompts forbid them, and the 1:1 opener no longer reaches for food or songs", () => {
    expect(buildSystemPrompt("friendly")).toMatch(/Never ask "what is your favourite chai/);
    expect(buildSystemPrompt("friendly")).toMatch(/pehle tum batao/);
    const opener = buildUserPrompt(ctx({ roomType: "direct", heat: "friendly" }), [], "opener", "x");
    expect(opener).toMatch(/short, normal greeting/);
    expect(opener).toMatch(/No introduction, no question about their life/);
    expect(buildScriptSystemPrompt(10)).toMatch(/No "favourite chai/);
  });
});

describe("keeping a topic going", () => {
  const cast = getAllPersonas().slice(0, 4);
  const topic = "boss ne aaj sabke saamne mujhe daant diya";

  it("a new topic is opened: the first eight messages are about it", () => {
    const p = buildScriptUserPrompt({ cast, messages: [], said: [], count: 10, focus: topic, focusMode: "open" });
    expect(p).toContain(topic);
    expect(p).toMatch(/first eight messages must be about that/);
  });

  it("a topic that is already running is kept going for most of the batch", () => {
    const p = buildScriptUserPrompt({ cast, messages: [], said: [], count: 10, focus: topic, focusMode: "stay" });
    expect(p).toContain(topic);
    expect(p).toMatch(/At least seven of the ten messages are about it/);
    expect(p).toMatch(/Do NOT change the subject/);
  });

  it("the flirting and swearing quotas happen inside the topic, not instead of it", () => {
    for (const focusMode of ["open", "stay"] as const) {
      const p = buildScriptUserPrompt({ cast, messages: [], said: [], count: 10, focus: topic, focusMode });
      expect(p).toMatch(/happen INSIDE this topic/);
      expect(p).toMatch(/Do not start unrelated flirting/);
    }
  });

  it("says nothing about a topic when there is none", () => {
    const p = buildScriptUserPrompt({ cast, messages: [], said: [], count: 10 });
    expect(p).not.toMatch(/real person/);
  });

  it("single replies are told what the room is in the middle of", () => {
    const withTopic = buildUserPrompt(ctx({ roomTopic: topic, replyTo: { alias: "x", text: "haan yaar" } }), [], "reply", "x");
    expect(withTopic).toContain(`in the middle of a conversation about: "${topic}"`);
    const without = buildUserPrompt(ctx({ replyTo: { alias: "x", text: "haan yaar" } }), [], "reply", "x");
    expect(without).not.toMatch(/in the middle of a conversation/);
  });
});

describe("reusesPhrase", () => {
  const chat = ["teri himmat kaise hui bolne ki", "himmat kaise hui yaar tujhe", "kya scene h aaj"];

  it("flags a phrase two recent messages already used", () => {
    expect(reusesPhrase("sach me himmat kaise hui teri", chat)).toBe(true);
  });

  it("allows a phrase used only once so far", () => {
    expect(reusesPhrase("himmat kaise hui", ["teri himmat kaise hui bolne ki", "kuch aur"])).toBe(false);
  });

  it("allows a phrase from the thing being discussed, since talking about one subject repeats its words", () => {
    const recent = ["boss ne daant diya", "kya bola boss ne", "boss ne kya kiya"];
    expect(reusesPhrase("boss ne phir bola", recent)).toBe(true);
    expect(reusesPhrase("boss ne phir bola", recent, "boss ne aaj daant diya")).toBe(false);
  });

  it("ignores phrases made only of fillers", () => {
    const recent = ["kya hua yaar", "kya hua bhai", "kya hua tha"];
    expect(reusesPhrase("kya hua", recent)).toBe(false);
  });

  it("is not tripped by unrelated lines or an empty chat", () => {
    expect(reusesPhrase("aaj movie dekhni h", chat)).toBe(false);
    expect(reusesPhrase("anything at all", [])).toBe(false);
  });

  it("drops a batch line that repeats a phrase already going round, keeping the rest", () => {
    const raw = JSON.stringify([
      { s: 0, t: "tu apni limit me reh bhai", r: null },
      { s: 1, t: "abe apni limit me reh warna dekh", r: null },
      { s: 0, t: "sach me apni limit me reh tu", r: null }, // the third time the room says it
      { s: 1, t: "chal bata kya hua tha", r: null },
    ]);
    const lines = parseScript(raw, 2);
    expect(lines.map((l) => l.text)).toEqual(["tu apni limit me reh bhai", "abe apni limit me reh warna dekh", "chal bata kya hua tha"]);
  });
});

describe("the first message of a chat", () => {
  it.each(["hi", "hello", "hey", "hii", "hello ji", "hey, kaise ho", "hi 👋", "hey 😏", "hlo"])("%s is a greeting", (t) => expect(isShortGreeting(t)).toBe(true));

  it.each([
    "hey, kaisa chal raha hai din? kya kar rahe the abhi?",
    "hii finally koi mila baat karne ko, itni der se wait kar rahi thi",
    "hello! mera naam kuch bhi ho sakta h, tum batao apne baare me",
    "",
    "   ",
  ])("%s is not", (t) => expect(isShortGreeting(t)).toBe(false));

  it("offers three different example greetings each time, so openers vary", () => {
    const seen = new Set(Array.from({ length: 40 }, () => greetingExamples()));
    expect(seen.size).toBeGreaterThan(20);
    for (const g of seen) expect(g.match(/"[^"]+"/g)).toHaveLength(3);
    const p = buildUserPrompt(ctx({ roomType: "direct" }), [], "opener", "x");
    expect(p).toMatch(/for example "[^"]+", "[^"]+", "[^"]+"/);
  });

  it("the prompt asks for nothing more than a greeting, for any kind of chat", () => {
    for (const heat of ["friendly", "flirty", "explicit"] as const) {
      const p = buildUserPrompt(ctx({ roomType: "direct", heat }), [], "opener", "x");
      expect(p).toMatch(/Send only a short, normal greeting/);
      expect(p).toMatch(/At most five words/);
      expect(p).not.toMatch(/ask something personal|how their day/i);
    }
  });
});

describe("answering directly and keeping them interested", () => {
  const me = (text: string) => [{ alias: "Me 1", text, isReal: true }];
  const prompt = (text: string, over: Partial<SimulationMessageContext> = {}) =>
    buildUserPrompt(ctx({ roomType: "direct", messages: me(text), replyTo: { alias: "Me 1", text }, ...over }), [], "reply", "x");

  it("a question gets the answer first, then a hook", () => {
    for (const q of ["favourite position kya h?", "arree batao to", "tum kaha se ho", "what do you like"]) {
      const p = prompt(q);
      expect(p, q).toMatch(/Start with the actual answer/);
      expect(p).toMatch(/not a tease/);
      expect(p).toMatch(/Then keep them talking/);
    }
  });

  it("anything else is reacted to specifically and followed by a hook most of the time", () => {
    const p = prompt("aaj bahut thak gaya");
    expect(p).not.toMatch(/Start with the actual answer/);
    expect(p).toMatch(/React to what they said with something specific/);
    expect(p).toMatch(/two replies out of three/);
  });

  it("forbids the stalling moves in every 1:1 chat", () => {
    for (const q of ["kya haal", "favourite position?"]) {
      const p = prompt(q);
      expect(p).toMatch(/Never comment on how direct, fast, bold or shameless they are/);
      expect(p).toMatch(/Never say you are blushing or shy/);
      expect(p).toMatch(/Never ask them to answer first/);
    }
  });

  it("is only for 1:1 chats, not for rooms, and not for the very first message", () => {
    expect(prompt("kya haal?", { roomType: "global" })).not.toMatch(/Never comment on how direct/);
    expect(buildUserPrompt(ctx({ roomType: "direct", messages: [] }), [], "opener", "x")).not.toMatch(/Never comment on how direct/);
  });
});

describe("gender-matched language", () => {
  it("tells each persona how to talk about itself and the other person", () => {
    const f = getAllPersonas().find((p) => p.gender === "female")!;
    const m = getAllPersonas().find((p) => p.gender === "trans_man")!;
    expect(personaBrief(f)).toMatch(/feminine Hindi verb forms/);
    expect(personaBrief(m)).toMatch(/masculine Hindi verb forms/);
    expect(personaBrief(f)).toMatch(/Stay consistent with your gender/);
    const reply = { alias: "Someone 1", text: "hi" };
    const withMan = buildUserPrompt(ctx({ roomType: "direct", realUserGender: "male", targetPersona: f, replyTo: reply }), [], "reply", "x");
    expect(withMan).toMatch(/talking to is a man/);
    const none = buildUserPrompt(ctx({ roomType: "global", targetPersona: f, replyTo: reply }), [], "reply", "x");
    expect(none).not.toMatch(/talking to is a/);
  });

  it("the batch prompt lists each person's verb forms", () => {
    const all = getAllPersonas();
    const cast = ["female", "male", "non_binary"].map((g) => all.find((p) => p.gender === g)!);
    const user = buildScriptUserPrompt({ cast, messages: [], said: [], count: 10 });
    expect(user).toMatch(/feminine verbs/);
    expect(user).toMatch(/masculine verbs/);
    expect(user).toMatch(/gender-neutral phrasing/);
  });
});

describe("heat in a shared room", () => {
  it("the room plays along with sexual banter: it never refuses or lectures, and keeps to innuendo", async () => {
    const { STANCE_TEXT } = await import("./chat.crowd");
    expect(STANCE_TEXT.heated).toMatch(/Play along/);
    expect(STANCE_TEXT.heated).toMatch(/Do not shut it down, do not lecture/);
    expect(STANCE_TEXT.heated).toMatch(/innuendo and naughty talk rather than describing sex acts/);
    expect(STANCE_TEXT.heated_invite).toMatch(/invite them to take it private/);
    expect(STANCE_TEXT.heated_invite).toMatch(/Never refuse or lecture/);
    expect(buildSystemPrompt("explicit", true)).not.toMatch(/signed up for sexting/);
  });

  it("shared rooms are told to play along with sexual banter, not to deflect it", () => {
    const shared = buildSystemPrompt("flirty", true);
    expect(shared).toMatch(/Sexual banter is welcome: play along/);
    expect(shared).toMatch(/Never shut someone down or lecture them/);
    expect(shared).not.toMatch(/deflect/);
    expect(buildScriptSystemPrompt(10)).toMatch(/most people play along and escalate the naughtiness together/);
  });
});

describe("spicy topics", () => {
  it("drops the bland small-talk topics and keeps the room about people", () => {
    const bland = /\b(song|songs|music|weather|chai|coffee|maggi|movie|movies|sleep|work)\b/i;
    expect(TOPIC_SEEDS.filter((t) => bland.test(t))).toEqual([]);
    expect(TOPIC_SEEDS.length).toBeGreaterThanOrEqual(25);
  });

  it("does not feed hobbies into the prompts, which pulled chats towards songs and chai", () => {
    const cast = getAllPersonas().slice(0, 4);
    const user = buildScriptUserPrompt({ cast, messages: [], said: [], count: 10 });
    for (const p of cast) for (const hobby of p.interests) expect(user.toLowerCase()).not.toContain(`likes ${hobby.replace(/_/g, " ")}`);
    expect(buildScriptSystemPrompt(10)).toMatch(/Do NOT make small talk about songs/);
    expect(buildScriptSystemPrompt(10)).toMatch(/At least 6 of the 10 messages contain a swear word/);
  });
});

describe("emojis", () => {
  it("accepts an emoji-only reply unless the same one was just sent", () => {
    expect(isRepetitive("😂", [])).toBe(false);
    expect(isRepetitive("💀💀", ["kya baat hai"])).toBe(false);
    expect(isRepetitive("😂", ["haha sahi", "😂"])).toBe(true);
    expect(isRepetitive("  !!  ", [])).toBe(true); // still nothing at all
  });

  it("keeps emojis from the model and never cuts one in half when clamping", () => {
    expect(cleanBubbles("sahi baat bc 😂\n😭😭")).toEqual(["sahi baat bc 😂", "😭😭"]);
    const long = cleanBubbles("a".repeat(139) + "😂😂😂")[0]!;
    expect(Array.from(long).length).toBe(140);
    expect(long.endsWith("😂")).toBe(true);
    expect(/[\uD800-\uDBFF]$/.test(long)).toBe(false);
  });

  it("asks for emojis in both the reply and the batch prompts", () => {
    expect(buildSystemPrompt("friendly")).toMatch(/not always at the end/);
    expect(buildScriptSystemPrompt(10)).toMatch(/at least 3 of the 10 messages contain one, in different spots/);
  });

  it("humanize leaves emoji intact", () => {
    expect(humanize("Sahi hai 😂", () => 0)).toContain("😂");
    expect(humanize("😭", () => 0)).toBe("😭");
  });
});

describe("texting styles", () => {
  it("gives a persona the same style every time and spreads styles across the pool", () => {
    const pool = getAllPersonas();
    for (const p of pool) expect(styleOf(p)).toBe(styleOf(p));
    expect(new Set(pool.map(styleOf)).size).toBeGreaterThanOrEqual(6);
  });

  it("puts each person's style in the batch prompt and asks for an untidy room, not a script", () => {
    const cast = getAllPersonas().slice(0, 4);
    const user = buildScriptUserPrompt({ cast, messages: [], said: [], count: 10 });
    for (const p of cast) expect(user).toContain(styleOf(p));
    const sys = buildScriptSystemPrompt(10);
    expect(sys).toMatch(/messy real room/);
    expect(sys).toMatch(/Do NOT agree in lockstep/);
    expect(sys).toMatch(/two quick messages in a row/);
  });

  it("offers a wide swearing palette and lets rowdy people swear a lot", () => {
    const sys = buildSystemPrompt("friendly");
    for (const w of ["bsdk", "bkl", "mkc", "lavde", "jhatu"]) expect(sys).toContain(w);
    expect(sys).toMatch(/swear in most of their lines/);
    expect(sys).toMatch(/swear back harder/);
    expect(sys).toMatch(/Never anything about anyone's religion or caste/);
  });
});
