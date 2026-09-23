import { query, transaction } from "./db.js";
import { env } from "./env.js";

/**
 * Cleanup worker: runs periodically to:
 * 1. Hard-delete expired guest accounts
 * 2. Clean up expired CAPTCHA challenges
 * 3. Enforce rate limit resets
 * 4. Apply auto-escalation of moderation actions
 * 5. Anonymize old reports/audit logs per retention policy
 */

export async function runCleanupWorker() {
  if (!env.DATABASE_URL) {
    console.error("DATABASE_URL not configured. Cleanup worker cannot start.");
    return;
  }

  try {
    await deleteExpiredGuestAccounts();
    await cleanupExpiredCaptchaChallenges();
    await resetRateLimitBuckets();
    await escalateModeration();
    await anonymizeOldData();
    console.log(JSON.stringify({ event: "cleanup_worker_completed", timestamp: new Date().toISOString() }));
  } catch (error) {
    console.error(JSON.stringify({
      event: "cleanup_worker_error",
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }));
  }
}

/**
 * Hard-delete guest accounts scheduled for cleanup.
 * Cascades delete all their data: sessions, profiles, messages, etc.
 */
async function deleteExpiredGuestAccounts(): Promise<void> {
  const scheduled = await query<{ account_id: string }>(
    `select account_id from guest_account_cleanup where scheduled_for <= now() limit 100`,
  );

  for (const { account_id } of scheduled) {
    await transaction(async (client) => {
      // Verify it's actually a guest before deleting
      const account = await client.query<{ is_guest: boolean }>(
        `select is_guest from accounts where id = $1`,
        [account_id],
      );

      if (account.rowCount && account.rows[0]?.is_guest) {
        // Hard delete cascades to sessions, profiles, messages, connections, etc
        await client.query(`delete from accounts where id = $1`, [account_id]);
        
        // Remove from cleanup queue
        await client.query(
          `delete from guest_account_cleanup where account_id = $1`,
          [account_id],
        );

        console.log(JSON.stringify({
          event: "guest_account_deleted",
          account_id,
          timestamp: new Date().toISOString(),
        }));
      }
    });
  }
}

/**
 * Clean up expired CAPTCHA challenges that were never verified.
 */
async function cleanupExpiredCaptchaChallenges(): Promise<void> {
  const result = await query<{ id: string }>(
    `delete from captcha_challenges 
     where expires_at < now() and verified = false
     returning id`,
  );

  const deleted = result.length;
  if (deleted > 0) {
    console.log(JSON.stringify({
      event: "captcha_challenges_cleaned",
      count: deleted,
    }));
  }
}

/**
 * Reset rate limit buckets for users to allow fresh quota.
 * Does not reset immediately; we rely on the refill logic in checkRateLimit.
 */
async function resetRateLimitBuckets(): Promise<void> {
  // Old buckets (older than 24 hours) can be deleted and recreated
  await query(
    `delete from rate_limit_buckets where refilled_at < now() - interval '24 hours'`,
  );
}

/**
 * Auto-escalate moderation actions:
 * - Warn → Mute (if warned multiple times)
 * - Mute → Suspend (if muted multiple times)
 * - Suspend → Ban (if suspended and new violations)
 */
async function escalateModeration(): Promise<void> {
  // Find accounts with 3+ warnings in 7 days → mute them
  const escalatableWarnings = await query<{ account_id: string }>(
    `select account_id from moderation_actions
     where action = 'warn' and created_at > now() - interval '7 days'
     group by account_id
     having count(*) >= 3`,
  );

  for (const { account_id } of escalatableWarnings) {
    await query(
      `insert into moderation_actions (account_id, action, reason, expires_at)
       values ($1, 'mute', 'Auto-escalated from warnings', now() + interval '24 hours')
       on conflict do nothing`,
      [account_id],
    );
  }

  // Find accounts with mutes that were just violated → suspend
  const escalatableMutes = await query<{ account_id: string }>(
    `select account_id from moderation_actions
     where action = 'mute' and expires_at > now()
     and account_id in (
       select reporter_account_id from reports
       where created_at > now() - interval '24 hours'
       and reason in ('harassment', 'sexual-content', 'hate')
     )`,
  );

  for (const { account_id } of escalatableMutes) {
    // Only escalate if not already suspended
    const existing = await query(
      `select 1 from moderation_actions
       where account_id = $1 and action = 'suspend' and expires_at > now()`,
      [account_id],
    );

    if (existing.length === 0) {
      await query(
        `insert into moderation_actions (account_id, action, reason, expires_at)
         values ($1, 'suspend', 'Auto-escalated from mute + violations', now() + interval '72 hours')`,
        [account_id],
      );
    }
  }
}

/**
 * Anonymize old reports and audit logs per retention policy.
 * Keeps the record but removes personally identifiable details.
 */
async function anonymizeOldData(): Promise<void> {
  const retentionDays = 90;

  // Anonymize old reports (replace reporter account ID with null after retention period)
  await query(
    `update reports
     set reporter_account_id = null, details = '[redacted]'
     where created_at < now() - interval '${retentionDays} days'
     and reporter_account_id is not null`,
  );

  // Anonymize old audit logs (keep action but redact metadata)
  await query(
    `update audit_log
     set metadata = '{"redacted": true}'::jsonb
     where created_at < now() - interval '${retentionDays} days'
     and action not in ('account.created', 'account.deleted')`,
  );

  console.log(JSON.stringify({
    event: "data_anonymized",
    retention_days: retentionDays,
    timestamp: new Date().toISOString(),
  }));
}

/**
 * Export for testing and scheduled execution.
 */
export async function startCleanupWorkerSchedule(intervalMinutes = 5): Promise<void> {
  console.log(JSON.stringify({
    event: "cleanup_worker_started",
    interval_minutes: intervalMinutes,
  }));

  // Run immediately on start
  await runCleanupWorker();

  // Then every N minutes
  setInterval(() => {
    void runCleanupWorker();
  }, intervalMinutes * 60 * 1000);
}
