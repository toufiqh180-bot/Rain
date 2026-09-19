import { env } from "./env.js";
import { query, queryOne } from "./db.js";
import { ApiError } from "./http.js";

/**
 * Rate limiter using token bucket algorithm stored in Postgres.
 * Each user gets buckets for different actions (match queue, messaging, etc).
 */
export async function checkRateLimit(
  accountId: string,
  bucketKey: string,
  tokensRequired: number = 1,
  maxTokens: number = 100,
  refillRate: number = 10,
): Promise<{ allowed: boolean; remaining: number; resetSeconds: number }> {
  const now = new Date();
  const result = await queryOne<{
    tokens: string;
    refilled_at: string;
  }>(
    `with refill as (
      select 
        least(
          $4,
          tokens + extract(epoch from (now() - refilled_at)) / 60 * $5
        ) as new_tokens,
        now() as now_ts
      from rate_limit_buckets
      where account_id = $1 and bucket_key = $2
    )
    update rate_limit_buckets
    set tokens = refill.new_tokens, refilled_at = refill.now_ts
    from refill
    where account_id = $1 and bucket_key = $2
    returning tokens, refilled_at`,
    [accountId, bucketKey, maxTokens, maxTokens, refillRate],
  );

  let tokens = result?.tokens ? Number(result.tokens) : maxTokens;

  if (!result) {
    // First request; create the bucket
    await query(
      `insert into rate_limit_buckets (account_id, bucket_key, tokens)
       values ($1, $2, $3)
       on conflict (account_id, bucket_key) do nothing`,
      [accountId, bucketKey, maxTokens - tokensRequired],
    );
    return {
      allowed: true,
      remaining: maxTokens - tokensRequired,
      resetSeconds: 60,
    };
  }

  const allowed = tokens >= tokensRequired;

  if (allowed) {
    // Deduct tokens
    await query(
      `update rate_limit_buckets set tokens = tokens - $3 
       where account_id = $1 and bucket_key = $2`,
      [accountId, bucketKey, tokensRequired],
    );
    tokens -= tokensRequired;
  }

  return {
    allowed,
    remaining: Math.max(0, Math.floor(tokens)),
    resetSeconds: 60,
  };
}

/**
 * Records a device fingerprint and updates risk score.
 */
export async function recordDevice(
  accountId: string,
  fingerprint: string,
  userAgent: string | null,
  ip: string,
): Promise<void> {
  const existing = await queryOne<{ id: string; risk_score: string }>(
    `select id, risk_score from device_fingerprints 
     where lower(fingerprint) = $1`,
    [fingerprint],
  );

  if (existing) {
    // Update last seen
    await query(
      `update device_fingerprints 
       set last_seen_at = now() 
       where lower(fingerprint) = $1`,
      [fingerprint],
    );
  } else {
    // New device
    await query(
      `insert into device_fingerprints (account_id, fingerprint, user_agent, ip, risk_score)
       values ($1, $2, $3, $4, 0)`,
      [accountId, fingerprint, userAgent, ip],
    );
  }
}

/**
 * Check if account should be blocked due to abuse patterns.
 */
export async function checkAbuseStatus(accountId: string): Promise<string | null> {
  // Check for active moderation action
  const action = await queryOne<{ action: string }>(
    `select action from moderation_actions
     where account_id = $1 
       and action in ('suspend', 'ban')
       and (expires_at is null or expires_at > now())
     limit 1`,
    [accountId],
  );

  if (action) {
    return `This account is currently ${action.action === "ban" ? "banned" : "suspended"}.`;
  }

  // Check for abuse pattern: too many reports against this account
  const reportedCount = await queryOne<{ count: string }>(
    `select count(*)::text as count from reports
     where subject_profile_id in (
       select id from profiles where account_id = $1
     ) and created_at > now() - interval '24 hours'
     and reason in ('harassment', 'sexual-content', 'hate', 'minor-safety')`,
    [accountId],
  );

  if (Number(reportedCount?.count ?? 0) > 5) {
    return "Too many reports against your account. Please contact support.";
  }

  return null;
}

/**
 * Log an abuse event for monitoring.
 */
export async function logAbuseEvent(
  eventType: string,
  accountId: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  await query(
    `insert into safety_metrics (metric_name, metric_value, bucket_window, tags)
     values ($1, 1, date_trunc('hour', now()), $2)`,
    [eventType, JSON.stringify({ account_id: accountId, ...metadata })],
  );
}

/**
 * Check if guest account should be auto-deleted after logout.
 * Schedules deletion for cleanup worker to handle.
 */
export async function scheduleGuestDeletion(accountId: string, reason: string): Promise<void> {
  // Schedule for immediate deletion (worker picks up immediately)
  await query(
    `insert into guest_account_cleanup (account_id, scheduled_for, reason)
     values ($1, now(), $2)
     on conflict (account_id) do nothing`,
    [accountId, reason],
  );
}
