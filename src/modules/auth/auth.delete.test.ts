import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";
import { db } from "../../db/client";
import { preferences, users } from "../../db/schema";
import { redis } from "../../lib/redis";
import { makeUser } from "../../test/helpers";

let app: FastifyInstance;
const TAG = "deltest";
const PASSWORD = "correct horse 9";
const del = (cookie: string | undefined, body: unknown) =>
  app.inject({ method: "POST", url: "/auth/delete-account", payload: body as object, headers: cookie ? { cookie } : {} });
const exists = async (email: string) => (await db.select().from(users).where(eq(users.email, email))).length === 1;

beforeAll(async () => {
  app = await buildApp(db);
});
afterAll(async () => {
  await db.delete(users).where(like(users.email, `${TAG}-%`));
  const keys = await redis.keys("thr:login:*");
  if (keys.length) await redis.del(...keys);
  await app.close();
});

describe("deleting your own account", () => {
  it("needs a session, and a password", async () => {
    expect((await del(undefined, { password: PASSWORD })).statusCode).toBe(401);
    const u = await makeUser(app, TAG, "a");
    expect((await del(u.cookie, {})).statusCode).toBe(400);
    expect(await exists(`${TAG}-a@example.com`)).toBe(true);
  });

  it("refuses the wrong password and keeps the account", async () => {
    const u = await makeUser(app, TAG, "b");
    const res = await del(u.cookie, { password: "not the password" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("bad_password");
    expect(await exists(`${TAG}-b@example.com`)).toBe(true);
  });

  it("erases the account and everything that belonged to it, and ends the session", async () => {
    const u = await makeUser(app, TAG, "c", { prefs: { intents: ["friendship"], wantGenders: ["male"], minAge: 18, maxAge: 40, interests: [] } });
    const res = await del(u.cookie, { password: PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(await exists(`${TAG}-c@example.com`)).toBe(false);
    expect((await db.select().from(preferences).where(eq(preferences.userId, u.userId))).length).toBe(0);
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: u.cookie } })).statusCode).toBe(401);
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: `${TAG}-c@example.com`, password: PASSWORD } });
    expect(login.statusCode).toBe(401);
  });

  it("will not let a banned account delete itself to escape a ban", async () => {
    const u = await makeUser(app, TAG, "d");
    await db.update(users).set({ bannedAt: new Date() }).where(eq(users.id, u.userId));
    // A banned user's session no longer works either; confirm both ways of trying are refused.
    expect((await del(u.cookie, { password: PASSWORD })).statusCode).toBeGreaterThanOrEqual(401);
    expect(await exists(`${TAG}-d@example.com`)).toBe(true);
  });
});
