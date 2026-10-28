import { normalise } from "./chat.quality";

/**
 * Is the person being cruel or pushy with the AI user, as opposed to joking around? Threats, slurs, directed
 * abuse, spam and pressure for personal details add up; kind or neutral messages let the score fall again.
 * The AI user warns twice, and leaves on the next offence. Pure, unit tested.
 */

// Serious threats. Each needs a target ("tujhe", "you", "tera") or an unmistakable phrase, so talking about news or a movie does not trip it.
const DEATH_THREAT = new RegExp([
  String.raw`\b(?:tujhe|tumhe|tujhko|tumko|tera|teri)\b[^.!?\n]{0,30}\b(?:maar\s*(?:dunga|dungi|daalunga|dalunga|daalenge|denge)|jaan\s*se\s*maar\w*|khatam\s*kar\s*(?:dunga|dungi|denge)|jinda\s*nahi\s*chhod\w*|kaat\s*(?:dunga|dalunga)|mita\s*(?:dunga|denge)|goli\s*maar\w*|tamam\s*kar\w*)`,
  String.raw`\bjaan\s*se\s*maar\s*(?:dunga|dungi|daalunga|dalunga)\b`,
  String.raw`\b(?:i(?:'ll|\s*will|'m\s*going\s*to|\s*am\s*going\s*to|'m\s*gonna)?|ill|gonna|will)\s*(?:kill|murder|stab|shoot|strangle)\s*(?:you|u|ya)\b`,
  String.raw`\b(?:kill|murder)\s*(?:you|u)\b`,
].join("|"), "i");
const RAPE_THREAT = new RegExp([
  String.raw`\brape\s*(?:kar\s*(?:dunga|dalunga|denge|ke)|karunga|karenge|kardunga|you|u)\b`,
  String.raw`\b(?:tera|teri|tujhe|tumhe|tujhko|tumhara|tumhari)\b[^.!?\n]{0,25}\b(?:rape|balatkar)\b`,
  String.raw`\b(?:will|ll|gonna|going\s*to)\s*(?:gang\s*)?rape\b`,
  String.raw`\bgang\s*rape\s*(?:kar|karunga|karenge|you)\b`,
  String.raw`\bbalatkar\s*(?:kar|karunga|karenge)\b`,
].join("|"), "i");
// Violence against the body ("tera loda tod dunga"). It needs a body part, so "record tod dunga" is left alone.
const BODY_VIOLENCE = /\b(?:lund|lauda|loda|lavda|gaand|haddi|haddiyan|haath|pair|taang|gardan|sir|jabda|daant|muh|chehra)\b[^.!?\n]{0,15}\b(?:tod|faad|phod|kaat)\s*(?:dunga|dungi|dalunga|dalungi|denge|dalenge|lunga|lungi)\b/i;
const WISH_DEATH = /\b(?:kill\s*yourself|kys|go\s*die|mar\s*ja+|mar\s*jao|jaake\s*mar|suicide\s*kar|khudkushi\s*kar)\b/i;
const STALK_THREAT = new RegExp([
  String.raw`\btera\s*address\s*(?:pata\s*(?:hai|chal|lag)\w*|nikal\s*(?:lunga|lungi|liya))`,
  String.raw`\b(?:tere|tumhare|teri)\s*ghar\s*(?:pe\s*)?(?:aa\s*raha|aa\s*rahi|aaunga|aaungi|aa\s*jaunga|aa\s*jaungi)\b`,
  String.raw`\b(?:will|ll|gonna|going\s*to)\s*find\s*(?:you|u)\b`,
  String.raw`\bdoxx\s*(?:you|u|kar)\b`,
  String.raw`\buthwa\s*(?:lunga|lungi)\b`,
  String.raw`\bkidnap\s*(?:kar|you|u)\b`,
  String.raw`\bacid\s*(?:daal|fek)\w*\b`,
].join("|"), "i");
// Still serious: religion and caste slurs, and slurs about someone's trans or gay identity. Gendered and sexual abuse is
// ordinary swearing here (the AI user says it too), so it scores like any other directed insult below.
const SLUR = /\b(?:chakka|hijra|hijda|hijde|kinnar|chamar|bhangi|katua|kafir|chuhra|mulla)\b/i;
const DIRECTED = /\b(?:tu|tum|tera|teri|tujhe|tumhe|you|ur|your)\b[^.!?\n]{0,25}\b(?:chutiya|chutiye|bc|mc|bsdk|bkl|mkc|gandu|harami|kamina|kamine|madarchod|bhenchod|lodu|randi|raand|kutiya|kutti|chhinal|veshya|bhadwa|gaand\s*mara|fuck|bitch|slut|whore|ugly|fat|stupid|idiot|loser|bakwas|bekaar|pagal)\b/i;
const FAMILY = /\bteri\s+(?:maa|ma|behen|bhen|mummy|bahan)\b/i;
const COMMAND = /\b(?:shut\s*up|chup\s*kar|chup\s*re|get\s*lost|bhaag\s*ja+)\b/i;
// Asking for something an AI user never gives: contact details, photos, an address. The first ask is fine; asking again after a "no" is pressure.
const ASK = /\b(?:number|whatsapp|insta\w*|snap\w*|telegram|photo|pic|selfie|address|location)\b[^.!?\n]{0,20}\b(?:do|de|dedo|bhejo|bhej|send|share|batao|bata)\b|\b(?:do|de|dedo|bhejo|bhej|send|share|batao|bata)\b[^.!?\n]{0,20}\b(?:number|whatsapp|insta\w*|snap\w*|telegram|photo|pic|selfie|address|location)\b/i;

export type HostileReason = "threat_death" | "threat_rape" | "threat_violence" | "wish_death" | "threat_stalk" | "abuse" | "spam" | "pressure";

/** Threats and wishes of death or sexual violence, and stalking threats. These skip at once and are flagged as severe. */
const SEVERE: ReadonlySet<HostileReason> = new Set(["threat_death", "threat_rape", "threat_violence", "wish_death", "threat_stalk"]);
export const isSevere = (r: HostileReason | undefined): boolean => !!r && SEVERE.has(r);

export interface HostilityState {
  score: number;
  recent: string[];
  /** Warnings given so far (0 to 2). */
  warnings: number;
  /** How many times they have asked for contact details or photos. */
  asks: number;
}

export const freshHostility = (): HostilityState => ({ score: 0, recent: [], warnings: 0, asks: 0 });

export function hostilityPoints(text: string): { points: number; severe: boolean; reason?: HostileReason } {
  // Rape and death threats first: when a message has both, the worse one is what gets reported.
  if (RAPE_THREAT.test(text)) return { points: 3, severe: true, reason: "threat_rape" };
  if (DEATH_THREAT.test(text)) return { points: 3, severe: true, reason: "threat_death" };
  if (BODY_VIOLENCE.test(text)) return { points: 3, severe: true, reason: "threat_violence" };
  if (WISH_DEATH.test(text)) return { points: 3, severe: true, reason: "wish_death" };
  if (STALK_THREAT.test(text)) return { points: 3, severe: true, reason: "threat_stalk" };
  let points = 0;
  if (SLUR.test(text)) points += 3;
  if (DIRECTED.test(text)) points += 1;
  if (COMMAND.test(text)) points += 1;
  if (FAMILY.test(text)) points += 1; // "teri maa ki..." is ordinary swearing here, so it scores like any other insult
  return { points, severe: false, reason: points ? "abuse" : undefined };
}

export interface HostilityVerdict {
  state: HostilityState;
  /** Enough: the AI user leaves and flags the person. */
  skip: boolean;
  /** 1 or 2 when the AI user should warn them now; 0 otherwise. */
  warn: 0 | 1 | 2;
  /** What the latest offence was. */
  reason?: HostileReason;
}

export function nextHostility(prev: HostilityState, text: string, tolerance: number): HostilityVerdict {
  const { points: base, severe, reason: baseReason } = hostilityPoints(text);
  const n = normalise(text);
  // Sending the same thing again and again is its own kind of pressure.
  const repeated = n.length >= 2 && prev.recent.slice(-3).includes(n) ? 1 : 0;
  const asked = ASK.test(text);
  const pressure = asked && prev.asks >= 1 ? 1 : 0;
  const points = base + repeated + pressure;
  const hostile = points > 0;

  const score = hostile ? prev.score + points : Math.max(0, prev.score - 1);
  let warnings = prev.warnings;
  if (!hostile && score === 0) warnings = 0; // they calmed down completely: a clean slate
  const reason: HostileReason | undefined = baseReason ?? (repeated ? "spam" : pressure ? "pressure" : undefined);

  let skip = false;
  let warn: 0 | 1 | 2 = 0;
  if (severe) skip = true; // a threat is not given a second chance
  else if (hostile && warnings >= 2) skip = true; // two warnings were given and it happened again
  else if (hostile && score >= Math.ceil(tolerance / 2)) {
    warnings += 1;
    warn = warnings as 1 | 2;
  }
  return { state: { score, recent: [...prev.recent, n].slice(-6), warnings, asks: prev.asks + (asked ? 1 : 0) }, skip, warn, reason };
}

const LABEL: Record<HostileReason, string> = {
  threat_death: "Threatened to kill the AI user",
  threat_rape: "Threatened to rape the AI user",
  threat_violence: "Threatened serious violence against the AI user",
  wish_death: "Told the AI user to kill themselves or die",
  threat_stalk: "Threatened to find, follow or harm the AI user",
  abuse: "Abusive language toward the AI user",
  spam: "Kept repeating the same message at the AI user",
  pressure: "Kept asking the AI user for contact details or photos after being refused",
};

/**
 * The reason text saved with the report, so staff see at a glance why an AI user flagged someone.
 * Serious threats start with "SEVERE", which the admin queue uses to pin them at the top.
 */
export function aiFlagReason(reason: HostileReason | undefined, warnings: number): string {
  const why = LABEL[reason ?? "abuse"];
  if (isSevere(reason)) return `${SEVERE_PREFIX} ${why}. The AI user left immediately, without a warning.`;
  const warned = warnings === 0 ? "No warning was given." : `Warned ${warnings} time${warnings === 1 ? "" : "s"} before the AI user skipped the chat.`;
  return `${AI_FLAG_PREFIX} ${why}. ${warned}`;
}

export const AI_FLAG_PREFIX = "[AI flagged]";
export const SEVERE_PREFIX = "[AI flagged] SEVERE:";
