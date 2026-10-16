# Built from the repository root (see docker-compose.yml): the bundle is produced here, so no
# separate build step or copied file is needed on the machine that runs `docker compose up --build`.
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN node_modules/.bin/esbuild src/execution/gateway-main.ts --bundle --platform=node --format=esm --target=node22 --outfile=/out/gateway.mjs

FROM node:22-alpine
WORKDIR /app
COPY --from=build /out/gateway.mjs ./
USER node
CMD ["node", "gateway.mjs"]
