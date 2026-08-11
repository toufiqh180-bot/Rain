FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/realtime/package.json apps/realtime/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN pnpm install --frozen-lockfile

COPY apps/realtime apps/realtime
COPY packages/protocol packages/protocol

RUN pnpm --filter @rain/protocol build \
  && pnpm --filter @rain/realtime build \
  && pnpm --filter @rain/realtime --prod deploy --legacy /app/runtime

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/runtime ./

EXPOSE 3001
CMD ["node", "dist/index.js"]
