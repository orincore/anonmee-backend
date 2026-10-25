import type { RedisClient } from "../../lib/redis";
import { sendVerificationEmail } from "../../lib/email";
import { AuthError } from "./auth.service";

interface StoredCode {
  code: string;
  createdAt: number;
  attempts: number;
}

const CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds
const MAX_ATTEMPTS = 5;

export function verificationService(redis?: RedisClient) {
  // In-memory fallback in case Redis is unavailable
  const memoryStore = new Map<string, StoredCode>();
  const memoryCooldown = new Map<string, number>();

  // Periodically clean up expired entries from memory store every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [key, val] of memoryStore.entries()) {
      if (now - val.createdAt > CODE_TTL_MS) memoryStore.delete(key);
    }
    for (const [key, exp] of memoryCooldown.entries()) {
      if (now > exp) memoryCooldown.delete(key);
    }
  }, 5 * 60 * 1000).unref();

  function norm(email: string): string {
    return email.trim().toLowerCase();
  }

  async function getStored(email: string): Promise<StoredCode | null> {
    const e = norm(email);
    if (redis && redis.status === "ready") {
      try {
        const raw = await redis.get(`email_verify:${e}`);
        if (!raw) return null;
        return JSON.parse(raw) as StoredCode;
      } catch {
        // Fall back to memory
      }
    }
    const val = memoryStore.get(e);
    if (!val) return null;
    if (Date.now() - val.createdAt > CODE_TTL_MS) {
      memoryStore.delete(e);
      return null;
    }
    return val;
  }

  async function setStored(email: string, data: StoredCode): Promise<void> {
    const e = norm(email);
    memoryStore.set(e, data);
    if (redis && redis.status === "ready") {
      try {
        await redis.set(`email_verify:${e}`, JSON.stringify(data), "PX", CODE_TTL_MS);
      } catch {
        // Ignored, memory store will serve
      }
    }
  }

  async function deleteStored(email: string): Promise<void> {
    const e = norm(email);
    memoryStore.delete(e);
    if (redis && redis.status === "ready") {
      try {
        await redis.del(`email_verify:${e}`);
      } catch {
        // Ignored
      }
    }
  }

  async function getCooldown(email: string): Promise<number> {
    const e = norm(email);
    if (redis && redis.status === "ready") {
      try {
        const ttl = await redis.pttl(`email_resend:${e}`);
        if (ttl > 0) return Math.ceil(ttl / 1000);
      } catch {
        // Fall back to memory
      }
    }
    const exp = memoryCooldown.get(e);
    if (!exp) return 0;
    const remaining = exp - Date.now();
    if (remaining <= 0) {
      memoryCooldown.delete(e);
      return 0;
    }
    return Math.ceil(remaining / 1000);
  }

  async function setCooldown(email: string): Promise<void> {
    const e = norm(email);
    memoryCooldown.set(e, Date.now() + RESEND_COOLDOWN_MS);
    if (redis && redis.status === "ready") {
      try {
        await redis.set(`email_resend:${e}`, "1", "PX", RESEND_COOLDOWN_MS);
      } catch {
        // Ignored
      }
    }
  }

  return {
    async sendCode(email: string, username?: string, force = false): Promise<{ ok: boolean; message: string; cooldown: number }> {
      const e = norm(email);
      if (!force) {
        const cd = await getCooldown(e);
        if (cd > 0) {
          throw new AuthError(429, "cooldown", `Please wait ${cd} seconds before requesting a new code.`);
        }
      }

      // Generate a secure 6-digit numeric OTP code
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      await setStored(e, { code, createdAt: Date.now(), attempts: 0 });
      await setCooldown(e);

      // Send the code through Brevo SMTP
      await sendVerificationEmail(e, code, username);

      return { ok: true, message: "Verification code sent to your email.", cooldown: 60 };
    },

    async verifyCode(email: string, inputCode: string): Promise<boolean> {
      const e = norm(email);
      const stored = await getStored(e);

      if (!stored) {
        throw new AuthError(400, "code_expired", "Verification code has expired or is invalid. Please request a new code.");
      }

      if (stored.attempts >= MAX_ATTEMPTS) {
        await deleteStored(e);
        throw new AuthError(400, "too_many_attempts", "Too many incorrect attempts. Please request a new verification code.");
      }

      if (stored.code !== inputCode.trim()) {
        stored.attempts += 1;
        if (stored.attempts >= MAX_ATTEMPTS) {
          await deleteStored(e);
          throw new AuthError(400, "too_many_attempts", "Too many incorrect attempts. Please request a new verification code.");
        }
        await setStored(e, stored);
        const remaining = MAX_ATTEMPTS - stored.attempts;
        throw new AuthError(
          400,
          "invalid_code",
          `Incorrect verification code. ${remaining} attempt(s) remaining.`
        );
      }

      // Correct code: remove from store
      await deleteStored(e);
      return true;
    },

    async getCooldownSeconds(email: string): Promise<number> {
      return getCooldown(email);
    },
  };
}

export type VerificationService = ReturnType<typeof verificationService>;
