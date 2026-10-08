# One image definition for every CommentBridge process. The API and the delivery
# worker use the same `runtime` image and differ only in their command:
#   API:    node dist/main.js
#   worker: node dist/worker.js
# `migrate` is a separate target because the Prisma CLI is a dev dependency. It applies
# migrations as the schema owner and then gives the restricted runtime roles their login.

FROM node:22-bookworm-slim AS base
WORKDIR /app
# Prisma's query engine needs OpenSSL.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
# postinstall runs `prisma generate`.
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm build

FROM build AS migrate
CMD ["pnpm", "db:deploy"]

FROM build AS prune
# Scripts are skipped: postinstall runs `prisma generate`, and the Prisma CLI is a dev
# dependency that prune removes. The client generated in the build stage is kept.
RUN pnpm prune --prod --ignore-scripts

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prune /app/package.json ./
COPY --from=prune /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/main.js"]
