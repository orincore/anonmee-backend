import { z } from "zod";

export const REPORT_REASONS = [
  "harassment",
  "spam",
  "inappropriate",
  "underage",
  "scam",
  "other",
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  harassment: "Harassment or hate",
  spam: "Spam",
  inappropriate: "Inappropriate content",
  underage: "Seems under 18",
  scam: "Scam or money request",
  other: "Something else",
};

/**
 * Users are only known to each other by alias, so reports and blocks name a room and an
 * alias, never an account id. The server resolves who that is.
 */
export const reportSchema = z.object({
  roomId: z.string().min(1).max(64),
  alias: z.string().min(1).max(40),
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(400).default(""),
  /** Also block this person. On by default in the UI. */
  alsoBlock: z.boolean().default(true),
});
export type ReportInput = z.infer<typeof reportSchema>;

export const blockSchema = reportSchema.pick({ roomId: true, alias: true });
export type BlockInput = z.infer<typeof blockSchema>;
