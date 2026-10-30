# Acme data sources mock image. Base pinned by digest like the sample apps: node:24.22.1-bookworm-slim (multi-arch index digest).
# Bump the tag and the digest together. Node 24 runs the .ts files directly (type stripping), so there is no build step.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY mock ./mock
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "mock/server.ts"]
