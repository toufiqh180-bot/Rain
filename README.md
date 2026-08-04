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

## Deploy

Vercel hosts the web client only. The included `vercel.json` builds the Vite app from this monorepo and publishes `apps/web/dist`.

1. Import the repository into Vercel and leave the project root at the repository root.
2. In **Settings → Environment Variables**, add `VITE_REALTIME_URL` with the public HTTPS URL of the deployed realtime gateway (for example, `https://api.rain.example`).
3. Deploy `apps/realtime` separately as a long-lived Docker service. Set `NODE_ENV=production`, `MATCHMAKER_DRIVER=redis`, `REDIS_URL`, and `ALLOWED_ORIGINS=https://rain-black.vercel.app`.
4. Redeploy the Vercel project after adding `VITE_REALTIME_URL`; Vite embeds that value at build time.

Vercel cannot host the persistent Socket.IO gateway itself. Without `VITE_REALTIME_URL`, the production UI intentionally shows a setup notice rather than attempting to connect a visitor to `localhost`.

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
# Rain
