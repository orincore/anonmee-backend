import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { authRoutes } from "./auth.routes";
import { authService } from "./auth.service";
import { verificationService } from "./verification.service";
import { signAccess } from "../../lib/tokens";

describe("Email verification routes", () => {
  it("sends verification code and handles verification flow", async () => {
    let verifiedAt: Date | null = null;
    let createdUser: any = null;
    const mockUser = {
      id: "11111111-1111-1111-1111-111111111111",
      email: "flow@example.com",
      username: "flowuser",
      passwordHash: "hash",
      gender: "male" as const,
      dateOfBirth: new Date("2000-01-01"),
      emailVerifiedAt: null as Date | null,
      acquisitionChannel: null,
      acquisitionSource: null,
      acquisitionCampaign: null,
      lastSeenAt: null,
      bannedAt: null,
      createdAt: new Date(),
    };

    const mockRepo = {
      findById: async (id: string) => (id === mockUser.id ? { ...mockUser, emailVerifiedAt: verifiedAt } : undefined),
      findByEmail: async (e: string) => (e === mockUser.email ? { ...mockUser, emailVerifiedAt: verifiedAt } : undefined),
      findByUsername: async () => undefined,
      emailOrUsernameTaken: async () => ({ email: false, username: false }),
      createUser: async (u: any) => {
        createdUser = { ...mockUser, ...u };
        return createdUser;
      },
      saveRefresh: async () => {},
      consumeRefresh: async () => null,
      ownerOfUsedRefresh: async () => null,
      revokeAllRefresh: async () => {},
      deleteUser: async () => {},
      touchLastSeen: async () => {},
      markEmailVerified: async (id: string) => {
        if (id === mockUser.id) verifiedAt = new Date();
        return { ...mockUser, emailVerifiedAt: verifiedAt };
      },
      markEmailVerifiedByEmail: async (e: string) => {
        if (e === mockUser.email) verifiedAt = new Date();
        return { ...mockUser, emailVerifiedAt: verifiedAt };
      },
    };

    const mockThrottle = {
      isLocked: async () => false,
      fail: async () => {},
      succeed: async () => {},
    };

    const verif = verificationService();
    const svc = authService(mockRepo as any, mockThrottle as any, verif);

    const app = Fastify();
    await app.register(cookie);
    await app.register(authRoutes(svc));

    // 1. Send verification code on signup (Step 1 -> Step 2)
    const sendRes = await app.inject({
      method: "POST",
      url: "/auth/send-verification",
      payload: { email: "signup@example.com", username: "newuser" },
    });
    expect(sendRes.statusCode).toBe(200);
    expect(sendRes.json().ok).toBe(true);

    // 2. Reject bad verification code
    const badCodeRes = await app.inject({
      method: "POST",
      url: "/auth/verify-code",
      payload: { email: "signup@example.com", code: "000000" },
    });
    expect(badCodeRes.statusCode).toBe(400);

    // 3. User verification status check for authenticated users
    const token = await signAccess(mockUser.id);
    const statusBefore = await app.inject({
      method: "GET",
      url: "/auth/verification-status",
      cookies: { access: token },
    });
    expect(statusBefore.statusCode).toBe(200);
    expect(statusBefore.json().emailVerified).toBe(false);

    // 4. Register with valid verificationToken
    // Force set code in verif service so we can verify it
    const sendForce = await verif.sendCode("signup@example.com", "newuser", true);
    expect(sendForce.ok).toBe(true);
  });
});
