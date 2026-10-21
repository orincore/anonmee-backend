import { SAME_GENDER } from "../../contracts";
import type { Ticket } from "./matching.types";

/** Seconds waited before the age window widens, and by how many years. */
const AGE_RELAX_AFTER_S = 20;
const AGE_RELAX_YEARS = 3;

/** Extra years of age tolerance a ticket has earned by waiting. Gender and intent never relax. */
export function ageSlack(t: Ticket, now: number): number {
  return (now - t.enqueuedAt) / 1000 >= AGE_RELAX_AFTER_S ? AGE_RELAX_YEARS : 0;
}

function acceptsAge(viewer: Ticket, other: Ticket, now: number): boolean {
  const slack = ageSlack(viewer, now);
  return other.age >= viewer.minAge - slack && other.age <= viewer.maxAge + slack;
}

/** The exact choices two people have in common. "Same gender" only counts when they really are the same gender. */
export function sharedIntents(a: Ticket, b: Ticket) {
  return a.intents.filter((i) => b.intents.includes(i) && (i !== SAME_GENDER || a.gender === b.gender));
}

/**
 * Hard filters. Every one must hold in BOTH directions, so nobody is ever matched
 * with someone they did not ask for, or who did not ask for them.
 */
export function isEligible(a: Ticket, b: Ticket, now: number): boolean {
  if (a.userId === b.userId) return false;
  if (a.blocked.has(b.userId) || b.blocked.has(a.userId)) return false;
  if (a.recentPartners.has(b.userId) || b.recentPartners.has(a.userId)) return false;
  if (!a.wantGenders.includes(b.gender) || !b.wantGenders.includes(a.gender)) return false;
  if (!acceptsAge(a, b, now) || !acceptsAge(b, a, now)) return false;
  return sharedIntents(a, b).length > 0;
}
