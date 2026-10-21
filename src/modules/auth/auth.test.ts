import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";
import { db } from "../../db/client";
import { users } from "../../db/schema";

let app: FastifyInstance;
const TAG = "authtest";
const dob = (yearsAgo: number, extraDays = 0) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - yearsAgo);
  d.setUTCDate(d.getUTCDate() + extraDays);
  return d.toISOString().slice(0, 10);
};
const body = (n: string, o: Record<string, unknown> = {}) => ({
  email: `${TAG}-${n}@example.com`, password: "correct horse 9", username: `${TAG}_${n}`,
  gender: "female", dateOfBirth: dob(25), confirmAdult: true, ...o,
});
const post = (url: string, payload: unknown, cookies?: Record<string, string>) =>
  app.inject({ method: "POST", url, payload: payload as object, cookies });
const cookiesOf = (res: { cookies: { name: string; value: string }[] }) =>
  Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));

beforeAll(async () => {
  app = await buildApp(db);
  await db.delete(users).where(like(users.email, `${TAG}-%`));
});
afterAll(async () => {
  await db.delete(users).where(like(users.email, `${TAG}-%`));
  await app.close();
});

describe("register", () => {
  it("creates an account, sets session cookies, returns only self info", async () => {
    const res = await post("/auth/register", body("ok"));
    expect(res.statusCode).toBe(201);
    expect(res.json().user).toEqual({ username: `${TAG}_ok`, gender: "female", age: 25 });
    expect(Object.keys(cookiesOf(res))).toEqual(expect.arrayContaining(["access", "refresh"]));
    expect(res.body).not.toContain("example.com");
    expect(res.body).not.toContain("dateOfBirth");
  });
  it("rejects under 18, including the day before the 18th birthday", async () => {
    expect((await post("/auth/register", body("kid", { dateOfBirth: dob(17) }))).statusCode).toBe(400);
    expect((await post("/auth/register", body("kid2", { dateOfBirth: dob(18, 1) }))).statusCode).toBe(400);
  });
  it("accepts someone turning 18 today", async () => {
    expect((await post("/auth/register", body("eighteen", { dateOfBirth: dob(18) }))).statusCode).toBe(201);
  });
  it("requires the adult confirmation", async () => {
    const res = await post("/auth/register", body("noconf", { confirmAdult: false }));
    expect(res.statusCode).toBe(400);
  });
  it("rejects duplicate email and username with a clear field", async () => {
    const e = await post("/auth/register", body("other", { email: `${TAG}-ok@example.com` }));
    expect(e.statusCode).toBe(409);
    expect(e.json().field).toBe("email");
    const u = await post("/auth/register", body("other2", { username: `${TAG}_ok` }));
    expect(u.json().field).toBe("username");
  });
  it("rejects weak input", async () => {
    expect((await post("/auth/register", body("weak", { password: "short" }))).statusCode).toBe(400);
    expect((await post("/auth/register", body("bad name", { username: "no spaces!" }))).statusCode).toBe(400);
  });
});

describe("login, session, refresh, logout", () => {
  it("logs in with the right password and fails with the wrong one, same message for unknown email", async () => {
    expect((await post("/auth/login", { email: `${TAG}-ok@example.com`, password: "correct horse 9" })).statusCode).toBe(200);
    const wrong = await post("/auth/login", { email: `${TAG}-ok@example.com`, password: "nope nope" });
    const unknown = await post("/auth/login", { email: `${TAG}-ghost@example.com`, password: "nope nope" });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json().message).toBe(wrong.json().message);
  });
  it("me needs a session", async () => {
    expect((await app.inject({ method: "GET", url: "/auth/me" })).statusCode).toBe(401);
    const login = await post("/auth/login", { email: `${TAG}-ok@example.com`, password: "correct horse 9" });
    const me = await app.inject({ method: "GET", url: "/auth/me", cookies: { access: cookiesOf(login).access! } });
    expect(me.json().user.username).toBe(`${TAG}_ok`);
  });
  it("refresh rotates: the old refresh token stops working", async () => {
    const login = await post("/auth/login", { email: `${TAG}-ok@example.com`, password: "correct horse 9" });
    const old = cookiesOf(login).refresh!;
    const first = await post("/auth/refresh", {}, { refresh: old });
    expect(first.statusCode).toBe(200);
    expect((await post("/auth/refresh", {}, { refresh: old })).statusCode).toBe(401);
  });
  it("banned users cannot log in or use a session", async () => {
    await post("/auth/register", body("banned"));
    const login = await post("/auth/login", { email: `${TAG}-banned@example.com`, password: "correct horse 9" });
    const access = cookiesOf(login).access!;
    await db.update(users).set({ bannedAt: new Date() }).where(like(users.email, `${TAG}-banned@%`));
    expect((await post("/auth/login", { email: `${TAG}-banned@example.com`, password: "correct horse 9" })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/auth/me", cookies: { access } })).statusCode).toBe(401);
  });
  it("logout revokes refresh tokens", async () => {
    const login = await post("/auth/login", { email: `${TAG}-ok@example.com`, password: "correct horse 9" });
    const c = cookiesOf(login);
    expect((await post("/auth/logout", {}, c as Record<string, string>)).statusCode).toBe(200);
    expect((await post("/auth/refresh", {}, { refresh: c.refresh! })).statusCode).toBe(401);
  });
});
