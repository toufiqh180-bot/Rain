import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, normalize } from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { allowedOrigins, env, isProduction } from "./env.js";
import { healthy, pool } from "./db.js";
import { ApiError } from "./http.js";
import { MAX_AVATAR_BYTES } from "./storage.js";
import { authRoutes } from "./routes/auth.js";
import { profileRoutes } from "./routes/profile.js";
import { socialRoutes } from "./routes/social.js";
import { circleRoutes } from "./routes/circles.js";
import { billingRoutes } from "./routes/billing.js";
import { safetyRoutes } from "./routes/safety.js";
import { internalRoutes, realtimeRoutes } from "./routes/realtime.js";

/**
 * Builds the fully-wired app without binding a port.
 *
 * `index.ts` listens on it; tests inject requests straight into it. Both go
 * through the same registration, so a passing test says something real about
 * what production runs.
 */
export async function buildApp() {

  const app = Fastify({
    // Trust the proxy's forwarded headers so `request.ip` is the caller, not the
    // load balancer — rate limiting is meaningless otherwise.
    trustProxy: true,
    bodyLimit: 1_000_000,
    logger: {
      // Tests assert on behaviour, not on log output; the noise hides failures.
      level: env.NODE_ENV === "test" ? "silent" : isProduction ? "info" : "debug",
      redact: ["req.headers.cookie", "req.headers.authorization", "req.headers['x-internal-key']"],
    },
  });

  await app.register(cors, {
    origin(origin, callback) {
      // No Origin header means a same-origin or server-to-server call.
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error("Origin is not allowed."), false);
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "accept", "x-rain-csrf", "x-internal-key", "stripe-signature"],
    maxAge: 86_400,
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: MAX_AVATAR_BYTES, files: 1 } });

  /**
   * Per-instance rate limiting. Running N instances means the effective ceiling is
   * N × this number, so treat it as a crude backstop against runaway clients — the
   * limits that must hold globally (failed sign-ins) are counted in Postgres
   * instead, and anything stricter belongs at the edge.
   */
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    allowList: (request) => request.url === "/healthz" || request.url === "/readyz",
  });

  // Stripe signs the exact bytes it sent, so the webhook needs the raw body. Every
  // other route keeps normal JSON parsing.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body: string, done) => {
    if (request.routeOptions.config?.rawBody) (request as { rawBody?: string }).rawBody = body;
    try {
      done(null, body.length ? JSON.parse(body) : {});
    } catch {
      done(new ApiError(400, "invalid_json", "That request body could not be read."), undefined);
    }
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cross-origin-resource-policy", "cross-origin");
    if (isProduction) reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      if (error.status >= 500) request.log.error({ err: error }, "api error");
      return reply.code(error.status).send({ code: error.code, message: error.message, fields: error.fields });
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.code(429).send({ code: "rate_limited", message: "Too many requests. Wait a moment and try again." });
    }
    if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
      return reply.code(400).send({ code: "image_too_large", message: "Images must be under 4 MB." });
    }
    // Never leak an internal message to a browser; the log keeps the detail.
    request.log.error({ err: error }, "unhandled error");
    return reply.code(500).send({ code: "internal_error", message: "Rain is having trouble on our side. Try again shortly." });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ code: "not_found", message: "That is no longer available." }));

  // Liveness: the process is up. Readiness: it can actually serve, which means the
  // database answers. Point the load balancer at /readyz.
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    if (!(await healthy())) return reply.code(503).send({ status: "degraded" });
    return { status: "ready" };
  });

  await app.register(authRoutes);
  await app.register(profileRoutes);
  await app.register(socialRoutes);
  await app.register(circleRoutes);
  await app.register(billingRoutes);
  await app.register(safetyRoutes);
  await app.register(realtimeRoutes);
  await app.register(internalRoutes);

  // Development only: serves avatars written by the local storage driver.
  // Production uses object storage and never reaches this.
  if (env.STORAGE_DRIVER === "local") {
    app.get("/uploads/*", async (request, reply) => {
      const requested = (request.params as { "*": string })["*"];
      const path = join(env.STORAGE_LOCAL_DIR, normalize(requested));
      // normalize() collapses "..", and this confirms the result stayed inside
      // the upload directory before anything is read.
      if (!path.startsWith(normalize(env.STORAGE_LOCAL_DIR))) return reply.code(404).send();
      try {
        await stat(path);
      } catch {
        return reply.code(404).send();
      }
      return reply.type("image/*").send(createReadStream(path));
    });
  }

  return app;
}
