import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { campaigns, users, visits } from "../../db/schema";
import type { Attribution } from "./attribution";

export function analyticsRepo(db: Db) {
  return {
    async recordVisit(v: Attribution & { visitorId: string; landingPath: string }): Promise<string> {
      const [row] = await db.insert(visits).values({
        visitorId: v.visitorId, landingPath: v.landingPath.slice(0, 200), channel: v.channel, source: v.source,
        medium: v.medium, campaign: v.campaign, content: v.content, term: v.term,
        referrerHost: v.referrerHost, campaignCode: v.campaignCode,
      }).returning({ id: visits.id });
      return row!.id;
    },

    /** Credits a new account to the visit that brought it. First touch only, and only once per visit. */
    async attributeSignup(visitId: string, userId: string): Promise<void> {
      const [v] = await db.update(visits).set({ signedUpUserId: userId })
        .where(and(eq(visits.id, visitId), isNull(visits.signedUpUserId))).returning();
      if (!v) return;
      await db.update(users).set({
        acquisitionChannel: v.channel,
        acquisitionSource: v.source,
        acquisitionCampaign: v.campaign,
      }).where(eq(users.id, userId));
    },

    async campaignByCode(code: string) {
      const [c] = await db.select().from(campaigns).where(and(eq(campaigns.code, code), isNull(campaigns.archivedAt))).limit(1);
      return c;
    },
  };
}
export type AnalyticsRepo = ReturnType<typeof analyticsRepo>;
