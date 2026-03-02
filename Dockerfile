# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY client/package.json ./client/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
COPY client ./client
RUN pnpm run build:server
RUN pnpm run client:build

FROM deps AS prod-deps
ENV CI=true
RUN pnpm prune --prod

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/client/dist ./client/dist
COPY src/db/migrations ./src/db/migrations

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/api/health').then((r)=>{if(!r.ok) throw new Error('unhealthy'); process.exit(0);}).catch(()=>process.exit(1))"

RUN chown -R node:node /app
USER node

CMD ["node", "dist/index.js"]
