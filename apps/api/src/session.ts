import type { FastifyReply, FastifyRequest } from "fastify";
import { env, isProduction } from "./env.js";
import { query, queryOne } from "./db.js";
import { ApiError } from "./http.js";
import { createToken, hashToken, safeEqual } from "./security.js";

export const SESSION_COOKIE = "rain_sid";
export const CSRF_COOKIE = "rain_csrf";

export type Viewer = {
  accountId: string;
  email: string;
  emailVerified: boolean;
  sessionId: string;
  profileId: string | null;
};

const cookieBase = {
  path: "/",
  domain: env.COOKIE_DOMAIN,
  // Lax still sends the cookie on top-level navigation (the Stripe return trip)
  // while blocking it on cross-site subrequests.
  sameSite: "lax" as const,
  secure: isProduction,
};

export async function issueSession(reply: FastifyReply, accountId: string, request: FastifyRequest): Promise<void> {
  const session = createToken();
  const csrf = createToken();
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 3_600_000);

  await query(
    `insert into sessions (account_id, token_hash, csrf_token, user_agent, ip, expires_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [accountId, session.hash, csrf.token, request.headers["user-agent"] ?? null, request.ip, expiresAt],
  );

  // HttpOnly: no script can read the session, so an injection cannot steal it.
  reply.setCookie(SESSION_COOKIE, session.token, { ...cookieBase, httpOnly: true, expires: expiresAt });
  // Readable on purpose — the client echoes it back in a header. A cross-site
  // attacker can cause the cookie to be sent but cannot read it to set the header.
  reply.setCookie(CSRF_COOKIE, csrf.token, { ...cookieBase, httpOnly: false, expires: expiresAt });
}

export async function revokeSession(reply: FastifyReply, sessionId: string): Promise<void> {
  await query("update sessions set revoked_at = now() where id = $1 and revoked_at is null", [sessionId]);
  reply.clearCookie(SESSION_COOKIE, cookieBase);
  reply.clearCookie(CSRF_COOKIE, cookieBase);
}

/** Signing in rotates every other session, so a stolen cookie dies on next login. */
export async function revokeAllSessions(accountId: string): Promise<void> {
  await query("update sessions set revoked_at = now() where account_id = $1 and revoked_at is null", [accountId]);
}

type SessionRow = {
  session_id: string;
  account_id: string;
  email: string;
  email_verified: boolean;
  csrf_token: string;
  profile_id: string | null;
};

async function lookup(request: FastifyRequest): Promise<{ viewer: Viewer; csrf: string } | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;

  const row = await queryOne<SessionRow>(
    `select s.id as session_id, s.csrf_token, a.id as account_id, a.email, a.email_verified, p.id as profile_id
       from sessions s
       join accounts a on a.id = s.account_id
       left join profiles p on p.account_id = a.id
      where s.token_hash = $1
        and s.revoked_at is null
        and s.expires_at > now()
        and a.deleted_at is null`,
    [hashToken(token)],
  );
  if (!row) return null;

  return {
    viewer: {
      accountId: row.account_id,
      email: row.email,
      emailVerified: row.email_verified,
      sessionId: row.session_id,
      profileId: row.profile_id,
    },
    csrf: row.csrf_token,
  };
}

/**
 * Resolves the caller and enforces CSRF on writes.
 *
 * Double-submit: the request must carry the same CSRF value in a header and in
 * a cookie. Reads skip the check because they change nothing.
 */
export async function requireViewer(request: FastifyRequest): Promise<Viewer> {
  const found = await lookup(request);
  if (!found) throw ApiError.unauthorized();

  if (request.method !== "GET" && request.method !== "HEAD") {
    const header = request.headers["x-rain-csrf"];
    if (typeof header !== "string" || !safeEqual(header, found.csrf)) {
      throw new ApiError(403, "csrf_failed", "That request could not be verified. Reload the page and try again.");
    }
  }

  // Cheap liveness signal for session listing; not on the hot path of anything.
  void query("update sessions set last_seen_at = now() where id = $1", [found.viewer.sessionId]).catch(() => undefined);
  return found.viewer;
}

/** Same as `requireViewer`, but also insists the account finished onboarding. */
export async function requireProfile(request: FastifyRequest): Promise<Viewer & { profileId: string }> {
  const viewer = await requireViewer(request);
  if (!viewer.profileId) throw ApiError.forbidden("Finish setting up your profile first.");
  return viewer as Viewer & { profileId: string };
}

export async function optionalViewer(request: FastifyRequest): Promise<Viewer | null> {
  const found = await lookup(request);
  return found?.viewer ?? null;
}
