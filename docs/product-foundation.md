# Rain product foundation

The web client is a complete product-shaped frontend: a scroll-driven landing page, email/password accounts, staged profile onboarding, temporary random chat, voice/video preview, Circles, connections, saved DMs, profile controls, opt-in audio feedback, and membership screens.

It renders **only** what a service returns. There are no seeded people, no sample conversations, no demo counts, and no client-side entitlements. Where a service is not connected, the screen says so.

## Product rules

- **Random text, voice, and video rooms are temporary.** Delete their messages when either participant ends the room.
- **DMs are persistent only after a mutual friend request.** Never create a permanent thread from a unilateral action.
- **Rain score is a trust signal, not a public popularity contest.** Positive acknowledgements can be rate-limited; negative safety actions need a reason code, moderation queue, audit log, and appeal process.
- **Gender, language, and trust filters are server-side matching inputs.** The client must not be trusted to enforce a Free, Plus, or Pro entitlement.
- **Media is always opt-in.** Ask for microphone/camera permission only after the user opens that mode and taps its preview button.

## What currently works in the browser

- **Accounts.** Email and password sign-up, sign-in, session restore from an HttpOnly cookie, and a sign-out that revokes server-side *before* the client forgets anything. No password or token is ever written to browser storage.
- **Profiles, connections, DMs, Circles, billing.** Wired to the API through [`apps/web/src/api.ts`](../apps/web/src/api.ts) against [the contract](api-contract.md). Connect a service and these screens are live.
- **Random text matching** runs on the Socket.IO gateway and stays ephemeral.
- **Voice and video** use real local media previews with explicit mute/stop control. Joining asks the API for an SFU room token; until that service exists the UI says so rather than pretending to connect.
- **Membership** opens Stripe Checkout and reads entitlement back from billing. Choosing a plan in the browser grants nothing.

The only thing this browser remembers on its own is one device preference: whether sound is on.

## Production services to add

### 1. Accounts and durable data

The client already speaks the full contract in [api-contract.md](api-contract.md);
implement it with an auth provider (Clerk, Auth.js) or your own service, plus Postgres. Store:

- users, profile fields, age-gate acceptance, plan entitlement and privacy choices
- friend requests and accepted friendships
- DM threads and messages
- channels, memberships, realtime presence and channel messages
- moderation reports, actions, audit logs and reputation events

Put uploaded avatars in object storage (S3/R2) and store only their signed URL in Postgres. Do not persist avatar images in browser local storage in production.

### 2. Expanded matchmaker contract

Extend `packages/protocol` and the matching service with a versioned match request containing:

```ts
{
  mode: "text" | "voice" | "video",
  language?: string,
  interests: string[],
  seekerIdentity?: string,
  seeking?: string[],
  minimumRainScore?: number,
  pace: "fast" | "balanced" | "close"
}
```

The gateway must read the authenticated user and plan from the server, discard fields the user is not entitled to send, and match only compatible two-way preferences. Never send gender or hidden preference data to the peer.

### 3. Saved social features

Use API endpoints for friend-request creation, accept/decline, removal, inbox pagination, and per-user block lists. Socket.IO can broadcast presence and new DM notices, but Postgres remains the source of truth.

### 4. Voice and video

Keep Socket.IO for matchmaking/signalling, then use a managed SFU such as LiveKit for media rooms. Issue a short-lived room token only after both people match. Configure a TURN service for users behind restrictive networks. The client must be able to mute, leave, report, and stop tracks immediately.

### 5. Payments and entitlements

Use Stripe Checkout and a webhook endpoint. The webhook—not a button in the browser—updates a subscription and entitlement table. Gate Plus and Pro matching fields in the realtime service from those stored entitlements. Add a billing portal and graceful downgrade behavior.

### 6. Safety before scale

Before marketing voice/video or charging users, add age gating, rate limits, blocks, report reasons, moderation review, abuse detection, device/IP protections, and clear retention/deletion policies. Start with an 18+ policy and have counsel review the final terms, privacy, payments, and regional age requirements.

## Recommended delivery order

1. Implement [the API contract](api-contract.md) — accounts, profiles, Postgres, avatar storage, connections, persistent DMs — and ship behind an 18+ beta gate.
2. Point `VITE_API_URL` at it and set `AUTH_INTROSPECTION_URL` on the gateway so no anonymous socket reaches the queue.
3. Add entitlement verification and Stripe before exposing paid filter controls.
4. Add server-side gender/language/trust matching and moderation tooling.
5. Add channels and channel presence.
6. Add LiveKit voice, then video after voice moderation and reporting are proven.
