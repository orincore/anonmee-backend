import type { Gender } from "../../contracts";

/**
 * Pure rules that decide how far a simulated persona may go. No I/O, unit tested.
 * Code decides this, never the model: the prompt only follows the level it is handed.
 */

/** friendly: banter and swearing. flirty: romantic and suggestive. explicit: sexual chat (1:1 only, opt-in). */
export type Heat = "friendly" | "flirty" | "explicit";

const EXPLICIT_INTENTS = new Set(["sexting", "one_night_stand", "friends_with_benefits"]);
const FLIRTY_INTENTS = new Set(["long_term", "marriage_minded", "casual_dating", "flirting", "online_romance"]);

/** What the person asked for when they signed up decides the ceiling. Choosing nothing romantic means banter only. */
export function heatForIntents(intents: readonly string[]): Heat {
  if (intents.some((i) => EXPLICIT_INTENTS.has(i))) return "explicit";
  if (intents.some((i) => FLIRTY_INTENTS.has(i))) return "flirty";
  return "friendly";
}

/**
 * How far one private 1:1 chat may go. What the person signed up for sets the start, and their own sexual messages
 * move it up: in a private chat between adults, asking for it is the clearest consent there is. Saying stop brings it all the way back.
 */
export function chatHeat(base: Heat | undefined, sexualMessages: number, stopped: boolean): Heat {
  if (stopped) return "friendly";
  const start = base ?? "friendly";
  if (sexualMessages >= 2) return "explicit";
  if (sexualMessages === 1 && start === "friendly") return "flirty";
  return start;
}

/** Shared rooms are read by people who never opted in, so sexual content stays out of them. */
export function capHeat(heat: Heat, roomType: "global" | "group" | "direct"): Heat {
  return roomType !== "direct" && heat === "explicit" ? "flirty" : heat;
}

const UNDERAGE: RegExp[] = [
  /\b(?:i\s*am|i'?m|im|age(?:\s*is)?|umar|main|mai)\s*(1[0-7])\b/i,
  /\b(1[0-7])\s*(?:yrs?|years?|y\/?o|yo|saal|sal)\b/i,
  /\b(?:class|std|standard|grade)\s*(?:[5-9]|1[0-2])\b|\b(?:[5-9]|1[0-2])(?:th|vi|vin)\s*(?:class|std|standard|grade)\b/i,
  /\bschool\s*(?:me|mein|mai|ja|jaata|jaati|student|girl|boy|kid|wala|wali)\b|\bi\s*(?:go|study)\s*(?:to|in)\s*school\b|\bboards?\s*(?:exam|ke)\b/i,
  /\b(?:minor|underage|under\s*18|not\s*18|abhi\s*18\s*nahi)\b/i,
];

/** A sign the other person may be under 18. Wide on purpose: a false alarm costs a chat, a miss costs far more. */
export const looksUnderage = (text: string) => UNDERAGE.some((r) => r.test(text));

const CRISIS = /\b(?:suicide|suicidal|kill\s*myself|end\s*my\s*life|want\s*to\s*die|marna\s*chah(?:ta|ti)|jeena\s*nahi|khudkushi|self[\s-]?harm|cut\s*myself)\b/i;
export const inCrisis = (text: string) => CRISIS.test(text);

const STOP = /\b(?:stop|enough|no\s*more|not\s*comfortable|uncomfortable|mat\s*karo|mat\s*bol|bas\s*karo|band\s*karo|nahi\s*karna|nahi\s*chahiye|pasand\s*nahi|leave\s*me|i\s*said\s*no|don'?t\s*want|dont\s*want)\b/i;
/** The person said no or stop: drop the spice for the rest of this chat. */
export const wantsStop = (text: string) => STOP.test(text);

/** The one thing a persona says before the chat ends. Short, kind, no role play. */
export function underageGoodbye(gender: Gender): string {
  return `yaar tumhari baat se lag raha hai tum 18 se chhote ho. yaha sirf 18+ ke liye hai, isliye main aage baat nahi kar ${gender === "female" || gender === "trans_woman" ? "paungi" : "paunga"}. apna khayal rakhna`;
}

export const crisisGoodbye = "yaar tum theek ho? agar tum khud ko nuksaan pahunchane ka soch rahe ho toh please kisi apne se ya Tele-MANAS (14416, free) pe baat karo. tumhara khayal rakhna";

const SEXUAL = /\b(?:sex|sexting|sext|horny|nudes?|naked|boobs?|tits|dick|cock|lund|lauda|chut|choot|gaand|pussy|fuck\s*me|chod(?:o|na|ne|unga|ungi)?|chudai|blowjob|bj|handjob|masturbat\w*|moan\w*|orgasm|bed\s*me|hookup|one\s*night|sexy|naughty|dirty\s*(?:talk|chat)|kiss(?:es|ing)?|nangi|nanga|chusna|mamme|garmi\s*lag)\b/i;
/** The person is being sexual. In a shared room the room matches their heat but stays suggestive. */
export const isSexualTalk = (text: string) => SEXUAL.test(text);
