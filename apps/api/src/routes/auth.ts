import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { query, queryOne, transaction } from "../db.js";
import { ApiError, send } from "../http.js";
import { createToken, hashPassword, hashToken, needsRehash, verifyPassword } from "../security.js";
import { issueSession, requireViewer, revokeAllSessions, revokeSession, optionalViewer } from "../session.js";
import { serialiseProfile, type ProfileRow } from "./profile.js";

const credentials = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(12).max(200),
});
const signUpBody = credentials.extend({ acceptedTerms: z.literal(true) });

/** Failed sign-ins are counted in Postgres so the limit holds across instances. */
const MAX_FAILURES = 8;
const WINDOW_MINUTES = 15;

async function tooManyFailures(email: string, ip: string): Promise<boolean> {
  const row = await queryOne<{ count: string }>(
    `select count(*)::text as count from login_attempts
      where succeeded = false
        and created_at > now() - ($1 || ' minutes')::interval
        and (lower(email) = $2 or ip = $3)`,
    [String(WINDOW_MINUTES), email, ip],
  );
  return Number(row?.count ?? 0) >= MAX_FAILURES;
}

async function recordAttempt(email: string, ip: string, succeeded: boolean): Promise<void> {
  await query("insert into login_attempts (email, ip, succeeded) values ($1, $2, $3)", [email, ip, succeeded]);
}

async function sessionPayload(accountId: string) {
  const account = await queryOne<{ id: string; email: string; email_verified: boolean; created_at: Date }>(
    "select id, email, email_verified, created_at from accounts where id = $1",
    [accountId],
  );
  if (!account) throw ApiError.unauthorized();
  const profile = await queryOne<ProfileRow>("select * from profiles where account_id = $1", [accountId]);
  const plan = await queryOne<{ plan: string; status: string }>(
    "select plan, status from subscriptions where account_id = $1",
    [accountId],
  );
  return {
    account: {
      id: account.id,
      email: account.email,
      emailVerified: account.email_verified,
      createdAt: account.created_at.toISOString(),
    },
    profile: profile ? serialiseProfile(profile, plan?.status === "active" || plan?.status === "trialing" ? plan.plan : "free") : null,
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // A signed-out visitor gets 401 here. That is an expected answer, not an error.
  app.get("/v1/auth/session", async (request, reply) => {
    const viewer = await optionalViewer(request);
    if (!viewer) throw ApiError.unauthorized("No active session.");
    return send(reply, 200, await sessionPayload(viewer.accountId));
  });

  app.post("/v1/auth/sign-up", async (request, reply) => {
    const parsed = signUpBody.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.badRequest("invalid_credentials", "Check your email and password.", {
        password: "Use at least 12 characters.",
      });
    }
    const { email, password } = parsed.data;

    const passwordHash = await hashPassword(password);
    const accountId = await transaction(async (client) => {
      const existing = await client.query("select 1 from accounts where lower(email) = $1 and deleted_at is null", [email]);
      if (existing.rowCount) throw ApiError.conflict("email_taken", "That email already has an account.");

      const inserted = await client.query<{ id: string }>(
        `insert into accounts (email, password_hash, terms_version, terms_accepted_at)
         values ($1, $2, $3, now()) returning id`,
        [email, passwordHash, env.TERMS_VERSION],
      );
      const id = inserted.rows[0].id;
      // Every account has a subscription row from birth, so entitlement reads
      // never have to special-case "no row yet".
      await client.query("insert into subscriptions (account_id) values ($1)", [id]);
      await client.query("insert into audit_log (account_id, action, metadata) values ($1, 'account.created', $2)", [
        id, JSON.stringify({ termsVersion: env.TERMS_VERSION, ip: request.ip }),
      ]);
      return id;
    });

    const verification = createToken();
    await query(
      `insert into account_tokens (account_id, purpose, token_hash, expires_at)
       values ($1, 'email_verify', $2, now() + interval '2 days')`,
      [accountId, verification.hash],
    );
    // Wire your mailer here. The token is deliberately not returned in the body.
    request.log.info({ event: "email_verification_pending", accountId }, "send verification email");

    await issueSession(reply, accountId, request);
    return send(reply, 200, await sessionPayload(accountId));
  });

  app.post("/v1/auth/sign-in", async (request, reply) => {
    const parsed = credentials.safeParse(request.body);
    if (!parsed.success) throw new ApiError(401, "bad_credentials", "Email or password is incorrect.");
    const { email, password } = parsed.data;

    if (await tooManyFailures(email, request.ip)) throw ApiError.tooMany();

    const account = await queryOne<{ id: string; password_hash: string }>(
      "select id, password_hash from accounts where lower(email) = $1 and deleted_at is null",
      [email],
    );

    // Verify even when no account exists, against a throwaway hash, so response
    // time does not reveal whether the email is registered.
    const hash = account?.password_hash ?? "scrypt$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA";
    const ok = await verifyPassword(password, hash);

    if (!account || !ok) {
      await recordAttempt(email, request.ip, false);
      throw new ApiError(401, "bad_credentials", "Email or password is incorrect.");
    }

    const banned = await queryOne<{ id: string }>(
      `select id from moderation_actions
        where account_id = $1 and action in ('suspend', 'ban')
          and (expires_at is null or expires_at > now()) limit 1`,
      [account.id],
    );
    if (banned) throw ApiError.forbidden("This account is not able to sign in.");

    await recordAttempt(email, request.ip, true);
    if (needsRehash(account.password_hash)) {
      await query("update accounts set password_hash = $1, updated_at = now() where id = $2", [
        await hashPassword(password), account.id,
      ]);
    }

    // Rotate every prior session: a cookie stolen earlier stops working now.
    await revokeAllSessions(account.id);
    await issueSession(reply, account.id, request);
    return send(reply, 200, await sessionPayload(account.id));
  });

  app.post("/v1/auth/sign-out", async (request, reply) => {
    const viewer = await requireViewer(request);
    await revokeSession(reply, viewer.sessionId);
    return send(reply, 204);
  });

  app.post("/v1/auth/password/reset-request", async (request, reply) => {
    const parsed = z.object({ email: z.string().trim().toLowerCase().email() }).safeParse(request.body);
    // Always 204, even on a malformed or unknown email: the response must not
    // reveal whether an account exists.
    if (parsed.success) {
      const account = await queryOne<{ id: string }>(
        "select id from accounts where lower(email) = $1 and deleted_at is null",
        [parsed.data.email],
      );
      if (account) {
        const reset = createToken();
        await query(
          `insert into account_tokens (account_id, purpose, token_hash, expires_at)
           values ($1, 'password_reset', $2, now() + interval '1 hour')`,
          [account.id, reset.hash],
        );
        request.log.info({ event: "password_reset_pending", accountId: account.id }, "send reset email");
      }
    }
    return send(reply, 204);
  });

  app.post("/v1/auth/password/reset", async (request, reply) => {
    const parsed = z.object({ token: z.string().min(20), password: z.string().min(12).max(200) }).safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("invalid_reset", "That reset link is no longer valid.");

    const row = await queryOne<{ id: string; account_id: string }>(
      `select id, account_id from account_tokens
        where token_hash = $1 and purpose = 'password_reset' and consumed_at is null and expires_at > now()`,
      [hashToken(parsed.data.token)],
    );
    if (!row) throw ApiError.badRequest("invalid_reset", "That reset link is no longer valid.");

    const passwordHash = await hashPassword(parsed.data.password);
    await transaction(async (client) => {
      await client.query("update account_tokens set consumed_at = now() where id = $1", [row.id]);
      await client.query("update accounts set password_hash = $1, updated_at = now() where id = $2", [passwordHash, row.account_id]);
      // A password reset must end every existing session, including the
      // attacker's if that is why the person reset it.
      await client.query("update sessions set revoked_at = now() where account_id = $1 and revoked_at is null", [row.account_id]);
      await client.query("insert into audit_log (account_id, action) values ($1, 'password.reset')", [row.account_id]);
    });
    return send(reply, 204);
  });

  app.post("/v1/auth/email/resend", async (request, reply) => {
    const viewer = await requireViewer(request);
    if (viewer.emailVerified) return send(reply, 204);
    const verification = createToken();
    await query(
      `insert into account_tokens (account_id, purpose, token_hash, expires_at)
       values ($1, 'email_verify', $2, now() + interval '2 days')`,
      [viewer.accountId, verification.hash],
    );
    request.log.info({ event: "email_verification_pending", accountId: viewer.accountId }, "send verification email");
    return send(reply, 204);
  });

  app.post("/v1/auth/email/verify", async (request, reply) => {
    const parsed = z.object({ token: z.string().min(20) }).safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("invalid_token", "That verification link is no longer valid.");
    const row = await queryOne<{ id: string; account_id: string }>(
      `select id, account_id from account_tokens
        where token_hash = $1 and purpose = 'email_verify' and consumed_at is null and expires_at > now()`,
      [hashToken(parsed.data.token)],
    );
    if (!row) throw ApiError.badRequest("invalid_token", "That verification link is no longer valid.");
    await transaction(async (client) => {
      await client.query("update account_tokens set consumed_at = now() where id = $1", [row.id]);
      await client.query("update accounts set email_verified = true, updated_at = now() where id = $1", [row.account_id]);
    });
    return send(reply, 204);
  });
}
