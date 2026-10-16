# The Corbits app (API, dashboard, worker). Multi-arch: builds natively on arm64 (Oracle Ampere) and x86.
FROM node:22-bookworm-slim
ENV NODE_ENV=production
RUN corepack enable \
 # The Claude Code CLI is the default model backend (see README, "Model access").
 && npm install -g --no-audit --no-fund @anthropic-ai/claude-code
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# tsx (a dev dependency) runs the TypeScript sources directly, as `pnpm start` does.
RUN pnpm install --frozen-lockfile --prod=false
COPY tsconfig.json ./
COPY migrations ./migrations
COPY src ./src
USER node
ENV HOME=/home/node HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node_modules/.bin/tsx", "src/main.ts"]
