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

# Next.js standalone output: server.js + .next + node_modules subset (nft-traced).
COPY --from=builder --chown=node:node /app/.next/standalone ./

# serverExternalPackages (pdf-parse/pdfjs-dist/mammoth) are NOT bundled into the
# server bundle — they stay as runtime require(). nft tracing copies them into
# standalone/node_modules, but mammoth's complex dep tree (@xmldom/xmldom, jszip,
# lop, underscore, xmlbuilder …) and pdf-parse's worker files are frequently
# MISSED by nft, causing `Cannot find module 'mammoth'` at runtime → /api/parse
# returns 500 before even reaching the session check. Copy the FULL node_modules
# to guarantee every external package + its deps are resolvable at runtime.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules

# Prisma schema（启动时 db push 自动迁移需要）
COPY --from=builder --chown=node:node /app/prisma ./prisma

EXPOSE 3000

USER node

# 启动前自动迁移数据库（prisma db push）：确保 schema 新增列（如 SM-2 复习字段
# nextReviewAt/ease/interval/reviewCount/lastReviewedAt）在 SQLite 中存在，
# 否则 /api/review/due 等查询会因列不存在而 500。SQLite 加列是非破坏性的。
# --skip-generate：client 已在构建阶段生成，无需重复。
CMD ["sh", "-c", "./node_modules/.bin/prisma db push --skip-generate --accept-data-loss 2>/dev/null; node server.js"]
