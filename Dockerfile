# syntax=docker/dockerfile:1
# One Dockerfile for every Node service in the workspace:
#   docker build --build-arg APP=@gatekeeper/gateway -t gatekeeper-gateway .
ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS build
RUN corepack enable
WORKDIR /repo
# Manifests first, so dependency installs are cached across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/gateway/package.json apps/gateway/
COPY packages/protocol/package.json packages/protocol/
COPY packages/demo-servers/package.json packages/demo-servers/
COPY tests/package.json tests/
# Optional: behind a TLS-intercepting proxy, pass its CA as a build secret:
#   docker build --secret id=extra_ca,src=/path/to/ca.pem ...
# The CA is only visible to this step and never lands in an image layer.
ARG NODE_USE_ENV_PROXY
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile
COPY . .
ARG APP
RUN test -n "$APP" && pnpm --filter "$APP" build && pnpm --filter "$APP" deploy --prod --legacy /out

FROM node:${NODE_VERSION}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
CMD ["node", "dist/main.js"]
