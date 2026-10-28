/**
 * How long a person takes before answering. Never the same beat twice: reading time grows with the message,
 * thinking time varies, and now and then they were simply away for a moment. Pure, unit tested.
 */

type Rng = () => number;

/** Delay before the first reply to a message of `chars` characters (about 2.5 to 32 seconds, usually 4 to 12). */
export function readThinkDelayMs(chars: number, rng: Rng = Math.random): number {
  const reading = Math.min(chars * 25, 3000);
  const thinking = 2000 + rng() * 7000;
  const distracted = rng() < 0.15 ? 5000 + rng() * 15_000 : 0;
  return Math.round(reading + thinking + distracted);
}

/** Delay before someone else in the room chimes in after an earlier reply (about 2 to 16 seconds). */
export function chimeInDelayMs(rng: Rng = Math.random): number {
  const base = 2000 + rng() * 6500;
  const late = rng() < 0.1 ? 4000 + rng() * 4000 : 0;
  return Math.round(base + late);
}

/**
 * How long a person stays quiet before the other side decides they are done and answers. Longer after a very
 * short message ("hi", "hey": a second message usually follows) or one that trails off, shorter after a finished question.
 */
export function settleGapMs(text: string, rng: Rng = Math.random): number {
  let gap = 1800 + rng() * 2700;
  const t = text.trim();
  if (/\?$/.test(t)) gap -= 600;
  if (t.length <= 12) gap += 1200;
  if (/(?:,|\.\.\.|…|\bki|\baur|\bbut|\bso)$/i.test(t)) gap += 900;
  return Math.round(Math.min(6000, Math.max(1200, gap)));
}

/**
 * How many messages an AI user sends in one turn: usually one, sometimes a quick second or third text, a bit
 * more often when the chat is flirty. Pure, unit tested.
 */
export function bubbleCount(heat?: "friendly" | "flirty" | "explicit", rng: Rng = Math.random): 1 | 2 | 3 {
  const shift = heat === "flirty" || heat === "explicit" ? 0.08 : 0;
  const r = rng();
  if (r < 0.68 - shift) return 1;
  return r < 0.92 - shift ? 2 : 3;
}

/** The short pause between two messages of the same turn, while the next one is being typed. */
export const betweenBubblesMs = (rng: Rng = Math.random) => Math.round(900 + rng() * 1800);
