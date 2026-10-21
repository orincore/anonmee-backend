/**
 * Creates a staff account. Usage: npm run admin:create -- you@company.com owner
 * Prints a one-time password and the authenticator setup key. Nothing is stored in plain text.
 */
import { randomBytes } from "node:crypto";
import { authenticator } from "otplib";
import { db } from "../src/db/client";
import { admins } from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { hashPassword } from "../src/lib/password";

const [email, role = "moderator"] = process.argv.slice(2);
if (!email || !["owner", "moderator", "analyst"].includes(role)) {
  console.error("Usage: npm run admin:create -- <email> <owner|moderator|analyst>");
  process.exit(1);
}
const password = randomBytes(15).toString("base64url");
const secret = authenticator.generateSecret();
await db.insert(admins).values({
  email: email.toLowerCase(), role: role as "owner", passwordHash: await hashPassword(password), totpSecretEnc: encrypt(secret),
});
console.log(`\nAdmin created: ${email} (${role})\nPassword (shown once): ${password}\nAuthenticator key (add to your app): ${secret}\notpauth URL: ${authenticator.keyuri(email, "Anonmee Admin", secret)}\n`);
process.exit(0);
