# Production Dockerfile for Solana Copy-Trading Bot
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3 native compilation
RUN apk add --no-cache python3 make g++ gcc

COPY package*.json ./
RUN npm ci

COPY . .

# Build dashboard and TypeScript
RUN npm run build
RUN npm run dashboard:build

# Production Runtime
FROM node:20-alpine AS runner

WORKDIR /app

RUN apk add --no-cache curl

ENV NODE_ENV=production
ENV DB_PATH=/app/data/copy_bot.db

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dashboard/dist ./dashboard/dist
COPY --from=builder /app/src ./src

RUN mkdir -p /app/data

EXPOSE 3000 3001

CMD ["node", "dist/index.js"]
