import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { authRoutes } from "./auth.routes";
import { AuthError, authService } from "./auth.service";
import { verificationService } from "./verification.service";
import type { AuthRepo } from "./auth.repo";
import type { LoginThrottle } from "../../lib/throttle";

function setup() {
  const user = { id: "11111111-1111-1111-1111-111111111111", email: "a@gmail.com", username: "alice", passwordHash: "old", emailVerifiedAt: null as Date | null };
  const calls = { password: "", revoked: 0, verified: 0 };
  const sent: { to: string; code: string }[] = [];
  const repo = {
    findByEmail: async (e: string) => (e === user.email ? user : undefined),
    updatePassword: async (_id: string, hash: string) => { calls.password = hash; },
    revokeAllRefresh: async () => { calls.revoked++; },
    markEmailVerified: async () => { calls.verified++; },
  } as unknown as AuthRepo;
  const codes = verificationService(undefined, { keyPrefix: "pwreset", send: async (to, code) => { sent.push({ to, code }); } });
  const app = Fastify();
  app.register(cookie);
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AuthError) return reply.code(err.status).send({ error: err.code, message: err.message });
    return reply.code(500).send({ error: "server" });
  });
  app.register(authRoutes(authService(repo, {} as LoginThrottle, verificationService(), undefined, codes)));
  return { app, sent, calls };
}

describe("password reset", () => {
  it("answers the same for known and unknown emails, but only emails real accounts", async () => {
    const { app, sent } = setup();
    const known = await app.inject({ method: "POST", url: "/auth/forgot-password", payload: { email: "a@gmail.com" } });
    const unknown = await app.inject({ method: "POST", url: "/auth/forgot-password", payload: { email: "nobody@gmail.com" } });
    expect(known.statusCode).toBe(200);
    expect(unknown.json()).toEqual(known.json());
    expect(sent.map((s) => s.to)).toEqual(["a@gmail.com"]);
  });

  it("does not reveal an account when asked again inside the cooldown", async () => {
    const { app, sent } = setup();
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: "POST", url: "/auth/forgot-password", payload: { email: "a@gmail.com" } });
      expect(res.statusCode).toBe(200);
    }
    expect(sent).toHaveLength(1);
  });

  it("resets with the right code, signs out everywhere and rejects the code a second time", async () => {
    const { app, sent, calls } = setup();
    await app.inject({ method: "POST", url: "/auth/forgot-password", payload: { email: "a@gmail.com" } });
    const body = { email: "a@gmail.com", code: sent[0]!.code, password: "brand-new-pass" };
    const ok = await app.inject({ method: "POST", url: "/auth/reset-password", payload: body });
    expect(ok.statusCode).toBe(200);
    expect(calls.password).toMatch(/^\$argon2id\$/);
    expect(calls.revoked).toBe(1);
    expect(calls.verified).toBe(1);
    const again = await app.inject({ method: "POST", url: "/auth/reset-password", payload: body });
    expect(again.statusCode).toBe(400);
  });

  it("rejects a wrong code, short passwords, and locks the code after 5 misses", async () => {
    const { app, sent, calls } = setup();
    await app.inject({ method: "POST", url: "/auth/forgot-password", payload: { email: "a@gmail.com" } });
    const real = sent[0]!.code;
    const wrong = real === "000000" ? "111111" : "000000";
    const short = await app.inject({ method: "POST", url: "/auth/reset-password", payload: { email: "a@gmail.com", code: real, password: "short" } });
    expect(short.statusCode).toBe(400);
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: "POST", url: "/auth/reset-password", payload: { email: "a@gmail.com", code: wrong, password: "brand-new-pass" } });
      expect(r.statusCode).toBe(400);
    }
    const late = await app.inject({ method: "POST", url: "/auth/reset-password", payload: { email: "a@gmail.com", code: real, password: "brand-new-pass" } });
    expect(late.statusCode).toBe(400);
    expect(calls.password).toBe("");
  });

  it("rejects a reset for an email that never asked", async () => {
    const { app } = setup();
    const r = await app.inject({ method: "POST", url: "/auth/reset-password", payload: { email: "nobody@gmail.com", code: "123456", password: "brand-new-pass" } });
    expect(r.statusCode).toBe(400);
  });
});
