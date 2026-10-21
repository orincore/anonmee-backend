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

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(254, "That email is too long"),
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
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(128),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
