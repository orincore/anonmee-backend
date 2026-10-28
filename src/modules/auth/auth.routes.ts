import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../../config/env";
import { forgotPasswordSchema, isReputedEmail, resetPasswordSchema, loginSchema, registerSchema, sendVerificationSchema, verifyEmailSchema } from "../../contracts";
import { ACCESS_TTL_S, REFRESH_TTL_S, verifyAccess } from "../../lib/tokens";
import { AuthError, type authService } from "./auth.service";

type Service = ReturnType<typeof authService>;
const secure = env.NODE_ENV === "production";
const cookie = (maxAge: number, path = "/") => ({ httpOnly: true, secure, sameSite: "lax" as const, path, maxAge });

function resolveDevice(req: FastifyRequest, input: { deviceId?: string; deviceFingerprint?: string }) {
  let deviceId = input.deviceId || req.cookies.anon_did;
  let deviceFingerprint = input.deviceFingerprint;

  if (!deviceFingerprint || deviceFingerprint.length < 16) {
    const ip = req.ip || "";
    const ua = String(req.headers["user-agent"] ?? "");
    const lang = String(req.headers["accept-language"] ?? "");
    deviceFingerprint = createHash("sha256").update(`${ip}|${ua}|${lang}`).digest("hex");
  }

  if (!deviceId || deviceId.length < 16) {
    deviceId = deviceFingerprint;
  }

  return { deviceId, deviceFingerprint };
}

function setSession(reply: FastifyReply, s: { access: string; refresh: string }) {
  reply.setCookie("access", s.access, cookie(ACCESS_TTL_S));
  reply.setCookie("refresh", s.refresh, cookie(REFRESH_TTL_S, "/auth"));
}

/** Reads the access cookie and returns the user id, or sends 401. */
export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const token = req.cookies.access;
  const id = token ? await verifyAccess(token) : null;
  if (!id) {
    await reply.code(401).send({ error: "unauthorized", message: "Please log in." });
    return null;
  }
  return id;
}

export function authRoutes(svc: Service, hooks: { onAccountDeleted?: (userId: string) => void } = {}) {
  return async function (app: FastifyInstance) {
    const limited = { config: { rateLimit: { max: process.env.NODE_ENV === "test" ? 1000 : 10, timeWindow: "1 minute" } } };

    app.post("/auth/register", limited, async (req, reply) => {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid", message: parsed.error.issues[0]?.message, field: parsed.error.issues[0]?.path[0] });
      const device = resolveDevice(req, parsed.data);
      const { user, ...session } = await svc.register({
        ...parsed.data,
        deviceId: device.deviceId,
        deviceFingerprint: device.deviceFingerprint,
      });
      reply.setCookie("anon_did", device.deviceId, {
        path: "/",
        maxAge: 10 * 365 * 24 * 3600,
        httpOnly: false,
        sameSite: "lax",
      });
      setSession(reply, session);
      return reply.code(201).send({ user });
    });

    /** Sends a 6-digit verification code to the user's email via Brevo SMTP. */
    app.post("/auth/send-verification", limited, async (req, reply) => {
      const token = req.cookies.access;
      const id = token ? await verifyAccess(token) : null;
      const parsed = sendVerificationSchema.safeParse(req.body);
      if (!parsed.success && !id) {
        return reply.code(400).send({ error: "invalid", message: "Enter a valid email address." });
      }
      const email = parsed.success ? parsed.data.email : undefined;
      const username = parsed.success ? parsed.data.username : undefined;
      if (!id && !email) {
        return reply.code(400).send({ error: "invalid", message: "Email address is required." });
      }
      if (email && !isReputedEmail(email)) {
        return reply.code(400).send({
          error: "invalid",
          field: "email",
          message: "Please use a trusted email provider (such as Gmail, Outlook, Yahoo, iCloud, or Proton).",
        });
      }
      const device = resolveDevice(req, parsed.success ? parsed.data : {});
      reply.setCookie("anon_did", device.deviceId, {
        path: "/",
        maxAge: 10 * 365 * 24 * 3600,
        httpOnly: false,
        sameSite: "lax",
      });
      const res = await svc.sendVerification({
        userId: id ?? undefined,
        email,
        username,
        deviceId: device.deviceId,
        deviceFingerprint: device.deviceFingerprint,
      });
      return reply.send(res);
    });

    /** Verifies the 6-digit code during signup and returns a signed verificationToken. */
    app.post("/auth/verify-code", limited, async (req, reply) => {
      const parsed = z
        .object({
          email: z.string().trim().toLowerCase().email("Enter a valid email address"),
          code: z.string().trim().regex(/^\d{6}$/, "Enter a 6-digit verification code"),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid",
          message: parsed.error.issues[0]?.message ?? "Enter the 6-digit verification code.",
          field: parsed.error.issues[0]?.path[0],
        });
      }
      const res = await svc.verifySignupCode(parsed.data.email, parsed.data.code);
      return reply.send(res);
    });

    /** Verifies the 6-digit code entered by the user. */
    app.post("/auth/verify-email", limited, async (req, reply) => {
      const parsed = verifyEmailSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid", message: parsed.error.issues[0]?.message ?? "Enter the 6-digit code." });
      }
      const token = req.cookies.access;
      const id = token ? await verifyAccess(token) : null;
      if (!id && !parsed.data.email) {
        return reply.code(400).send({ error: "invalid", message: "Please log in or provide your email." });
      }
      const res = await svc.verifyEmail(parsed.data.code, { userId: id ?? undefined, email: parsed.data.email });
      return reply.send(res);
    });

    app.post("/auth/login", limited, async (req, reply) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Enter your email or username and password." });
      const { user, ...session } = await svc.login(parsed.data, req.ip);
      setSession(reply, session);
      return { user };
    });

    /** Always answers the same way, whether or not the email has an account. */
    app.post("/auth/forgot-password", limited, async (req, reply) => {
      const parsed = forgotPasswordSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Enter a valid email address.", field: "email" });
      await svc.requestPasswordReset(parsed.data.email);
      return { ok: true, cooldown: 60, message: "If that email has an account, a reset code is on its way." };
    });

    app.post("/auth/reset-password", limited, async (req, reply) => {
      const parsed = resetPasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid", message: parsed.error.issues[0]?.message, field: parsed.error.issues[0]?.path[0] });
      }
      await svc.resetPassword(parsed.data.email, parsed.data.code, parsed.data.password);
      reply.clearCookie("access", { path: "/" }).clearCookie("refresh", { path: "/auth" });
      return { ok: true };
    });

    /** Quick check used by the sign-up form to tell the user whether a username is taken. */
    app.get("/auth/check-username", { config: { rateLimit: { max: process.env.NODE_ENV === "test" ? 1000 : 60, timeWindow: "1 minute" } } }, async (req) => {
      const parsed = z.object({ username: z.string().min(1).max(20) }).safeParse(req.query);
      if (!parsed.success) return { available: false };
      const taken = await svc.isUsernameTaken(parsed.data.username);
      return { available: !taken };
    });

    app.post("/auth/refresh", async (req, reply) => {
      const token = req.cookies.refresh;
      if (!token) throw new AuthError(401, "bad_refresh", "Please log in again.");
      const { user, ...session } = await svc.refresh(token);
      setSession(reply, session);
      return { user };
    });

    app.post("/auth/logout", async (req, reply) => {
      const id = await requireUser(req, reply);
      if (!id) return;
      await svc.logout(id);
      reply.clearCookie("access", { path: "/" }).clearCookie("refresh", { path: "/auth" });
      return { ok: true };
    });

    app.post("/auth/delete-account", { config: { rateLimit: { max: process.env.NODE_ENV === "test" ? 1000 : 5, timeWindow: "1 hour" } } }, async (req, reply) => {
      const id = await requireUser(req, reply);
      if (!id) return;
      const parsed = z.object({ password: z.string().min(1).max(128) }).safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Enter your password to confirm." });
      await svc.deleteAccount(id, parsed.data.password);
      hooks.onAccountDeleted?.(id); // cut off any open chats
      reply.clearCookie("access", { path: "/" }).clearCookie("refresh", { path: "/auth" });
      return { ok: true };
    });

    app.get("/auth/verification-status", async (req, reply) => {
      const id = await requireUser(req, reply);
      if (!id) return;
      return svc.getVerificationStatus(id);
    });

    app.get("/auth/me", async (req, reply) => {
      const id = await requireUser(req, reply);
      if (!id) return;
      return { user: await svc.me(id) };
    });
  };
}
