# ---- build ----
FROM node:22-slim AS build
WORKDIR /app
# package-lock.json was never copied in here before — `npm install` with no
# lockfile present re-resolves every floating-range dependency (package.json
# uses ^-ranges throughout) fresh against the registry on every build,
# silently drifting from whatever's actually pinned and tested. `npm ci`
# requires the lockfile and fails loudly if it and package.json disagree,
# instead of quietly installing something neither was tested against.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
# Never root.
RUN useradd -m -u 10002 api && chown -R api:api /app
USER api
EXPOSE 3000
CMD ["node","dist/server.js"]
