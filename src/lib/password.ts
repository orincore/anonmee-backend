import { hash, verify } from "@node-rs/argon2";

// argon2id with the library defaults (OWASP-aligned: 19 MiB, 2 passes).
export const hashPassword = (plain: string) => hash(plain);
export const verifyPassword = (digest: string, plain: string) => verify(digest, plain);
