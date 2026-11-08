FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4
RUN npm install -g --allow-scripts=pnpm pnpm@12.0.0
WORKDIR /app
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node apps/dashboard/package.json ./apps/dashboard/package.json
COPY --chown=node:node packages/observability/package.json ./packages/observability/package.json
RUN pnpm install --frozen-lockfile
COPY --chown=node:node apps/dashboard ./apps/dashboard
COPY --chown=node:node packages/observability ./packages/observability
USER node
ENV NODE_ENV=production
ENV PORT=8790
ENV COMPUTAH_DASHBOARD_HOST=0.0.0.0
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "apps/dashboard/src/main.mjs"]
