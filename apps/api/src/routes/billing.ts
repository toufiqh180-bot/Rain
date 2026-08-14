import type { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { billingConfigured, env } from "../env.js";
import { query, queryOne, transaction } from "../db.js";
import { ApiError, send } from "../http.js";
import { requireViewer } from "../session.js";

/**
 * Stripe over `fetch`, with the webhook signature verified by hand.
 *
 * Two rules make this safe:
 *   1. Only the webhook writes `subscriptions`. A browser request never does,
 *      so nobody upgrades themselves by replaying a call.
 *   2. Every webhook is verified and de-duplicated before it is trusted.
 */
const PRICE: Record<"plus" | "pro", () => string | undefined> = {
  plus: () => env.STRIPE_PRICE_PLUS,
  pro: () => env.STRIPE_PRICE_PRO,
};

async function stripe<T>(path: string, form: Record<string, string>): Promise<T> {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = (payload as { error?: { message?: string } }).error?.message;
    throw ApiError.unavailable(detail ?? "Could not reach the payment provider.");
  }
  return payload as T;
}

async function customerFor(accountId: string, email: string): Promise<string> {
  const existing = await queryOne<{ stripe_customer_id: string | null }>(
    "select stripe_customer_id from subscriptions where account_id = $1", [accountId],
  );
  if (existing?.stripe_customer_id) return existing.stripe_customer_id;

  const created = await stripe<{ id: string }>("customers", { email, "metadata[accountId]": accountId });
  await query(
    `insert into subscriptions (account_id, stripe_customer_id) values ($1, $2)
     on conflict (account_id) do update set stripe_customer_id = excluded.stripe_customer_id, updated_at = now()`,
    [accountId, created.id],
  );
  return created.id;
}

/**
 * Verifies `Stripe-Signature` without the SDK.
 *
 * The timestamp check matters as much as the HMAC: without it a captured
 * request could be replayed forever.
 */
function verifySignature(payload: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((piece) => piece.split("=", 2) as [string, string]));
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) return false;

  const expected = createHmac("sha256", secret).update(`${parts.t}.${payload}`).digest("hex");
  const provided = parts.v1 ?? "";
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

const PLAN_BY_PRICE = () => new Map<string, "plus" | "pro">([
  [env.STRIPE_PRICE_PLUS ?? "", "plus"],
  [env.STRIPE_PRICE_PRO ?? "", "pro"],
]);

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/billing/entitlement", async (request, reply) => {
    const viewer = await requireViewer(request);
    const row = await queryOne<{
      plan: string; status: string; current_period_end: Date | null; cancel_at_period_end: boolean;
    }>(
      `select plan, status, current_period_end, cancel_at_period_end
         from subscriptions where account_id = $1`,
      [viewer.accountId],
    );
    // Entitlement is derived from status, so a lapsed card downgrades access
    // without anyone running a cleanup job.
    const active = row?.status === "active" || row?.status === "trialing";
    return send(reply, 200, {
      plan: active ? row!.plan : "free",
      status: row?.status ?? "none",
      renewsAt: row?.current_period_end?.toISOString() ?? null,
      cancelAtPeriodEnd: row?.cancel_at_period_end ?? false,
    });
  });

  app.post("/v1/billing/checkout", async (request, reply) => {
    const viewer = await requireViewer(request);
    if (!billingConfigured) throw ApiError.unavailable("Billing is not connected yet.");

    const parsed = z.object({ plan: z.enum(["plus", "pro"]) }).safeParse(request.body);
    if (!parsed.success) throw ApiError.badRequest("invalid_plan", "Choose a membership to continue.");
    const price = PRICE[parsed.data.plan]();
    if (!price) throw ApiError.unavailable("That membership is not available yet.");

    const customer = await customerFor(viewer.accountId, viewer.email);
    const session = await stripe<{ url: string }>("checkout/sessions", {
      mode: "subscription",
      customer,
      "line_items[0][price]": price,
      "line_items[0][quantity]": "1",
      success_url: `${env.BILLING_RETURN_URL}?checkout=done`,
      cancel_url: `${env.BILLING_RETURN_URL}?checkout=cancelled`,
      "subscription_data[metadata][accountId]": viewer.accountId,
      client_reference_id: viewer.accountId,
    });
    return send(reply, 200, { url: session.url });
  });

  app.post("/v1/billing/portal", async (request, reply) => {
    const viewer = await requireViewer(request);
    if (!billingConfigured) throw ApiError.unavailable("Billing is not connected yet.");
    const customer = await customerFor(viewer.accountId, viewer.email);
    const portal = await stripe<{ url: string }>("billing_portal/sessions", {
      customer,
      return_url: env.BILLING_RETURN_URL,
    });
    return send(reply, 200, { url: portal.url });
  });

  // Stripe calls this, not a browser: no session cookie, no CSRF token. The
  // signature is the entire authentication, which is why it is checked first.
  app.post("/v1/billing/webhook", { config: { rawBody: true } }, async (request, reply) => {
    if (!env.STRIPE_WEBHOOK_SECRET) throw ApiError.unavailable("Billing is not connected yet.");
    const raw = (request as { rawBody?: string }).rawBody ?? "";
    if (!verifySignature(raw, request.headers["stripe-signature"] as string | undefined, env.STRIPE_WEBHOOK_SECRET)) {
      throw new ApiError(400, "invalid_signature", "Signature verification failed.");
    }

    const event = JSON.parse(raw) as {
      id: string; type: string;
      data: { object: Record<string, unknown> };
    };

    await transaction(async (client) => {
      // Stripe retries on any non-2xx, so the same event arrives more than
      // once. Recording the id makes a replay a no-op instead of a double-grant.
      const seen = await client.query("insert into processed_stripe_events (event_id) values ($1) on conflict do nothing", [event.id]);
      if (!seen.rowCount) return;

      if (event.type.startsWith("customer.subscription.")) {
        const object = event.data.object as {
          id: string; customer: string; status: string; cancel_at_period_end: boolean;
          current_period_end: number;
          items?: { data?: { price?: { id?: string } }[] };
        };
        const priceId = object.items?.data?.[0]?.price?.id ?? "";
        const plan = PLAN_BY_PRICE().get(priceId) ?? "free";
        const status = event.type === "customer.subscription.deleted" ? "canceled" : object.status;

        await client.query(
          `update subscriptions
              set stripe_subscription_id = $2, plan = $3, status = $4,
                  current_period_end = to_timestamp($5), cancel_at_period_end = $6, updated_at = now()
            where stripe_customer_id = $1`,
          [object.customer, object.id, plan, normaliseStatus(status), object.current_period_end, object.cancel_at_period_end],
        );
      }

      await client.query("insert into outbox (topic, payload) values ('billing.event', $1)", [
        JSON.stringify({ id: event.id, type: event.type }),
      ]);
    });

    return send(reply, 200, { received: true });
  });
}

/** Maps Stripe's status vocabulary onto the four states the client renders. */
function normaliseStatus(status: string): string {
  if (status === "active" || status === "trialing" || status === "past_due" || status === "canceled") return status;
  if (status === "incomplete_expired" || status === "unpaid") return "canceled";
  return "none";
}
