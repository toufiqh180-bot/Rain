import { env } from "./env.js";
import { pool } from "./db.js";
import { buildApp } from "./app.js";

const app = await buildApp();

const shutdown = async (signal: string) => {
  app.log.info({ event: "shutting_down", signal });
  // Stop accepting connections, let in-flight requests finish, then release the
  // pool. A hard exit here would drop a half-written transaction.
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: env.PORT, host: env.HOST });
app.log.info({ event: "api_ready", port: env.PORT, storage: env.STORAGE_DRIVER });
