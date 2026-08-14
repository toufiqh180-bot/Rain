# Rain API contract

The web client talks to exactly one HTTP service, through one module:
[`apps/web/src/api.ts`](../apps/web/src/api.ts). Nothing else in the browser
calls `fetch`. Implement the endpoints below and the existing UI is live — no
component changes required.

Base URL comes from `VITE_API_URL`. When it is unset the client reports every
service as "not connected" and renders empty states. It never fabricates data.

## Ground rules

| Rule | Why |
| --- | --- |
| The session lives in an **HttpOnly, Secure, SameSite=Lax** cookie named `rain_sid`. | A token in `localStorage` is readable by any injected script. The browser never sees this value. |
| Every mutating request carries `x-rain-csrf`, echoing a readable `rain_csrf` cookie. | Double-submit defence. A cross-site attacker can send the cookie but cannot read it to set the header. |
| `401` means the session is gone. | The client clears account state and returns to the landing page on any `401`. |
| Errors return `{ code, message, fields? }`. | `message` is shown to the person as-is, so write it for them. `fields` maps a form field to its error. |
| The **server** owns `plan`, `karma`, `handle`, and every id. | The client sends none of them and cannot raise its own entitlement. |
| `204` for successful writes with no body. | The client expects no JSON there. |

CORS must allow the web origin with `Access-Control-Allow-Credentials: true`.

## Auth

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/v1/auth/session` | — | `Session`, or `401` when signed out (expected, not an error) |
| `POST` | `/v1/auth/sign-up` | `{ email, password, acceptedTerms }` | `Session` + sets cookies |
| `POST` | `/v1/auth/sign-in` | `{ email, password }` | `Session` + sets cookies |
| `POST` | `/v1/auth/sign-out` | — | `204`, session revoked and cookie cleared |
| `POST` | `/v1/auth/password/reset-request` | `{ email }` | `204` **always** — never reveal whether the email exists |
| `POST` | `/v1/auth/email/resend` | — | `204` |

```ts
type Session = { account: Account; profile: Profile | null }
type Account = { id, email, emailVerified: boolean, createdAt }
```

`profile: null` is meaningful: the client sends that person to onboarding.

Server-side requirements the client assumes:

- Argon2id or scrypt password hashing. The client enforces 12 characters as a
  courtesy; enforce it again and check against a breached-password list.
- Rate limit sign-in per email **and** per IP, and return `429` with a
  `message` the person can act on.
- Sign-up is refused unless `acceptedTerms` is true. Record the acceptance
  timestamp and policy version — it is your 18+ age-gate evidence.
- Rotate `rain_sid` on sign-in to prevent session fixation.

## Profile

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `POST` | `/v1/profile` | `{ name, bio, identity, seeking, interests, acceptedAgeGate }` | `Profile` |
| `PATCH` | `/v1/profile` | any of `{ name, bio, identity, seeking, interests }` | `Profile` |
| `POST` | `/v1/profile/avatar` | `multipart/form-data`, field `avatar` | `{ avatarUrl }` |
| `DELETE` | `/v1/profile` | `{ password }` | `204` |

```ts
type Profile = {
  id, name, handle, avatarUrl: string | null, bio,
  identity, seeking, interests: string[],
  plan: "free" | "plus" | "pro", karma: number, createdAt
}
```

`identity` and `seeking` are **private matching inputs**. They are never
included in any payload describing another person.

Avatars go to object storage (S3/R2). Store the key, return a URL. Re-encode
uploads server-side to strip EXIF — a raw phone photo carries GPS coordinates.
The client caps uploads at 4 MB and image MIME types; enforce both again.

## Connections and direct messages

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/v1/connections` | `Connection[]` |
| `DELETE` | `/v1/connections/:id` | `204` |
| `POST` | `/v1/blocks` | `204`, body `{ profileId }` |
| `GET` | `/v1/dm/threads` | `DirectThread[]` |
| `GET` | `/v1/dm/threads/:id/messages?cursor=` | `Page<DirectMessage>` |
| `POST` | `/v1/dm/threads/:id/messages` | `DirectMessage`, body `{ clientMessageId, body }` |
| `POST` | `/v1/dm/threads/:id/read` | `204`, body `{ messageId }` |

A `Connection` only exists after **both** people accept. A unilateral action
must never create a durable thread — that is the product rule that separates a
saved DM from a random room.

`clientMessageId` is a UUID the browser generates. Treat it as an idempotency
key so a retry after a flaky network does not double-post.

A block must remove the connection, hide the thread both ways, and be checked
before matchmaking.

## Circles

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/v1/circles` | `Circle[]` |
| `GET` | `/v1/circles/:id/messages?cursor=` | `Page<CircleMessage>` |
| `POST` | `/v1/circles/:id/messages` | `CircleMessage`, body `{ clientMessageId, body }` |
| `POST` | `/v1/circles/:id/join` · `/leave` | `Circle` · `204` |

## Billing

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/v1/billing/entitlement` | `Entitlement` |
| `POST` | `/v1/billing/checkout` | `{ url }` — Stripe Checkout, body `{ plan }` |
| `POST` | `/v1/billing/portal` | `{ url }` — Stripe billing portal |

```ts
type Entitlement = {
  plan, status: "active"|"trialing"|"past_due"|"canceled"|"none",
  renewsAt: string | null, cancelAtPeriodEnd: boolean
}
```

The client reads `entitlement` on load and gates Plus/Pro controls from it. That
gate is a **courtesy, not a boundary** — it stops an honest person from hitting
a wall, and stops nobody else. The realtime gateway must re-check entitlement
server-side and discard preference fields the account is not entitled to send.

Only the Stripe webhook writes the entitlement table. A button in a browser
never grants access, and the client never PATCHes a plan.

## Realtime and media

| Method | Path | Returns |
| --- | --- | --- |
| `POST` | `/v1/realtime/token` | `{ token, expiresAt }` |
| `POST` | `/v1/media/room-token` | `{ token, url, expiresAt }`, body `{ matchId, kind }` |

The browser never sends its session cookie to the gateway or the SFU. It asks
for a short-lived, narrowly-scoped token and presents that on the socket
handshake. The gateway exchanges it at
`POST /v1/internal/realtime/introspect` → `{ accountId, blocked }`, configured
as `AUTH_INTROSPECTION_URL`; `apps/realtime` refuses to boot in production
without it, so no anonymous socket reaches the queue.

Issue a media room token only when the server itself agrees the match is
active and both people consented. Expire it in minutes, not hours.

## Safety

| Method | Path | Returns |
| --- | --- | --- |
| `POST` | `/v1/reports` | `{ id }`, body `{ matchId?, profileId?, reason, details? }` |

`reason` is one of `harassment`, `sexual-content`, `hate`, `spam`,
`minor-safety`, `other`.

Write the report and an outbox event in one transaction, then let a worker
classify and act. `minor-safety` needs its own escalation path, not a queue
position.

## Suggested storage

`accounts`, `sessions`, `profiles`, `connections`, `blocks`, `dm_threads`,
`dm_messages`, `circles`, `circle_members`, `circle_messages`,
`subscriptions`, `entitlements`, `reports`, `moderation_actions`,
`audit_log`, `outbox`.

Random text, voice, and video rooms have **no** table. They are ephemeral by
design and their transcripts are never written.

## Verifying an implementation

Run the client against your service and walk this path. It is the same path
this contract was checked against:

1. Sign up → land in onboarding.
2. Complete onboarding → land in the workspace with your own name in the rail.
3. Reload → still signed in, from the cookie alone.
4. Send a DM → it appears, and survives a reload.
5. Sign out → back to the landing page, and `GET /v1/auth/session` now returns
   `401` from a fresh request. If it still returns `200`, the session was only
   hidden, not revoked.
