import "dotenv/config";
import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  ALLOWED_ORIGINS: z.string().default("http://localhost:5173"),
  MATCHMAKER_DRIVER: z.enum(["memory", "redis"]).default("memory"),
  REDIS_URL: z.string().url().optional(),
  AUTH_INTROSPECTION_URL: z.string().url().optional(),
  INTERNAL_API_KEY: z.string().min(24).optional(),
  /** Where the gateway posts peer reports into the API. */
  REPORT_INGEST_URL: z.string().url().optional(),
}).superRefine((environment, context) => {
  if (environment.NODE_ENV === "production" && environment.MATCHMAKER_DRIVER !== "redis") {
    context.addIssue({ code: "custom", path: ["MATCHMAKER_DRIVER"], message: "Production requires MATCHMAKER_DRIVER=redis." });
  }
  if (environment.NODE_ENV === "production" && !environment.AUTH_INTROSPECTION_URL) {
    context.addIssue({ code: "custom", path: ["AUTH_INTROSPECTION_URL"], message: "Production requires AUTH_INTROSPECTION_URL so sockets are authenticated." });
  }
  if (environment.AUTH_INTROSPECTION_URL && !environment.INTERNAL_API_KEY) {
    context.addIssue({ code: "custom", path: ["INTERNAL_API_KEY"], message: "INTERNAL_API_KEY is required to call the introspection endpoint." });
  }
  if (environment.MATCHMAKER_DRIVER === "redis" && !environment.REDIS_URL) {
    context.addIssue({ code: "custom", path: ["REDIS_URL"], message: "REDIS_URL is required for Redis matching." });
  }
});

export type Environment = z.infer<typeof environmentSchema>;

export function loadEnvironment(source = process.env): Environment {
  const result = environmentSchema.safeParse(source);
  if (result.success) return result.data;
  console.error(result.error.flatten().fieldErrors);
  throw new Error("Invalid runtime environment.");
}
