import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { groupMembers, groups, users } from "../../db/schema";
import type { GroupCandidate } from "./groups.recommend";

export type GroupRow = typeof groups.$inferSelect;

export class GroupGone extends Error {}

export function groupsRepo(db: Db) {
  return {
    async create(ownerId: string, g: { title: string; topic: string; description: string }, alias: string): Promise<GroupRow> {
      return db.transaction(async (tx) => {
        const [row] = await tx.insert(groups).values({ ownerId, ...g, tags: [g.topic], memberCount: 1 }).returning();
        await tx.insert(groupMembers).values({ groupId: row!.id, userId: ownerId, alias });
        return row!;
      });
    },

    async get(id: string) {
      const [row] = await db.select().from(groups).where(eq(groups.id, id)).limit(1);
      return row;
    },

    /** Newest-first keyset page: stable while new groups keep arriving, never repeats or skips. */
    async list(opts: { topic?: string; cursor?: { at: Date; id: string }; limit: number }) {
      const where = and(
        isNull(groups.closedAt),
        opts.topic ? eq(groups.topic, opts.topic) : undefined,
        opts.cursor
          ? or(lt(groups.createdAt, opts.cursor.at), and(eq(groups.createdAt, opts.cursor.at), lt(groups.id, opts.cursor.id)))
          : undefined,
      );
      return db.select().from(groups).where(where).orderBy(desc(groups.createdAt), desc(groups.id)).limit(opts.limit + 1);
    },

    async feedCandidates(): Promise<GroupCandidate[]> {
      const rows = await db.select({
        id: groups.id, topic: groups.topic, tags: groups.tags,
        createdAt: groups.createdAt, ownerId: groups.ownerId, members: groups.memberCount,
      }).from(groups).where(isNull(groups.closedAt)).orderBy(desc(groups.createdAt), desc(groups.id)).limit(300);
      // Activity comes from Redis, filled in by the caller. Nothing here counts rows.
      return rows.map((r) => ({
        id: r.id, topic: r.topic, tags: r.tags, memberCount: r.members,
        messagesLast10m: 0, createdAt: r.createdAt.getTime(), ownerId: r.ownerId,
      }));
    },

    /** Several groups at once, for turning a ranked list of ids into full cards. */
    async getMany(ids: string[]) {
      return ids.length ? db.select().from(groups).where(inArray(groups.id, ids)) : [];
    },

    async joinedIds(userId: string): Promise<Set<string>> {
      const rows = await db.select({ id: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.userId, userId));
      return new Set(rows.map((r) => r.id));
    },

    async memberAlias(groupId: string, userId: string): Promise<string | null> {
      const [row] = await db.select({ alias: groupMembers.alias }).from(groupMembers)
        .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId))).limit(1);
      return row?.alias ?? null;
    },

    async userByAlias(groupId: string, alias: string): Promise<string | null> {
      const [row] = await db.select({ id: groupMembers.userId }).from(groupMembers)
        .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.alias, alias))).limit(1);
      return row?.id ?? null;
    },

    /**
     * No cap on members, so no lock is needed: the primary key makes a double join a no-op.
     * Joining twice returns the alias already assigned.
     */
    async join(groupId: string, userId: string, newAlias: string): Promise<{ alias: string; alreadyMember: boolean }> {
      const [g] = await db.select({ closedAt: groups.closedAt }).from(groups).where(eq(groups.id, groupId)).limit(1);
      if (!g || g.closedAt) throw new GroupGone();
      const inserted = await db.insert(groupMembers).values({ groupId, userId, alias: newAlias }).onConflictDoNothing().returning({ alias: groupMembers.alias });
      if (inserted.length) {
        // Atomic increment: concurrent joins never lose a count and no row lock is held.
        await db.update(groups).set({ memberCount: sql`${groups.memberCount} + 1` }).where(eq(groups.id, groupId));
        return { alias: newAlias, alreadyMember: false };
      }
      const existing = await this.memberAlias(groupId, userId);
      return { alias: existing ?? newAlias, alreadyMember: true };
    },

    /** Leaving removes the person; an empty group is closed so it drops out of every list. */
    async leave(groupId: string, userId: string): Promise<void> {
      await db.transaction(async (tx) => {
        const gone = await tx.delete(groupMembers).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId))).returning({ u: groupMembers.userId });
        if (!gone.length) return;
        const [g] = await tx.update(groups).set({ memberCount: sql`greatest(${groups.memberCount} - 1, 0)` }).where(eq(groups.id, groupId)).returning({ n: groups.memberCount });
        if (g && g.n === 0) await tx.update(groups).set({ closedAt: new Date() }).where(eq(groups.id, groupId));
      });
    },

    /** One page of members, oldest first, keyset on (joined_at, user_id). Cheap at any group size. */
    async members(groupId: string, limit: number, after?: { at: Date; userId: string }) {
      const where = and(
        eq(groupMembers.groupId, groupId),
        after ? or(gt(groupMembers.joinedAt, after.at), and(eq(groupMembers.joinedAt, after.at), gt(groupMembers.userId, after.userId))) : undefined,
      );
      return db.select({ alias: groupMembers.alias, gender: users.gender, dob: users.dateOfBirth, at: groupMembers.joinedAt, userId: groupMembers.userId })
        .from(groupMembers).innerJoin(users, eq(users.id, groupMembers.userId))
        .where(where).orderBy(asc(groupMembers.joinedAt), asc(groupMembers.userId)).limit(limit + 1);
    },
  };
}
export type GroupsRepo = ReturnType<typeof groupsRepo>;
