# line-evidence adapter image. Build context = packages/line-evidence-adapter (the parent of this deploy/ directory):
#   docker build -f deploy/Dockerfile -t line-evidence-adapter:<tag> .
# The only runtime dependency is mysql2, pinned exactly in deploy/package.json with a lockfile; install scripts are disabled.
FROM node:22-slim
WORKDIR /app
COPY deploy/package.json deploy/package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund
COPY evidence.mjs server.mjs magnus-sql.mjs ./
USER node
ENV NODE_ENV=production BIND=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node", "server.mjs"]
