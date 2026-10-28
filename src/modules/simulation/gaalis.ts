/**
 * Swear words and insults for the AI users, so a room does not hear the same three words all night.
 * Sources for the base vocabulary: Wiktionary's Hindi vulgarities category and Wikipedia's Hindustani profanity
 * article, plus common Hinglish usage. Regional entries (Punjabi, Marathi, Bengali, Gujarati, Tamil, Telugu,
 * Malayalam) are best effort and worth a native speaker's review.
 *
 * Gender-based and sexual abuse is in on purpose (the owner's call): it is what a lot of real Hindi swearing is.
 * Deliberately NOT here: anything about religion or caste, and slurs about someone's trans or gay identity, ethnicity or
 * region, or disability. The app has trans and non-binary people in it, and that is hate, not banter. A test
 * (gaalis.test.ts) keeps it that way.
 */

/** The everyday ones. These may repeat as often as people really repeat them. */
export const STAPLES = ["bc", "mc", "bkc", "mkc", "bsdk", "bkl", "tmkc", "tmc", "mcbc", "bhosdike", "saale"] as const;

/** Single words and short expressions, from a mild "fool" up to properly vulgar. */
const BASE = [
  // fool, useless, annoying
  "saala", "kamina", "kamine", "kameena", "gadha", "gadhe", "ullu", "ullu ka pattha", "ullu ke pathe", "pagal", "bewakoof", "bevkoof",
  "nikamma", "nalayak", "dhakkan", "chomu", "chaman", "chaman chutiya", "fattu", "phattu", "lafanga", "lukkha", "tharki", "charsi", "nashedi",
  "jhootha", "ghatiya", "bekaar", "gobar", "gobar ganesh", "kachra", "kanjoos", "makkhichoos", "dagabaaz", "nautanki", "dramebaaz", "bakwaas",
  "faltu", "bandar", "suar", "suwar", "soor", "bhains", "chindichor", "chhapri", "chapri", "tapori", "chhichhora", "launda", "ganda insaan",
  "paapi", "dhokebaaz", "ghanta", "ghante", "tattu", "tatti",
  // dog, donkey, pig
  "kutta", "kutte", "kuttey", "kutta kahin ka", "kutte ki aulaad", "kutte ka bachcha", "suar ki aulaad", "gadhe ki aulaad", "ullu ki aulaad",
  // bastard, rascal
  "harami", "haramkhor", "haramzada", "haramzade", "haramipanti", "haraami",
  // the heavy hitters
  "gandu", "gaandu", "gaand", "chutiya", "chutiye", "chutiyapa", "chutiyapanti", "chutiye ki aulaad", "chutmarike", "chutad", "chut", "choot",
  "bakchod", "bakchodi", "bakchodo", "chodu", "chodu bhagat", "lund", "lauda", "lavda", "lavde", "lode", "lodu", "lodey", "loda", "lund ke baal",
  "bhosda", "bhosdi", "bhosdika", "bhosdiwala", "bhosadpappu", "bhonsdi", "jhatu", "jhantu", "jhaant", "jhaantu", "mutthal", "muthal",
  // family, as people really swear
  "madarchod", "maderchod", "madrchod", "behenchod", "bhenchod", "bhen ke lode", "bhen ke laude", "bhen ke takke", "teri maa ki aankh",
  "teri aisi ki taisi", "teri maa ka", "maa ka bhosda",
  // abbreviations beyond the staples
  "bhk", "bhenkc", "mkb",
  // Punjabi, Marathi, Bengali, Gujarati, Tamil, Telugu, Malayalam (best effort)
  "kutteya", "ullu da pattha", "phuddu", "penchod", "chutya", "gadhav", "bevda", "bokachoda", "pagol", "chagol", "shala", "banchod",
  "gando", "chutiyo", "kutro", "loosu", "naaye", "poda", "punda", "otha", "mayiru", "thayoli", "oombu", "dengey", "pichodu", "gadida",
  "patti", "myre",
  // gender-based abuse
  "randi", "randwa", "raand", "kutiya", "kutti", "kuttiya", "chhinal", "chinal", "rakhail", "saali randi", "kutti kamini", "bhadwa", "bhadwe", "bhadua",
  "khanki", "magi", "lanja", "thevdiya", "zavadya",
  // private parts
  "tatte", "tatta", "gote", "gotiyan", "lulli", "lulla", "supari", "lund ka", "lund ke jaisa", "lund ka tola", "lauda lassan", "lavde ke baal", "chut ke baal",
  "gaand ke baal", "jhaant ke baal", "bhosde ke", "bhosda phad", "chut ka daana", "gaand ka chhed", "lund pakad", "tatte pakad", "lund hilata reh", "gote chaat",
  // mother and sister
  "teri maa ki", "teri maa ki chut", "teri maa ka bhosda", "teri maa ki gaand", "teri behen ki", "teri behen ka", "teri behen ki chut", "maa chod", "maa ke lode",
  "maa ke laude", "maa ki aankh", "maa behen ek kar dunga", "behen ke lode", "behen ki gaand", "behen chod", "bahenchod", "behnchod", "madarjaat", "maa ka laal",
  "teri ma ka", "teri bhen ki", "teri maa ko", "teri behen ko", "maa ka yaar", "behen ka yaar",
  // sexual abuse
  "gaand marao", "gaand marwa", "gaand mara", "gand mara", "gaand phad", "gaand phat gayi", "gaand mein dum", "gaand ka", "gaand mein ghus ja",
  "chut ke", "chut ka", "lund choos", "lund chus", "chudasi", "chudai", "chudayi", "chod diya", "bhosdi mein ja", "lund pe baith", "lund le",
  "muth maar", "muthi maar", "gaandfat",
];

/** Nouns that fit "tu ___ hai", for building natural phrases. */
const NOUNS = [
  "chutiya", "gandu", "harami", "kamina", "kutta", "gadha", "ullu", "bewakoof", "nikamma", "nalayak", "dhakkan", "chomu", "fattu", "lafanga",
  "tharki", "bakchod", "ghatiya", "jhatu", "jhantu", "chapri", "chhapri", "tapori", "dagabaaz", "kanjoos", "bandar", "suar", "launda", "nautanki",
  "lodu", "haramkhor", "charsi", "nashedi", "tatti", "ullu ka pattha", "chindichor", "chhichhora", "makkhichoos", "dramebaaz", "jhootha", "pagal",
  "ghanta", "gobar", "bhosdiwala", "chutiye ki aulaad", "kachra", "faltu insaan",
];

// Gender-based nouns, with the forms that agree with a feminine noun.
const FEMININE_NOUNS = ["randi", "kutiya", "kutti", "chhinal", "raand"];
const FEMININE_TEMPLATES = ["abe {w}", "saali {w}", "{w} kahin ki", "ek number ki {w}", "kya {w} hai tu", "{w} sali", "oye {w}"];

// Private-part nouns and the forms people use them in ("tera lund", "gaand ke baal", "chut jaisa muh").
const BODY_NOUNS = ["lund", "lauda", "lavda", "chut", "choot", "gaand", "bhosda", "bhosdi", "jhaant", "tatte", "gote", "lulli", "chutad"];
const BODY_TEMPLATES = ["abe {w}", "{w} ke baal", "{w} jaisa muh", "tera {w}", "{w} ke jaisa", "kya {w} hai tu", "{w} saala", "oye {w}"];

const TEMPLATES = [
  "abe {w}", "saale {w}", "oye {w}", "{w} kahin ka", "kya {w} hai tu", "bada {w} hai tu", "ek number ka {w}", "pura {w} nikla tu",
  "{w} insaan", "tu to {w} hai", "{w} sala", "chal be {w}",
];

const phrases = (): string[] => [
  ...NOUNS.flatMap((w) => TEMPLATES.map((t) => t.replace("{w}", w))),
  ...FEMININE_NOUNS.flatMap((w) => FEMININE_TEMPLATES.map((t) => t.replace("{w}", w))),
  ...BODY_NOUNS.flatMap((w) => BODY_TEMPLATES.map((t) => t.replace("{w}", w))),
];

const unique = (xs: string[]) => [...new Set(xs.map((x) => x.trim().toLowerCase()))];

/** Single words and expressions. */
export const GAALI_WORDS: readonly string[] = unique(BASE);
/** Full phrases built from the nouns above (the ones that are already a base expression stay there). */
export const GAALI_PHRASES: readonly string[] = unique(phrases()).filter((p) => !GAALI_WORDS.includes(p));
/** Everything the AI users can be offered. */
export const GAALI_POOL: readonly string[] = unique([...GAALI_WORDS, ...GAALI_PHRASES]);

function sample<T>(items: T[], n: number, rng: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

/**
 * Ten fresh ones for one request: mostly single words, some phrases, none that were offered recently.
 * The staples are not in here; they are always allowed and may repeat. Pure, unit tested.
 */
export function pickGaalis(recent: Iterable<string> = [], n = 10, rng: () => number = Math.random): string[] {
  const avoid = new Set([...recent].map((x) => x.toLowerCase()));
  const staples = new Set<string>(STAPLES);
  const fresh = (xs: readonly string[]) => xs.filter((x) => !avoid.has(x) && !staples.has(x));
  const words = sample(fresh(GAALI_WORDS), Math.min(6, n), rng);
  const rest = sample(fresh(GAALI_PHRASES), n - words.length, rng);
  const picked = [...words, ...rest];
  if (picked.length >= n) return picked;
  // Everything was used recently: start over rather than offer nothing.
  const again = sample(GAALI_POOL.filter((x) => !picked.includes(x) && !staples.has(x)), n - picked.length, rng);
  return [...picked, ...again];
}
