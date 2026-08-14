import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";

/**
 * Applies every unapplied file in `migrations/`, in filename order, each in its
 * own transaction. Already-applied files are skipped, so running this on every
 * deploy is safe and is the intended way to use it.
 *
 * A Postgres advisory lock makes concurrent deploys safe: if two instances boot
 * at once, one migrates and the other waits, rather than both racing the same
 * DDL.
 */
const LOCK_KEY = 8_531_004; // Arbitrary but fixed: the same number every deploy.

async function migrate(): Promise<void> {
  const directory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const applied = new Set(
      (await client.query<{ name: string }>("select name from schema_migrations")).rows.map((row) => row.name),
    );
    const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();

    for (const name of files) {
      if (applied.has(name)) continue;
      const sql = await readFile(join(directory, name), "utf8");
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [name]);
        await client.query("commit");
        console.info(JSON.stringify({ event: "migration_applied", name }));
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw new Error(`Migration ${name} failed: ${error instanceof Error ? error.message : "unknown"}`);
      }
    }
    console.info(JSON.stringify({ event: "migrations_up_to_date", count: files.length }));
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

migrate()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error(JSON.stringify({ event: "migration_failed", error: error instanceof Error ? error.message : "unknown" }));
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
