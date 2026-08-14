import pg from "pg";
import { env } from "./env.js";

/**
 * One pool per process. Every API instance is stateless, so scaling out means
 * running more of them — but each one holds `DATABASE_POOL_MAX` connections, and
 * Postgres has a hard connection ceiling. Instances × pool size must stay under
 * it, which is why serverless Postgres (Neon, Supabase) or PgBouncer in
 * transaction mode is the usual answer past a handful of instances.
 */
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL === "require" ? { rejectUnauthorized: true } : undefined,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // A query that hangs holds a connection hostage; fail it instead.
  statement_timeout: 10_000,
});

pool.on("error", (error) => {
  console.error(JSON.stringify({ event: "pool_error", error: error.message }));
});

export type Row = Record<string, unknown>;

export async function query<T extends Row = Row>(text: string, values: unknown[] = []): Promise<T[]> {
  const result = await pool.query<T>(text, values);
  return result.rows;
}

export async function queryOne<T extends Row = Row>(text: string, values: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, values);
  return rows[0] ?? null;
}

/**
 * Runs `handler` inside a transaction, rolling back on any throw.
 *
 * Use this wherever a write must not be observable on its own — a report and
 * its outbox event, a connection and its DM thread.
 */
export async function transaction<T>(handler: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await handler(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function healthy(): Promise<boolean> {
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  }
}
