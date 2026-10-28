/** What the AI user says when the person goes quiet, and when it leaves. Fixed lines, so no model tokens. Pure, unit tested. */

// Neutral wording on purpose: Hindi verbs would give away the AI user's gender, or guess the person's.
export const PINGS = [
  "hello? ho kya wahan?",
  "oye, available ho abhi?",
  "hii, busy ho kya?",
  "kaha ho tum? 👀",
  "are you there?",
  "hello?? koi hai 😅",
  "abhi chat pe ho ya nahi?",
];

export const IDLE_GOODBYES = [
  "lagta hai tum busy ho, baad me baat karte hain. bye 👋",
  "koi reply nahi aaya, chalo baad me baat karte hain. bye",
  "okay no worries, baad me milte hain. take care 🙂",
];

export const SKIP_GOODBYES = [
  "mujhe ye sab accha nahi lag raha. bye",
  "bas, itna kaafi hai. bye",
  "aise baat karni hai to mujhse nahi hogi. bye",
  "ye chat yahi khatam karte hain. bye",
];

export const pickLine = (lines: readonly string[], rng: () => number = Math.random) => lines[Math.floor(rng() * lines.length)]!;

/** Silence before the "are you there?" message: about one to two minutes. */
export const pingAfterMs = (rng: () => number = Math.random) => Math.round(55_000 + rng() * 65_000);
/** Silence after that before the chat is closed: another minute or two. */
export const closeAfterMs = (rng: () => number = Math.random) => Math.round(60_000 + rng() * 60_000);
