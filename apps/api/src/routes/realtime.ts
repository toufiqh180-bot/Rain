import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { query, queryOne } from "../db.js";
import { ApiError, send } from "../http.js";
import { issueLiveKitToken } from "../livekit.js";
import { createToken, hashToken, safeEqual } from "../security.js";
import { requireProfile } from "../session.js";

const TOKEN_TTL_SECONDS = 120;

export async function realtimeRoutes(app: FastifyInstance): Promise<void> {
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
    await query("insert into realtime_tokens (account_id, token_hash, expires_at) values ($1, $2, $3)", [
      viewer.accountId,
      token.hash,
      expiresAt,
    ]);
    return send(reply, 200, { token: token.token, expiresAt: expiresAt.toISOString() });
  });

  app.post("/v1/media/room-token", async (request, reply) => {
    const viewer = await requireProfile(request);
    const parsed = z
      .object({
        matchId: z.string().uuid(),
        kind: z.enum(["voice", "video"]),
      })
      .safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("invalid_room", "Could not join that room.");

    const profile = await queryOne<{ name: string }>("select name from profiles where id = $1", [viewer.profileId]);
    if (!profile) throw ApiError.forbidden("Finish setting up your profile first.");

    const roomName = `${parsed.data.kind}-${parsed.data.matchId}`;
    const issued = issueLiveKitToken({
      identity: viewer.profileId,
      name: profile.name,
      roomName,
      canPublish: true,
      ttlSeconds: 300,
    });
    return send(reply, 200, issued);
  });
}

export async function internalRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/internal/realtime/introspect", async (request, reply) => {
    const presented = request.headers["x-internal-key"];
    if (!env.INTERNAL_API_KEY || typeof presented !== "string" || !safeEqual(presented, env.INTERNAL_API_KEY)) {
      throw ApiError.unauthorized("Not authorised.");
    }

    const parsed = z.object({ token: z.string().min(20) }).safeParse(request.body);
    if (!parsed.success) {
      return send(reply, 200, {
        accountId: null,
        profileId: null,
        blocked: true,
        blockedProfileIds: [],
        plan: "free",
      });
    }

    const row = await queryOne<{ id: string; account_id: string }>(
      `select id, account_id from realtime_tokens
        where token_hash = $1 and consumed_at is null and expires_at > now()`,
      [hashToken(parsed.data.token)],
    );
    if (!row) {
      return send(reply, 200, {
        accountId: null,
        profileId: null,
        blocked: true,
        blockedProfileIds: [],
        plan: "free",
      });
    }

    const banned = await queryOne<{ id: string }>(
      `select id from moderation_actions
        where account_id = $1 and action in ('suspend', 'ban')
          and (expires_at is null or expires_at > now()) limit 1`,
      [row.account_id],
    );

    const profile = await queryOne<{ id: string }>("select id from profiles where account_id = $1", [row.account_id]);
    const blocks = profile
      ? await query<{ blocked_profile_id: string }>(
          `select blocked_profile_id as blocked_profile_id from blocks where blocker_profile_id = $1
           union
           select blocker_profile_id as blocked_profile_id from blocks where blocked_profile_id = $1`,
          [profile.id],
        )
      : [];

    const sub = await queryOne<{ plan: string; status: string }>(
      "select plan, status from subscriptions where account_id = $1",
      [row.account_id],
    );
    const plan =
      sub && (sub.status === "active" || sub.status === "trialing") && (sub.plan === "plus" || sub.plan === "pro")
        ? sub.plan
        : "free";

    return send(reply, 200, {
      accountId: row.account_id,
      profileId: profile?.id ?? null,
      blocked: Boolean(banned),
      blockedProfileIds: blocks.map((b) => b.blocked_profile_id),
      plan,
    });
  });

  app.post("/v1/internal/reports", async (request, reply) => {
    const presented = request.headers["x-internal-key"];
    if (!env.INTERNAL_API_KEY || typeof presented !== "string" || !safeEqual(presented, env.INTERNAL_API_KEY)) {
      throw ApiError.unauthorized("Not authorised.");
    }

    const parsed = z
      .object({
        accountId: z.string().uuid(),
        subjectProfileId: z.string().uuid().optional(),
        matchId: z.string().min(1).max(120).optional(),
        reason: z.enum(["harassment", "sexual-content", "hate", "spam", "minor-safety", "other"]),
        details: z.string().trim().max(500).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("invalid_report", "Could not record that report.");

    const { accountId, subjectProfileId, matchId, reason, details } = parsed.data;
    const report = await queryOne<{ id: string }>(
      `insert into reports (reporter_account_id, subject_profile_id, match_id, reason, details)
       values ($1, $2, $3, $4, $5) returning id`,
      [accountId, subjectProfileId ?? null, matchId ?? null, reason, details ?? null],
    );
    await query(`insert into outbox (topic, payload) values ('report.created', $1)`, [
      JSON.stringify({ reportId: report!.id, reason, accountId, matchId }),
    ]);
    if (reason === "minor-safety") {
      await query(`insert into outbox (topic, payload) values ('report.escalate', $1)`, [
        JSON.stringify({ reportId: report!.id, reason, accountId }),
      ]);
    }
    return send(reply, 200, { id: report!.id });
  });
}
