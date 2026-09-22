# ─── Multi-Stage Dockerfile ──────────────────────────────────────────

# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency manifests
COPY package.json package-lock.json ./

# Install dependencies (including devDependencies for TypeScript compilation)
RUN npm ci

# Copy source code and config
COPY tsconfig.json eslint.config.js vitest.config.ts ./
COPY src/ ./src/
COPY scripts/ ./scripts/

# Build TypeScript to dist/ and bundle client
RUN npm run build

# Stage 2: Production Runtime
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Install only production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled artifacts from builder
COPY --from=builder /app/dist ./dist

# Create non-root user for security
USER node

# Expose game server and metrics port
EXPOSE 3000

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/server/index.js"]
