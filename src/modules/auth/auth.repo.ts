import { and, eq, gt, isNull, or } from "drizzle-orm";
import { GENDERS } from "../../contracts";
import type { Db } from "../../db/client";
import { preferences, refreshTokens, users } from "../../db/schema";

export type UserRow = typeof users.$inferSelect;
type NewUser = Pick<typeof users.$inferInsert, "email" | "passwordHash" | "username" | "gender" | "dateOfBirth"> & { emailVerifiedAt?: Date | null };

export function authRepo(db: Db) {
  return {
    async findByEmail(email: string): Promise<UserRow | undefined> {
      return (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
    },
    async findByUsername(username: string): Promise<UserRow | undefined> {
      return (await db.select().from(users).where(eq(users.username, username)).limit(1))[0];
    },
    async findById(id: string): Promise<UserRow | undefined> {
      return (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
    },
    async emailOrUsernameTaken(email: string, username: string) {
      const rows = await db
        .select({ email: users.email, username: users.username })
        .from(users)
        .where(or(eq(users.email, email), eq(users.username, username)));
      return { email: rows.some((r) => r.email === email), username: rows.some((r) => r.username === username) };
    },
    /** User and default preferences are created together or not at all. */
    async createUser(u: NewUser): Promise<UserRow> {
      return db.transaction(async (tx) => {
        const [row] = await tx.insert(users).values(u).returning();
        await tx.insert(preferences).values({
          userId: row!.id,
          intents: ["casual_chat"],
          wantGenders: [...GENDERS],
        });
        return row!;
      });
    },
    async saveRefresh(userId: string, tokenHash: string, expiresAt: Date) {
      await db.insert(refreshTokens).values({ userId, tokenHash, expiresAt });
    },
    /** Rotation: a refresh token works once. Returns the owner, or null if unknown, used or expired. */
    async consumeRefresh(tokenHash: string): Promise<string | null> {
      const [row] = await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, new Date())))
        .returning({ userId: refreshTokens.userId });
      return row?.userId ?? null;
    },
    /** Owner of a refresh token that exists but was already revoked (reuse), else null. */
    async ownerOfUsedRefresh(tokenHash: string): Promise<string | null> {
      const [row] = await db.select({ userId: refreshTokens.userId, revokedAt: refreshTokens.revokedAt })
        .from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash)).limit(1);
      return row?.revokedAt ? row.userId : null;
    },
    async revokeAllRefresh(userId: string) {
      await db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
    },
    /** Removes the person and, through the database's cascade rules, everything that belongs to them. */
    async deleteUser(id: string) {
      await db.delete(users).where(eq(users.id, id));
    },
    async touchLastSeen(id: string) {
      await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, id));
    },
    async markEmailVerified(userId: string): Promise<UserRow | undefined> {
      const [row] = await db
        .update(users)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(users.id, userId))
        .returning();
      return row;
    },
    async markEmailVerifiedByEmail(email: string): Promise<UserRow | undefined> {
      const [row] = await db
        .update(users)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(users.email, email.toLowerCase()))
        .returning();
      return row;
    },
  };
}
export type AuthRepo = ReturnType<typeof authRepo>;
