import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";
import { db } from "../../db/client";
import { campaigns, users, visits } from "../../db/schema";

let app: FastifyInstance;
const TAG = "anltest";
const WEB = () => process.env.WEB_ORIGIN!;
const UA = { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1" };
const track = (url: string, referrer?: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/track/visit", payload: { url, referrer }, headers: { ...UA, ...headers } });

beforeAll(async () => {
  app = await buildApp(db);
  await db.delete(users).where(like(users.email, `${TAG}-%`));
  await db.delete(campaigns).where(like(campaigns.code, "tst%"));
});
afterAll(async () => {
  await db.delete(users).where(like(users.email, `${TAG}-%`));
  await db.delete(campaigns).where(like(campaigns.code, "tst%"));
  await db.delete(visits).where(eq(visits.landingPath, "/anl-test"));
  await app.close();
});

describe("visit tracking", () => {
  it("records a tagged visit with its campaign", async () => {
    const res = await track(`${WEB()}/anl-test?utm_source=Reddit&utm_medium=post&utm_campaign=Launch&utm_id=tst001`);
    expect(res.statusCode).toBe(200);
    const [v] = await db.select().from(visits).where(eq(visits.id, res.json().visitId));
    expect(v).toMatchObject({ channel: "utm", source: "reddit", campaign: "launch", campaignCode: "tst001" });
  });
  it("classifies search and AI assistant traffic", async () => {
    const seo = await track(`${WEB()}/anl-test`, "https://www.google.com/");
    const llm = await track(`${WEB()}/anl-test`, "https://chatgpt.com/");
    const rows = await Promise.all([seo, llm].map((r) => db.select().from(visits).where(eq(visits.id, r.json().visitId))));
    expect(rows.map((r) => r[0]!.channel)).toEqual(["seo", "llm"]);
  });
  it("ignores bots, other sites' URLs, and garbage", async () => {
    expect((await track(`${WEB()}/anl-test`, undefined, { "user-agent": "Googlebot/2.1" })).json().visitId).toBeUndefined();
    expect((await track("https://evil.example/anl-test")).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/track/visit", payload: { url: "nope" }, headers: UA })).statusCode).toBe(400);
  });
  it("sets a visitor cookie, but not when Do Not Track or GPC is on", async () => {
    expect((await track(`${WEB()}/anl-test`)).cookies.some((c) => c.name === "vid")).toBe(true);
    expect((await track(`${WEB()}/anl-test`, undefined, { dnt: "1" })).cookies.some((c) => c.name === "vid")).toBe(false);
    expect((await track(`${WEB()}/anl-test`, undefined, { "sec-gpc": "1" })).cookies.some((c) => c.name === "vid")).toBe(false);
  });
  it("stores no IP address or user agent", async () => {
    const cols = Object.keys((await db.select().from(visits).limit(1))[0] ?? { x: 1 }).join(",");
    expect(cols).not.toMatch(/ip|agent/i);
  });
});

describe("sign-up attribution", () => {
  it("credits a new account to the link that brought it, once", async () => {
    const v = (await track(`${WEB()}/anl-test?utm_source=tiktok&utm_medium=video&utm_campaign=spring`)).json().visitId;
    const body = (n: string) => ({ email: `${TAG}-${n}@example.com`, password: "correct horse 9", username: `${TAG}_${n}`, gender: "male", dateOfBirth: "1995-01-01", confirmAdult: true, visitId: v });
    expect((await app.inject({ method: "POST", url: "/auth/register", payload: body("a") })).statusCode).toBe(201);
    const [u] = await db.select().from(users).where(eq(users.email, `${TAG}-a@example.com`));
    expect(u).toMatchObject({ acquisitionChannel: "utm", acquisitionSource: "tiktok", acquisitionCampaign: "spring" });
    // The same visit cannot be claimed by a second account.
    await app.inject({ method: "POST", url: "/auth/register", payload: body("b") });
    const [u2] = await db.select().from(users).where(eq(users.email, `${TAG}-b@example.com`));
    expect(u2?.acquisitionChannel).toBeNull();
  });
  it("a bogus visit id never blocks sign-up", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/register", payload: { email: `${TAG}-c@example.com`, password: "correct horse 9", username: `${TAG}_c`, gender: "male", dateOfBirth: "1995-01-01", confirmAdult: true, visitId: "00000000-0000-0000-0000-000000000000" } });
    expect(res.statusCode).toBe(201);
  });
});

describe("short links", () => {
  it("redirects to the landing page with full tags and never to another site", async () => {
    await db.insert(campaigns).values({ code: "tstok1", name: "Test", source: "reddit", medium: "post", campaign: "launch", targetPath: "/anl-test" });
    const ok = await app.inject({ method: "GET", url: "/c/tstok1" });
    expect(ok.statusCode).toBe(302);
    const okR = await app.inject({ method: "GET", url: "/r/tstok1" });
    expect(okR.statusCode).toBe(302);
    const loc = new URL(ok.headers.location as string);
    expect(loc.origin).toBe(WEB());
    expect(loc.pathname).toBe("/anl-test");
    expect(Object.fromEntries(loc.searchParams)).toMatchObject({ utm_source: "reddit", utm_medium: "post", utm_campaign: "launch", utm_id: "tstok1" });

    await db.insert(campaigns).values({ code: "tstbad", name: "Bad", source: "x", medium: "y", campaign: "z", targetPath: "//evil.example" });
    const bad = new URL((await app.inject({ method: "GET", url: "/r/tstbad" })).headers.location as string);
    expect(bad.origin).toBe(WEB());
    expect(bad.pathname).toBe("/");
    const unknown = new URL((await app.inject({ method: "GET", url: "/r/nosuchcode" })).headers.location as string);
    expect(unknown.origin).toBe(WEB());
    const weird = await app.inject({ method: "GET", url: "/r/..%2F..%2Fevil" });
    expect(new URL(weird.headers.location as string).origin).toBe(WEB());
  });
});
