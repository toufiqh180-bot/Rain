# Rain product foundation

The web client now has a complete product-shaped frontend: a landing page, staged profile onboarding, temporary random chat, voice/video preparation, Circles, friends, saved DMs, profile controls, subtle opt-in audio feedback, and membership screens.

## Product rules

- **Random text, voice, and video rooms are temporary.** Delete their messages when either participant ends the room.
- **DMs are persistent only after a mutual friend request.** Never create a permanent thread from a unilateral action.
- **Rain score is a trust signal, not a public popularity contest.** Positive acknowledgements can be rate-limited; negative safety actions need a reason code, moderation queue, audit log, and appeal process.
- **Gender, language, and trust filters are server-side matching inputs.** The client must not be trusted to enforce a Free, Plus, or Pro entitlement.
- **Media is always opt-in.** Ask for microphone/camera permission only after the user opens that mode and taps its preview button.

## What currently works in the browser

- Profile setup, avatar upload, plan selection, sound preference, saved DMs, friends, group messages, and per-user demo karma persist in `localStorage` for a useful frontend prototype.
- Random **text** matching still uses the deployed Socket.IO gateway and stays ephemeral.
- Voice and video use real local media previews and reactive UI, but do not yet create a peer-to-peer media room.
- The membership selection is visual only. It must not charge a user or unlock a real entitlement until the services below exist.

## Production services to add

### 1. Accounts and durable data

Use an authentication provider (for example, Clerk or Auth.js) plus Postgres. Store:

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

1. Fix the live text gateway connection and ship this frontend behind an 18+ beta gate.
2. Add authentication, profiles, Postgres, avatar storage, friend requests, and persistent DMs.
3. Add entitlement verification and Stripe before exposing paid filter controls.
4. Add server-side gender/language/trust matching and moderation tooling.
5. Add channels and channel presence.
6. Add LiveKit voice, then video after voice moderation and reporting are proven.
