# syntax=docker/dockerfile:1

# --- dependencies (full, includes TypeScript for tests/verify) ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- production build -----------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- runtime image --------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
COPY package.json ./
COPY --from=builder /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/src/main.js"]

# --- one-shot verification image (tests + build + HTTP smoke) -------------
FROM deps AS verify
WORKDIR /app
COPY package.json tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY test ./test
COPY scripts ./scripts
# Type-check, run the unit suite, produce the production build, then run
# the HTTP smoke against the running api service. A non-zero exit from
# any step fails the whole verification.
CMD ["sh", "-c", "npm run typecheck && npm test && npm run build && node scripts/smoke.ts"]
