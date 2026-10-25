import { describe, expect, it } from "vitest";
import { verificationService } from "./verification.service";

describe("verificationService", () => {
  it("generates and verifies a 6-digit code", async () => {
    const svc = verificationService();
    const res = await svc.sendCode("test@example.com", "Tester", true);
    expect(res.ok).toBe(true);

    // In-memory test: try wrong code
    await expect(svc.verifyCode("test@example.com", "000000")).rejects.toThrow(/Incorrect verification code/);

    // Attempting resend immediately should hit cooldown
    await expect(svc.sendCode("test@example.com", "Tester", false)).rejects.toThrow(/Please wait/);
  });

  it("locks out after 5 invalid attempts", async () => {
    const svc = verificationService();
    await svc.sendCode("brute@example.com", "Bruter", true);

    for (let i = 0; i < 4; i++) {
      await expect(svc.verifyCode("brute@example.com", `99999${i}`)).rejects.toThrow(/Incorrect verification code/);
    }
    // 5th attempt locks out
    await expect(svc.verifyCode("brute@example.com", "999995")).rejects.toThrow(/Too many incorrect attempts/);
  });

  it("rejects non-existent or expired code", async () => {
    const svc = verificationService();
    await expect(svc.verifyCode("nonexistent@example.com", "123456")).rejects.toThrow(/expired or is invalid/);
  });
});
