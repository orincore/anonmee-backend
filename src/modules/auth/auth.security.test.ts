import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";
import { db } from "../../db/client";
import { refreshTokens, users } from "../../db/schema";
import { redis } from "../../lib/redis";

let app: FastifyInstance;
const TAG = "sectest";
const email = (n: string) => `${TAG}-${n}@example.com`;
const reg = (n: string, o: Record<string, unknown> = {}) => ({
  email: email(n), password: "correct horse 9", username: `${TAG}_${n}`, gender: "male",
  dateOfBirth: "1995-01-01", confirmAdult: true, ...o,
});
const post = (url: string, payload: unknown, extra: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url, payload: payload as object, ...extra });
const cookiesOf = (res: { cookies: { name: string; value: string }[] }) =>
  Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));

async function clean() {
  await db.delete(users).where(like(users.email, `${TAG}-%`));
  const keys = await redis.keys(`thr:login:*${TAG}-*`);
  if (keys.length) await redis.del(...keys);
}
beforeAll(async () => {
  app = await buildApp(db);
  await clean();
});
afterAll(async () => {
  await clean();
  await app.close();
  redis.disconnect();
});

describe("A01/A05 access and configuration", () => {
  it("sets hardened response headers", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
  it("blocks state-changing requests from another origin (CSRF)", async () => {
    const res = await post("/auth/login", { email: email("x"), password: "x" }, { headers: { origin: "https://evil.example" } });
    expect(res.statusCode).toBe(403);
  });
  it("allows the real web origin", async () => {
    const res = await post("/auth/login", { email: email("x"), password: "x" }, { headers: { origin: process.env.WEB_ORIGIN! } });
    expect(res.statusCode).toBe(401);
  });
  it("refuses oversized bodies and non-JSON content", async () => {
    expect((await post("/auth/register", { pad: "a".repeat(20_000) })).statusCode).toBe(413);
    const form = await app.inject({ method: "POST", url: "/auth/login", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "email=a&password=b" });
    expect(form.statusCode).toBe(415);
  });
  it("does not leak internals in errors", async () => {
    const res = await post("/auth/register", "{not json", { headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toMatch(/at .*\.(ts|js)|node_modules|SyntaxError/);
  });
});

describe("A03 injection", () => {
  it("treats SQL metacharacters as plain data", async () => {
    const evil = "x'; drop table users;--";
    expect((await post("/auth/login", { email: `${evil}@example.com`, password: evil })).statusCode).toBe(400);
    expect((await post("/auth/register", reg("inj", { username: evil }))).statusCode).toBe(400);
    expect((await db.select().from(users).limit(1)).length).toBeGreaterThanOrEqual(0); // table still exists
  });
  it("ignores unexpected fields (no mass assignment)", async () => {
    const res = await post("/auth/register", reg("mass", { bannedAt: "2020-01-01", id: "00000000-0000-0000-0000-000000000000", isAdmin: true }));
    expect(res.statusCode).toBe(201);
    const [row] = await db.select().from(users).where(eq(users.email, email("mass")));
    expect(row?.bannedAt).toBeNull();
    expect(row?.id).not.toBe("00000000-0000-0000-0000-000000000000");
  });
});

describe("A02 cryptography and data exposure", () => {
  it("stores an argon2id hash, never the password, and never returns it", async () => {
    const res = await post("/auth/register", reg("hash"));
    const [row] = await db.select().from(users).where(eq(users.email, email("hash")));
    expect(row?.passwordHash.startsWith("$argon2id$")).toBe(true);
    expect(res.body).not.toContain("argon2");
    expect(res.body).not.toContain("correct horse");
  });
  it("stores only a hash of refresh tokens", async () => {
    const res = await post("/auth/login", { email: email("hash"), password: "correct horse 9" });
    const token = cookiesOf(res).refresh!;
    const rows = await db.select().from(refreshTokens);
    expect(rows.some((r) => r.tokenHash === token)).toBe(false);
  });
  it("sets httpOnly SameSite cookies, refresh limited to /auth", async () => {
    const res = await post("/auth/login", { email: email("hash"), password: "correct horse 9" });
    const set = res.headers["set-cookie"] as string[];
    expect(set.every((c) => /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c))).toBe(true);
    expect(set.find((c) => c.startsWith("refresh="))).toMatch(/Path=\/auth/);
  });
});

describe("A07 authentication failures", () => {
  it("locks an account after repeated failures, even with the right password afterwards", async () => {
    await post("/auth/register", reg("lock"));
    for (let i = 0; i < 5; i++) {
      expect((await post("/auth/login", { email: email("lock"), password: "wrong wrong" })).statusCode).toBe(401);
    }
    const locked = await post("/auth/login", { email: email("lock"), password: "correct horse 9" });
    expect(locked.statusCode).toBe(429);
  });
  it("a different IP cannot spoof its way around the limiter via X-Forwarded-For", async () => {
    for (let i = 0; i < 6; i++) {
      await post("/auth/login", { email: email("lock"), password: "x" }, { headers: { "x-forwarded-for": `9.9.9.${i}` } });
    }
    const res = await post("/auth/login", { email: email("lock"), password: "correct horse 9" }, { headers: { "x-forwarded-for": "8.8.8.8" } });
    expect(res.statusCode).toBe(429);
  });
  it("reusing a rotated refresh token revokes the whole session family", async () => {
    await post("/auth/register", reg("theft"));
    const login = await post("/auth/login", { email: email("theft"), password: "correct horse 9" });
    const stolen = cookiesOf(login).refresh!;
    const rotated = await post("/auth/refresh", {}, { cookies: { refresh: stolen } });
    const fresh = cookiesOf(rotated).refresh!;
    expect((await post("/auth/refresh", {}, { cookies: { refresh: stolen } })).statusCode).toBe(401); // attacker replay
    expect((await post("/auth/refresh", {}, { cookies: { refresh: fresh } })).statusCode).toBe(401); // victim token now dead too
  });
  it("rejects forged and tampered access tokens", async () => {
    const forged = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJhbnlvbmUifQ.";
    expect((await app.inject({ method: "GET", url: "/auth/me", cookies: { access: forged } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/auth/me", cookies: { access: "garbage" } })).statusCode).toBe(401);
  });
});
