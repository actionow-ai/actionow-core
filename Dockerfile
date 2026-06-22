# syntax=docker/dockerfile:1
#
# Whole-project image for actionow-core (pnpm + turbo monorepo, Node 22).
# One `build` stage installs deps and builds every package/app; the `api` and
# `worker` targets run from that stage (the api/worker `start` scripts use tsx
# to consume the workspace TS packages, so the full node_modules + source are
# kept in the runtime image — simple and correct over minimal). The `web` target
# serves the pre-built Vite SPA via nginx.

# ---- build: install + build the whole monorepo ----
FROM node:22-slim AS build
WORKDIR /app
# Skip husky (no .git in the build context) + keep installs non-interactive.
ENV HUSKY=0 CI=true
RUN corepack enable
# Copy the whole repo (.dockerignore prunes node_modules/dist/.git/etc), then
# install against the committed lockfile and build all packages + apps.
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

# ---- api (NestJS; listens on API_PORT, default 3000) ----
FROM build AS api
ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "@actionow/api", "start"]

# ---- worker (BullMQ job runner) ----
FROM build AS worker
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@actionow/worker", "start"]

# ---- web (static SPA served + proxied by nginx) ----
FROM nginx:1.27-alpine AS web
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
