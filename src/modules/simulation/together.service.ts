import Together from "together-ai";
import { env } from "../../config/env";
import { buildScriptSystemPrompt, buildScriptUserPrompt, buildSystemPrompt, buildUserPrompt, cleanBubbles, humanize, isNonSequitur, asksGenericFavourite, reusesPhrase, isShortGreeting, isNearDuplicate, isRepetitive, parseScript, pickMode, styleOf, TOPIC_SEEDS } from "./chat.quality";
import type { Stance } from "./chat.crowd";
import { emojisIn, mixEmoji } from "./chat.emoji";
import { formsMismatch } from "./chat.gender";
import { capHeat } from "./chat.safety";
import { pickGaalis } from "./gaalis";
import { exampleKindFor, pickExamples, pickTexture } from "./hinglish.examples";
import { isBookish, isCliche, isCoyStall, spellingIntensity } from "./chat.texting";
import { botUsage, type UsageKind } from "./usage.meter";
import type { ScriptLine, SimulatedPersona, SimulationMessageContext } from "./simulation.types";

let togetherClient: Together | null = null;

function getClient(): Together | null {
  if (!togetherClient && env.TOGETHER_API_KEY) {
    togetherClient = new Together({ apiKey: env.TOGETHER_API_KEY });
  }
  return togetherClient;
}

interface CompletionParams {
  messages: { role: "system" | "user"; content: string }[];
  max_tokens: number;
  temperature: number;
  top_p: number;
}

/**
 * Chat completion with the model's hidden reasoning switched off. Reasoning models spend most of
 * max_tokens thinking and then return an empty or cut-off answer, which is what used to send canned lines.
 * A model that does not support the switch rejects it, so we retry once without.
 */
async function complete(client: Together, kind: UsageKind, params: CompletionParams) {
  let response;
  try {
    response = await client.chat.completions.create({ model: env.TOGETHER_MODEL, reasoning: { enabled: false }, ...params });
  } catch {
    response = await client.chat.completions.create({ model: env.TOGETHER_MODEL, ...params });
  }
  // Every call is counted so spend can be watched and the daily budget enforced.
  const u = response.usage as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined;
  const used = { prompt: u?.prompt_tokens ?? 0, completion: u?.completion_tokens ?? 0, cached: u?.prompt_tokens_details?.cached_tokens ?? 0 };
  botUsage.record(kind, used);
  totals.calls++;
  totals.prompt += used.prompt;
  totals.completion += used.completion;
  totals.cached += used.cached;
  return response;
}

const MAX_ATTEMPTS = 3; // a retry costs a full call; the third try only happens when the first two were rejected
const MEMORY_LINES = 40;
const MEMORY_ROOMS = 200;

/** What personas already said per room, so a line is never sent twice even when the room history is short. */
const said = new Map<string, string[]>();
const seedsUsed = new Map<string, string[]>();
/**
 * The last lines any AI user sent, in any chat. Per-room memory cannot stop one phrase from becoming the reply in every
 * conversation at once ("seedha point pe" to everyone), so a phrase that has already gone out four times is not used again.
 */
const recentGlobal: string[] = [];
const GLOBAL_MEMORY = 200;
const GLOBAL_LIMIT = 4;
function rememberGlobally(lines: string[]) {
  recentGlobal.push(...lines);
  if (recentGlobal.length > GLOBAL_MEMORY) recentGlobal.splice(0, recentGlobal.length - GLOBAL_MEMORY);
}

/** Rules that are about not repeating ourselves. Everything else (gender, stalling, clichés, dashes) is never relaxed. */
const SOFT_REASONS = new Set(["room-phrase", "everywhere-phrase", "repeats-a-line"]);

/** Calls and tokens spent by this process so far, for comparing models. */
const totals = { calls: 0, prompt: 0, completion: 0, cached: 0 };
export const usageTotals = () => ({ ...totals });

/** How often each rule has thrown a line away. For monitoring and for tuning the rules. */
const rejectionCounts: Record<string, number> = {};
export const generationStats = () => ({ ...rejectionCounts });

/** For tests: forget everything remembered between requests. */
export function resetGeneratorMemory() {
  recentGlobal.length = 0;
  for (const k of Object.keys(rejectionCounts)) delete rejectionCounts[k];
  said.clear();
  seedsUsed.clear();
  gaalisOffered.clear();
}

/** Swear words already offered per room, so the next ten are all new. */
const gaalisOffered = new Map<string, string[]>();

function takeGaalis(roomKey: string): string[] {
  const picked = pickGaalis(gaalisOffered.get(roomKey) ?? []);
  remember(gaalisOffered, roomKey, picked, 400);
  return picked;
}

function remember(store: Map<string, string[]>, key: string, items: string[], cap: number) {
  const list = [...(store.get(key) ?? []), ...items].slice(-cap);
  store.delete(key); // re-insert so the map stays ordered by last use
  store.set(key, list);
  if (store.size > MEMORY_ROOMS) store.delete(store.keys().next().value!);
}

function pickSeed(roomKey: string, wanted?: string): string {
  if (wanted) return wanted;
  const used = seedsUsed.get(roomKey) ?? [];
  const fresh = TOPIC_SEEDS.filter((s) => !used.includes(s));
  const pool = fresh.length ? fresh : TOPIC_SEEDS;
  const seed = pool[Math.floor(Math.random() * pool.length)]!;
  remember(seedsUsed, roomKey, [seed], TOPIC_SEEDS.length - 5);
  return seed;
}

// Used only in one-to-one chats, where staying silent would leave a person waiting. Never in shared rooms.
// Short and plain, the way a chat really starts. Neutral wording, so any AI user can say them.
const DIRECT_OPENERS = [["hii"], ["hello"], ["hey"], ["heyy"], ["hello ji"], ["hi 👋"], ["hii, kaise ho"], ["hey, kaise ho"], ["hello, kya haal"], ["hey there"], ["hii hii"], ["hlo"]];
const FLIRTY_OPENERS = [["hey 😏"], ["hii 😉"], ["hello 😌"], ["heyy 😏"], ["hii 🙈"]];
// Gender-neutral on purpose: these can be said by any AI user.
const DIRECT_ACKS = ["hmm acha", "oh nice", "wait seriously?", "achaa", "okk samajh aaya", "interesting.. aur?", "haan sahi", "hmm", "acha acha", "phir?", "sach me?", "oh", "waise?", "aur batao"];

/** Never empty: a person waiting on a 1:1 reply gets a neutral line even if every one has been used before. */
function directFallback(opener: boolean, avoid: string[], flirty = false): string[] {
  if (opener) {
    const pool = flirty && Math.random() < 0.5 ? FLIRTY_OPENERS : DIRECT_OPENERS;
    return pool[Math.floor(Math.random() * pool.length)]!;
  }
  const fresh = DIRECT_ACKS.filter((a) => !isRepetitive(a, avoid));
  const pool = fresh.length ? fresh : DIRECT_ACKS;
  return [pool[Math.floor(Math.random() * pool.length)]!];
}

/**
 * Returns the chat lines a persona should send, or an empty list when it is better to say nothing
 * (model stayed quiet, kept repeating itself, or failed in a shared room).
 */
export async function generateChatBubbles(context: SimulationMessageContext): Promise<string[]> {
  const persona = context.targetPersona;
  const roomKey = context.roomKey ?? context.roomType;
  const mode = pickMode(context);
  // Shared rooms default to flirty banter; a 1:1 chat starts friendly until the person's sign-up choices say more.
  const heat = capHeat(context.heat ?? persona.heat ?? (context.roomType === "direct" ? "friendly" : "flirty"), context.roomType);
  // Ten fresh swear words go with the request, unless this persona never swears or is warning someone.
  const swears = !/never swears/.test(styleOf(persona)) && !context.stance?.startsWith("warning");
  const examples = pickExamples(exampleKindFor(context.stance, heat), 4);
  const withWords: SimulationMessageContext = { ...context, examples, ...(swears ? { gaalis: takeGaalis(roomKey) } : {}) };
  // In a 1:1 chat only this AI user's own earlier lines count as "already going round". In a room, everyone's do.
  const direct = context.roomType === "direct";
  const recentRoom = [...(said.get(roomKey) ?? []).slice(-25), ...context.messages.slice(-25).filter((m) => !direct || m.alias === persona.alias).map((m) => m.text)];
  const lastOtherText = [...context.messages].reverse().find((m) => m.alias !== persona.alias)?.text;
  // Words the person used (or that the room is on) may be repeated back: answering them naturally echoes them.
  const exemptText = [context.replyTo?.text, context.roomTopic, lastOtherText].filter(Boolean).join(" ");
  const ownLines = context.messages.filter((m) => m.alias === persona.alias).map((m) => m.text);
  const avoid = [...(said.get(roomKey) ?? []), ...ownLines];
  const aliases = [...new Set(context.messages.map((m) => m.alias)), persona.alias];
  // No budget left means no model call at all; 1:1 chats fall back to a neutral line below, shared rooms go quiet.
  /**
   * Why a line may not be sent, or null if it can. Safety and style rules always apply. The "already said" preferences
   * (repeating a phrase) are dropped on the last attempt: a slightly familiar answer is better than "oh nice" to a question.
   */
  const rejected: string[] = [];
  const softOk: string[] = [];
  const rejectReason = (line: string, attempt: number): string | null => {
    const taken = [...avoid, ...rejected];
    if (formsMismatch(line, persona.gender)) return "wrong-gender-forms";
    if (isCoyStall(line)) return "coy-stall";
    if (isCliche(line)) return "cliche";
    if (isBookish(line)) return "bookish";
    if (mode === "opener" && !isShortGreeting(line)) return "long-opener";
    if (isNonSequitur(line, lastOtherText)) return "off-topic";
    if (direct ? isNearDuplicate(line, taken) : isRepetitive(line, taken)) return "repeats-a-line";
    if (attempt < MAX_ATTEMPTS - 1) {
      if (reusesPhrase(line, recentRoom, exemptText)) return "room-phrase";
      if (reusesPhrase(line, recentGlobal, exemptText, GLOBAL_LIMIT)) return "everywhere-phrase";
    }
    return null;
  };
  const client = botUsage.budgetLeft() ? getClient() : null;

  if (client) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const response = await complete(client, context.roomType === "direct" ? "chat" : "reply", {
          messages: [
            { role: "system", content: buildSystemPrompt(heat, context.roomType !== "direct") },
            { role: "user", content: buildUserPrompt(withWords, [...avoid, ...rejected], mode, pickSeed(roomKey, attempt === 0 ? context.topicSeed : undefined)) },
          ],
          max_tokens: 120, // one to three short lines
          temperature: Math.min((mode === "reply" ? 0.72 : 0.88) + attempt * 0.07, 1),
          top_p: 0.92,
        });
        const raw = response.choices?.[0]?.message?.content?.trim() ?? "";
        const lines = cleanBubbles(raw, aliases);
        // In a shared room the model may choose to stay quiet. In a 1:1 chat the person is waiting, so it never may.
        if (raw && lines.length === 0 && /^skip/i.test(raw) && context.roomType !== "direct") return [];
        const kept: string[] = [];
        for (const line of lines) {
          const why = rejectReason(line, attempt);
          if (why) {
            rejectionCounts[why] = (rejectionCounts[why] ?? 0) + 1;
            if (process.env.SIM_DEBUG) console.error(`  [reject ${why}] ${line}`);
            rejected.push(line);
            // A line that only broke a repetition preference, and is not a word-for-word copy, is still a real answer.
            if (SOFT_REASONS.has(why) && !avoid.some((p) => p.trim().toLowerCase() === line.trim().toLowerCase())) softOk.push(line);
          } else kept.push(line);
        }
        if (context.roomType === "direct") kept.splice(context.maxBubbles ?? 1); // usually one message; a caller can ask for a quick second or third text
        if (kept.length) {
          const recentEmoji = emojisIn([...(said.get(roomKey) ?? []).slice(-6), ...context.messages.slice(-4).map((m) => m.text)].join(" "));
          const out: string[] = [];
          for (const l of kept) out.push(mixEmoji(humanize(l, Math.random, spellingIntensity(styleOf(persona))), [...recentEmoji, ...emojisIn(out.join(" "))]));
          remember(said, roomKey, out, MEMORY_LINES);
          rememberGlobally(out);
          return out;
        }
      } catch (error) {
        console.error("Together AI chat completion error:", error);
        break;
      }
    }
  }

  if (context.roomType !== "direct") return [];
  // Every try broke only a repetition preference: a slightly familiar real answer beats "oh nice" to a direct question.
  if (softOk.length) {
    const out = [mixEmoji(humanize(softOk[0]!, Math.random, spellingIntensity(styleOf(persona))), emojisIn(avoid.slice(-6).join(" ")))];
    rejectionCounts["used-despite-repeat"] = (rejectionCounts["used-despite-repeat"] ?? 0) + 1;
    remember(said, roomKey, out, MEMORY_LINES);
    rememberGlobally(out);
    return out;
  }
  const fallback = directFallback(mode === "opener", avoid, heat !== "friendly");
  if (fallback.length) remember(said, roomKey, fallback, MEMORY_LINES);
  return fallback;
}

export interface ScriptRequest {
  cast: SimulatedPersona[];
  messages: SimulationMessageContext["messages"];
  roomKey: string;
  groupTitle?: string;
  topicSeed?: string;
  stances?: Stance[];
  /** What a real person just wrote. The batch deals with it first. */
  focus?: string;
  focusMode?: "open" | "stay";
  count?: number;
}

/**
 * Writes the next `count` messages of a conversation between the cast in ONE model call.
 * Slow (a few seconds), so callers generate the next batch while the current one is still being posted.
 * Returns an empty list on any failure: a room without chatter is better than filler.
 */
export async function generateScript(req: ScriptRequest): Promise<ScriptLine[]> {
  const client = botUsage.budgetLeft() ? getClient() : null;
  if (!client || req.cast.length < 2) return [];
  const count = req.count ?? 10;
  const alreadySaid = [...(said.get(req.roomKey) ?? []), ...req.messages.slice(-10).map((m) => m.text)];
  const aliases = [...new Set([...req.messages.map((m) => m.alias), ...req.cast.map((p) => p.alias)])];

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await complete(client, "script", {
        messages: [
          { role: "system", content: buildScriptSystemPrompt(count) },
          { role: "user", content: buildScriptUserPrompt({ cast: req.cast, messages: req.messages, said: alreadySaid, count, groupTitle: req.groupTitle, topicSeed: req.topicSeed ?? pickSeed(req.roomKey), stances: req.stances, gaalis: takeGaalis(req.roomKey), texture: pickTexture(8), focus: req.focus, focusMode: req.focusMode }) },
        ],
        max_tokens: 700, // 10 short lines of JSON is about 450 tokens
        temperature: 0.9 + attempt * 0.05,
        top_p: 0.92,
      });
      const lines = parseScript(response.choices?.[0]?.message?.content ?? "", req.cast.length, [...alreadySaid], aliases, count, (speaker, text) => formsMismatch(text, req.cast[speaker]!.gender) || asksGenericFavourite(text, req.messages[req.messages.length - 1]?.text) || isBookish(text) || isCliche(text) || isCoyStall(text) || reusesPhrase(text, recentGlobal, "", GLOBAL_LIMIT), [req.focus, req.topicSeed].filter(Boolean).join(" "));
      if (lines.length >= Math.min(4, count)) {
        const used = emojisIn((said.get(req.roomKey) ?? []).slice(-6).join(" ") + " " + req.messages.slice(-4).map((m) => m.text).join(" "));
        const rough: ScriptLine[] = [];
        for (const l of lines) {
          // Look back over the last few lines of this batch too, so the same emoji does not come round again and again.
          const recent = [...used, ...emojisIn(rough.slice(-4).map((r) => r.text).join(" "))];
          rough.push({ ...l, text: mixEmoji(humanize(l.text, Math.random, spellingIntensity(styleOf(req.cast[l.speaker]!))), recent) });
        }
        remember(said, req.roomKey, rough.map((l) => l.text), MEMORY_LINES);
        rememberGlobally(rough.map((l) => l.text));
        return rough;
      }
    } catch (error) {
      console.error("Together AI script generation error:", error);
      return [];
    }
  }
  return [];
}
