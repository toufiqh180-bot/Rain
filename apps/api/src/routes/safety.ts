import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { transaction } from "../db.js";
import { ApiError, send } from "../http.js";
import { requireViewer } from "../session.js";

const report = z.object({
  matchId: z.string().max(120).optional(),
  profileId: z.string().uuid().optional(),
  reason: z.enum(["harassment", "sexual-content", "hate", "spam", "minor-safety", "other"]),
  details: z.string().trim().max(500).optional(),
});

export async function safetyRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/reports", async (request, reply) => {
    const viewer = await requireViewer(request);
    const parsed = report.safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("invalid_report", "Choose a reason for the report.");
    const { matchId, profileId, reason, details } = parsed.data;

    const id = await transaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `insert into reports (reporter_account_id, subject_profile_id, match_id, reason, details)
         values ($1, $2, $3, $4, $5) returning id`,
        [viewer.accountId, profileId ?? null, matchId ?? null, reason, details ?? null],
      );
      // The report and its moderation job commit together. Either both exist or
      // neither does — a report that silently never gets reviewed is the
      // failure mode this prevents.
      await client.query("insert into outbox (topic, payload) values ($1, $2)", [
        reason === "minor-safety" ? "report.escalate" : "report.created",
        JSON.stringify({ reportId: inserted.rows[0].id, reason }),
      ]);
      return inserted.rows[0].id;
    });

    return send(reply, 200, { id });
  });
}
