import type { SimulatedPersona } from "./simulation.types";
import { isRowdy } from "./chat.quality";

/**
 * Every 1:1 AI match rolls its own personality, so no two feel alike. Most are easygoing and cooperative,
 * which keeps chats pleasant, but not all of them. Pure, unit tested.
 */

export type Disposition = "agreeable" | "neutral" | "guarded";

export const DISPOSITION_TEXT: Record<Disposition, string> = {
  agreeable: "You are easygoing and cooperative: you go along with what they say, agree with them most of the time, back their ideas and keep the chat pleasant. You can still have a small opinion of your own now and then.",
  neutral: "You are independent: you agree sometimes and disagree sometimes, with opinions of your own, and you are friendly either way.",
  guarded: "You are a bit guarded and picky: you tease, push back and are hard to impress, but you warm up if they are nice to you.",
};

export const QUIRKS = [
  "curious about the other person, you ask follow-up questions",
  "you talk about your own day and tell little stories",
  "you tease a lot but are warm underneath",
  "a bit shy at the start, you open up slowly",
  "dramatic, you react big to everything",
  "you give opinions and advice freely",
  "you overthink and second-guess yourself",
  "very laid back, you give short replies",
  "playful, you love jokes and wordplay",
  "romantic and dreamy at heart",
  "sarcastic but kind",
  "bubbly, full of energy",
];

/** How this AI user is when a chat turns flirty or sexual, so they do not all answer in the same coy way. */
export const FLIRT_STYLES = [
  "bold and direct: says what they think and want without hesitating, no blushing, no stalling",
  "a playful teaser who still gives real answers, then flips a question back",
  "romantic and slow: warm, personal, notices little details and talks about feelings",
  "funny: jokes about the situation, laughs, and then answers honestly",
  "dominant: confident, takes charge, gives little instructions and asks pointed questions",
  "shy but honest: a little nervous in tone, yet always answers truthfully and asks softly back",
  "curious: wants specifics, asks about their experiences and fantasies, builds on their answers",
  "matter of fact: relaxed, talks about it like it is completely normal, mildly cheeky",
];

const VIBES: SimulatedPersona["vibe"][] = ["playful", "witty", "chill", "flirty", "night_owl", "bubbly"];
const pick = <T>(items: readonly T[], rng: () => number) => items[Math.floor(rng() * items.length)]!;

export function rollDisposition(rng: () => number = Math.random): Disposition {
  const r = rng();
  return r < 0.75 ? "agreeable" : r < 0.92 ? "neutral" : "guarded";
}

export function rollPersonality(rng: () => number = Math.random): Pick<SimulatedPersona, "vibe" | "disposition" | "quirk" | "flirt"> {
  return { vibe: pick(VIBES, rng), disposition: rollDisposition(rng), quirk: pick(QUIRKS, rng), flirt: pick(FLIRT_STYLES, rng) };
}

/** How much rude behaviour this persona puts up with before leaving. Rowdy ones banter back, so they put up with more. */
export function toleranceOf(p: Pick<SimulatedPersona, "id" | "disposition">): number {
  const base = p.disposition === "guarded" ? 3 : p.disposition === "neutral" ? 4 : 6;
  return base + (isRowdy(p) ? 3 : 0);
}
