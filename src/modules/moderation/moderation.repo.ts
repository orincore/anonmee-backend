import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { blocks, reports, users } from "../../db/schema";

export function moderationRepo(db: Db) {
  return {
    /** Idempotent: blocking someone twice is fine. */
    async addBlock(blockerId: string, blockedId: string) {
      await db.insert(blocks).values({ blockerId, blockedId }).onConflictDoNothing();
    },

    async removeBlock(blockerId: string, blockedId: string) {
      await db.delete(blocks).where(and(eq(blocks.blockerId, blockerId), eq(blocks.blockedId, blockedId)));
    },

    /** Everyone this user blocked or was blocked by. Fed into matching and group recommendations. */
    async blockedEitherWay(userId: string): Promise<Set<string>> {
      const rows = await db
        .select({ a: blocks.blockerId, b: blocks.blockedId })
        .from(blocks)
        .where(sql`${blocks.blockerId} = ${userId} or ${blocks.blockedId} = ${userId}`);
      return new Set(rows.map((r) => (r.a === userId ? r.b : r.a)));
    },

    async insertReport(r: {
      reporterId: string;
      reportedId: string;
      roomId: string;
      reason: string;
      evidence: string | null;
    }) {
      await db.insert(reports).values(r);
    },

    async distinctReporters24h(reportedId: string): Promise<number> {
      const since = new Date(Date.now() - 24 * 3_600_000);
      const [row] = await db
        .select({ n: sql<number>`count(distinct ${reports.reporterId})::int` })
        .from(reports)
        .where(and(eq(reports.reportedId, reportedId), gte(reports.createdAt, since)));
      return row?.n ?? 0;
    },

    async setBanned(userId: string) {
      await db.update(users).set({ bannedAt: new Date() }).where(eq(users.id, userId));
    },
  };
}
export type ModerationRepo = ReturnType<typeof moderationRepo>;
