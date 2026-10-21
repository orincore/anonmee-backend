import { ageFromDob, type LoginInput, type RegisterInput } from "../../contracts";
import { hashPassword, verifyPassword } from "../../lib/password";
import { hashRefresh, newRefreshToken, REFRESH_TTL_S, signAccess } from "../../lib/tokens";
import type { LoginThrottle } from "../../lib/throttle";
import type { AuthRepo, UserRow } from "./auth.repo";

// Verified against when the email is unknown, so unknown and known accounts take equally long.
const DUMMY_HASH = hashPassword("anonme-timing-equaliser");

export class AuthError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly field?: string) {
    super(message);
  }
}

/** What the signed-in user may see about themselves. Never sent to anyone else. */
export function toSelf(u: UserRow) {
  return { username: u.username, gender: u.gender, age: ageFromDob(u.dateOfBirth) };
}

export function authService(repo: AuthRepo, throttle: LoginThrottle, analytics?: { attributeSignup(visitId: string, userId: string): Promise<void> }) {
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
      const user = await repo.createUser({
        email: input.email,
        passwordHash: await hashPassword(input.password),
        username: input.username,
        gender: input.gender,
        dateOfBirth: input.dateOfBirth,
      });
      // Marketing attribution must never be able to break a sign-up.
      if (input.visitId && analytics) await analytics.attributeSignup(input.visitId, user.id).catch(() => {});
      return { user: toSelf(user), ...(await issueSession(user.id)) };
    },

    async login(input: LoginInput, ip: string) {
      if (await throttle.isLocked(input.email, ip)) {
        throw new AuthError(429, "locked", "Too many tries. Wait 15 minutes, then try again.");
      }
      const user = await repo.findByEmail(input.email);
      // Same message and same work for unknown email and wrong password, so accounts cannot be probed.
      const ok = await verifyPassword(user?.passwordHash ?? (await DUMMY_HASH), input.password);
      if (!user || !ok) {
        await throttle.fail(input.email, ip);
        throw new AuthError(401, "bad_credentials", "Email or password is wrong.");
      }
      await throttle.succeed(input.email, ip);
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

    async me(userId: string) {
      const user = await repo.findById(userId);
      if (!user || user.bannedAt) throw new AuthError(401, "unauthorized", "Please log in again.");
      return toSelf(user);
    },
  };
}
