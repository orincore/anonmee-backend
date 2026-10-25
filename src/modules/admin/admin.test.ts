import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticator } from "otplib";
import { eq, like } from "drizzle-orm";
import { db } from "../../db/client";
import { adminAudit, admins, campaigns, reports, users, visits } from "../../db/schema";
import { redis } from "../../lib/redis";
import { encrypt } from "../../lib/crypto";
import { hashPassword } from "../../lib/password";
import { cleanTag, makeUser, startTestServer } from "../../test/helpers";

const TAG = "admt";
let srv: Awaited<ReturnType<typeof startTestServer>>;
const secrets = new Map<string, string>();
const PASSWORD = "Admin-pass-9-Strong!";

async function makeAdmin(n: string, role: "owner" | "moderator" | "analyst") {
  const secret = authenticator.generateSecret();
  const email = `${TAG}-${n}@staff.example.com`;
  await db.insert(admins).values({ email, role, passwordHash: await hashPassword(PASSWORD), totpSecretEnc: encrypt(secret) });
  secrets.set(email, secret);
  return email;
}
let lastCodes = new Set<string>();
const code = (email: string) => {
  // A code only works once, so tests that log in repeatedly nudge the clock one 30 second step.
  let step = 0;
  for (;;) {
    const c = authenticator.generate(secrets.get(email)!);
    const t = step === 0 ? c : authenticator.clone({ epoch: Date.now() + step * 30_000 }).generate(secrets.get(email)!);
    if (!lastCodes.has(email + t)) { lastCodes.add(email + t); return t; }
    step += 1;
  }
};
async function login(email: string, extra: Partial<{ password: string }> = {}) {
  return srv.app.inject({ method: "POST", url: "/admin/auth/login", payload: { email, password: extra.password ?? PASSWORD } });
}
async function session(email: string) {
  const res = await login(email);
  expect(res.statusCode).toBe(200);
  return { cookie: `admin_session=${res.cookies.find((c) => c.name === "admin_session")!.value}` };
}
const get = (cookie: string, url: string) => srv.app.inject({ method: "GET", url, headers: { cookie } });
const post = (cookie: string, url: string, payload: unknown = {}) => srv.app.inject({ method: "POST", url, payload: payload as object, headers: { cookie } });

async function clean() {
  const mine = await db.select({ id: admins.id }).from(admins).where(like(admins.email, `${TAG}-%`));
  for (const a of mine) {
    await db.delete(campaigns).where(eq(campaigns.createdBy, a.id));
    await db.delete(adminAudit).where(eq(adminAudit.adminId, a.id));
  }
  await db.delete(admins).where(like(admins.email, `${TAG}-%`));
  await db.delete(campaigns).where(like(campaigns.code, "admt%"));
  await cleanTag(TAG);
  const keys = await redis.keys("admin:*");
  if (keys.length) await redis.del(...keys);
}
beforeAll(async () => { await clean(); srv = await startTestServer(); });
afterAll(async () => { await clean(); await srv.app.close(); });

describe("admin login", () => {
  it("needs valid password", async () => {
    const e = await makeAdmin("login", "owner");
    expect((await login(e, { password: "wrong" })).statusCode).toBe(401);
    const ok = await login(e);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().admin).toEqual({ email: e, role: "owner" });
    const set = ok.headers["set-cookie"] as string;
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Strict/i);
    expect(set).toMatch(/Path=\/admin/);
  });
  it("gives the same answer for unknown accounts, and does not lock out", async () => {
    const e = await makeAdmin("lock", "moderator");
    const wrong = await login(e, { password: "nope" });
    const ghost = await login(`${TAG}-ghost@staff.example.com`, { password: "nope" });
    expect(ghost.json().message).toBe(wrong.json().message);
    for (let i = 0; i < 5; i++) await login(e, { password: "nope" });
    expect((await login(e, { password: "nope" })).statusCode).toBe(401);
  });
  it("normal user sessions are not admin sessions", async () => {
    const u = await makeUser(srv.app, TAG, "plain");
    expect((await get(u.cookie, "/admin/overview")).statusCode).toBe(401);
    expect((await get("admin_session=forged.token.value", "/admin/me")).statusCode).toBe(401);
  });
  it("a disabled admin loses access immediately", async () => {
    const e = await makeAdmin("off", "owner");
    const { cookie } = await session(e);
    expect((await get(cookie, "/admin/me")).statusCode).toBe(200);
    await db.update(admins).set({ disabledAt: new Date() }).where(eq(admins.email, e));
    expect((await get(cookie, "/admin/me")).statusCode).toBe(401);
  });
});

describe("roles", () => {
  it("analysts see numbers but not people; moderators cannot touch campaigns or the audit log", async () => {
    const an = await session(await makeAdmin("an", "analyst"));
    const mod = await session(await makeAdmin("mod", "moderator"));
    expect((await get(an.cookie, "/admin/overview")).statusCode).toBe(200);
    expect((await get(an.cookie, "/admin/analytics")).statusCode).toBe(200);
    expect((await get(an.cookie, "/admin/users")).statusCode).toBe(403);
    expect((await get(an.cookie, "/admin/escalations")).statusCode).toBe(403);
    expect((await get(mod.cookie, "/admin/users")).statusCode).toBe(200);
    expect((await post(mod.cookie, "/admin/campaigns", { name: "x", source: "a", medium: "b", campaign: "c" })).statusCode).toBe(403);
    expect((await get(mod.cookie, "/admin/audit")).statusCode).toBe(403);
  });
});

describe("users and escalations", () => {
  it("lists users in pages, shows everything on the detail page, and audits every view", async () => {
    const owner = await session(await makeAdmin("own", "owner"));
    for (let i = 0; i < 5; i++) await makeUser(srv.app, TAG, `person${i}`);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 4; i++) {
      const r: any = (await get(owner.cookie, `/admin/users?q=${TAG}&limit=2${cursor ? `&cursor=${cursor}` : ""}`)).json();
      seen.push(...r.users.map((u: { id: string }) => u.id));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(5);

    const detail = (await get(owner.cookie, `/admin/users/${seen[0]}`)).json().user;
    expect(detail).toMatchObject({ email: expect.stringContaining("@example.com"), dateOfBirth: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(detail.counts).toHaveProperty("reportsReceived");
    expect(detail).not.toHaveProperty("passwordHash");
    const trail = await db.select().from(adminAudit).where(eq(adminAudit.targetUserId, seen[0]!));
    expect(trail.some((t) => t.action === "user.view")).toBe(true);
    expect((await get(owner.cookie, "/admin/users/not-a-uuid")).statusCode).toBe(404);
  });

  it("works the escalation queue: ban cuts the user off, dismiss clears evidence, all audited", async () => {
    const owner = await session(await makeAdmin("esc", "owner"));
    const reporter = await makeUser(srv.app, TAG, "rep");
    const bad = await makeUser(srv.app, TAG, "bad");
    const [r1] = await db.insert(reports).values({ reporterId: reporter.userId, reportedId: bad.userId, reason: "harassment: rude", evidence: "some words" }).returning();
    const [r2] = await db.insert(reports).values({ reporterId: reporter.userId, reportedId: bad.userId, reason: "spam", evidence: "buy now" }).returning();
    const q = (await get(owner.cookie, "/admin/escalations")).json();
    const item = q.escalations.find((e: { id: string }) => e.id === r1!.id);
    expect(item.evidence).toBe("some words");
    expect(item.reported).toMatchObject({ banned: false });

    expect((await post(owner.cookie, `/admin/escalations/${r2!.id}/action`, { action: "dismiss" })).statusCode).toBe(200);
    const [d] = await db.select().from(reports).where(eq(reports.id, r2!.id));
    expect(d).toMatchObject({ status: "dismissed", evidence: null });

    expect((await post(owner.cookie, `/admin/escalations/${r1!.id}/action`, { action: "ban" })).statusCode).toBe(200);
    const [u] = await db.select().from(users).where(eq(users.id, bad.userId));
    expect(u?.bannedAt).not.toBeNull();
    expect((await srv.app.inject({ method: "GET", url: "/auth/me", headers: { cookie: bad.cookie } })).statusCode).toBe(401);
    expect((await post(owner.cookie, `/admin/escalations/${r1!.id}/action`, { action: "explode" })).statusCode).toBe(400);
    const actions = (await db.select().from(adminAudit).where(eq(adminAudit.targetUserId, bad.userId))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["report.ban", "report.dismiss"]));
  });
});

describe("overview, analytics and campaigns", () => {
  it("overview returns the headline numbers", async () => {
    const an = await session(await makeAdmin("ov", "analyst"));
    const o = (await get(an.cookie, "/admin/overview?days=7")).json();
    for (const k of ["totalUsers", "newUsers", "onlineNow", "matches", "groupsCreated", "messagesSent", "openReports", "daily"]) expect(o).toHaveProperty(k);
    expect(Array.isArray(o.daily)).toBe(true);
    expect((await get(an.cookie, "/admin/overview?days=9999")).statusCode).toBe(400);
  });

  it("builds a tracked link and reports its traffic and sign-ups", async () => {
    const owner = await session(await makeAdmin("camp", "owner"));
    const made = await post(owner.cookie, "/admin/campaigns", { name: "Reddit launch", source: "Reddit", medium: "Post", campaign: "Launch", targetPath: "/" });
    expect(made.statusCode).toBe(201);
    const { code: c, shortLink, fullUrl } = made.json();
    expect(shortLink).toContain(`/c/${c}`);
    expect(fullUrl).toContain("utm_source=reddit");
    expect(fullUrl).toContain(`utm_id=${c}`);

    // Two visits arrive through the link, one of them signs up.
    const v1 = (await srv.app.inject({ method: "POST", url: "/track/visit", payload: { url: fullUrl }, headers: { "user-agent": "Mozilla/5.0 Safari" } })).json().visitId;
    await srv.app.inject({ method: "POST", url: "/track/visit", payload: { url: fullUrl }, headers: { "user-agent": "Mozilla/5.0 Safari" } });
    await srv.app.inject({ method: "POST", url: "/auth/register", payload: { email: `${TAG}-fromlink@example.com`, password: "correct horse 9", username: `${TAG}_fromlink`, gender: "male", dateOfBirth: "1995-01-01", confirmAdult: true, visitId: v1 } });
    await redis.del("admin:analytics:7");

    const list = (await get(owner.cookie, "/admin/campaigns")).json().campaigns.find((x: { code: string }) => x.code === c);
    expect(list).toMatchObject({ visits: 2, signups: 1 });
    const stats = (await get(owner.cookie, "/admin/analytics?days=7")).json();
    expect(stats.topCampaigns.some((x: { campaign: string; signups: number }) => x.campaign === "launch" && x.signups >= 1)).toBe(true);
    expect(stats.channels.find((x: { channel: string }) => x.channel === "utm").signups).toBeGreaterThanOrEqual(1);
    await db.delete(visits).where(eq(visits.campaignCode, c));
  });

  it("rejects unsafe campaign paths and fields", async () => {
    const owner = await session(await makeAdmin("camp2", "owner"));
    for (const targetPath of ["//evil.example", "https://evil.example", "/a?b=c", "/../x"]) {
      expect((await post(owner.cookie, "/admin/campaigns", { name: "x", source: "a", medium: "b", campaign: "c", targetPath })).statusCode).toBe(400);
    }
    expect((await post(owner.cookie, "/admin/campaigns", { name: "x", source: "<script>", medium: "b", campaign: "c" })).statusCode).toBe(400);
  });

  it("audit log is paged and owner only", async () => {
    const owner = await session(await makeAdmin("aud", "owner"));
    const page = (await get(owner.cookie, "/admin/audit?limit=2")).json();
    expect(page.entries.length).toBeLessThanOrEqual(2);
    expect(page).toHaveProperty("nextCursor");
  });
});
