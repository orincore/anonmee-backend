/**
 * How young Indians really type Hinglish, and how to spot the opposite. Evidence: studies of code-mixed social media
 * text (PHINC, L3Cube-HingCorpus, HASOC) show Roman Hindi has no standard spelling: "mujhe / mjhe", "jaldi / jldi / jldiii",
 * "nhi", "kr", "h", with English mixed into the middle of sentences and "u / pls / coz". Pure, unit tested.
 */

type Rng = () => number;

/** Roman Hindi and English words and the lazier ways people type them. The first form is the usual one. */
const SHORT: Record<string, string[]> = {
  nahi: ["nhi", "ni", "nahi"], nahin: ["nhi"], nai: ["ni"], hai: ["h"], hain: ["h", "hn"], hoon: ["hu"], hun: ["hu"],
  kya: ["kya", "kyaa", "kya"], kyun: ["kyu", "kyun"], kyu: ["kyu"], kaise: ["kese", "kaise"], kahan: ["kaha"], kab: ["kb"], kal: ["kl"],
  kar: ["kr"], karo: ["kro"], karna: ["krna"], karta: ["krta"], karti: ["krti"], karte: ["krte"], karunga: ["krunga"], karenge: ["krenge"],
  raha: ["rha"], rahi: ["rhi"], rahe: ["rhe"], mujhe: ["mjhe", "mje"], mujhko: ["mjko"], tumhe: ["tmhe"], tumko: ["tmko"], tumhara: ["tmhara"],
  tumhari: ["tmhari"], bahut: ["bht", "bhot"], bohot: ["bht", "bhot"], kuch: ["kch", "kuch"], theek: ["thik", "tik"], acha: ["acha", "achha"],
  achha: ["acha"], toh: ["to"], lekin: ["lkin"], kyunki: ["kyuki"], wala: ["wla"], wali: ["wli"], bata: ["bta"], batao: ["btao"], bolo: ["bolo"],
  chalo: ["chlo"], matlab: ["mtlb"], samajh: ["smjh"], zyada: ["jyada", "zada"], pyaar: ["pyar"], haan: ["hn", "han"], abhi: ["abhi", "abi"],
  sab: ["sb"], jaldi: ["jldi", "jldiii"], mein: ["me"], main: ["mai", "me"],
  please: ["pls", "plz"], you: ["u"], your: ["ur"], are: ["r"], because: ["coz", "bcoz"], before: ["bfr"], message: ["msg"], okay: ["ok", "k"],
  thanks: ["thnks", "thx"], tomorrow: ["tmrw"], tonight: ["tonite"], seriously: ["srsly"], whatever: ["whatevr"],
};

/**
 * Types a line the lazy way. `intensity` is how likely each word is to be shortened (0 to 1); people differ,
 * and the same person is not consistent, so each word is decided separately.
 */
export function degradeSpelling(text: string, intensity: number, rng: Rng = Math.random): string {
  if (intensity <= 0) return text;
  let out = text.replace(/[A-Za-z]+/g, (word) => {
    const forms = SHORT[word.toLowerCase()];
    if (!forms || rng() >= intensity) return word;
    const pick = forms[Math.floor(rng() * forms.length)]!;
    return word[0] === word[0]!.toUpperCase() && word.length > 1 && word !== word.toLowerCase() ? pick[0]!.toUpperCase() + pick.slice(1) : pick;
  });
  // Now and then a stretched ending, the way people type when they feel something: "yaar" -> "yaaar", "pls" -> "plsss".
  if (rng() > 1 - intensity * 0.12) out = out.replace(/\b(yaar|bhai|pls|please|arre|haan|nhi|sach|bro)\b/i, (w) => w + w[w.length - 1]!.repeat(1 + Math.floor(rng() * 2)));
  return out;
}

/** How lazily a persona types, from its texting style. */
export function spellingIntensity(style: string): number {
  if (/lazy|fragments/.test(style)) return 0.85;
  if (/rowdy|casual swearer/.test(style)) return 0.7;
  if (/changing the topic|topic/.test(style)) return 0.6;
  if (/one to three words|rants|flirt|English with Hindi/.test(style)) return 0.5;
  if (/dry/.test(style)) return 0.4;
  if (/polite|sweet/.test(style)) return 0.3;
  if (/clean full sentences/.test(style)) return 0.2;
  return 0.5;
}

/**
 * No em dashes, en dashes or other long dashes in anything an AI user sends, ever. People texting do not type them, and
 * they are the most obvious sign of machine-written text. A dash between numbers becomes a hyphen ("10 to 15 min" stays
 * readable); anywhere else it becomes a comma. Pure, unit tested.
 */
export function noDashes(text: string): string {
  return text
    .replace(/(\d)\s*[\u2012\u2013\u2014\u2015\u2212]\s*(\d)/g, "$1-$2")
    .replace(/\s*[\u2012\u2013\u2014\u2015\u2212]+\s*/g, ", ")
    .replace(/^[,\s]+|[,\s]+$/g, "")
    .replace(/,\s*,/g, ",");
}

/**
 * Stock phrases the model reaches for again and again ("line cross mat kar", "line maar raha h", "limit cross"). One of them
 * is fine in a real chat, a whole room speaking in them sounds like a script, so they are not allowed at all.
 */
const CLICHES = [
  /\bline\s+(?:cross\w*|maar\w*|mar\w*|mat\s+(?:maar|mar|de|cross)\w*|de\w*|do|pe\s+aa\w*|todn\w*|tod\w*)\b/i,
  /\b(?:limit|hadd|seema)\s+(?:cross|paar)\w*/i,
  /\bcross\s+(?:mat\s+)?kar\w*/i,
  /\bnext\s+level\b/i,
  /\bvibe\s+check\b/i,
  /\b(?:red|green)\s+flag\b/i,
  /\btension\s+mat\s+le\b/i,
  /\bgame\s+(?:on|changer)\b/i,
];

/** True when a line is built on one of the stock phrases. */
export const isCliche = (line: string): boolean => CLICHES.some((r) => r.test(line));

/**
 * The coy stall: instead of answering, comment on how direct the other person is, say you are shy, or demand they answer
 * first. Every AI user reached for the same few of these, so a chat never got anywhere. Rejected everywhere.
 */
const COY_STALLS = [
  /\bseedha\s+(?:point|sawaal|sawal|hi\s+(?:pooch|puch)\w*|pooch\w*|puch\w*)\b/i,
  /\bitn[ia]\s+(?:jaldi|himmat|direct|seedha|bold|shameless)\b/i,
  /\b(?:direct|seedha)\s+kyu\b/i,
  /\bhimmat\s+kaha\b/i,
  /\bwarm\s*up\b/i,
  /\bsharm\s+se\b|\bsharma\s+jaun\w*|\bsharam\s+aa\w*/i,
  /\bpehle\s+(?:apni|apna|ye\s+bata\w*|thoda|tum\s+bata\w*|tu\s+bata\w*|tum\s+batao)\b/i,
  /\b(?:nhi|nahi)\s+bataungi\b|\bbataungi\s+bataungi\b|\bbataunga\s+bataunga\b/i,
  /\bitn[ia]\s+(?:asaan|easy)\s+(?:nhi|nahi)\b/i,
  /\beffort\s+dal\w*/i,
  /\bthoda\s+context\s+de\b/i,
  /\bbina\s+baat\s*cheet\b/i,
  /\bhil\s+gayi\b|\bhil\s+gaya\b/i,
  /\bek\s*dm\s+seedha\b|\bekdum\s+seedha\b/i,
];

/** True when a line stalls instead of answering. */
export const isCoyStall = (line: string): boolean => COY_STALLS.some((r) => r.test(line));

/** Bookish and Sanskritised words nobody types in a chat. Their presence is the giveaway of "pure Hindi". */
const BOOKISH = [
  "kripya", "kripaya", "dhanyavaad", "dhanyawad", "dhanyavad", "mitra", "mitr", "vichaar", "vichar", "prashn", "uttar", "avashya", "avashyak", "atyant", "kintu",
  "parantu", "tathapi", "atah", "sahayata", "sambandh", "vyakti", "pratikriya", "samaachar", "parivaar", "bhojan", "vidyalaya", "karyalaya", "mahodaya",
  "shubh ratri", "shubhratri", "namaskar", "abhivadan", "swagat", "vaarta", "vartalap", "charcha", "uplabdh", "pratiksha", "sadhuvaad", "aabhaar", "anurodh",
  "yadyapi", "athva", "tatha", "evam", "sankshep", "vistaar", "samasya", "samaadhan", "prasann", "kripa", "krupaya",
];
const BOOKISH_RE = new RegExp(`\\b(?:${BOOKISH.join("|")})\\b`, "i");

/** True when a line sounds like a textbook instead of a person. */
export const isBookish = (line: string): boolean => BOOKISH_RE.test(line);
