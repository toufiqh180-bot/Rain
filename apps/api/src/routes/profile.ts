import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query, queryOne, transaction } from "../db.js";
import { ApiError, send } from "../http.js";
import { handleFrom, verifyPassword } from "../security.js";
import { requireProfile, requireViewer } from "../session.js";
import { MAX_AVATAR_BYTES, storeAvatar } from "../storage.js";

export type ProfileRow = {
  id: string;
  name: string;
  handle: string;
  avatar_url: string | null;
  bio: string;
  identity: string;
  seeking: string;
  interests: string[];
  karma: number;
  created_at: Date;
};

/**
 * The only place a profile becomes JSON.
 *
 * `plan` is passed in from the subscriptions table rather than read off the
 * profile, so an entitlement can never drift from what billing says.
 */
export function serialiseProfile(row: ProfileRow, plan: string) {
  return {
    id: row.id,
    name: row.name,
    handle: row.handle,
    avatarUrl: row.avatar_url,
    bio: row.bio,
    identity: row.identity,
    seeking: row.seeking,
    interests: row.interests,
    plan,
    karma: row.karma,
    createdAt: row.created_at.toISOString(),
  };
}

const interests = z.array(z.string().trim().toLowerCase().min(2).max(32)).max(5)
  .transform((values) => [...new Set(values)]);

const draft = z.object({
  name: z.string().trim().min(2).max(24),
  bio: z.string().trim().max(120).default(""),
  identity: z.string().trim().max(40).default("Prefer not to say"),
  seeking: z.string().trim().max(40).default("Everyone"),
  interests: interests.default([]),
  acceptedAgeGate: z.literal(true),
});

const patch = z.object({
  name: z.string().trim().min(2).max(24).optional(),
  bio: z.string().trim().max(120).optional(),
  identity: z.string().trim().max(40).optional(),
  seeking: z.string().trim().max(40).optional(),
  interests: interests.optional(),
});

async function planFor(accountId: string): Promise<string> {
  const row = await queryOne<{ plan: string; status: string }>(
    "select plan, status from subscriptions where account_id = $1",
    [accountId],
  );
  if (!row) return "free";
  return row.status === "active" || row.status === "trialing" ? row.plan : "free";
}

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/profile", async (request, reply) => {
    const viewer = await requireViewer(request);
    if (viewer.profileId) throw ApiError.conflict("profile_exists", "You already have a profile.");

    const parsed = draft.safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("invalid_profile", "Check your profile details.");
    const { name, bio, identity, seeking, interests: chosen } = parsed.data;

    // The handle carries a random suffix, so a collision is rare — but the
    // unique index is the authority, and we retry rather than fail the signup.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const row = await queryOne<ProfileRow>(
          `insert into profiles (account_id, name, handle, bio, identity, seeking, interests)
           values ($1, $2, $3, $4, $5, $6, $7) returning *`,
          [viewer.accountId, name, handleFrom(name), bio, identity, seeking, chosen],
        );
        return send(reply, 200, serialiseProfile(row!, await planFor(viewer.accountId)));
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "23505") throw error;
      }
    }
    throw ApiError.conflict("handle_unavailable", "Could not reserve a handle. Try a different name.");
  });

  app.patch("/v1/profile", async (request, reply) => {
    const viewer = await requireProfile(request);
    const parsed = patch.safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("invalid_profile", "Check your profile details.");

    const fields = Object.entries(parsed.data).filter(([, value]) => value !== undefined);
    if (!fields.length) throw ApiError.badRequest("nothing_to_update", "Nothing to change.");

    const assignments = fields.map(([key], index) => `${key} = $${index + 2}`).join(", ");
    const row = await queryOne<ProfileRow>(
      `update profiles set ${assignments}, updated_at = now() where id = $1 returning *`,
      [viewer.profileId, ...fields.map(([, value]) => value)],
    );
    return send(reply, 200, serialiseProfile(row!, await planFor(viewer.accountId)));
  });

  app.post("/v1/profile/avatar", async (request, reply) => {
    const viewer = await requireProfile(request);
    const file = await request.file({ limits: { fileSize: MAX_AVATAR_BYTES, files: 1 } });
    if (!file) throw ApiError.badRequest("missing_file", "Choose an image to upload.");

    const bytes = await file.toBuffer();
    const avatarUrl = await storeAvatar(bytes, file.mimetype);
    await query("update profiles set avatar_url = $1, updated_at = now() where id = $2", [avatarUrl, viewer.profileId]);
    return send(reply, 200, { avatarUrl });
  });

  app.delete("/v1/profile", async (request, reply) => {
    const viewer = await requireViewer(request);
    const parsed = z.object({ password: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("password_required", "Confirm your password to delete your account.");

    const account = await queryOne<{ password_hash: string }>(
      "select password_hash from accounts where id = $1", [viewer.accountId],
    );
    if (!account || !(await verifyPassword(parsed.data.password, account.password_hash))) {
      throw new ApiError(401, "bad_credentials", "That password is incorrect.");
    }

    await transaction(async (client) => {
      // Soft delete plus scrubbed email: the row stays for moderation and
      // billing history, but the identity is gone and the address is reusable.
      await client.query(
        `update accounts set deleted_at = now(), email = 'deleted+' || id || '@invalid',
                             password_hash = '', updated_at = now() where id = $1`,
        [viewer.accountId],
      );
      await client.query("update sessions set revoked_at = now() where account_id = $1", [viewer.accountId]);
      await client.query("delete from profiles where account_id = $1", [viewer.accountId]);
      await client.query("insert into audit_log (account_id, action) values ($1, 'account.deleted')", [viewer.accountId]);
      await client.query("insert into outbox (topic, payload) values ('account.deleted', $1)", [
        JSON.stringify({ accountId: viewer.accountId }),
      ]);
    });
    return send(reply, 204);
  });
}
