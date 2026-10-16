# The Playwright image ships Chromium and its system libraries. We add the matching npm package at
# build time (the running container has no internet, so nothing is downloaded at runtime).
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
RUN npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund playwright@1.63.0
COPY server.mjs ./
USER pwuser
CMD ["node", "server.mjs"]
