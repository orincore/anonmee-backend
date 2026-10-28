import type { Gender } from "../../contracts";

/**
 * Hindi verbs agree with the speaker's gender ("thak gayi" / "thak gaya"). A persona that gets this wrong
 * breaks the illusion at once, most of all in flirty chat. Pure, unit tested.
 */

export type Forms = "feminine" | "masculine" | "neutral";

export const formsOf = (g: Gender): Forms =>
  g === "female" || g === "trans_woman" ? "feminine" : g === "male" || g === "trans_man" ? "masculine" : "neutral";

const MASC = "raha|gaya|aaya|karta|chahta|jaata|sota|deta|leta|khaata|peeta|bola";
const FEM = "rahi|gayi|gai|aayi|aai|karti|chahti|jaati|soti|deti|leti|khaati|peeti|boli";

// "main ... gaya" (the verb agrees with "main") or "raha hu" (first person present).
const re = (stems: string, participle: string) =>
  new RegExp(`\\b(?:main|mai)\\b[^.!?\\n]{0,40}?\\b(?:${stems})\\b|\\b(?:${stems}|${participle})\\s+(?:hu|hoon|hun)\\b`, "i");
// "leta hua hu" / "leti hui hu": the participle only counts right before "hu", so "kya hua" is left alone.
// First-person future ("karunga" / "karungi", "lagunga" / "lagungi") shows the speaker's gender with no "main" needed.
const MASC_RE_BASE = re(MASC, "hua");
const FEM_RE_BASE = re(FEM, "hui");
const MASC_RE = { test: (t: string) => MASC_RE_BASE.test(t) || /\b[a-z]+unga\b/i.test(t) };
const FEM_RE = { test: (t: string) => FEM_RE_BASE.test(t) || /\b(?!lungi\b)[a-z]+ungi\b/i.test(t) };

/** True when a line talks about the speaker with the other gender's verb forms. */
export function formsMismatch(text: string, speaker: Gender): boolean {
  const forms = formsOf(speaker);
  if (forms === "neutral") return MASC_RE.test(text) || FEM_RE.test(text); // neither gendered form fits
  return forms === "feminine" ? MASC_RE.test(text) : FEM_RE.test(text);
}

/** What the persona's own verbs should look like. */
export function formsHint(g: Gender): string {
  switch (formsOf(g)) {
    case "feminine": return "Use feminine Hindi verb forms for yourself (karti, gayi, rahi hu, thi).";
    case "masculine": return "Use masculine Hindi verb forms for yourself (karta, gaya, raha hu, tha).";
    default: return "Never use gendered verb forms for yourself: no raha/rahi, gaya/gayi, karta/karti with main. Rephrase (\"mujhe neend aa rahi h\", \"bore ho gaya\", \"chill chal raha h\" about things, not yourself).";
  }
}

/** Short tag for the batch writer, which lists several people at once. */
export const formsTag = (g: Gender) => ({ feminine: "feminine verbs", masculine: "masculine verbs", neutral: "gender-neutral phrasing" })[formsOf(g)];

/** How the other person should be addressed. */
export function addressHint(other: Gender): string {
  switch (formsOf(other)) {
    case "feminine": return "The person you are talking to is a woman: use feminine forms for them (tum aayi thi, tu kahan gayi).";
    case "masculine": return "The person you are talking to is a man: use masculine forms for them (tum aaye the, tu kahan gaya).";
    default: return "The person you are talking to is non-binary or has not said: avoid gendered forms for them.";
  }
}
