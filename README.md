# Rain

Rain is a social chat product with three parts:

- `apps/web`: the React browser app.
- `apps/api`: the account, profile, direct-message, safety, and billing API.
- `apps/realtime`: the Socket.IO gateway that matches people for live text chat.

Postgres stores permanent data. Redis is optional for local development and is
required when more than one realtime server is running.

## Start locally

Requirements: Node.js 20+, pnpm 11+, and Docker with Compose.

From the repository root, run these commands in order:

```bash
pnpm install
pnpm infra:up
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
pnpm migrate
pnpm dev
```

Open <http://localhost:5173>. The API is at <http://localhost:4000> and the
realtime gateway is at <http://localhost:3001>.

The web app starts in local demo mode by default. This lets an engineer inspect
the interface immediately. To test real sign-up, profiles, and sessions, edit
`apps/web/.env.local` and change `VITE_DEMO_MODE=true` to
`VITE_DEMO_MODE=false`, then restart `pnpm dev`.

Useful checks:

```bash
curl http://localhost:4000/readyz
curl http://localhost:3001/readyz
```

Both services should report `{"status":"ready"}`. Stop local infrastructure
when finished with `pnpm infra:down`.

## What is complete

The project currently provides the foundation for:

- account creation, cookie sessions, profiles, connections, direct messages,
  circles, and safety endpoints;
- local random text matching with reconnect and rate-limit handling;
- a Redis-backed realtime matcher for horizontal scaling;
- typed messages shared between the browser and realtime service;
- production builds, migrations, health checks, and environment validation.

## What is not ready for public launch

These are deliberate follow-up projects, not configuration switches:

- email delivery for verification and password reset;
- persistent report moderation and a moderation dashboard;
- production object storage for avatars;
- Stripe keys and webhook setup for paid plans;
- a voice/video provider and its consent/token flow;
- reviewed terms, privacy policy, retention rules, and launch monitoring.

Do not treat the demo mode or local disk avatar storage as production features.
See [docs/backend-setup.md](docs/backend-setup.md) for deployment setup and
[docs/handoff.md](docs/handoff.md) for the current engineering priorities.

## Commands

```bash
pnpm dev              # web, API, and realtime together
pnpm infra:up         # local Postgres and Redis
pnpm infra:down       # stop local containers
pnpm migrate          # apply database migrations
pnpm typecheck        # check every workspace package
pnpm build            # build every workspace package
pnpm test             # integration tests; requires Postgres and migrations
```

## How to maintain it

Keep changes in the service that owns the behavior. Shared client/server event
types belong in `packages/protocol`; durable account and safety data belongs in
`apps/api`; matching and socket lifecycle belongs in `apps/realtime`; screen
and browser behavior belongs in `apps/web`.

Before opening a pull request, run:

```bash
pnpm typecheck && pnpm build
pnpm test
```

If a change affects Postgres, add a new numbered migration. If it changes a
socket event, update `packages/protocol` and its tests. Avoid putting database
or Redis knowledge into the browser.
