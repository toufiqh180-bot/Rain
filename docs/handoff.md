# Rain engineering handoff

## Current working state

- `pnpm dev` starts the web client and a functional memory-backed realtime gateway.
- `pnpm infra:up` starts local Redis and Postgres.
- `pnpm dev:distributed` starts the same gateway with Redis matching and the Socket.IO Redis adapter. Run two gateway containers to validate horizontal routing.
- `pnpm test`, `pnpm typecheck`, and `pnpm build` must pass before merging. CI runs all three.

## Boundaries that make this easy to extend

The browser only imports `@rain/protocol`; it does not know about Redis, Postgres, or a particular voice provider. The gateway only depends on the `Matchmaker` interface. `MemoryMatchmaker` makes local work fast; `RedisMatchmaker` uses an atomic Lua script and Redis Cluster-compatible hash tags for distributed queue operations.

When adding a capability, put it in the matching boundary it belongs to:

| Need | Correct home |
| --- | --- |
| More profile/match preferences | `packages/protocol`, then matcher compatibility logic |
| Accounts, blocks, reports, retention | a service implementing [api-contract.md](api-contract.md), backed by Postgres + an outbox worker |
| CAPTCHA/device reputation/rate limits | an admission service before `joinQueue` |
| Voice invitation and consent | new gateway events, checked against active match |
| Voice media + animated microphones | browser client plus a LiveKit token service; never Socket.IO audio |

## Deploy topology

Deploy `apps/web` as static assets behind a CDN, built with `VITE_API_URL` and `VITE_REALTIME_URL` set. Run at least two copies of `apps/realtime` as long-lived containers behind a WebSocket-capable load balancer. Set `NODE_ENV=production`, `MATCHMAKER_DRIVER=redis`, `REDIS_URL`, `AUTH_INTROSPECTION_URL`, and an explicit `ALLOWED_ORIGINS` list. The gateway refuses to boot in production without the introspection URL, so an unauthenticated socket cannot reach the queue. Kubernetes/ECS health checks should call `/healthz`; only route traffic after `/readyz` is 200.

Do not use `MATCHMAKER_DRIVER=memory` outside a single local process. The app intentionally refuses that configuration in production.

## Next implementation milestone: safety persistence

Reports currently end the live chat and emit structured logs, but persistent moderation is the next required step before public launch:

1. Add Postgres tables for reports, blocks, device/account actions, and an outbox.
2. Write the report and an outbox event transactionally.
3. Have a worker classify the event and apply a block/admission decision.
4. Encrypt sensitive fields, define retention windows, and never persist message content by default without a reviewed policy.

After that, add the voice invitation/token flow described in [architecture.md](architecture.md). It should be a feature flag until safety, consent, and observability are live.
