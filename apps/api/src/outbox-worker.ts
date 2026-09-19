import { pool } from "./db.js";

type OutboxRow = {
  id: string;
  topic: string;
  payload: { reportId?: string; reason?: string; accountId?: string };
};

/**
 * Drains the transactional outbox inside one connection transaction so
 * `FOR UPDATE SKIP LOCKED` actually serialises workers across instances.
 */
export async function processOutboxBatch(limit = 25): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<OutboxRow>(
      `select id, topic, payload
         from outbox
        where processed_at is null
        order by created_at
        limit $1
        for update skip locked`,
      [limit],
    );

    for (const row of rows) {
      try {
        if (
          row.topic === "report.escalate" ||
          (row.topic === "report.created" && row.payload.reason === "minor-safety")
        ) {
          if (row.payload.reportId) {
            await client.query(`update reports set status = 'reviewing' where id = $1 and status = 'open'`, [
              row.payload.reportId,
            ]);
          }
        }

        if (row.topic === "report.created") {
          await client.query(
            `insert into audit_log (account_id, action, metadata) values ($1, 'report.queued', $2)`,
            [row.payload.accountId ?? null, JSON.stringify(row.payload)],
          );
        }

        await client.query(`update outbox set processed_at = now(), attempts = attempts + 1 where id = $1`, [
          row.id,
        ]);
      } catch {
        await client.query(`update outbox set attempts = attempts + 1 where id = $1`, [row.id]);
      }
    }

    await client.query("commit");
    return rows.length;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function startOutboxWorker(intervalMs = 2_000): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;

  const tick = async () => {
    if (stopped) return;
    try {
      await processOutboxBatch();
    } catch {
      // Never crash the API process on a worker tick.
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };

  timer = setTimeout(() => void tick(), intervalMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
