# Production Dockerfile for Solana Copy-Trading Bot
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install build dependencies for native compilation if required
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    gcc \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
# Use npm install to gracefully resolve platform-specific Linux binaries and optional dependencies
RUN npm install

COPY . .

# Build both Vite dashboard and TypeScript server
RUN npm run dashboard:build
RUN npm run build:server

# Production Runtime
FROM node:22-bookworm-slim AS runner

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV DB_PATH=/app/data/copy_bot.db

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dashboard/dist ./dashboard/dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/src ./src

RUN mkdir -p /app/data

EXPOSE 3000 3001

CMD ["node", "dist/index.js"]
