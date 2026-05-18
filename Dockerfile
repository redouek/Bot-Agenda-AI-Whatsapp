# Stage 1: compila addons nativos (sqlite3) from source contra o GLIBC local
FROM node:20-slim AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm_config_build_from_source=true npm install --omit=dev

# Stage 2: imagem de produção — sem ferramentas de build
FROM node:20-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    wget \
    ca-certificates \
    gnupg \
    chromium \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV CONFIG_PATH=/data/config.json
ENV DB_PATH=/data/app.sqlite
ENV SESSIONS_ROOT=/data/whatsapp-sessions
ENV NODE_ENV=production

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY web/ ./web/

EXPOSE 3000
CMD ["node", "src/index.js"]
