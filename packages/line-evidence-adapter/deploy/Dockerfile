# line-evidence adapter image. Build context = packages/line-evidence-adapter (the parent of this deploy/ directory):
#   docker build -f deploy/Dockerfile -t line-evidence-adapter:<tag> .
# The only runtime dependency is mysql2, pinned exactly in deploy/package.json with a lockfile; install scripts are disabled.
# openssh-client is included for the restricted database forward that deploy/entrypoint.sh opens. Run with an init (compose/swarm: init: true).
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client && apt-get clean
WORKDIR /app
COPY deploy/package.json deploy/package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund
COPY evidence.mjs server.mjs magnus-sql.mjs ./
COPY deploy/entrypoint.sh /app/entrypoint.sh
RUN chmod 755 /app/entrypoint.sh
USER node
ENV NODE_ENV=production BIND=0.0.0.0 PORT=8787 HOME=/home/node
EXPOSE 8787
ENTRYPOINT ["/app/entrypoint.sh"]
