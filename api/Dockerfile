# Multi-stage build for the API (on-chain engine + Postgres).
#   deps     → production-only node_modules (no dev deps / build tools in the final image)
#   build    → full deps, compiles shared + api to dist/
#   runtime  → slim, non-root: prod deps + dist + Drizzle migrations + share-card assets
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
RUN corepack enable
# Manifests first so the install layer is cached until a dependency actually changes.
COPY package.json yarn.lock .yarnrc.yml ./
COPY shared/package.json shared/
COPY api/package.json api/
RUN yarn workspaces focus @meteora/api @meteora/shared --production

FROM ${NODE_IMAGE} AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml tsconfig.base.json ./
COPY shared/package.json shared/
COPY api/package.json api/
RUN yarn workspaces focus @meteora/api @meteora/shared
COPY shared/ shared/
COPY api/ api/
RUN yarn workspace @meteora/shared build && yarn workspace @meteora/api build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=deps  /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./
COPY --from=build /repo/shared/dist ./shared/dist
COPY --from=build /repo/shared/package.json ./shared/
COPY --from=build /repo/api/dist ./api/dist
COPY --from=build /repo/api/package.json ./api/
# runMigrations(db, './drizzle') runs at boot; with WORKDIR /repo it resolves to /repo/drizzle.
COPY --from=build /repo/api/drizzle ./drizzle
# share-card backgrounds + font: resolved at module load (walks up from dist/) — MUST be present or the
# API throws on boot.
COPY --from=build /repo/api/assets ./api/assets
# Drop privileges: the API is stateless on disk (all state is in Postgres), so it needs no write access.
USER node
EXPOSE 8787
CMD ["node", "api/dist/main.js"]
