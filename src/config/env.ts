import { z } from "zod";

const weak = /^(dev_|change-me|secret|password)/i;

const schema = z
  .object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  /** Signs admin sessions. Different from the user secrets on purpose. */
  ADMIN_JWT_SECRET: z.string().min(32),
  /** Encrypts admin 2FA secrets at rest. */
  ADMIN_ENC_KEY: z.string().min(32),
  /** Public address of this API, used to print short links such as /r/ab12cd. */
  PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),
  WEB_ORIGIN: z.string().url(),
  SERVER_PORT: z.coerce.number().default(4000),
  /** Use 127.0.0.1 behind a reverse proxy so the API is only reachable through it. */
  HOST: z.string().default("0.0.0.0"),
  DB_POOL_MAX: z.coerce.number().int().min(2).max(100).default(20),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  /** Only set when running behind a reverse proxy you control. Otherwise client IPs can be spoofed. */
  TRUST_PROXY: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  SMTP_HOST: z.string().default("smtp-relay.brevo.com"),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  SMTP_FROM: z.string().default("Anonmee <no-reply@anonmee.orincore.com>"),
  TOGETHER_API_KEY: z.string().default(""),
  TOGETHER_MODEL: z.string().default("deepseek-ai/DeepSeek-V4.1-Flash-1017"),
  })
  .superRefine((e, ctx) => {
    if (e.NODE_ENV !== "production") return;
    for (const k of ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "ADMIN_JWT_SECRET", "ADMIN_ENC_KEY"] as const) {
      if (weak.test(e[k])) ctx.addIssue({ code: "custom", path: [k], message: "Use a strong random secret in production" });
    }
    if (new Set([e.JWT_ACCESS_SECRET, e.JWT_REFRESH_SECRET, e.ADMIN_JWT_SECRET, e.ADMIN_ENC_KEY]).size < 4) {
      ctx.addIssue({ code: "custom", path: ["JWT_REFRESH_SECRET"], message: "Secrets must differ" });
    }
    if (!e.WEB_ORIGIN.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["WEB_ORIGIN"], message: "Must be https in production" });
    }
  });

export const env = schema.parse(process.env);
