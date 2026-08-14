import { z } from "zod";

/**
 * Every configuration value the API reads, validated once at boot.
 *
 * The service refuses to start on a bad config rather than failing later on a
 * request. Production has stricter rules than development — see the refinements
 * at the bottom.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  HOST: z.string().default("0.0.0.0"),

  /** Postgres connection string. Any host works: Neon, RDS, Railway, local. */
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_SSL: z.enum(["require", "disable"]).default("disable"),

  /** Optional. Enables presence and cross-instance coordination when present. */
  REDIS_URL: z.string().url().optional(),

  /** Comma-separated web origins allowed to send credentialed requests. */
  ALLOWED_ORIGINS: z.string().default("http://localhost:5173"),

  /** Cookie domain. Leave unset for host-only cookies, which is right for most setups. */
  COOKIE_DOMAIN: z.string().optional(),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(24 * 30),

  /** Bumped whenever the terms change; recorded against each acceptance. */
  TERMS_VERSION: z.string().default("2026-08-14"),

  /** Avatar storage. "local" writes to disk and is for development only. */
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./.uploads"),
  STORAGE_PUBLIC_URL: z.string().url().optional(),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_ENDPOINT: z.string().url().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  /** Billing. Absent means the membership screen reports billing as unavailable. */
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PLUS: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),
  BILLING_RETURN_URL: z.string().url().default("http://localhost:5173"),

  /** Shared secret the realtime gateway presents when introspecting a token. */
  INTERNAL_API_KEY: z.string().min(24).optional(),
}).superRefine((environment, context) => {
  const require = (path: string, message: string) =>
    context.addIssue({ code: "custom", path: [path], message });

  if (environment.NODE_ENV !== "production") return;

  if (environment.STORAGE_DRIVER === "local") {
    require("STORAGE_DRIVER", "Production needs object storage; local disk does not survive a redeploy or scale out.");
  }
  if (!environment.INTERNAL_API_KEY) {
    require("INTERNAL_API_KEY", "Production requires INTERNAL_API_KEY so only the gateway can introspect tokens.");
  }
  if (environment.ALLOWED_ORIGINS.split(",").some((origin) => origin.includes("localhost"))) {
    require("ALLOWED_ORIGINS", "Production must not allow a localhost origin.");
  }
  if (environment.DATABASE_SSL !== "require") {
    require("DATABASE_SSL", "Production requires DATABASE_SSL=require.");
  }
});

if (typeof process === "undefined") throw new Error("The Rain API runs on Node.");

export type Environment = z.infer<typeof schema>;

function load(source: NodeJS.ProcessEnv = process.env): Environment {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  console.error(JSON.stringify({ event: "invalid_environment", issues: result.error.flatten().fieldErrors }, null, 2));
  throw new Error("Invalid runtime environment.");
}

export const env = load();
export const isProduction = env.NODE_ENV === "production";
export const allowedOrigins = env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean);

/** Storage and billing are optional; screens report honestly when they are off. */
export const storageConfigured = env.STORAGE_DRIVER === "local" || Boolean(env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY);
export const billingConfigured = Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_PLUS && env.STRIPE_PRICE_PRO);
