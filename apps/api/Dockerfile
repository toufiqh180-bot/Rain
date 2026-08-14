# Build stage: install everything, compile, then discard the toolchain.
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile

COPY packages/protocol packages/protocol
COPY apps/api apps/api
RUN pnpm --filter @rain/protocol build && pnpm --filter @rain/api build

# Runtime stage: production dependencies only, no source, no compiler.
FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /repo/packages/protocol/dist packages/protocol/dist
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY apps/api/migrations apps/api/migrations

# Run as a non-root user: a container escape should not land on uid 0.
USER node
EXPOSE 4000

# Migrations run at boot. The advisory lock in migrate.ts makes concurrent
# instance starts safe, so this is correct even when the platform rolls several
# containers at once.
CMD ["sh", "-c", "node apps/api/dist/migrate.js && node apps/api/dist/index.js"]
