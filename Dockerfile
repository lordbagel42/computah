FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4
RUN npm install -g --allow-scripts=pnpm pnpm@12.0.0
WORKDIR /app
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node apps/server/package.json ./apps/server/package.json
COPY --chown=node:node packages/contracts/package.json ./packages/contracts/package.json
COPY --chown=node:node packages/observability/package.json ./packages/observability/package.json
RUN pnpm install --frozen-lockfile
COPY --chown=node:node apps/server ./apps/server
COPY --chown=node:node packages/contracts ./packages/contracts
COPY --chown=node:node packages/observability ./packages/observability
ENV NODE_ENV=production HOME=/data PORT=8787
USER node
EXPOSE 8787
CMD ["node", "--import", "tsx", "apps/server/src/main.ts"]
