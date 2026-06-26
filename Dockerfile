# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Multi-stage build for the Next.js 16 app (standalone output).
#
# Easypanel invokes `docker build` and passes the NEXT_PUBLIC_* values as
# --build-arg, because client-side env vars must be inlined at BUILD time.
# Server-only secrets (SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY,
# ENCRYPTION_KEY, ANTHROPIC_API_KEY, EVOLUTION_WEBHOOK_TOKEN, ...) are read
# from the container ENV at RUN time and must be set in the Easypanel
# service env — NOT baked into the image.
# ---------------------------------------------------------------------------
FROM node:20-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---- deps: install with a clean, reproducible lockfile ----
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder: compile the standalone server bundle ----
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Public env must be present at build time so Next inlines it into the
# client bundle. Declared as ARG, promoted to ENV for `npm run build`.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY

RUN npm run build

# ---- runner: minimal image that serves the standalone output ----
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
# Bind all interfaces so the container is reachable from the proxy.
ENV HOSTNAME=0.0.0.0

# Run as the unprivileged node user shipped in the base image.
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
USER node

EXPOSE 3000
CMD ["node", "server.js"]
