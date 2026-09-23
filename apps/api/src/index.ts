import { env } from "./env.js";
import { pool } from "./db.js";
import { buildApp } from "./app.js";
import { startOutboxWorker } from "./outbox-worker.js";

const app = await buildApp();
const stopOutbox = startOutboxWorker();

const shutdown = async (signal: string) => {
  app.log.info({ event: "shutting_down", signal });
  stopOutbox();
  await pool.end().catch(() => undefined);
  await app.close().catch(() => undefined);
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: env.PORT, host: env.HOST });
app.log.info({ event: "api_ready", port: env.PORT, storage: env.STORAGE_DRIVER });
