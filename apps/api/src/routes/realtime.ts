import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { query, queryOne } from "../db.js";
import { ApiError, send } from "../http.js";
import { createToken, hashToken, safeEqual } from "../security.js";
import { requireProfile, requireViewer } from "../session.js";

const TOKEN_TTL_SECONDS = 120;

export async function realtimeRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Mints the short-lived token the browser presents on the socket handshake.
   *
   * The session cookie never leaves this origin. If a gateway is compromised it
   * holds two-minute tokens, not sessions.
   */
  app.post("/v1/realtime/token", async (request, reply) => {
    const viewer = await requireProfile(request);

    const banned = await queryOne<{ id: string }>(
      `select id from moderation_actions
        where account_id = $1 and action in ('suspend', 'ban')
          and (expires_at is null or expires_at > now()) limit 1`,
      [viewer.accountId],
    );
    if (banned) throw ApiError.forbidden("This account cannot join chats right now.");

    const token = createToken();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000);
    await query(
      "insert into realtime_tokens (account_id, token_hash, expires_at) values ($1, $2, $3)",
      [viewer.accountId, token.hash, expiresAt],
    );
    return send(reply, 200, { token: token.token, expiresAt: expiresAt.toISOString() });
  });

  /**
   * Media rooms need a live match, and this service has no matches table —
   * random rooms are deliberately not persisted. Until the SFU and the
   * gateway's match registry exist, this says so rather than issuing a token
   * for a room nobody is in.
   */
  app.post("/v1/media/room-token", async (request, reply) => {
    await requireProfile(request);
    const parsed = z.object({
      matchId: z.string().min(1).max(120),
      kind: z.enum(["voice", "video"]),
    }).safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("invalid_room", "Could not join that room.");

    void reply;
    throw ApiError.unavailable("Voice and video rooms are not connected yet.");
  });
}

/**
 * Internal: the realtime gateway exchanges a handshake token for an account id.
 *
 * Guarded by a shared key rather than a session, because the caller is a
 * service. Tokens are single use: consuming one here means a captured token
 * cannot be replayed by a second connection.
 */
export async function internalRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/internal/realtime/introspect", async (request, reply) => {
    const presented = request.headers["x-internal-key"];
    if (!env.INTERNAL_API_KEY || typeof presented !== "string" || !safeEqual(presented, env.INTERNAL_API_KEY)) {
      throw ApiError.unauthorized("Not authorised.");
    }

    const parsed = z.object({ token: z.string().min(20) }).safeParse(request.body);
    if (!parsed.success) return send(reply, 200, { accountId: null, blocked: true });

    const row = await queryOne<{ id: string; account_id: string }>(
      `update realtime_tokens set consumed_at = now()
        where token_hash = $1 and consumed_at is null and expires_at > now()
        returning id, account_id`,
      [hashToken(parsed.data.token)],
    );
    if (!row) return send(reply, 200, { accountId: null, blocked: true });

    const banned = await queryOne<{ id: string }>(
      `select id from moderation_actions
        where account_id = $1 and action in ('suspend', 'ban')
          and (expires_at is null or expires_at > now()) limit 1`,
      [row.account_id],
    );
    return send(reply, 200, { accountId: row.account_id, blocked: Boolean(banned) });
  });
}
