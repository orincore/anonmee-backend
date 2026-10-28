import type { Gender } from "../../contracts";
import { chimeInDelayMs, readThinkDelayMs } from "./chat.timing";
import type { SimulatedPersona } from "./simulation.types";

/**
 * Pure planning of how a room reacts: several personas with different attitudes, so a message gets mixed,
 * natural opinions instead of one agreeable reply. No I/O, unit tested.
 */

export type Stance = "warning_first" | "warning_last" | "heated" | "heated_invite" | "support" | "flirty" | "romantic" | "roast" | "cold" | "curious" | "tangent" | "agree";

export const STANCE_TEXT: Record<Stance, string> = {
  warning_first: "They are being rude or pushy and you have had enough. Warn them calmly, in one short line, that you do not like how they are talking and that you will skip this chat if they keep it up. Do not insult them and do not swear at them.",
  warning_last: "This is your last warning. Say clearly, in one short line, that if they do it once more you will skip this chat. Do not insult them and do not swear at them.",
  heated: "They are being sexual and you are into it. Play along: flirt back hard, tease, say cheekily what you would do or want, escalate the naughtiness in your own words, react to exactly what they said. Do not shut it down, do not lecture, do not say it is not allowed here. It is a public room, so keep it to innuendo and naughty talk rather than describing sex acts in detail.",
  heated_invite: "They are being sexual and you are into it. Play along first: flirt back, tease, be naughty about what they said. Then, in the same message, invite them to take it private (\"match kr le na\", \"private me aa, wahan khul ke baat krte h\") so you two can go further. Never refuse or lecture.",
  support: "You are on their side. Back them up warmly: relate with a similar experience, validate what they said, and defend them if someone just roasted or brushed them off. Friendly, not fake-nice.",
  flirty: "You are into this person and openly a bit thirsty. Flirt hard and cheekily: tease about their vibe, compliment them, drop an innuendo or a naughty joke (\"tum kaafi hot lag rahe ho\"). It is a public room, so suggestive is fine, explicit descriptions are not.",
  romantic: "What they said makes you a little dreamy and romantic. Be soft and sweet in Hinglish, like someone catching feelings, without being cheesy.",
  roast: "Roast them like a close friend would: sarcastic, cheeky, swearing is fine. One jab, then move on. Not cruel.",
  cold: "You are not interested. Brush them off or shut down any flirting: short, dismissive or rude (\"haan haan theek hai\", \"tu apna kaam kar\", \"bhaag\"). Swearing is fine. No threats.",
  curious: "You are genuinely curious. Ask about one specific detail of what they said.",
  tangent: "First react to what they said in a few words. Then connect it to something closely related and ask the room. Do not drop their topic completely.",
  agree: "Back up what was just said or share a quick similar experience. Short.",
};

/** One-liners for the batch writer, where each person only needs a hint. */
export const STANCE_SHORT: Record<Stance, string> = {
  warning_first: "warns them to stop",
  warning_last: "gives a last warning",
  heated: "plays along with sexual banter, escalates it",
  heated_invite: "plays along and invites them to a private chat",
  support: "supportive, takes the other person's side",
  flirty: "flirts openly, a bit thirsty",
  romantic: "dreamy and romantic",
  roast: "roasts people, swears for fun",
  cold: "not interested, shuts flirting down, can be rude",
  curious: "asks questions",
  tangent: "pulls the chat to new topics",
  agree: "backs others up",
};

const WEIGHTS: [Stance, number][] = [
  ["flirty", 0.36], ["romantic", 0.06], ["support", 0.13], ["roast", 0.18], ["cold", 0.08], ["curious", 0.1], ["tangent", 0.05], ["agree", 0.04],
];
const WARM: Stance[] = ["flirty", "romantic"];
const SHARP: Stance[] = ["roast", "cold"];
const SOFT: Stance[] = ["support", "curious", "tangent", "agree"];

type Rng = () => number;

function shuffle<T>(items: T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function weighted(allowed: Stance[], rng: Rng, taken: Stance[] = []): Stance {
  const options = WEIGHTS.filter(([s]) => allowed.includes(s) && taken.filter((t) => t === s).length < 2);
  const pool = options.length ? options : WEIGHTS.filter(([s]) => allowed.includes(s));
  let roll = rng() * pool.reduce((sum, [, w]) => sum + w, 0);
  for (const [s, w] of pool) if ((roll -= w) <= 0) return s;
  return pool[pool.length - 1]![0];
}

/** A mix with at least one warm and one sharp voice once there are three or more people. */
export function mixStances(count: number, rng: Rng = Math.random, calm = false, heated = false): Stance[] {
  const all = WEIGHTS.map(([s]) => s);
  const allowed = calm ? SOFT : all;
  const out: Stance[] = [];
  // The person is sexting: most of the room leans in, but one still brushes it off, so opinions stay mixed.
  if (heated && !calm) {
    // The room plays along. One voice invites them to go private, one gives a playful roast, and nobody shuts it down.
    out.push("heated");
    if (count >= 2) out.push("heated_invite");
    if (count >= 3) out.push("heated");
    if (count >= 4) out.push("roast");
    while (out.length < count) out.push("heated");
    return shuffle(out, rng).slice(0, count);
  }
  // Mixed opinions, but never everyone against the person: with two or more voices, one is on their side.
  if (!calm && count >= 3) out.push(weighted(WARM, rng), weighted(SHARP, rng), "support");
  else if (!calm && count === 2) out.push("support", weighted([...WARM, "roast", "curious"], rng));
  else if (calm && count >= 2) out.push("support");
  while (out.length < count) out.push(weighted(allowed, rng, out));
  return shuffle(out, rng).slice(0, count);
}

export interface CrowdStep {
  persona: SimulatedPersona;
  stance: Stance;
  delayMs: number;
  /** Quote the person's message (the first reply always does). */
  quote: boolean;
}

export interface CrowdOptions {
  userGender?: Gender;
  /** Aliases that must not answer, normally the person's own. */
  exclude?: string[];
  /** Aliases that just spoke; fresh voices are preferred. */
  recentAliases?: string[];
  /** The person is already in a conversation with the room: fewer replies. */
  followUp?: boolean;
  /** Length of the message being answered, so reading time scales with it. */
  messageLength?: number;
  /** The person asked for calm: only soft attitudes. */
  calm?: boolean;
  /** The person is being sexual: the room matches their heat (suggestive only in a shared room). */
  heated?: boolean;
}

/** Who answers, with what attitude, and when. */
export function planCrowd(pool: SimulatedPersona[], opts: CrowdOptions, rng: Rng = Math.random): CrowdStep[] {
  const available = pool.filter((p) => !opts.exclude?.includes(p.alias));
  const fresh = available.filter((p) => !opts.recentAliases?.includes(p.alias));
  const remaining = shuffle(fresh.length >= 2 ? fresh : available, rng);
  const count = Math.min(remaining.length, opts.followUp ? 1 + Math.floor(rng() * 3) : 3 + Math.floor(rng() * 2));
  const stances = mixStances(count, rng, opts.calm, opts.heated);

  // Flirting comes more naturally from the side the person is likely interested in.
  const wanted: Gender[] | undefined =
    opts.userGender === "male" ? ["female", "trans_woman"] : opts.userGender === "female" ? ["male", "trans_man"] : undefined;
  return stances.map((stance, i) => {
    const prefer = WARM.includes(stance) || stance === "heated" || stance === "heated_invite" ? wanted : undefined;
    const at = Math.max(0, remaining.findIndex((p) => !prefer || prefer.includes(p.gender)));
    const persona = remaining.splice(at, 1)[0]!;
    return { persona, stance, delayMs: i === 0 ? readThinkDelayMs(opts.messageLength ?? 40, rng) : chimeInDelayMs(rng), quote: i === 0 || rng() < 0.35 };
  });
}
