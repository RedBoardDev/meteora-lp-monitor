# better-sqlite3 requires native compilation → build tools in the build stage
FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml tsconfig.base.json ./
COPY shared/package.json shared/
COPY api/package.json api/
RUN yarn workspaces focus @meteora/api @meteora/shared || yarn install
COPY shared/ shared/
COPY api/ api/
RUN yarn workspace @meteora/shared build && yarn workspace @meteora/api build

FROM node:22-bookworm-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /repo/package.json /repo/yarn.lock /repo/.yarnrc.yml ./
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/shared/dist ./shared/dist
COPY --from=build /repo/shared/package.json ./shared/
COPY --from=build /repo/api/dist ./api/dist
COPY --from=build /repo/api/package.json ./api/
EXPOSE 8787
CMD ["node", "api/dist/main.js"]
