# Rain — random chat

Rain starts with anonymous, one-to-one random text chat. The repository is structured to add voice chat as a separate media capability rather than entangling it with matching or text delivery.

## Run locally

```bash
pnpm install
pnpm dev
```

Open `http://localhost:5173`. The realtime service runs at `http://localhost:3001`.

Copy the example environment files before deploying. The development matcher is intentionally memory-backed; use the Redis-backed implementation described in [docs/architecture.md](docs/architecture.md) before running more than one realtime instance.

## Run the distributed path locally

```bash
pnpm infra:up
pnpm dev:distributed
```

This starts Redis and Postgres through Docker, then uses the Redis matcher and Socket.IO adapter. See the [engineering handoff](docs/handoff.md) for deployment topology and the next milestones.

## Repository

- `apps/web` — browser client and text-chat UX.
- `apps/realtime` — Socket.IO gateway, rate limits, match lifecycle, and message relay.
- `packages/protocol` — one event contract shared by browser and gateway.
- `docs` — deployment, safety, and voice design.

## Commands

```bash
pnpm dev
pnpm typecheck
pnpm build
pnpm test
```
