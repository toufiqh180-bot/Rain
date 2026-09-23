import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { query, queryOne, transaction } from "../db.js";
import { ApiError, send } from "../http.js";
import { sendEmail } from "../mail.js";
import { createToken, hashPassword, hashToken, needsRehash, verifyPassword, handleFrom } from "../security.js";
import { issueSession, requireViewer, revokeAllSessions, revokeSession, optionalViewer, CSRF_COOKIE, SESSION_COOKIE } from "../session.js";
import { serialiseProfile, type ProfileRow } from "./profile.js";
import { verifyCaptcha, generateDeviceFingerprint, assessDeviceRisk } from "../captcha.js";
import { checkAbuseStatus, logAbuseEvent, recordDevice, checkRateLimit } from "../abuse-prevention.js";

const credentials = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(12).max(200),
});
const signUpBody = credentials.extend({ 
  acceptedTerms: z.literal(true), 
  acceptedAgeGate: z.literal(true).optional(),
  captchaToken: z.string().optional(),
  deviceFingerprint: z.string().optional(),
});

const guestBody = z.object({
  username: z.string().trim().min(2).max(24),
  gender: z.string().trim().min(1).max(40),
  acceptedTerms: z.literal(true),
  acceptedAgeGate: z.literal(true),
  captchaToken: z.string().optional(),
  deviceFingerprint: z.string().optional(),
});

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
  const account = await queryOne<{
    id: string;
    email: string | null;
    email_verified: boolean;
    is_guest: boolean;
    created_at: Date;
  }>("select id, email, email_verified, is_guest, created_at from accounts where id = $1 and deleted_at is null", [
    accountId,
  ]);
  if (!account) throw ApiError.unauthorized();
  const profile = await queryOne<ProfileRow>("select * from profiles where account_id = $1", [accountId]);
  const plan = await queryOne<{ plan: string; status: string }>(
    "select plan, status from subscriptions where account_id = $1",
    [accountId],
  );
  return {
    account: {
      id: account.id,
      email: account.email ?? "",
      emailVerified: account.email_verified,
      isGuest: account.is_guest,
      createdAt: account.created_at.toISOString(),
    },
    profile: profile
      ? serialiseProfile(
          profile,
          plan?.status === "active" || plan?.status === "trialing" ? plan.plan : "free",
        )
      : null,
  };
}

/** Hard-deletes a guest account and every row cascaded from it. */
async function destroyGuestAccount(accountId: string): Promise<void> {
  await transaction(async (client) => {
    const row = await client.query<{ is_guest: boolean }>(
      "select is_guest from accounts where id = $1 and deleted_at is null",
      [accountId],
    );
    if (!row.rowCount || !row.rows[0].is_guest) {
      throw ApiError.forbidden("Only guest profiles can be removed this way.");
    }
    // Cascade removes sessions, profile, connections, DMs, circle memberships.
    await client.query("delete from accounts where id = $1", [accountId]);
  });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/auth/session", async (request, reply) => {
    const viewer = await optionalViewer(request);
    if (!viewer) throw ApiError.unauthorized("No active session.");
    return send(reply, 200, await sessionPayload(viewer.accountId));
  });

  /**
   * Credential-free entry: username + gender, age gate, then a real session
   * with friends/inbox. Signing out deletes the guest forever.
   */
  app.post("/v1/auth/guest", async (request, reply) => {
    const parsed = guestBody.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.badRequest("invalid_guest", "Enter a username and gender, and confirm you are 18+.");
    }
    const { username, gender, captchaToken, deviceFingerprint } = parsed.data;

    // Verify CAPTCHA in production
    if (env.REQUIRE_CAPTCHA_ON_SIGNUP && captchaToken) {
      const captchaValid = await verifyCaptcha(captchaToken, request.ip);
      if (!captchaValid) {
        await logAbuseEvent("captcha_failed_guest", null, { ip: request.ip });
        throw ApiError.badRequest("captcha_failed", "CAPTCHA verification failed. Try again.");
      }
    }

    // Check device reputation
    if (env.DEVICE_REPUTATION_ENABLED && deviceFingerprint) {
      const riskScore = await assessDeviceRisk(request.ip, deviceFingerprint, query);
      if (riskScore >= 2) {
        await logAbuseEvent("device_blocked_guest_join", null, { ip: request.ip, fingerprint: deviceFingerprint });
        throw ApiError.forbidden("Your device cannot join at this time. Contact support if this is an error.");
      }
    }

    const accountId = await transaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `insert into accounts (email, password_hash, email_verified, is_guest, terms_version, terms_accepted_at, age_gate_accepted_at, age_gate_version)
         values (null, null, false, true, $1, now(), now(), $1) returning id`,
        [env.TERMS_VERSION],
      );
      const id = inserted.rows[0].id;
      await client.query("insert into subscriptions (account_id) values ($1)", [id]);

      let profileId: string | null = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const profile = await client.query<{ id: string }>(
            `insert into profiles (account_id, name, handle, bio, identity, seeking, interests)
             values ($1, $2, $3, '', $4, 'Everyone', '{}') returning id`,
            [id, username, handleFrom(username), gender],
          );
          profileId = profile.rows[0].id;
          break;
        } catch (error) {
          if ((error as { code?: string }).code !== "23505") throw error;
        }
      }
      if (!profileId) throw ApiError.conflict("handle_unavailable", "Could not reserve that username. Try another.");

      // Record device fingerprint for future checks
      if (deviceFingerprint) {
        await client.query(
          `insert into device_fingerprints (account_id, fingerprint, user_agent, ip, risk_score)
           values ($1, $2, $3, $4, 0)
           on conflict do nothing`,
          [id, deviceFingerprint, request.headers["user-agent"] ?? null, request.ip],
        );
      }

      await client.query("insert into audit_log (account_id, action, metadata) values ($1, 'guest.created', $2)", [
        id,
        JSON.stringify({ ip: request.ip, termsVersion: env.TERMS_VERSION, deviceFingerprint }),
      ]);
      return id;
    });

    await issueSession(reply, accountId, request);
    return send(reply, 200, await sessionPayload(accountId));
  });

  app.post("/v1/auth/sign-up", async (request, reply) => {
    const parsed = signUpBody.safeParse(request.body);
    if (!parsed.success) {
      throw ApiError.badRequest("invalid_credentials", "Check your email and password.", {
        password: "Use at least 12 characters.",
      });
    }
    const { email, password, acceptedAgeGate, captchaToken, deviceFingerprint } = parsed.data;

    // Verify CAPTCHA in production
    if (env.REQUIRE_CAPTCHA_ON_SIGNUP && captchaToken) {
      const captchaValid = await verifyCaptcha(captchaToken, request.ip);
      if (!captchaValid) {
        await logAbuseEvent("captcha_failed_signup", null, { ip: request.ip, email });
        throw ApiError.badRequest("captcha_failed", "CAPTCHA verification failed. Try again.");
      }
    }

    // Check device reputation
    if (env.DEVICE_REPUTATION_ENABLED && deviceFingerprint) {
      const riskScore = await assessDeviceRisk(request.ip, deviceFingerprint, query);
      if (riskScore >= 2) {
        await logAbuseEvent("device_blocked_signup", null, { ip: request.ip, fingerprint: deviceFingerprint });
        throw ApiError.forbidden("Your device cannot sign up at this time. Contact support if this is an error.");
      }
    }

    const passwordHash = await hashPassword(password);
    const accountId = await transaction(async (client) => {
      const existing = await client.query("select 1 from accounts where lower(email) = $1 and deleted_at is null", [
        email,
      ]);
      if (existing.rowCount) throw ApiError.conflict("email_taken", "That email already has an account.");

      const inserted = await client.query<{ id: string }>(
        `insert into accounts (email, password_hash, terms_version, terms_accepted_at, age_gate_accepted_at, age_gate_version, is_guest)
         values ($1, $2, $3, now(), $4, $5, false) returning id`,
        [
          email,
          passwordHash,
          env.TERMS_VERSION,
          acceptedAgeGate ? new Date() : null,
          acceptedAgeGate ? env.TERMS_VERSION : null,
        ],
      );
      const id = inserted.rows[0].id;
      await client.query("insert into subscriptions (account_id) values ($1)", [id]);
      
      // Record device fingerprint for future checks
      if (deviceFingerprint) {
        await client.query(
          `insert into device_fingerprints (account_id, fingerprint, user_agent, ip, risk_score)
           values ($1, $2, $3, $4, 0)
           on conflict do nothing`,
          [id, deviceFingerprint, request.headers["user-agent"] ?? null, request.ip],
        );
      }
      
      await client.query("insert into audit_log (account_id, action, metadata) values ($1, 'account.created', $2)", [
        id,
        JSON.stringify({ termsVersion: env.TERMS_VERSION, ip: request.ip, deviceFingerprint }),
      ]);
      return id;
    });

    const verification = createToken();
    await query(
      `insert into account_tokens (account_id, purpose, token_hash, expires_at)
       values ($1, 'email_verify', $2, now() + interval '2 days')`,
      [accountId, verification.hash],
    );
    await sendEmail({
      to: email,
      subject: "Verify your Rain account",
      text: `Verify your Rain email with this code:\n\n${verification.token}\n\nIt expires in 2 days.`,
      log: request.log,
      event: "email_verification_pending",
      accountId,
    });

    await issueSession(reply, accountId, request);
    return send(reply, 200, await sessionPayload(accountId));
  });

  app.post("/v1/auth/sign-in", async (request, reply) => {
    const parsed = credentials.safeParse(request.body);
    if (!parsed.success) throw new ApiError(401, "bad_credentials", "Email or password is incorrect.");
    const { email, password } = parsed.data;

    if (await tooManyFailures(email, request.ip)) throw ApiError.tooMany();

    const account = await queryOne<{ id: string; password_hash: string | null; is_guest: boolean }>(
      "select id, password_hash, is_guest from accounts where lower(email) = $1 and deleted_at is null",
      [email],
    );

    const hash = account?.password_hash ?? "scrypt$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA";
    const ok = account?.password_hash ? await verifyPassword(password, hash) : await verifyPassword(password, hash);

    if (!account || account.is_guest || !account.password_hash || !ok) {
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
        await hashPassword(password),
        account.id,
      ]);
    }

    await revokeAllSessions(account.id);
    await issueSession(reply, account.id, request);
    return send(reply, 200, await sessionPayload(account.id));
  });

  app.post("/v1/auth/sign-out", async (request, reply) => {
    const viewer = await requireViewer(request);
    if (viewer.isGuest) {
      // Guest accounts are intentionally one-time. Delete immediately on logout.
      await destroyGuestAccount(viewer.accountId);
      reply.clearCookie(SESSION_COOKIE, { path: "/", domain: env.COOKIE_DOMAIN, sameSite: "lax" });
      reply.clearCookie(CSRF_COOKIE, { path: "/", domain: env.COOKIE_DOMAIN, sameSite: "lax" });
      await query("insert into audit_log (account_id, action) values ($1, 'guest.deleted')", [viewer.accountId]);
      return send(reply, 204);
    }
    await revokeSession(reply, viewer.sessionId);
    return send(reply, 204);
  });

  app.post("/v1/auth/password/reset-request", async (request, reply) => {
    const parsed = z.object({ email: z.string().trim().toLowerCase().email() }).safeParse(request.body);
    if (parsed.success) {
      const account = await queryOne<{ id: string; email: string }>(
        "select id, email from accounts where lower(email) = $1 and deleted_at is null and is_guest = false",
        [parsed.data.email],
      );
      if (account?.email) {
        const reset = createToken();
        await query(
          `insert into account_tokens (account_id, purpose, token_hash, expires_at)
           values ($1, 'password_reset', $2, now() + interval '1 hour')`,
          [account.id, reset.hash],
        );
        await sendEmail({
          to: account.email,
          subject: "Reset your Rain password",
          text: `Reset your Rain password with this code:\n\n${reset.token}\n\nIt expires in one hour.`,
          log: request.log,
          event: "password_reset_pending",
          accountId: account.id,
        });
      }
    }
    return send(reply, 204);
  });

  app.post("/v1/auth/password/reset", async (request, reply) => {
    const parsed = z
      .object({ token: z.string().min(20), password: z.string().min(12).max(200) })
      .safeParse(request.body);
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
      await client.query("update accounts set password_hash = $1, updated_at = now() where id = $2", [
        passwordHash,
        row.account_id,
      ]);
      await client.query("update sessions set revoked_at = now() where account_id = $1 and revoked_at is null", [
        row.account_id,
      ]);
      await client.query("insert into audit_log (account_id, action) values ($1, 'password.reset')", [row.account_id]);
    });
    return send(reply, 204);
  });

  app.post("/v1/auth/email/resend", async (request, reply) => {
    const viewer = await requireViewer(request);
    if (viewer.isGuest) throw ApiError.forbidden("Guest profiles do not use email.");
    if (viewer.emailVerified) return send(reply, 204);
    if (!viewer.email) throw ApiError.badRequest("no_email", "This account has no email.");
    const verification = createToken();
    await query(
      `insert into account_tokens (account_id, purpose, token_hash, expires_at)
       values ($1, 'email_verify', $2, now() + interval '2 days')`,
      [viewer.accountId, verification.hash],
    );
    await sendEmail({
      to: viewer.email,
      subject: "Verify your Rain account",
      text: `Verify your Rain email with this code:\n\n${verification.token}\n\nIt expires in 2 days.`,
      log: request.log,
      event: "email_verification_pending",
      accountId: viewer.accountId,
    });
    return send(reply, 204);
  });

  app.post("/v1/auth/email/verify", async (request, reply) => {
    const parsed = z.object({ token: z.string().min(20) }).safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("invalid_token", "That verification link is no longer valid.");
    const row = await queryOne<{ id: string; account_id: string }>(
      `select id, account_id from account_tokens
        where token_hash = $1 and purpose = 'email_verify' and consumed_at = null and expires_at > now()`,
      [hashToken(parsed.data.token)],
    );
    if (!row) throw ApiError.badRequest("invalid_token", "That verification link is no longer valid.");
    await transaction(async (client) => {
      await client.query("update account_tokens set consumed_at = now() where id = $1", [row.id]);
      await client.query("update accounts set email_verified = true, updated_at = now() where id = $1", [
        row.account_id,
      ]);
    });
    return send(reply, 204);
  });
}
