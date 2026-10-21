// Tests run against the local dev database; load its env before anything imports config/env.
try {
  process.loadEnvFile(new URL("../../.env", import.meta.url).pathname);
} catch {
  /* CI provides real env vars */
}
process.env.NODE_ENV = "test";
