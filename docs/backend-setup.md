# Running Rain's backend

One path, in order. Each step ends with something you can check, so you always
know whether it worked before moving on.

Rain is three services:

| Service | What it is | Where it runs |
| --- | --- | --- |
| `apps/web` | The React app | Static files on a CDN (Vercel is fine) |
| `apps/api` | Accounts, profiles, DMs, Circles, billing, safety | A container, always on |
| `apps/realtime` | Random text matching over WebSocket | A container, always on |

**The one thing that will bite you:** `apps/realtime` cannot run on Vercel.
Serverless functions cannot hold a WebSocket open. It needs a real container
host. `apps/api` can technically run serverless, but keep it next to the gateway
— one less thing to reason about.

---

## Step 1 — Get a Postgres

You need a connection string. Anything that speaks Postgres works: Neon,
Supabase, Railway, Render, RDS, or Postgres on your own box.

If you have Docker, the repo ships one:

```bash
pnpm infra:up
```

That gives you `postgres://rain:local-development-only@localhost:5432/rain`.

**Check:** you can connect with that string and it does not error.

## Step 2 — Point the API at it

```bash
cp apps/api/.env.example apps/api/.env
```

Edit `apps/api/.env` and set `DATABASE_URL`. Leave everything else alone for now
— storage, Redis and Stripe are all optional and the app tells you honestly when
they are off.

## Step 3 — Create the tables

```bash
pnpm migrate
```

This applies every file in `apps/api/migrations/` that has not run yet, so it is
safe to run on every deploy — and that is exactly how you should use it. The
Docker image runs it automatically at boot.

**Check:** you see `{"event":"migrations_up_to_date","count":1}`.

## Step 4 — Run everything

```bash
pnpm dev
```

Web, API and gateway all start together.

**Check:** `curl http://localhost:4000/readyz` returns `{"status":"ready"}`. If
it returns `degraded`, the API is up but cannot reach Postgres — recheck
`DATABASE_URL`.

## Step 5 — Connect the web app

```bash
cp apps/web/.env.example apps/web/.env.local
```

Set `VITE_API_URL=http://localhost:4000`. Restart the dev server (Vite reads env
files at startup, not on save).

**Check — walk this path in the browser:**

1. Sign up → you land in onboarding
2. Finish onboarding → your own name appears in the sidebar
3. Reload the page → still signed in
4. Sign out → back to the landing page
5. `curl http://localhost:4000/v1/auth/session` → `401`

Step 5 is the one people skip. If it returns `200`, the session was only hidden
in the browser, not revoked on the server.

---

## Step 6 — Deploy

Build the API image from the repo root, not from `apps/api` — the Dockerfile
needs the workspace:

```bash
docker build -f apps/api/Dockerfile -t rain-api .
```

Deploy that image anywhere that runs containers. Set these:

```
NODE_ENV=production
DATABASE_URL=...                      # your Postgres
DATABASE_SSL=require
ALLOWED_ORIGINS=https://yourdomain.com
STORAGE_DRIVER=s3                     # plus the S3_* values
INTERNAL_API_KEY=...                  # openssl rand -base64 32
```

The API **refuses to boot** if any of those are wrong in production — local disk
storage, a localhost origin, unencrypted database traffic, or a missing internal
key. That is deliberate: a config mistake should stop a deploy, not quietly ship.

Then set the same `INTERNAL_API_KEY` on `apps/realtime`, plus
`AUTH_INTROSPECTION_URL=https://your-api/v1/internal/realtime/introspect`. The
gateway refuses to boot in production without it, so an unauthenticated socket
can never reach the matchmaking queue.

Point your load balancer's health check at `/readyz`, not `/healthz`. `/healthz`
says the process is alive; `/readyz` says it can actually serve.

---

## Optional pieces, in the order worth adding them

**Object storage** (needed before production). Any S3-compatible bucket — R2,
S3, B2. Set `STORAGE_DRIVER=s3` and the `S3_*` values. Until then avatars go to
local disk, which is fine on your laptop and refused in production, because disk
does not survive a redeploy and is not shared between instances.

**Redis.** Set `REDIS_URL` and the inbox shows who is online. Without it
everyone reads as offline — the app does not invent presence.

**Stripe.** Set the four `STRIPE_*` values. Until then the membership screen
says billing is not connected. Point the webhook at
`POST /v1/billing/webhook`. Only that webhook writes entitlements — a button in
a browser never grants access.

**Email.** Two places in `apps/api/src/routes/auth.ts` log
`send verification email` and `send reset email` with a token already minted and
stored. Hand those tokens to your mailer; nothing else changes.

---

## Scaling: what to do, and when

 
| When | What happens | What to do |
| --- | --- | --- |
| Any traffic | — | Run 2+ API containers. They are stateless — sessions live in Postgres, not in memory — so this works with no code change. |
| ~10 containers | Postgres runs out of connections | Each container holds `DATABASE_POOL_MAX` (default 10). Use serverless Postgres (Neon, Supabase) or put PgBouncer in transaction mode in front. |
| Slow message lists | — | Nothing. Message pagination is keyset-based, so page 500 costs the same as page 1. This is already handled. |
| Slow inbox | Thread list query gets heavy | It counts unread messages per thread. Cache the count in `dm_thread_members` and update it on write. |
| Gateway at capacity | One gateway cannot hold all sockets | Set `MATCHMAKER_DRIVER=redis` and run several. The Redis adapter routes between them. Already built — see `docs/architecture.md`. |
| Reports pile up | Moderation falls behind | The `outbox` table is already written transactionally with each report. Add a worker that reads it and acts. |
| Avatars slow | Storage is far from users | Put a CDN in front of the bucket and set `STORAGE_PUBLIC_URL` to the CDN domain. |

The order matters less than the principle: **every one of these is a
configuration or an addition, not a rewrite.** The parts that would have forced
a rewrite — stateless containers, keyset pagination, entitlements owned by the
server, ephemeral rooms that were never persisted — are decided already.

---

## What is genuinely not built yet

Everything above runs. These need an account or a decision from you, and the app
says so honestly rather than pretending:

| Missing | What happens today | What it needs |
| --- | --- | --- |
| **Email delivery** | Verification and reset tokens are minted and stored correctly, then logged instead of sent | A provider (Resend, Postmark, SES). Two places in `apps/api/src/routes/auth.ts` log `send verification email` / `send reset email` — hand the token to your mailer there. |
| **Object storage** | Avatars go to local disk; production refuses to boot | An S3-compatible bucket |
| **Stripe** | Membership screen says billing is not connected | A Stripe account and two prices |
| **Voice/video rooms** | Local mic and camera preview work; joining reports the room service is not connected | A managed SFU (LiveKit) and the match registry in the gateway |
| **Moderation worker** | Reports and their jobs are written correctly to `outbox`; nothing reads it yet | A worker process, plus a review surface |
| **Terms and privacy pages** | Sign-up records acceptance and the version | The actual documents, reviewed by counsel before launch |

The sequence that matters: email, then storage, then terms — those three gate a
public launch. Stripe gates revenue, not launch. Voice and video gate nothing;
ship without them.

## Security you get for free

Verified working, not just intended:

- Sessions are HttpOnly cookies. No script can read them. Only a hash is stored,
  so a database leak does not hand over live sessions.
- Every write requires a CSRF header matching a cookie. Requests without it get
  `403`.
- Passwords are scrypt-hashed. Sign-in verifies against a dummy hash when the
  account does not exist, so response time does not reveal who is registered.
- Failed sign-ins are counted **in Postgres**, so the limit holds across every
  container. Eight failures locks the email and the IP for 15 minutes.
- Password reset always returns `204`, even for an unknown address, so it cannot
  be used to discover who has an account.
- Signing in revokes every other session. Resetting a password revokes all of
  them, including an attacker's.
- Gateway handshake tokens are single-use and expire in two minutes.
- `identity` and `seeking` are private matching inputs and are never selected
  into a payload describing you to someone else.
