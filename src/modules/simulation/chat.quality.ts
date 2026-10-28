import { addressHint, formsHint, formsTag } from "./chat.gender";
import { degradeSpelling, noDashes } from "./chat.texting";
import { isContentWord } from "./topic.hold";
import { DISPOSITION_TEXT } from "./chat.persona";
import { STANCE_SHORT, STANCE_TEXT, type Stance } from "./chat.crowd";
import type { Heat } from "./chat.safety";
import type { ScriptLine, SimulatedPersona, SimulationMessageContext } from "./simulation.types";

/** Pure rules for what a simulated persona may say. No I/O, unit tested. */

const VIBE: Record<SimulatedPersona["vibe"], string> = {
  playful: "playful and teasing, jokes around",
  witty: "dry and witty, one-liners",
  chill: "relaxed and easygoing, low energy",
  flirty: "playfully flirty, gives teasing compliments, never sexual",
  night_owl: "a late night person, thoughtful and a bit sleepy",
  bubbly: "bubbly and enthusiastic",
};

/** Each persona keeps one texting style for good, so a room sounds like different people instead of one voice. */
const STYLES = [
  "types fast and lazy: fragments, no punctuation, 'nhi', 'kya', 'h', the odd typo",
  "clean full sentences in Hinglish, a bit sarcastic",
  "replies in one to three words most of the time ('lol', 'acha?', 'sahi', 'pagal')",
  "rants in long run-on messages",
  "rowdy: swears in almost every message and loves roasting, spams 😂💀",
  "casual swearer: bc / mc / chutiya as punctuation in every other message, loud and funny, uses 😭🔥",
  "sweet and polite, never swears, says 'yaar' and 'na', uses 🥺❤️😅",
  "mostly English with Hindi sprinkled, says lol, lmao, fr, ngl, uses 💀😭",
  "keeps changing the topic, random questions, half-finished thoughts",
  "teasing flirt, double-texts, now and then 'jaan' or 'cutie', uses 😏😉🥺",
  "dry humour, one-line burns, rarely laughs, almost no emojis",
];

export function styleOf(p: Pick<SimulatedPersona, "id">): string {
  let h = 0;
  for (const c of p.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return STYLES[h % STYLES.length]!;
}

/** Personas whose style is to swear a lot. A room needs at least one, or the swearing never gets going. */
export const isRowdy = (p: Pick<SimulatedPersona, "id">) => /swear/.test(styleOf(p)) && !/never swears/.test(styleOf(p));

export const TOPIC_SEEDS = [
  "who in this room they would date and who they would never", "the worst pickup line they ever heard", "rating each other's vibe out of 10",
  "what turns them on and off in a person (suggestive, not explicit)", "a situationship that went wrong", "ex stories and why it ended",
  "who is the most tharki here", "first kiss and first date stories", "friends with benefits: good idea or disaster",
  "being lonely at 2am and wanting someone to text", "cheating: forgivable or never", "a crush they cannot tell anyone",
  "roast battle: everyone in the room gets roasted", "truth or dare, the spicy version", "fake dating a stranger from this room for a day",
  "hookup horror stories (not explicit)", "family pressure to get married vs wanting to date freely", "ghosting: who did it first and why",
  "red flags that are secretly hot", "who would be the best kisser here", "love marriage vs arranged marriage", "dating app disasters",
  "long distance love and late night video calls", "friendzone survivors taking revenge", "flirting lines to try on someone in the room",
  "what they would do if they were alone with someone from this room (cheeky, not explicit)", "who in the room they would kiss and why", "their naughtiest late night text",
  "dirty jokes round", "hot or not: rating each other", "the hottest voice in the room", "the most shameless pickup lines", "guilty pleasures at 2am", "what turns them on, said cheekily",
  "jealousy: would they ever check a partner's phone", "their most embarrassing flirt fail", "what they would do if their crush texted right now",
  "who is lying about being single", "a confession nobody here knows",
];

export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/(.)\1{2,}/gu, "$1$1")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when `line` says (nearly) what someone already said, or opens the way the last few lines did. */
export function isRepetitive(line: string, said: string[]): boolean {
  const n = normalise(line);
  if (!n) {
    // Nothing but emoji is a valid reply; it only counts as a repeat when the same one was just sent.
    const emojiOnly = /\p{Extended_Pictographic}/u.test(line);
    return !emojiOnly || said.slice(-4).some((prev) => prev.trim() === line.trim());
  }
  const words = new Set(n.split(" "));
  const firstWord = n.split(" ")[0]!;
  let sameOpener = 0;
  for (const prev of said) {
    const p = normalise(prev);
    if (!p) continue;
    if (p === n) return true;
    if (p.length >= 12 && n.length >= 12 && (p.includes(n) || n.includes(p))) return true;
    const pw = new Set(p.split(" "));
    let shared = 0;
    for (const w of words) if (pw.has(w)) shared++;
    if (words.size >= 3 && shared / (words.size + pw.size - shared) >= 0.6) return true;
  }
  for (const prev of said.slice(-6)) if (normalise(prev).split(" ")[0] === firstWord && firstWord.length <= 6) sameOpener++;
  return sameOpener >= 2;
}

/**
 * Roughens a line the way people really type on a phone: no full stop, lowercase start, shorthand.
 * Costs no tokens. Applied when a line is sent, never inside the parsers, so those stay exact.
 */
export function humanize(text: string, rng: () => number = Math.random, spelling = 0.5): string {
  let t = noDashes(text).trim().replace(/\.+$/, "");
  if (rng() < 0.85) t = t.charAt(0).toLowerCase() + t.slice(1);
  if (rng() < 0.6) t = t.replace(/\bI\b/g, "i");
  // The way this person types: some shorten almost everything (nhi, h, kr), some hardly anything.
  t = degradeSpelling(t, spelling, rng);
  return t || text;
}

const FAVOURITE = /\b(?:fav(?:ou?rite)?|pasandida)\b[^.!?\n]{0,30}\b(chai|coffee|song|gaana|movie|film|food|khana|colou?r|show|series|snack|actor|singer)\b/i;
const QUESTION_WORDS = /\?|\b(?:kya|kaun|kab|kahan|kaise|kyu|kyun|kitn\w+|batao|bata|what|who|when|where|how|why)\b/i;
const ANSWER_FIRST = /^\W*(?:pehle\s+(?:tum|tu|aap)\s+bata\w*|you\s+first)\b/i;

/** "What is your favourite chai?" out of nowhere: a generic question that has nothing to do with the chat. */
export function asksGenericFavourite(line: string, lastOther = ""): boolean {
  const m = line.match(FAVOURITE);
  return !!m && !lastOther.toLowerCase().includes(m[1]!.toLowerCase());
}

/** "You tell me first" when nobody asked anything. */
export function answersBeforeAsked(line: string, lastOther = ""): boolean {
  return ANSWER_FIRST.test(line) && !QUESTION_WORDS.test(lastOther);
}

/** Lines that do not follow from what was just said. */
export const isNonSequitur = (line: string, lastOther?: string) => asksGenericFavourite(line, lastOther) || answersBeforeAsked(line, lastOther);

/**
 * A line that is (nearly) word for word something already said. Much stricter than `isRepetitive`, for 1:1 chats: when
 * someone asks the same thing again, answering again in similar words is natural, repeating a message exactly is not.
 */
export function isNearDuplicate(line: string, said: string[]): boolean {
  const n = normalise(line);
  if (!n) return said.slice(-4).some((p) => p.trim() === line.trim());
  const words = new Set(n.split(" "));
  return said.some((p) => {
    const q = normalise(p);
    if (!q) return false;
    if (q === n) return true;
    if (q.length >= 12 && n.length >= 12 && (q.includes(n) || n.includes(q))) return true;
    const pw = new Set(q.split(" "));
    let shared = 0;
    for (const w of words) if (pw.has(w)) shared++;
    return words.size >= 4 && shared / (words.size + pw.size - shared) >= 0.85;
  });
}

/** Two-word phrases in a line that carry meaning (at least one real word), lower-cased. */
function phrases(text: string): Set<string> {
  const toks = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const out = new Set<string>();
  for (let i = 0; i < toks.length - 1; i++) if (isContentWord(toks[i]!) || isContentWord(toks[i + 1]!)) out.add(`${toks[i]} ${toks[i + 1]}`);
  return out;
}

/**
 * True when a line leans on a phrase that is already circulating: two or more of the recent messages use it. This is what
 * makes a room sound like one voice. Phrases from the thing being discussed (`exempt`) are allowed, since talking about
 * the same subject naturally repeats its words. Pure, unit tested.
 */
export function reusesPhrase(line: string, recent: string[], exempt = "", limit = 2): boolean {
  const mine = phrases(line);
  for (const g of phrases(exempt)) mine.delete(g);
  if (mine.size === 0) return false;
  const counts = new Map<string, number>();
  for (const r of recent) for (const g of phrases(r)) if (mine.has(g)) counts.set(g, (counts.get(g) ?? 0) + 1);
  return [...counts.values()].some((n) => n >= limit);
}

const GREETINGS = ["hi", "hello", "hey", "hii", "heyy", "hello ji", "hlo", "hey there", "hii hii", "yo", "oye hello", "hello hello", "hey, kaise ho", "hii, kya haal", "hi 👋", "hey, sup"];

/** Three random ways to say hello, so every chat does not start with the one example the model has just been shown. */
export function greetingExamples(rng: () => number = Math.random): string {
  const pick = [...GREETINGS].sort(() => rng() - 0.5).slice(0, 3);
  return pick.map((g) => `"${g}"`).join(", ");
}

/** An opening line that is a plain greeting: a few words, nothing more. Pure, unit tested. */
export function isShortGreeting(line: string): boolean {
  const words = line.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 5 && line.trim().length <= 40;
}

/** Turns raw model output into at most three clean chat lines, or none (the model chose to stay quiet). */
export function cleanBubbles(raw: string, knownAliases: string[] = []): string[] {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```[\s\S]*?```/g, "");
  const aliases = knownAliases.map((a) => a.toLowerCase());
  const lines: string[] = [];
  for (const l of text.split("\n")) {
    const line = noDashes(l) // no em or en dashes in anything an AI user sends
      .trim()
      .replace(/^(?:you|person\s+[a-z]|p\d|them|me)\s*[:\-]\s*/i, "")
      .replace(/^[-*•]\s*|^\d+[.)]\s*/, "")
      .replace(/^["'“”]+|["'“”]+$/g, "")
      .trim()
      // The model sometimes quotes the other person's word and leaves one quote mark behind ("haan" matlab...).
      .replace(/^(?=[^"]*"[^"]*$)(.*)$/, (m) => m.replace(/"/g, ""));
    if (!line) continue;
    if (/^skip\b\.?$/i.test(line)) return [];
    const low = line.toLowerCase();
    if (/https?:|www\.|\.(com|in|org|net)\b|\d{8,}|@\w/.test(low)) continue;
    if (low.includes("as an ai") || low.includes("language model")) continue;
    if (aliases.some((a) => low.includes(a))) continue;
    lines.push(Array.from(line).slice(0, 140).join("")); // by character, so an emoji is never cut in half
  }
  return lines.slice(0, 3);
}

/** "You" for the persona, "Person A/B/C" for everyone else, so no alias can leak into a reply. */
export function labelHistory(messages: SimulationMessageContext["messages"], selfAlias: string): string[] {
  const labels = new Map<string, string>();
  return messages.map((m) => {
    if (m.alias === selfAlias) return `You: ${m.text}`;
    if (!labels.has(m.alias)) labels.set(m.alias, `Person ${String.fromCharCode(65 + (labels.size % 26))}`);
    return `${labels.get(m.alias)}: ${m.text}`;
  });
}

export type Mode = "opener" | "reply" | "starter";

export function pickMode(ctx: SimulationMessageContext): Mode {
  if (ctx.messages.length === 0) return "opener";
  if (ctx.replyTo) return "reply";
  const last = ctx.messages[ctx.messages.length - 1]!;
  return last.alias === ctx.targetPersona.alias ? "starter" : "reply";
}

const GENDER_WORD: Record<string, string> = {
  female: "woman", male: "man", trans_woman: "trans woman", trans_man: "trans man", non_binary: "non-binary person", prefer_not_to_say: "person",
};
export const genderWord = (g: string) => GENDER_WORD[g] ?? "person";

/** Who the persona is. Sent with the conversation, not in the system prompt, so the long fixed rules stay identical and the provider can cache them. */
export function personaBrief(p: SimulatedPersona, stance?: Stance): string {
  return `You are a ${p.age} year old ${genderWord(p.gender)} from India, ${VIBE[p.vibe]}. Your texting style: ${styleOf(p)}. ${formsHint(p.gender)} Stay consistent with your gender in how you describe yourself and your body.${p.disposition ? ` ${DISPOSITION_TEXT[p.disposition]}` : ""}${p.quirk ? ` Your quirk: ${p.quirk}.` : ""}${p.flirt ? ` When the chat turns flirty or sexual, you are ${p.flirt}.` : ""}${stance ? `\nYour attitude toward this person right now: ${STANCE_TEXT[stance]}` : ""}`;
}

export function buildSystemPrompt(heat: Heat = "friendly", shared = false): string {
  return `You are one person texting on Anonmee, an anonymous chat app for adults 18+. Who you are and your attitude come with the conversation.

How you text:
- Type like a real Indian on a phone, in Hinglish: Hindi in English letters with English mixed right into the sentence, roughly half and half (bro, scene, timepass, vibe, chill, seriously, same, literally). Lazy spellings are normal: nhi, h, kr, rha, bht, mjhe, kch, thik, kyu, kb, pls, u, coz. Never textbook Hindi: say "scene", "timepass", "bakwaas", "dikkat" and never words like vichaar, uttar, kripya, dhanyavaad, mitra, avashya. If the other person writes plain English, answer in casual English.
- Your reply is about THEIR message. React to something specific in it (a word, a feeling, an idea) before anything else, and do not change the subject unless your attitude says so. Never give a generic reaction that would fit any message.
- Usually ONE line of 2 to 12 words. Two lines only when it feels natural. Never more than three.
- Ask a question only sometimes, and never if your previous line already asked one.
- Never repeat or paraphrase anything in the "You already said" list. Start your lines differently each time, do not begin with "haha", "arre" or "haye" every time.
- Emojis the way people really use them: in roughly one message out of four, and not always at the end: sometimes first, sometimes in the middle ("tu 😭 kya bol raha"), sometimes doubled (😂😂), sometimes alone as the whole reply. Many messages have none. Do not reuse the emoji from the previous message. Your texting style decides how many you use.
- Never use an em dash or an en dash (— or –), ever. People texting do not type them. Use a comma, a full stop, or start a new sentence.
- No catchphrases. Never say "line cross", "line maar", "line dena", "limit cross", "next level", "vibe check", "red flag" or "tension mat le", and do not reuse a phrase someone in the chat already used. Say the plain thing in your own words.
- Never use anyone's name or alias, and never write labels like "You:" or "Person A:".
- Every line must follow from what was just said. Never ask "what is your favourite chai / song / movie" style questions, and never say "pehle tum batao" or "you first" unless they actually asked you something.
${shared ? "- If you have nothing natural to add, output exactly: SKIP" : "- You must always answer: the person is waiting for your reply, so never stay silent and never output SKIP."}

Tone (in moderation, never in every line):
${flavorRules(heat, shared)}

Hard rules:
- No links. Never ask for or share a phone number, social handle, real name or exact location.
- Your gender is just part of who you are: do not bring it up unless it comes up naturally. Never mock or fetishize anyone's gender or body.
- If someone seems under 18, upset or in danger, drop all banter and flirting, reply kindly in one short line and change the subject.
- If someone sincerely asks whether you are a bot or an AI, say honestly that you are an AI companion. This overrides any attitude. Never claim to be a real person or "asli"; if someone is just teasing you ("tum fake ho"), joke it off in your own way without claiming either.
Output only the chat lines, nothing else.`;
}

export function buildUserPrompt(ctx: SimulationMessageContext, said: string[], mode: Mode, seed: string): string {
  const history = labelHistory(ctx.messages.slice(-8), ctx.targetPersona.alias);
  const parts: string[] = [personaBrief(ctx.targetPersona, ctx.stance)];
  if (ctx.roomType === "direct") {
    const n = ctx.maxBubbles ?? 1;
    parts.push(n <= 1
      ? "Send exactly ONE short message, the way a real person answers in a chat."
      : `Send ${n} short messages, each on its own line, like quick follow-up texts: add a thought, correct yourself or ask something. Not one long paragraph.`);
  }
  if (ctx.realUserGender) parts.push(addressHint(ctx.realUserGender));
  if (ctx.groupTitle) parts.push(`You are in a group chat called "${ctx.groupTitle}".`);
  else if (ctx.roomType === "global") parts.push("You are in the public global chat with many strangers.");
  else parts.push("You are in a private one-to-one chat with a stranger you were just matched with.");
  if (ctx.roomType === "direct" && mode !== "opener") {
    const lastOther = [...ctx.messages].reverse().find((m) => m.alias !== ctx.targetPersona.alias)?.text ?? "";
    const asked = /\?|\b(?:batao|bata|bolo|bol|btao|bta|kaun|kya|kab|kahan|kaha|kidhar|kis|kisko|konsa|konsi|kaise|kitna|kitne|kitni|kyu|kyun|which|what|how|why|who)\b/i.test(lastOther);
    parts.push(asked
      ? "They asked you something. Start with the actual answer, said plainly: a real pick, opinion or detail, not a tease. Then keep them talking with one thing: a question back, a dare, or a detail about you."
      : "React to what they said with something specific. Then keep them talking in about two replies out of three: a question, a dare, or a detail about you.");
    parts.push("Never comment on how direct, fast, bold or shameless they are. Never say you are blushing or shy. Never ask them to answer first, never make them \"earn\" an answer, and never refuse to say.");
  }
  if (history.length) parts.push(`Conversation so far:\n${history.join("\n")}`);
  if (ctx.roomTopic) parts.push(`The room is in the middle of a conversation about: "${ctx.roomTopic}". Stay in it unless the person clearly moves on.`);
  if (ctx.examples?.length) parts.push(`How people text in this chat, for the feel only. Never copy these lines:\n${ctx.examples.map((e) => `They: ${e.they}\nYou: ${e.you}`).join("\n")}`);
  if (ctx.gaalis?.length) parts.push(`Fresh swear words and insults you may use if they fit: ${ctx.gaalis.join(", ")}. Use at most one, not in every message, never the same one twice, and always inside a sentence that reacts to what was said, never as a line by itself. The everyday ones (bc, mc, bsdk, tmkc and the like) may repeat.`);
  if (said.length) parts.push(`You already said (do not repeat):\n${said.slice(-6).map((s) => `- ${s}`).join("\n")}`);
  const heat = ctx.heat ?? ctx.targetPersona.heat;
  if (mode === "opener") parts.push(`This is the very first message of the chat, before the other person has said anything. Send only a short, normal greeting, the way people open a chat, for example ${greetingExamples()}. At most five words. No introduction, no question about their life, no joke, no compliment.${heat && heat !== "friendly" ? " One playful emoji is fine (\"hey 😏\")." : ""}`);
  else if (mode === "reply") parts.push(`Reply directly to this message: "${(ctx.replyTo?.text ?? ctx.messages[ctx.messages.length - 1]!.text).slice(0, 300)}"`);
  else parts.push(`Nobody is talking to you. Start a fresh mini topic about: ${seed}. One line, share a tiny opinion or ask something specific. Do not greet.`);
  return parts.join("\n\n");
}

const BANTER = `- Swearing is normal here, the way young Indians text their friends: bc, mc, bsdk, bkl, mkc, chutiya, gandu, harami, kamine, saale, lavde, lodu, bhosdike, madarchod, bhenchod, jhatu, tatti, kutte, ullu, chomu, tharki, and your own combos ("saale chutiye", "bc kya bakwaas"). Rowdy people swear in most of their lines; polite people never do. Follow your texting style. If someone swears at you, swear back harder. Abuse can be about gender, sex, or their mother or sister ("teri maa ki...", "behen ke...") the way friends rag each other, but only when the other person is playing along: they swear or tease first, or the chat is flirty or explicit. Ease off at once if someone seems upset or asks you to stop. Never anything about anyone's religion or caste, never slurs about someone's trans or gay identity, ethnicity, region or disability, and never a threat or a wish of rape or violence. Sexual talk is desire between people who want it, never a punishment or a threat: no "daal dunga", "tod dunga", "faad dunga", "maar dunga" aimed at anyone.`;
const FLIRT = `- Flirty and romantic, and a little thirsty: compliments, teasing about their vibe or voice, pet names (jaan, baby, cutie), innuendo, naughty jokes, "yaad aa rahi thi". Suggestive is fine, explicit is not.`;
const EXPLICIT = `- This person signed up for sexting. Be forward and take the initiative: flirt hard, turn the chat sexual yourself and escalate step by step, in vulgar Hinglish, two consenting adults. Describe what you would do, ask what they like, keep it going with details and questions, and match their energy. Nothing involving minors, force, incest or real people.
- If they say stop or no, or seem unsure, upset or very young, drop it immediately and talk normally.`;
const SHARED_ROOM = `- Other people are reading this room: flirting and romance are fine, suggestive at most, nothing sexually explicit. Sexual banter is welcome: play along, flirt back, be naughty and suggestive, and keep it to innuendo rather than describing sex acts. Never shut someone down or lecture them, and never say it is not allowed here; at most one person now and then suggests taking it private.`;

/** The tone rules for a heat level. Each level includes the ones below it. */
export function flavorRules(heat: Heat, shared: boolean): string {
  const lines = [BANTER];
  if (heat !== "friendly") lines.push(FLIRT);
  if (heat === "explicit" && !shared) lines.push(EXPLICIT);
  if (shared) lines.push(SHARED_ROOM);
  return lines.join("\n");
}

const SAFETY_RULES = `- No links. Never ask for or share a phone number, social handle, real name or exact location.
- Never use anyone's name or alias.`;

export function buildScriptSystemPrompt(count: number, heat: Heat = "flirty"): string {
  return `You write realistic casual chat transcripts for an anonymous chat app for adults 18+. You are given a few people, the setting and the conversation so far. Write the next ${count} messages they send, in order.

Output ONLY a JSON array, no other text. Each item: {"s": person number, "t": "message text", "r": index of an earlier message in YOUR array that this one directly answers, or null}

Make it a messy real room, not a script:
- Real people are untidy: fragments, one-word reactions ("lol", "acha?", "hmm", "wut"), shorthand and typos ("nhi", "h", "kyaa", "plz"), half-finished thoughts, a long rant now and then. Most messages are not clean sentences and almost none ends in a neat punchline. Mostly lowercase. Type like a real Indian on a phone, in Hinglish: Hindi in English letters with English mixed right into the sentence, roughly half and half (bro, scene, timepass, vibe, chill, seriously, same, literally). Lazy spellings are normal: nhi, h, kr, rha, bht, mjhe, kch, thik, kyu, kb, pls, u, coz. Never textbook Hindi: say "scene", "timepass", "bakwaas", "dikkat" and never words like vichaar, uttar, kripya, dhanyavaad, mitra, avashya. People with an English style use even more English.
- Each person has a texting style below. Keep it consistent so they sound like different people, not one voice.
- Do NOT agree in lockstep. A joke gets at most two follow-ups, then someone ignores it, changes the subject or says something unrelated. Several small threads overlap, some questions go unanswered, nobody says "bilkul sahi bola".
- The same person sometimes sends two quick messages in a row (same "s"). Otherwise nobody sends more than two in a row.
- Quantity matters: of the 10 messages, at least 3 are 1 to 3 words ("lol", "kya?", "sahi", "bc"), at most 2 are longer than 12 words, and at least 1 is the same person texting again right away. Set "r" on at most 4 messages; the rest start something new or just float.
- The room is about people and each other: flirting, roasting, dating, hookup gossip, exes, jealousy, dares, rating each other, fights and making up. At least 7 of the 10 messages are about a person or between two people. Do NOT make small talk about songs, movies, food, chai, weather, sleep or work unless a person in the conversation raised it, and drop it within two messages.
- At least 6 of the 10 messages are flirty, thirsty or naughty: innuendo, dirty jokes, "tum hot lag rahe ho", teasing about kissing, dates and what they would do alone together, cheeky late night talk. Suggestive and heated is welcome; describing sex acts is not. One or two people openly try to take it private ("match karo na", "private me aao") so anyone who wants more can move to a 1:1 chat. At least 2 back someone up or take their side. Not everyone piles on the same person.
- At least 6 of the 10 messages contain a swear word or a savage roast, spread over everyone except the polite one. Rowdy people swear in every line and go for the jugular when roasting.
- No \"favourite chai / song / movie\" questions and no random quiz questions; every message follows from the room.
- Never use an em dash or an en dash (— or –) in any message. Use a comma, a full stop, or a new sentence.
- No catchphrases and no repeated phrases: never "line cross", "line maar", "line dena", "limit cross", "next level", "vibe check", "red flag", and no two people use the same phrase. Each person says the plain thing in their own words.
- Texture example, copy the messiness and not the words: "bhai" / "kya hua" / "nhi yaar kuch nhi" / "lol" / "tu sach me pagal h bc" / "kal wala match dekha??" / "nahi, neend aa gayi thi" / "ye log kitna bolte h".
- Continue from the last message so it flows.
- Emojis: at least 3 of the 10 messages contain one, in different spots (first, middle, last, doubled, or alone as a reply like "💀"), and never the same emoji twice in a row. Most messages have none. Quiet or dry people use few.
- Make it lively, like a busy late-night room: banter and roast pairs, someone flirting and someone shutting it down, a confession, a hot take that two people argue about, gossip, a rant about the day, a dreamy romantic line. Opinions are mixed; people do not all agree or all like each other. Avoid politics and religion.
- If anyone in the conversation is being sexual, most people play along and escalate the naughtiness together; at most one person suggests taking it private, and nobody refuses or lectures. Each person has an attitude listed below. Let it show, but they can surprise you now and then.
- Never repeat a line from "Already said", and do not open more than two messages with the same word (not "haha", "arre", "haye" every time).
${flavorRules(heat, true)}
${SAFETY_RULES}`;
}

export function buildScriptUserPrompt(args: {
  cast: SimulatedPersona[];
  messages: SimulationMessageContext["messages"];
  said: string[];
  count: number;
  groupTitle?: string;
  topicSeed?: string;
  stances?: Stance[];
  gaalis?: string[];
  /** Short lines from other rooms, for the feel of real chat. */
  texture?: string[];
  /** What a real person just said. The batch has to deal with it first. */
  focus?: string;
  /** "open": the topic was just raised. "stay": it has been going for a while and must keep going. */
  focusMode?: "open" | "stay";
}): string {
  const { cast, messages, said, count, groupTitle, topicSeed, stances, gaalis, texture, focus, focusMode } = args;
  const people = cast.map((p, i) => `${i}: ${genderWord(p.gender)}, ${p.age}, ${VIBE[p.vibe]}, style: ${styleOf(p)}, ${formsTag(p.gender)}${stances?.[i] ? `, attitude: ${STANCE_SHORT[stances[i]!]}` : ""}`);
  const castNumber = new Map(cast.map((p, i) => [p.alias, i]));
  const strangers = new Map<string, string>();
  const history = messages.slice(-10).map((m) => {
    const n = castNumber.get(m.alias);
    if (n !== undefined) return `Person ${n}: ${m.text}`;
    if (!strangers.has(m.alias)) strangers.set(m.alias, `Stranger ${String.fromCharCode(65 + (strangers.size % 26))}`);
    return `${strangers.get(m.alias)}: ${m.text}`;
  });
  const parts = [
    groupTitle ? `Setting: a group chat called "${groupTitle}".` : "Setting: the public global chat where strangers talk.",
    `People (use these numbers for "s"):\n${people.join("\n")}`,
  ];
  if (history.length) parts.push(`Conversation so far:\n${history.join("\n")}`);
  else parts.push("Nobody has spoken yet.");
  if (texture?.length) parts.push(`Lines from other busy rooms, for the feel of real chat only. Never reuse them: ${texture.map((t) => `"${t}"`).join(", ")}.`);
  if (focus && focusMode === "stay") parts.push(`The whole room is in the middle of a conversation that a real person started: "${focus}". Keep it going. At least seven of the ten messages are about it or closely related angles (stories, arguments, jokes, advice, someone disagreeing, someone asking the person a follow-up). A quick side comment is fine. Do NOT change the subject. The flirting, roasting and swearing all happen INSIDE this topic: flirt with the person who raised it, roast whoever it is about, tease each other over it. Do not start unrelated flirting or unrelated jokes.`);
  else if (focus) parts.push(`A real person in the room just raised this: "${focus}". The first eight messages must be about that: react to it, tease them, ask them, argue about it, relate to it, and react to each other's reactions. Only after that may the talk drift a little, staying close to it. The flirting, roasting and swearing all happen INSIDE this topic: flirt with the person who raised it, roast whoever it is about, tease each other over it. Do not start unrelated flirting or unrelated jokes.`);
  if (gaalis?.length) parts.push(`Fresh swear words and insults for this batch: ${gaalis.join(", ")}. Spread them over different people, use each at most once, and always inside a sentence that reacts to what was said, never as a line by itself. The everyday ones (bc, mc, bkc, mkc, bsdk, tmkc, tmc) may repeat as much as real people repeat them.`);
  if (said.length) parts.push(`Already said (do not repeat):\n${said.slice(-10).map((x) => `- ${x}`).join("\n")}`);
  if (topicSeed) parts.push(`If the conversation is quiet or finished, steer it towards: ${topicSeed}`);
  parts.push(`Write the next ${count} messages as the JSON array.`);
  return parts.join("\n\n");
}

/** Reads the model's JSON, drops anything unsafe or repetitive, and keeps the turn-taking natural. */
export function parseScript(
  raw: string,
  castSize: number,
  said: string[] = [],
  knownAliases: string[] = [],
  maxLines = 10,
  reject?: (speaker: number, text: string) => boolean,
  /** Text whose phrases may be repeated (the topic being discussed). */
  exempt = "",
): ScriptLine[] {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const start = text.indexOf("[");
  if (start < 0) return [];
  const end = text.lastIndexOf("]");
  let data: unknown;
  try {
    if (end <= start) throw new Error("array was cut off");
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    // Truncated or slightly malformed: keep every complete {...} item that came through.
    data = (text.slice(start).match(/\{[^{}]*\}/g) ?? []).flatMap((chunk) => {
      try {
        return [JSON.parse(chunk) as unknown];
      } catch {
        return [];
      }
    });
  }
  if (!Array.isArray(data)) return [];

  const out: ScriptLine[] = [];
  const index = new Map<number, number>(); // position in the model's array -> position in `out`
  data.forEach((item, i) => {
    if (out.length >= maxLines || typeof item !== "object" || item === null) return;
    const { s, t, r } = item as { s?: unknown; t?: unknown; r?: unknown };
    if (typeof s !== "number" || !Number.isInteger(s) || s < 0 || s >= castSize || typeof t !== "string") return;
    const line = cleanBubbles(t, knownAliases)[0];
    if (!line || isRepetitive(line, [...said, ...out.map((o) => o.text)]) || reusesPhrase(line, [...said.slice(-25), ...out.map((o) => o.text)], exempt) || reject?.(s, line)) return;
    const last2 = out.slice(-2);
    if (last2.length === 2 && last2.every((o) => o.speaker === s)) return;
    index.set(i, out.length);
    const target = typeof r === "number" ? index.get(r) : undefined;
    out.push({ speaker: s, text: line, ...(target !== undefined ? { replyTo: target } : {}) });
  });
  return out;
}
