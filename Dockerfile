FROM node:22-alpine
WORKDIR /app
COPY mini-server.mjs ./
COPY scripts/hermes-prefill.mjs ./scripts/hermes-prefill.mjs
COPY scripts/hermes-system1.mjs ./scripts/hermes-system1.mjs
COPY scripts/hermes-business-registry.mjs ./scripts/hermes-business-registry.mjs
COPY scripts/hermes-agent-providers.mjs ./scripts/hermes-agent-providers.mjs
COPY scripts/hermes-discord-lib.mjs ./scripts/hermes-discord-lib.mjs
COPY scripts/hermes-backup-executor.mjs ./scripts/hermes-backup-executor.mjs
COPY scripts/hermes-backup-manifest.mjs ./scripts/hermes-backup-manifest.mjs
COPY hermes-projects.json ./
ENV NODE_ENV=production
ENV PORT=3000
ENV HERMES_DATA_FILE=/app/var/data/requests.json
ENV HERMES_PROJECTS_FILE=/app/hermes-projects.json
EXPOSE 3000
CMD ["node", "/app/mini-server.mjs"]
