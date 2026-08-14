import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query, queryOne, transaction } from "../db.js";
import { ApiError, send } from "../http.js";
import { requireProfile } from "../session.js";
import { presenceFor } from "../presence.js";

const PAGE_SIZE = 50;

const message = z.object({
  clientMessageId: z.string().uuid(),
  body: z.string().trim().min(1).max(1000),
});

/** Confirms the caller is in this thread before any read or write touches it. */
async function assertMember(threadId: string, profileId: string): Promise<void> {
  const row = await queryOne<{ profile_id: string }>(
    "select profile_id from dm_thread_members where thread_id = $1 and profile_id = $2",
    [threadId, profileId],
  );
  if (!row) throw ApiError.notFound("That conversation is no longer available.");
}


/**
 * Turns a pending request into a connection.
 *
 * Thread, membership and both direction rows commit together — a thread with
 * only one member, or a connection with no thread, would be unrenderable.
 */
async function acceptRequest(requestId: string, addresseeProfileId: string): Promise<void> {
  await transaction(async (client) => {
    const found = await client.query<{ from_profile: string; to_profile: string }>(
      `update connection_requests set status = 'accepted', resolved_at = now()
        where id = $1 and to_profile = $2 and status = 'pending'
        returning from_profile, to_profile`,
      [requestId, addresseeProfileId],
    );
    if (!found.rowCount) throw ApiError.notFound("That request is no longer pending.");
    const { from_profile: requester, to_profile: addressee } = found.rows[0];

    const thread = await client.query<{ id: string }>("insert into dm_threads default values returning id");
    const threadId = thread.rows[0].id;
    await client.query(
      "insert into dm_thread_members (thread_id, profile_id) values ($1, $2), ($1, $3)",
      [threadId, requester, addressee],
    );
    await client.query(
      `insert into connections (profile_id, peer_profile_id, thread_id)
       values ($1, $2, $3), ($2, $1, $3)`,
      [requester, addressee, threadId],
    );
  });
}

export async function socialRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/connections", async (request, reply) => {
    const viewer = await requireProfile(request);
    const rows = await query<{
      id: string; peer_profile_id: string; name: string; handle: string;
      avatar_url: string | null; karma: number; interests: string[];
    }>(
      `select c.id, c.peer_profile_id, p.name, p.handle, p.avatar_url, p.karma, p.interests
         from connections c
         join profiles p on p.id = c.peer_profile_id
        where c.profile_id = $1
        order by c.created_at desc`,
      [viewer.profileId],
    );

    const presence = await presenceFor(rows.map((row) => row.peer_profile_id));
    // `identity` and `seeking` are never selected here. They are private
    // matching inputs and must not reach another person's client.
    return send(reply, 200, rows.map((row) => ({
      id: row.id,
      profileId: row.peer_profile_id,
      name: row.name,
      handle: row.handle,
      avatarUrl: row.avatar_url,
      presence: presence.get(row.peer_profile_id) ?? "offline",
      karma: row.karma,
      interests: row.interests,
    })));
  });

  /**
   * The mutual-consent half of the social graph.
   *
   * A DM thread is created only when a request is accepted, never by a
   * one-sided action — that is what separates a saved conversation from a
   * random room.
   */
  app.post("/v1/connections/requests", async (request, reply) => {
    const viewer = await requireProfile(request);
    const parsed = z.object({ profileId: z.string().uuid() }).safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("invalid_request", "Could not send that request.");
    const target = parsed.data.profileId;
    if (target === viewer.profileId) throw ApiError.badRequest("invalid_request", "You cannot connect with yourself.");

    const blocked = await queryOne<{ blocker_profile_id: string }>(
      `select blocker_profile_id from blocks
        where (blocker_profile_id = $1 and blocked_profile_id = $2)
           or (blocker_profile_id = $2 and blocked_profile_id = $1) limit 1`,
      [viewer.profileId, target],
    );
    // Deliberately the same answer whether they blocked you or do not exist:
    // the response must not confirm that a block is in place.
    if (blocked) throw ApiError.notFound("That person is not available.");

    const already = await queryOne<{ id: string }>(
      "select id from connections where profile_id = $1 and peer_profile_id = $2",
      [viewer.profileId, target],
    );
    if (already) throw ApiError.conflict("already_connected", "You are already connected.");

    // If they already asked you, accepting is the obvious intent — do that
    // rather than creating a second, mirrored pending request.
    const incoming = await queryOne<{ id: string }>(
      "select id from connection_requests where from_profile = $1 and to_profile = $2 and status = 'pending'",
      [target, viewer.profileId],
    );
    if (incoming) {
      await acceptRequest(incoming.id, viewer.profileId);
      return send(reply, 200, { status: "accepted" });
    }

    const row = await queryOne<{ id: string }>(
      `insert into connection_requests (from_profile, to_profile) values ($1, $2)
       on conflict (from_profile, to_profile) where status = 'pending' do nothing
       returning id`,
      [viewer.profileId, target],
    );
    return send(reply, 200, { status: "pending", id: row?.id ?? null });
  });

  app.get("/v1/connections/requests", async (request, reply) => {
    const viewer = await requireProfile(request);
    const rows = await query<{
      id: string; direction: string; profile_id: string; name: string; handle: string; avatar_url: string | null; created_at: Date;
    }>(
      `select r.id,
              case when r.to_profile = $1 then 'incoming' else 'outgoing' end as direction,
              p.id as profile_id, p.name, p.handle, p.avatar_url, r.created_at
         from connection_requests r
         join profiles p on p.id = case when r.to_profile = $1 then r.from_profile else r.to_profile end
        where r.status = 'pending' and (r.to_profile = $1 or r.from_profile = $1)
        order by r.created_at desc`,
      [viewer.profileId],
    );
    return send(reply, 200, rows.map((row) => ({
      id: row.id,
      direction: row.direction,
      profileId: row.profile_id,
      name: row.name,
      handle: row.handle,
      avatarUrl: row.avatar_url,
      createdAt: row.created_at.toISOString(),
    })));
  });

  app.post("/v1/connections/requests/:id/accept", async (request, reply) => {
    const viewer = await requireProfile(request);
    const { id } = request.params as { id: string };
    await acceptRequest(id, viewer.profileId);
    return send(reply, 200, { status: "accepted" });
  });

  app.post("/v1/connections/requests/:id/decline", async (request, reply) => {
    const viewer = await requireProfile(request);
    const { id } = request.params as { id: string };
    const row = await queryOne<{ id: string }>(
      `update connection_requests set status = 'declined', resolved_at = now()
        where id = $1 and to_profile = $2 and status = 'pending' returning id`,
      [id, viewer.profileId],
    );
    if (!row) throw ApiError.notFound("That request is no longer pending.");
    return send(reply, 204);
  });

  app.delete("/v1/connections/:id", async (request, reply) => {
    const viewer = await requireProfile(request);
    const { id } = request.params as { id: string };

    await transaction(async (client) => {
      const found = await client.query<{ peer_profile_id: string; thread_id: string }>(
        "select peer_profile_id, thread_id from connections where id = $1 and profile_id = $2",
        [id, viewer.profileId],
      );
      if (!found.rowCount) throw ApiError.notFound();
      const { peer_profile_id: peer, thread_id: thread } = found.rows[0];
      // Removal is mutual by definition: a one-sided connection is not a thing.
      await client.query(
        "delete from connections where (profile_id = $1 and peer_profile_id = $2) or (profile_id = $2 and peer_profile_id = $1)",
        [viewer.profileId, peer],
      );
      await client.query("delete from dm_threads where id = $1", [thread]);
    });
    return send(reply, 204);
  });

  app.post("/v1/blocks", async (request, reply) => {
    const viewer = await requireProfile(request);
    const parsed = z.object({ profileId: z.string().uuid() }).safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("invalid_block", "Could not block that person.");
    const target = parsed.data.profileId;
    if (target === viewer.profileId) throw ApiError.badRequest("invalid_block", "You cannot block yourself.");

    await transaction(async (client) => {
      await client.query(
        "insert into blocks (blocker_profile_id, blocked_profile_id) values ($1, $2) on conflict do nothing",
        [viewer.profileId, target],
      );
      // A block also severs the connection, both ways, and drops the thread.
      const rows = await client.query<{ thread_id: string }>(
        "select thread_id from connections where profile_id = $1 and peer_profile_id = $2",
        [viewer.profileId, target],
      );
      await client.query(
        "delete from connections where (profile_id = $1 and peer_profile_id = $2) or (profile_id = $2 and peer_profile_id = $1)",
        [viewer.profileId, target],
      );
      for (const row of rows.rows) await client.query("delete from dm_threads where id = $1", [row.thread_id]);
      await client.query("insert into audit_log (account_id, action, metadata) values ($1, 'profile.blocked', $2)", [
        viewer.accountId, JSON.stringify({ target }),
      ]);
    });
    return send(reply, 204);
  });

  app.get("/v1/dm/threads", async (request, reply) => {
    const viewer = await requireProfile(request);
    const rows = await query<{
      id: string; connection_id: string | null; unread: string;
      last_id: string | null; last_author: string | null; last_body: string | null; last_sent_at: Date | null;
    }>(
      `select t.id,
              c.id as connection_id,
              (select count(*) from dm_messages m
                where m.thread_id = t.id
                  and m.author_profile_id <> $1
                  and (tm.last_read_message_id is null
                       or m.sent_at > (select sent_at from dm_messages r where r.id = tm.last_read_message_id)))::text as unread,
              last.id as last_id, last.author_profile_id as last_author,
              last.body as last_body, last.sent_at as last_sent_at
         from dm_thread_members tm
         join dm_threads t on t.id = tm.thread_id
         left join connections c on c.thread_id = t.id and c.profile_id = $1
         left join lateral (
              select id, author_profile_id, body, sent_at from dm_messages
               where thread_id = t.id order by sent_at desc, id desc limit 1
         ) last on true
        where tm.profile_id = $1
        order by coalesce(last.sent_at, t.created_at) desc`,
      [viewer.profileId],
    );

    return send(reply, 200, rows.map((row) => ({
      id: row.id,
      connectionId: row.connection_id,
      unreadCount: Number(row.unread),
      lastMessage: row.last_id ? {
        id: row.last_id,
        threadId: row.id,
        authorId: row.last_author,
        body: row.last_body,
        sentAt: row.last_sent_at!.toISOString(),
      } : null,
    })));
  });

  app.get("/v1/dm/threads/:id/messages", async (request, reply) => {
    const viewer = await requireProfile(request);
    const { id } = request.params as { id: string };
    const { cursor } = request.query as { cursor?: string };
    await assertMember(id, viewer.profileId);

    // Keyset pagination, not OFFSET: page 500 costs the same as page 1, and a
    // message arriving mid-scroll cannot shift rows across page boundaries.
    const rows = await query<{ id: string; author_profile_id: string; body: string; sent_at: Date }>(
      `select id, author_profile_id, body, sent_at from dm_messages
        where thread_id = $1 and ($2::timestamptz is null or sent_at < $2)
        order by sent_at desc, id desc limit ${PAGE_SIZE + 1}`,
      [id, cursor ?? null],
    );

    const page = rows.slice(0, PAGE_SIZE).reverse();
    return send(reply, 200, {
      items: page.map((row) => ({
        id: row.id, threadId: id, authorId: row.author_profile_id,
        body: row.body, sentAt: row.sent_at.toISOString(),
      })),
      nextCursor: rows.length > PAGE_SIZE ? page[0]?.sent_at.toISOString() ?? null : null,
    });
  });

  app.post("/v1/dm/threads/:id/messages", async (request, reply) => {
    const viewer = await requireProfile(request);
    const { id } = request.params as { id: string };
    const parsed = message.safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("invalid_message", "Messages must be 1 to 1,000 characters.");
    await assertMember(id, viewer.profileId);

    // `on conflict do update` rather than `do nothing`, so a retry returns the
    // original row instead of an empty result the client cannot render.
    const row = await queryOne<{ id: string; author_profile_id: string; body: string; sent_at: Date }>(
      `insert into dm_messages (thread_id, author_profile_id, client_message_id, body)
       values ($1, $2, $3, $4)
       on conflict (thread_id, client_message_id) do update set body = dm_messages.body
       returning id, author_profile_id, body, sent_at`,
      [id, viewer.profileId, parsed.data.clientMessageId, parsed.data.body],
    );

    return send(reply, 200, {
      id: row!.id, threadId: id, authorId: row!.author_profile_id,
      body: row!.body, sentAt: row!.sent_at.toISOString(),
    });
  });

  app.post("/v1/dm/threads/:id/read", async (request, reply) => {
    const viewer = await requireProfile(request);
    const { id } = request.params as { id: string };
    const parsed = z.object({ messageId: z.string().uuid() }).safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("invalid_read", "Could not update the read marker.");
    await assertMember(id, viewer.profileId);

    await query(
      "update dm_thread_members set last_read_message_id = $1 where thread_id = $2 and profile_id = $3",
      [parsed.data.messageId, id, viewer.profileId],
    );
    return send(reply, 204);
  });
}
