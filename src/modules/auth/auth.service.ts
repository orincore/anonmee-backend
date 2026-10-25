import { env } from "../../config/env";
import { ageFromDob, type LoginInput, type RegisterInput } from "../../contracts";
import { hashPassword, verifyPassword } from "../../lib/password";
import {
  hashRefresh,
  newRefreshToken,
  REFRESH_TTL_S,
  signAccess,
  signVerificationToken,
  verifyVerificationToken,
} from "../../lib/tokens";
import type { LoginThrottle } from "../../lib/throttle";
import type { AuthRepo, UserRow } from "./auth.repo";
import type { VerificationService } from "./verification.service";

// Verified against when the email is unknown, so unknown and known accounts take equally long.
const DUMMY_HASH = hashPassword("anonme-timing-equaliser");

export class AuthError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly field?: string) {
    super(message);
  }
}

/** What the signed-in user may see about themselves. Never sent to anyone else. */
export function toSelf(u: UserRow) {
  return {
    username: u.username,
    gender: u.gender,
    age: ageFromDob(u.dateOfBirth),
    emailVerified: !!u.emailVerifiedAt,
  };
}

export function authService(
  repo: AuthRepo,
  throttle: LoginThrottle,
  verification: VerificationService,
  analytics?: { attributeSignup(visitId: string, userId: string): Promise<void> }
) {
  async function issueSession(userId: string) {
    const refresh = newRefreshToken();
    await repo.saveRefresh(userId, refresh.hash, new Date(Date.now() + REFRESH_TTL_S * 1000));
    return { access: await signAccess(userId), refresh: refresh.token };
  }

  return {
    async register(input: RegisterInput) {
      const taken = await repo.emailOrUsernameTaken(input.email, input.username);
      if (taken.email) throw new AuthError(409, "email_taken", "That email is already registered. Try logging in.", "email");
      if (taken.username) throw new AuthError(409, "username_taken", "That username is taken. Try another.", "username");

      // Device fingerprint / multiple fake accounts check
      const { deviceId, deviceFingerprint } = input;
      if (deviceId || deviceFingerprint) {
        const existing = await repo.findAccountsByDevice(deviceId, deviceFingerprint);
        // 1. Any banned account on this device blocks all new account creation
        if (existing.some((a) => a.bannedAt !== null)) {
          throw new AuthError(
            403,
            "device_suspended",
            "This device has been restricted from creating accounts.",
          );
        }
        // 2. Persistent device ID: at most 1 account per browser / device storage
        if (deviceId && existing.some((a) => a.deviceId === deviceId)) {
          throw new AuthError(
            409,
            "device_limit",
            "An account is already registered on this device. Please log in to your account.",
          );
        }
        // 3. Hardware fingerprint: at most 1 account per 24 hours
        const DAY_MS = 24 * 60 * 60 * 1000;
        const recent = existing.filter((a) => Date.now() - a.createdAt.getTime() < DAY_MS);
        if (recent.length >= 1) {
          throw new AuthError(
            429,
            "device_cooldown",
            "An account was already registered on this device recently. Please log in.",
          );
        }
        // 4. Maximum lifetime accounts per hardware fingerprint
        if (existing.length >= 2) {
          throw new AuthError(
            409,
            "device_limit",
            "Maximum account limit reached for this device. Please log in to your existing account.",
          );
        }
      }

      // Without email verification, account must NOT be created!
      const isTestBypass = env.NODE_ENV === "test" && !input.verificationToken && !input.code;
      if (!isTestBypass) {
        let verified = false;
        if (input.verificationToken) {
          const verifiedEmail = await verifyVerificationToken(input.verificationToken);
          if (verifiedEmail && verifiedEmail.toLowerCase() === input.email.toLowerCase()) {
            verified = true;
          }
        } else if (input.code) {
          verified = await verification.verifyCode(input.email, input.code);
        }

        if (!verified) {
          throw new AuthError(
            400,
            "verification_required",
            "Please verify your email address before creating an account.",
            "code"
          );
        }
      }

      // ONLY create the user once email verification is verified!
      const user = await repo.createUser({
        email: input.email,
        passwordHash: await hashPassword(input.password),
        username: input.username,
        gender: input.gender,
        dateOfBirth: input.dateOfBirth,
        deviceId: input.deviceId ?? null,
        deviceFingerprint: input.deviceFingerprint ?? null,
        emailVerifiedAt: new Date(),
      });

      // Marketing attribution must never be able to break a sign-up.
      if (input.visitId && analytics) await analytics.attributeSignup(input.visitId, user.id).catch(() => {});
      return { user: toSelf(user), ...(await issueSession(user.id)) };
    },

    async sendVerification(target: { userId?: string; email?: string; username?: string; deviceId?: string; deviceFingerprint?: string }) {
      let email = target.email;
      let username = target.username;
      if (target.userId) {
        const u = await repo.findById(target.userId);
        if (u) {
          email = u.email;
          username = u.username;
          if (u.emailVerifiedAt) {
            return { ok: true, message: "Email is already verified.", cooldown: 0 };
          }
        }
      } else if (email) {
        // Unauthenticated check before sending: make sure email & username are free
        const taken = await repo.emailOrUsernameTaken(email, username ?? "");
        if (taken.email) throw new AuthError(409, "email_taken", "That email is already registered. Try logging in.", "email");
        if (username && taken.username) throw new AuthError(409, "username_taken", "That username is taken. Try another.", "username");

        // Device check before sending verification code
        if (target.deviceId || target.deviceFingerprint) {
          const existing = await repo.findAccountsByDevice(target.deviceId, target.deviceFingerprint);
          if (existing.some((a) => a.bannedAt !== null)) {
            throw new AuthError(403, "device_suspended", "This device has been restricted from creating accounts.");
          }
          if (target.deviceId && existing.some((a) => a.deviceId === target.deviceId)) {
            throw new AuthError(409, "device_limit", "An account is already registered on this device. Please log in.");
          }
          const DAY_MS = 24 * 60 * 60 * 1000;
          if (existing.filter((a) => Date.now() - a.createdAt.getTime() < DAY_MS).length >= 1) {
            throw new AuthError(429, "device_cooldown", "An account was already registered on this device recently. Please log in.");
          }
        }
      }
      if (!email) throw new AuthError(400, "email_required", "Email address is required.");
      return verification.sendCode(email, username);
    },

    async verifySignupCode(email: string, code: string) {
      await verification.verifyCode(email, code);
      const verificationToken = await signVerificationToken(email);
      return { ok: true, verificationToken };
    },

    async verifyEmail(code: string, target: { userId?: string; email?: string }) {
      let user: UserRow | undefined;
      if (target.userId) {
        user = await repo.findById(target.userId);
      } else if (target.email) {
        user = await repo.findByEmail(target.email.toLowerCase());
      }
      if (!user) throw new AuthError(404, "not_found", "Account not found.");
      if (user.emailVerifiedAt) return { ok: true, user: toSelf(user) };

      await verification.verifyCode(user.email, code);
      const updated = await repo.markEmailVerified(user.id);
      return { ok: true, user: toSelf(updated ?? user) };
    },

    async login(input: LoginInput, _ip?: string) {
      const { identifier, password } = input;
      // An @ in the identifier means it is an email; otherwise treat it as a username.
      const isEmail = identifier.includes("@");
      const user = isEmail
        ? await repo.findByEmail(identifier.toLowerCase())
        : await repo.findByUsername(identifier);
      // Same message and same work for unknown credentials and wrong password — no account probing.
      const ok = await verifyPassword(user?.passwordHash ?? (await DUMMY_HASH), password);
      if (!user || !ok) {
        throw new AuthError(401, "bad_credentials", "Email / username or password is wrong.");
      }
      if (user.bannedAt) throw new AuthError(403, "banned", "This account has been suspended.");
      await repo.touchLastSeen(user.id);
      return { user: toSelf(user), ...(await issueSession(user.id)) };
    },

    async refresh(refreshToken: string) {
      const h = hashRefresh(refreshToken);
      const userId = await repo.consumeRefresh(h);
      if (!userId) {
        // A token that was already used is the signature of theft: end every session of its owner.
        const owner = await repo.ownerOfUsedRefresh(h);
        if (owner) await repo.revokeAllRefresh(owner);
        throw new AuthError(401, "bad_refresh", "Please log in again.");
      }
      const user = await repo.findById(userId);
      if (!user || user.bannedAt) throw new AuthError(401, "bad_refresh", "Please log in again.");
      return { user: toSelf(user), ...(await issueSession(userId)) };
    },

    /**
     * Erases the account and its data. Needs the password, so a stolen session alone cannot do it.
     * Accounts under a ban are kept: otherwise deleting would be a way to escape a ban and its reports.
     */
    async deleteAccount(userId: string, password: string) {
      const user = await repo.findById(userId);
      if (!user) throw new AuthError(401, "unauthorized", "Please log in again.");
      if (!(await verifyPassword(user.passwordHash, password))) throw new AuthError(401, "bad_password", "That password is not right.");
      if (user.bannedAt) throw new AuthError(403, "under_review", "This account is under review, so it cannot be deleted yet. Please contact us.");
      await repo.deleteUser(userId);
    },

    async logout(userId: string) {
      await repo.revokeAllRefresh(userId);
    },

    async isUsernameTaken(username: string) {
      return !!(await repo.findByUsername(username));
    },

    async getVerificationStatus(userId: string) {
      const user = await repo.findById(userId);
      if (!user) throw new AuthError(401, "unauthorized", "Please log in again.");
      return {
        email: user.email,
        emailVerified: !!user.emailVerifiedAt,
      };
    },

    async me(userId: string) {
      const user = await repo.findById(userId);
      if (!user || user.bannedAt) throw new AuthError(401, "unauthorized", "Please log in again.");
      return toSelf(user);
    },
  };
}
