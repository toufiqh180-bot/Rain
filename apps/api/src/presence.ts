import { env } from "./env.js";

/**
 * Who is online right now.
 *
 * Presence is ephemeral and high-churn, so it belongs in Redis, not Postgres —
 * writing a row on every heartbeat would generate more dead tuples than the
 * autovacuum can keep up with. The realtime gateway sets `presence:<profileId>`
 * with a short TTL; this only reads.
 *
 * Without Redis everyone reads as offline. That is honest: this deployment has
 * no presence source, so it does not claim one.
 */
type Presence = "online" | "away" | "in-a-chat" | "offline";

let client: { mGet(keys: string[]): Promise<(string | null)[]> } | null = null;
let ready: Promise<void> | null = null;

async function connect(): Promise<void> {
  if (!env.REDIS_URL || client) return;
  try {
    const { createClient } = await import("redis");
    const redis = createClient({ url: env.REDIS_URL });
    redis.on("error", () => undefined);
    await redis.connect();
    client = redis as unknown as typeof client;
  } catch {
    client = null;
  }
}

export async function presenceFor(profileIds: string[]): Promise<Map<string, Presence>> {
  const result = new Map<string, Presence>();
  if (!profileIds.length) return result;
  if (!env.REDIS_URL) return result;

  ready ??= connect();
  await ready;
  if (!client) return result;

  try {
    const values = await client.mGet(profileIds.map((id) => `presence:${id}`));
    profileIds.forEach((id, index) => {
      const value = values[index];
      if (value === "online" || value === "away" || value === "in-a-chat") result.set(id, value);
    });
  } catch {
    // A presence outage must never take down the inbox.
  }
  return result;
}
