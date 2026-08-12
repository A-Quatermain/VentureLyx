# Venturelyx :: Command Center (web) — multi-stage, standalone Next.js output.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Baked into the client bundle at build time — this is the one place a URL
# is "hardcoded" per build, and it's driven by a build arg, never literal.
ARG NEXT_PUBLIC_API_BASE
ENV NEXT_PUBLIC_API_BASE=${NEXT_PUBLIC_API_BASE}
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Next's standalone server.js binds to $HOSTNAME. Docker sets HOSTNAME to the
# container's short ID by default, which resolves (via the container's own
# /etc/hosts) to its private IP only — so the server ends up reachable from
# the Docker network but not from 127.0.0.1 inside the container itself.
# Pin it explicitly so healthchecks and any localhost tooling work.
ENV HOSTNAME=0.0.0.0
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=build /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
