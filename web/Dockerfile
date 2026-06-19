# Build the Next.js web app as a standalone server. The standalone output bundles only the traced
# production dependencies, so the runtime stays minimal.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
RUN corepack enable
# NEXT_PUBLIC_* values are baked into the client bundle at build time. The browser uses this to open
# the API WebSocket (/live) directly, so it MUST be the public wss origin in production.
ARG NEXT_PUBLIC_API_WS_URL=ws://localhost:8787
ENV NEXT_PUBLIC_API_WS_URL=${NEXT_PUBLIC_API_WS_URL}
# Manifests first so the install layer is cached until a dependency actually changes.
COPY package.json yarn.lock .yarnrc.yml tsconfig.base.json ./
COPY shared/package.json shared/
COPY web/package.json web/
RUN yarn workspaces focus @binsight/web @binsight/shared
COPY shared/ shared/
COPY web/ web/
RUN yarn workspace @binsight/shared build && yarn workspace @binsight/web build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /repo
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Standalone output (monorepo: server + traced deps live under web/, shared/ and node_modules/).
COPY --from=build /repo/web/.next/standalone ./
COPY --from=build /repo/web/.next/static ./web/.next/static
COPY --from=build /repo/web/public ./web/public
USER node
EXPOSE 3000
CMD ["node", "web/server.js"]
