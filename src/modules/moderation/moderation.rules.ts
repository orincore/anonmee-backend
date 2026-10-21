import type { ReportReason } from "../../contracts";

/** Distinct reporters in 24h that send an account to the human review queue. */
export const REVIEW_THRESHOLD = 3;
/** Distinct reporters in 24h that suspend an account until a human clears it. */
export const SUSPEND_THRESHOLD = 5;

export type ReportOutcome = "none" | "review" | "suspend" | "ban";

/**
 * What a new report does to the reported account. `distinctReporters24h` includes this report.
 * An "underage" report is the one case that acts immediately, because we have no minors on
 * the platform. A human can reverse it from the review queue.
 */
export function outcomeForReport(reason: ReportReason, distinctReporters24h: number): ReportOutcome {
  if (reason === "underage") return "ban";
  if (distinctReporters24h >= SUSPEND_THRESHOLD) return "suspend";
  if (distinctReporters24h >= REVIEW_THRESHOLD) return "review";
  return "none";
}

/** A user may not report the same person for the same room more than once. */
export function reportKey(reporterId: string, reportedId: string, roomId: string): string {
  return `${reporterId}:${reportedId}:${roomId}`;
}
