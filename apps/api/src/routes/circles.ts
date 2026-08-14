import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query, queryOne } from "../db.js";
import { ApiError, send } from "../http.js";
import { requireProfile } from "../session.js";

const PAGE_SIZE = 50;
const message = z.object({
  clientMessageId: z.string().uuid(),
  body: z.string().trim().min(1).max(1000),
});

export async function circleRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/circles", async (request, reply) => {
    await requireProfile(request);
    const rows = await query<{ id: string; slug: string; name: string; members: string; live: boolean }>(
      `select c.id, c.slug, c.name,
              (select count(*) from circle_members m where m.circle_id = c.id)::text as members,
              exists (
                select 1 from circle_messages cm
                 where cm.circle_id = c.id and cm.sent_at > now() - interval '15 minutes'
              ) as live
         from circles c
        order by c.name asc`,
    );
    return send(reply, 200, rows.map((row) => ({
      id: row.id, slug: row.slug, name: row.name,
      memberCount: Number(row.members), live: row.live,
    })));
  });

  app.get("/v1/circles/:id/messages", async (request, reply) => {
    await requireProfile(request);
    const { id } = request.params as { id: string };
    const { cursor } = request.query as { cursor?: string };

    const rows = await query<{
      id: string; author_profile_id: string; name: string; avatar_url: string | null; body: string; sent_at: Date;
    }>(
      `select m.id, m.author_profile_id, p.name, p.avatar_url, m.body, m.sent_at
         from circle_messages m
         join profiles p on p.id = m.author_profile_id
        where m.circle_id = $1 and ($2::timestamptz is null or m.sent_at < $2)
        order by m.sent_at desc, m.id desc limit ${PAGE_SIZE + 1}`,
      [id, cursor ?? null],
    );

    const page = rows.slice(0, PAGE_SIZE).reverse();
    return send(reply, 200, {
      items: page.map((row) => ({
        id: row.id, circleId: id, authorId: row.author_profile_id,
        authorName: row.name, authorAvatarUrl: row.avatar_url,
        body: row.body, sentAt: row.sent_at.toISOString(),
      })),
      nextCursor: rows.length > PAGE_SIZE ? page[0]?.sent_at.toISOString() ?? null : null,
    });
  });

  app.post("/v1/circles/:id/messages", async (request, reply) => {
    const viewer = await requireProfile(request);
    const { id } = request.params as { id: string };
    const parsed = message.safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("invalid_message", "Messages must be 1 to 1,000 characters.");

    // Posting implies membership, so joining is implicit rather than a second
    // round trip the person has to think about.
    await query(
      "insert into circle_members (circle_id, profile_id) values ($1, $2) on conflict do nothing",
      [id, viewer.profileId],
    );

    const row = await queryOne<{ id: string; body: string; sent_at: Date }>(
      `insert into circle_messages (circle_id, author_profile_id, client_message_id, body)
       values ($1, $2, $3, $4)
       on conflict (circle_id, client_message_id) do update set body = circle_messages.body
       returning id, body, sent_at`,
      [id, viewer.profileId, parsed.data.clientMessageId, parsed.data.body],
    );

    const author = await queryOne<{ name: string; avatar_url: string | null }>(
      "select name, avatar_url from profiles where id = $1", [viewer.profileId],
    );
    return send(reply, 200, {
      id: row!.id, circleId: id, authorId: viewer.profileId,
      authorName: author!.name, authorAvatarUrl: author!.avatar_url,
      body: row!.body, sentAt: row!.sent_at.toISOString(),
    });
  });

  app.post("/v1/circles/:id/join", async (request, reply) => {
    const viewer = await requireProfile(request);
    const { id } = request.params as { id: string };
    const circle = await queryOne<{ id: string; slug: string; name: string }>(
      "select id, slug, name from circles where id = $1", [id],
    );
    if (!circle) throw ApiError.notFound();
    await query("insert into circle_members (circle_id, profile_id) values ($1, $2) on conflict do nothing", [id, viewer.profileId]);
    const members = await queryOne<{ count: string }>(
      "select count(*)::text as count from circle_members where circle_id = $1", [id],
    );
    return send(reply, 200, { ...circle, memberCount: Number(members?.count ?? 0), live: false });
  });

  app.post("/v1/circles/:id/leave", async (request, reply) => {
    const viewer = await requireProfile(request);
    const { id } = request.params as { id: string };
    await query("delete from circle_members where circle_id = $1 and profile_id = $2", [id, viewer.profileId]);
    return send(reply, 204);
  });
}
