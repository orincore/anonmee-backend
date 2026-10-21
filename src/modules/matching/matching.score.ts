import { isEligible, sharedIntents } from "./matching.rules";
import type { Ticket } from "./matching.types";

const W = { intent: 40, interests: 25, age: 15, wait: 20 } as const;
/** Waiting this long gives the full fairness bonus. */
const WAIT_FULL_S = 45;

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sb = new Set(b);
  const inter = a.filter((x) => sb.has(x)).length;
  return inter / (a.length + b.length - inter);
}

/** 0..100. Higher is a better pair. Returns -1 when the pair is not allowed at all. */
export function pairScore(a: Ticket, b: Ticket, now: number): number {
  if (!isEligible(a, b, now)) return -1;

  const shared = sharedIntents(a, b).length;
  const intent = shared / (a.intents.length + b.intents.length - shared);
  const interests = jaccard(a.interests, b.interests);

  const aMid = (a.minAge + a.maxAge) / 2;
  const bMid = (b.minAge + b.maxAge) / 2;
  const agePull = 1 - Math.min(Math.abs(a.age - bMid) + Math.abs(b.age - aMid), 20) / 20;

  // The longer the longer-waiting side has waited, the more any valid match is worth taking.
  const waited = Math.max(now - a.enqueuedAt, now - b.enqueuedAt) / 1000;
  const wait = Math.min(waited / WAIT_FULL_S, 1);

  return W.intent * intent + W.interests * interests + W.age * agePull + W.wait * wait;
}

/**
 * Best partner for `seeker` among `pool`, or null. Deterministic: ties go to the
 * longest waiter, then to the lower user id, so two runs never disagree.
 */
export function pickPartner(seeker: Ticket, pool: readonly Ticket[], now: number): Ticket | null {
  let best: Ticket | null = null;
  let bestScore = -1;
  for (const cand of pool) {
    const s = pairScore(seeker, cand, now);
    if (s < 0) continue;
    const better =
      s > bestScore ||
      (s === bestScore &&
        best !== null &&
        (cand.enqueuedAt < best.enqueuedAt ||
          (cand.enqueuedAt === best.enqueuedAt && cand.userId < best.userId)));
    if (better) {
      best = cand;
      bestScore = s;
    }
  }
  return best;
}
