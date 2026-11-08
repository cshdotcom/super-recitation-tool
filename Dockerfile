# syntax=docker/dockerfile:1

# ---------- deps + build (bun, debian/glibc base) ----------
# The project is managed with bun (bun.lock). Prisma generates glibc query
# engines on this image, so the runtime stage MUST also be glibc-based —
# that's why we use node:22-slim below instead of alpine.
FROM oven/bun:1 AS builder

WORKDIR /app

# Install dependencies first (cached layer). Prisma schema is needed for the
# client codegen; a dummy DATABASE_URL is enough since generate never connects.
COPY package.json bun.lock ./
COPY prisma/schema.prisma ./prisma/schema.prisma
ENV DATABASE_URL=file:/app/data/beishuba.db
RUN bun install --frozen-lockfile

# Generate the Prisma client, then build the Next.js standalone bundle.
# The "build" script runs `next build` and copies .next/static + public into
# .next/standalone (self-contained server output).
COPY . .
RUN bun run db:generate
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

# ---------- runtime (node, glibc — matches Prisma engines) ----------
FROM node:22-slim AS runner

WORKDIR /app

# openssl: required by the Prisma query engine on Debian slim images.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_URL=file:/app/data/beishuba.db

# Non-root user; /app/data holds the SQLite database (bind-mounted volume).
RUN mkdir -p /app/data \
  && chown -R node:node /app/data \
  && chown -R node:node /app
VOLUME /app/data

# Next.js standalone output: server.js + .next + node_modules subset.
COPY --from=builder --chown=node:node /app/.next/standalone ./

EXPOSE 3000

USER node

CMD ["node", "server.js"]
