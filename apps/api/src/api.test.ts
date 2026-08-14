import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { pool, query } from "./db.js";

/**
 * Integration tests against a real Postgres.
 *
 * These do not mock the database. A mocked test would have passed against every
 * broken query this suite has caught — the point is to exercise the SQL, the
 * transactions and the constraints exactly as production does.
 *
 * Requires DATABASE_URL and applied migrations. CI runs `pnpm migrate` first.
 */

let app: FastifyInstance;

type Actor = { cookies: string; csrf: string; profileId: string; accountId: string };

function readCookies(raw: string[] | string | undefined): Map<string, string> {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const jar = new Map<string, string>();
  for (const entry of list) {
    const [pair] = entry.split(";");
    const index = pair.indexOf("=");
    jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  return jar;
}

async function signUp(email: string, name: string): Promise<Actor> {
  const created = await app.inject({
    method: "POST",
    url: "/v1/auth/sign-up",
    payload: { email, password: "a-sufficiently-long-passphrase", acceptedTerms: true },
  });
  assert.equal(created.statusCode, 200, created.body);

  const jar = readCookies(created.headers["set-cookie"] as string[] | undefined);
  const cookies = [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
  const csrf = jar.get("rain_csrf")!;

  const profile = await app.inject({
    method: "POST",
    url: "/v1/profile",
    headers: { cookie: cookies, "x-rain-csrf": csrf },
    payload: { name, bio: "", identity: "Prefer not to say", seeking: "Everyone", interests: [], acceptedAgeGate: true },
  });
  assert.equal(profile.statusCode, 200, profile.body);

  return {
    cookies,
    csrf,
    profileId: profile.json().id,
    accountId: created.json().account.id,
  };
}

before(async () => {
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app.close();
  await pool.end();
});

describe("accounts", () => {
  it("rejects a session request when signed out", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/auth/session" });
    assert.equal(response.statusCode, 401);
  });

  it("normalises the email and restores the session from the cookie alone", async () => {
    const email = `Mixed.Case.${randomUUID()}@Rain.app`;
    const actor = await signUp(email, "Casey");

    const session = await app.inject({ method: "GET", url: "/v1/auth/session", headers: { cookie: actor.cookies } });
    assert.equal(session.statusCode, 200);
    assert.equal(session.json().account.email, email.toLowerCase());
    assert.equal(session.json().profile.name, "Casey");
  });

  it("refuses a duplicate email regardless of casing", async () => {
    const email = `dupe.${randomUUID()}@rain.app`;
    await signUp(email, "First");
    const second = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-up",
      payload: { email: email.toUpperCase(), password: "a-sufficiently-long-passphrase", acceptedTerms: true },
    });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().code, "email_taken");
  });

  it("revokes the session server-side on sign out", async () => {
    const actor = await signUp(`out.${randomUUID()}@rain.app`, "Leaver");
    const out = await app.inject({
      method: "POST", url: "/v1/auth/sign-out",
      headers: { cookie: actor.cookies, "x-rain-csrf": actor.csrf },
    });
    assert.equal(out.statusCode, 204);

    // The same cookie must now fail. If this passes with 200, sign-out only
    // hid the session in the browser.
    const replay = await app.inject({ method: "GET", url: "/v1/auth/session", headers: { cookie: actor.cookies } });
    assert.equal(replay.statusCode, 401);
  });

  it("answers 204 to a password reset for an address that does not exist", async () => {
    const response = await app.inject({
      method: "POST", url: "/v1/auth/password/reset-request",
      payload: { email: `ghost.${randomUUID()}@nowhere.test` },
    });
    // Anything other than 204 would let someone enumerate registered emails.
    assert.equal(response.statusCode, 204);
  });

  it("locks an email out after repeated failures", async () => {
    const email = `brute.${randomUUID()}@rain.app`;
    await signUp(email, "Target");

    let sawLockout = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({
        method: "POST", url: "/v1/auth/sign-in",
        payload: { email, password: "definitely-the-wrong-password" },
      });
      if (response.statusCode === 429) { sawLockout = true; break; }
      assert.equal(response.statusCode, 401);
    }
    assert.ok(sawLockout, "expected a lockout before the tenth attempt");

    // The correct password must also be refused while locked out, otherwise the
    // limit only slows an attacker down rather than stopping them.
    const correct = await app.inject({
      method: "POST", url: "/v1/auth/sign-in",
      payload: { email, password: "a-sufficiently-long-passphrase" },
    });
    assert.equal(correct.statusCode, 429);
    await query("delete from login_attempts where lower(email) = $1", [email.toLowerCase()]);
  });
});

describe("csrf", () => {
  it("refuses a write without the header and accepts it with", async () => {
    const actor = await signUp(`csrf.${randomUUID()}@rain.app`, "Guarded");

    const without = await app.inject({
      method: "PATCH", url: "/v1/profile",
      headers: { cookie: actor.cookies },
      payload: { bio: "should not land" },
    });
    assert.equal(without.statusCode, 403);

    const with_ = await app.inject({
      method: "PATCH", url: "/v1/profile",
      headers: { cookie: actor.cookies, "x-rain-csrf": actor.csrf },
      payload: { bio: "should land" },
    });
    assert.equal(with_.statusCode, 200);
    assert.equal(with_.json().bio, "should land");
  });
});

describe("entitlements", () => {
  it("starts everyone on free and ignores a client-supplied plan", async () => {
    const actor = await signUp(`plan.${randomUUID()}@rain.app`, "Hopeful");

    const before = await app.inject({ method: "GET", url: "/v1/billing/entitlement", headers: { cookie: actor.cookies } });
    assert.equal(before.json().plan, "free");

    // Only the Stripe webhook may change a plan. A PATCH carrying one must not
    // be honoured, whatever else it contains.
    const attempt = await app.inject({
      method: "PATCH", url: "/v1/profile",
      headers: { cookie: actor.cookies, "x-rain-csrf": actor.csrf },
      payload: { plan: "pro", karma: 9999, name: "Hopeful" },
    });
    assert.equal(attempt.statusCode, 200);
    assert.equal(attempt.json().plan, "free");
    assert.equal(attempt.json().karma, 0);
  });
});

describe("connections and messages", () => {
  it("creates a thread only once both people agree", async () => {
    const asker = await signUp(`asker.${randomUUID()}@rain.app`, "Asker");
    const target = await signUp(`target.${randomUUID()}@rain.app`, "Target");

    const requested = await app.inject({
      method: "POST", url: "/v1/connections/requests",
      headers: { cookie: asker.cookies, "x-rain-csrf": asker.csrf },
      payload: { profileId: target.profileId },
    });
    assert.equal(requested.statusCode, 200);
    assert.equal(requested.json().status, "pending");

    // A one-sided request must not produce a connection for either party.
    const pendingList = await app.inject({ method: "GET", url: "/v1/connections", headers: { cookie: asker.cookies } });
    assert.deepEqual(pendingList.json(), []);

    const inbox = await app.inject({ method: "GET", url: "/v1/connections/requests", headers: { cookie: target.cookies } });
    const requestId = inbox.json()[0].id;

    const accepted = await app.inject({
      method: "POST", url: `/v1/connections/requests/${requestId}/accept`,
      headers: { cookie: target.cookies, "x-rain-csrf": target.csrf },
    });
    assert.equal(accepted.statusCode, 200);

    const connections = await app.inject({ method: "GET", url: "/v1/connections", headers: { cookie: asker.cookies } });
    assert.equal(connections.json().length, 1);
    assert.equal(connections.json()[0].profileId, target.profileId);

    // Private matching inputs must never appear in a payload about someone else.
    assert.equal(connections.json()[0].identity, undefined);
    assert.equal(connections.json()[0].seeking, undefined);
  });

  it("treats a resend of the same client message id as the same message", async () => {
    const a = await signUp(`dm.a.${randomUUID()}@rain.app`, "Ana");
    const b = await signUp(`dm.b.${randomUUID()}@rain.app`, "Ben");

    await app.inject({
      method: "POST", url: "/v1/connections/requests",
      headers: { cookie: a.cookies, "x-rain-csrf": a.csrf },
      payload: { profileId: b.profileId },
    });
    const inbox = await app.inject({ method: "GET", url: "/v1/connections/requests", headers: { cookie: b.cookies } });
    await app.inject({
      method: "POST", url: `/v1/connections/requests/${inbox.json()[0].id}/accept`,
      headers: { cookie: b.cookies, "x-rain-csrf": b.csrf },
    });

    const threads = await app.inject({ method: "GET", url: "/v1/dm/threads", headers: { cookie: a.cookies } });
    const threadId = threads.json()[0].id;
    const clientMessageId = randomUUID();

    const first = await app.inject({
      method: "POST", url: `/v1/dm/threads/${threadId}/messages`,
      headers: { cookie: a.cookies, "x-rain-csrf": a.csrf },
      payload: { clientMessageId, body: "hello" },
    });
    const retry = await app.inject({
      method: "POST", url: `/v1/dm/threads/${threadId}/messages`,
      headers: { cookie: a.cookies, "x-rain-csrf": a.csrf },
      payload: { clientMessageId, body: "hello" },
    });

    assert.equal(first.statusCode, 200);
    assert.equal(retry.statusCode, 200);
    assert.equal(first.json().id, retry.json().id, "a retry must not create a second message");

    const listed = await app.inject({ method: "GET", url: `/v1/dm/threads/${threadId}/messages`, headers: { cookie: b.cookies } });
    assert.equal(listed.json().items.length, 1);
  });

  it("hides a thread from anyone who is not in it", async () => {
    const a = await signUp(`priv.a.${randomUUID()}@rain.app`, "Ida");
    const b = await signUp(`priv.b.${randomUUID()}@rain.app`, "Ivo");
    const stranger = await signUp(`priv.c.${randomUUID()}@rain.app`, "Nosy");

    await app.inject({
      method: "POST", url: "/v1/connections/requests",
      headers: { cookie: a.cookies, "x-rain-csrf": a.csrf },
      payload: { profileId: b.profileId },
    });
    const inbox = await app.inject({ method: "GET", url: "/v1/connections/requests", headers: { cookie: b.cookies } });
    await app.inject({
      method: "POST", url: `/v1/connections/requests/${inbox.json()[0].id}/accept`,
      headers: { cookie: b.cookies, "x-rain-csrf": b.csrf },
    });

    const threads = await app.inject({ method: "GET", url: "/v1/dm/threads", headers: { cookie: a.cookies } });
    const threadId = threads.json()[0].id;

    const peek = await app.inject({
      method: "GET", url: `/v1/dm/threads/${threadId}/messages`,
      headers: { cookie: stranger.cookies },
    });
    assert.equal(peek.statusCode, 404);

    const write = await app.inject({
      method: "POST", url: `/v1/dm/threads/${threadId}/messages`,
      headers: { cookie: stranger.cookies, "x-rain-csrf": stranger.csrf },
      payload: { clientMessageId: randomUUID(), body: "intruding" },
    });
    assert.equal(write.statusCode, 404);
  });
});

describe("gateway handshake", () => {
  it("issues single-use tokens and refuses callers without the internal key", async () => {
    const actor = await signUp(`rt.${randomUUID()}@rain.app`, "Socket");

    const minted = await app.inject({
      method: "POST", url: "/v1/realtime/token",
      headers: { cookie: actor.cookies, "x-rain-csrf": actor.csrf },
    });
    assert.equal(minted.statusCode, 200);
    const { token } = minted.json();

    const unauthorised = await app.inject({
      method: "POST", url: "/v1/internal/realtime/introspect",
      payload: { token },
    });
    assert.equal(unauthorised.statusCode, 401, "introspection must require the internal key");

    const key = process.env.INTERNAL_API_KEY!;
    const first = await app.inject({
      method: "POST", url: "/v1/internal/realtime/introspect",
      headers: { "x-internal-key": key },
      payload: { token },
    });
    assert.equal(first.json().accountId, actor.accountId);

    // Single use: a captured token cannot be replayed by a second connection.
    const second = await app.inject({
      method: "POST", url: "/v1/internal/realtime/introspect",
      headers: { "x-internal-key": key },
      payload: { token },
    });
    assert.equal(second.json().accountId, null);
    assert.equal(second.json().blocked, true);
  });
});

describe("safety", () => {
  it("writes the report and its moderation job together", async () => {
    const actor = await signUp(`report.${randomUUID()}@rain.app`, "Reporter");
    const response = await app.inject({
      method: "POST", url: "/v1/reports",
      headers: { cookie: actor.cookies, "x-rain-csrf": actor.csrf },
      payload: { matchId: "ephemeral-room-1", reason: "minor-safety", details: "test" },
    });
    assert.equal(response.statusCode, 200);

    // A report with no queued job would be a report nobody ever reviews.
    const queued = await query<{ topic: string }>(
      "select topic from outbox where payload->>'reportId' = $1", [response.json().id],
    );
    assert.equal(queued.length, 1);
    assert.equal(queued[0].topic, "report.escalate");
  });
});
