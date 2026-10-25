/**
 * Resets the password of an existing admin account.
 * Usage: npm run admin:password -- you@company.com newpassword
 */
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { admins } from "../src/db/schema";
import { hashPassword } from "../src/lib/password";

const [email, newPassword] = process.argv.slice(2);
if (!email || !newPassword) {
  console.error("Usage: npm run admin:password -- <email> <newPassword>");
  process.exit(1);
}

async function run() {
  const user = await db.query.admins.findFirst({
    where: eq(admins.email, email.toLowerCase()),
  });

  if (!user) {
    console.error(`Admin account not found: ${email}`);
    process.exit(1);
  }

  const passwordHash = await hashPassword(newPassword);
  await db.update(admins).set({ passwordHash }).where(eq(admins.id, user.id));

  console.log(`Admin password updated for: ${email}`);
  process.exit(0);
}

run().catch((err) => {
  console.error("Failed to reset admin password:", err);
  process.exit(1);
});
