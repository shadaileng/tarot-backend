# ========== 构建阶段 ==========
FROM node:22-slim AS builder

RUN npm install -g "pnpm@9.15.0"

WORKDIR /app
COPY pnpm-lock.yaml package.json ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm run build
COPY assets/ ./assets/

# ========== 运行阶段 ==========
FROM node:22-slim

RUN npm install -g "pnpm@9.15.0"

RUN apt-get update && apt-get install -y \
  chromium \
  chromium-sandbox \
  fonts-noto-cjk \
  fonts-noto-cjk-extra \
  fonts-noto-color-emoji \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true

ENV TZ=Asia/Shanghai

WORKDIR /app

COPY --from=builder /app/pnpm-lock.yaml ./
COPY --from=builder /app/package.json ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/assets ./assets

RUN mkdir -p /app/data

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "dist/index.js"]
