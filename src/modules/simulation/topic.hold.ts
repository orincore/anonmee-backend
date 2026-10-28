/**
 * The topic a real person raises in a shared room stays the topic: it is held for 15 minutes after they last spoke
 * about it, instead of being replaced by every new message. Pure, unit tested.
 */

export const HOLD_MS = 15 * 60_000;

export interface TopicHold {
  /** The person's own words, as they raised it. */
  topic: string;
  startedAt: number;
  /** The last time a real person spoke about it. The hold ends HOLD_MS after this. */
  lastMentionAt: number;
  /** How many batches of room chatter have been written about it. The first opens the topic, later ones keep it going. */
  batches: number;
}

const STOP = new Set([
  "hai", "h", "hu", "ho", "hain", "kya", "ki", "ka", "ke", "ko", "se", "me", "mein", "par", "pe", "to", "toh", "aur", "or", "bhi", "ye", "yeh", "wo", "woh",
  "tum", "tu", "main", "mai", "mera", "meri", "mere", "tera", "teri", "apna", "hum", "nhi", "nahi", "na", "koi", "kuch", "is", "us", "the", "and", "you", "are",
  "that", "this", "with", "for", "have", "has", "was", "not", "but", "what", "how", "why", "kaise", "kyu", "kyun", "kab", "kahan", "kaun", "yaar", "bro", "bhai", "lol", "haha",
  // pronouns, helpers and fillers that say nothing about the subject
  "mujhe", "mujhko", "tumhe", "tumko", "usne", "usko", "unhe", "unko", "hamara", "tumhara", "tumhari", "uska", "uski", "unka", "aaya", "gaya", "gayi", "aayi", "tha", "thi", "the",
  "raha", "rahi", "rahe", "rha", "rhi", "rhe", "phir", "abhi", "bahut", "bohot", "bht", "der", "tak", "bas", "sirf", "jaise", "jisme", "jiska", "kisi", "sabke", "sab", "kal", "aaj",
  "ek", "kar", "karo", "karna", "karta", "karti", "kiya", "liya", "diya", "bola", "bole", "wala", "wali", "sach", "sahi", "aise", "waise", "kyunki", "lekin", "agar", "jab", "tab",
  "hua", "hui", "hue", "hota", "hoti", "hote", "hona", "wahi", "yahi", "kaisa", "kaisi", "kaise", "can", "will", "just", "like", "really", "very", "about", "they", "them", "your", "from", "when", "then", "there", "their",
]);

/** A word that carries meaning, not a filler like "hai" or "kya". */
export const isContentWord = (w: string): boolean => w.length >= 3 && !STOP.has(w.toLowerCase());

/** The words that carry the subject: not fillers, not "hai" and "kya". */
export function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/\p{L}{3,}/gu) ?? []).filter(isContentWord);
}

const WORDS = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

/** Enough to be a topic: not a greeting, a reaction, or a single word. */
export const isSubstantive = (text: string): boolean => WORDS(text) >= 4 && contentWords(text).length >= 2;

const SHIFT = /^\s*(?:btw|by the way|waise|anyway|acha suno|ek baat|ek aur baat|kuch aur|topic change|baat badlo|chhodo|chodo ye sab|new topic|let'?s talk about|chalo ab)\b/i;

/**
 * Has the person moved on to a different subject? Only when they say so, or write a long message that has nothing in
 * common with the topic. A short reaction, a question back or a remark is the same conversation.
 */
export function isNewSubject(text: string, topic: string): boolean {
  if (SHIFT.test(text)) return true;
  if (WORDS(text) < 12) return false;
  const held = new Set(contentWords(topic));
  return !contentWords(text).some((w) => held.has(w));
}

const fresh = (text: string, now: number): TopicHold => ({ topic: text.trim().slice(0, 140), startedAt: now, lastMentionAt: now, batches: 0 });

/** The hold after a real person writes `text`. */
export function updateTopic(hold: TopicHold | null, text: string, now: number): TopicHold | null {
  const active = hold && now - hold.lastMentionAt < HOLD_MS ? hold : null;
  if (active) return isNewSubject(text, active.topic) && isSubstantive(text) ? fresh(text, now) : { ...active, lastMentionAt: now };
  return isSubstantive(text) ? fresh(text, now) : null;
}

/** The topic to keep going right now, or null once it has gone quiet for 15 minutes. */
export function activeTopic(hold: TopicHold | null, now: number): TopicHold | null {
  return hold && now - hold.lastMentionAt < HOLD_MS ? hold : null;
}
