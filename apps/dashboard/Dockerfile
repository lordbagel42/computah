FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node apps/dashboard/src ./src
COPY --chown=node:node apps/dashboard/public ./public
USER node
ENV PORT=8790
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/main.mjs"]
