import { z } from "zod";

export const MIN_AGE = 18;

/** Whole years between dob and now (UTC). Server is the authority; clients use it for early feedback only. */
export function ageFromDob(dob: Date, now: Date = new Date()): number {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < dob.getUTCMonth() ||
    (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}
export const GENDERS = ["male", "female", "trans_man", "trans_woman", "non_binary", "prefer_not_to_say"] as const;
export type Gender = (typeof GENDERS)[number];

export const REPUTED_EMAIL_DOMAINS = new Set([
  // Google
  "gmail.com",
  "googlemail.com",

  // Microsoft
  "outlook.com",
  "outlook.co.uk",
  "outlook.fr",
  "outlook.de",
  "outlook.es",
  "outlook.it",
  "outlook.in",
  "outlook.com.au",
  "hotmail.com",
  "hotmail.co.uk",
  "hotmail.fr",
  "hotmail.de",
  "hotmail.es",
  "hotmail.it",
  "hotmail.ca",
  "hotmail.com.au",
  "live.com",
  "live.co.uk",
  "live.fr",
  "live.de",
  "live.ca",
  "live.com.au",
  "msn.com",

  // Yahoo
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.co.in",
  "yahoo.ca",
  "yahoo.fr",
  "yahoo.de",
  "yahoo.es",
  "yahoo.it",
  "yahoo.com.au",
  "yahoo.co.jp",
  "yahoo.com.br",
  "yahoo.com.mx",
  "ymail.com",
  "myyahoo.com",
  "rocketmail.com",

  // Apple
  "icloud.com",
  "me.com",
  "mac.com",

  // Proton
  "proton.me",
  "protonmail.com",
  "pm.me",

  // Zoho
  "zoho.com",
  "zohomail.com",
  "zoho.in",
  "zoho.eu",

  // AOL
  "aol.com",
  "aim.com",

  // Fastmail
  "fastmail.com",
  "fastmail.fm",

  // GMX & Mail.com
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "gmx.at",
  "gmx.ch",
  "mail.com",
  "email.com",
  "usa.com",

  // Yandex
  "yandex.com",
  "yandex.ru",
  "ya.ru",

  // Tuta
  "tuta.com",
  "tutanota.com",

  // Web.de
  "web.de",

  // App & Org
  "orincore.com",
  "anonmee.in",
  "anonmee.orincore.com",
]);

export function isReputedEmail(email: string): boolean {
  if (!email || typeof email !== "string" || !email.includes("@")) return false;
  const parts = email.trim().toLowerCase().split("@");
  if (parts.length !== 2) return false;
  const domain = parts[1]!;

  if (REPUTED_EMAIL_DOMAINS.has(domain)) return true;

  // Recognized educational institution domains
  if (
    domain.endsWith(".edu") ||
    domain.endsWith(".ac.uk") ||
    domain.endsWith(".edu.in") ||
    domain.endsWith(".ac.in") ||
    domain.endsWith(".edu.au") ||
    domain.endsWith(".edu.ca") ||
    domain.endsWith(".edu.sg")
  ) {
    return true;
  }

  return false;
}

export const registerSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email address")
    .max(254, "That email is too long")
    .refine(
      isReputedEmail,
      "Please use a trusted email provider (such as Gmail, Outlook, Yahoo, iCloud, or Proton)",
    ),
  password: z.string().min(8, "Use at least 8 characters").max(128, "Use 128 characters or fewer"),
  username: z
    .string()
    .trim()
    .min(3, "Use at least 3 characters")
    .max(20, "Use 20 characters or fewer")
    .regex(/^[a-zA-Z0-9_]+$/, "Letters, numbers and underscores only"),
  gender: z.enum(GENDERS, { errorMap: () => ({ message: "Choose one" }) }),
  dateOfBirth: z.coerce
    .date({ errorMap: () => ({ message: "Enter your date of birth" }) })
    .refine((d) => ageFromDob(d) >= MIN_AGE, "Anonmee is for adults 18 and over")
    .refine((d) => ageFromDob(d) <= 99, "Please enter a valid date of birth"),
  /** Id returned by /track/visit, so the sign-up is credited to the link or search that brought the person. */
  visitId: z.string().uuid().optional(),
  confirmAdult: z.literal(true, { errorMap: () => ({ message: "Confirm you are 18 or older" }) }),
  verificationToken: z.string().optional(),
  code: z.string().optional(),
});

export const loginSchema = z.object({
  /** Email address or username — detected by whether the value contains an @. */
  identifier: z.string().trim().min(1, "Enter your email or username").max(254),
  password: z.string().min(1).max(128),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

export const verifyEmailSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, "Enter a 6-digit verification code"),
  email: z.string().trim().toLowerCase().email().optional(),
});

export const sendVerificationSchema = z.object({
  email: z.string().trim().toLowerCase().email().optional(),
});

export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type SendVerificationInput = z.infer<typeof sendVerificationSchema>;
