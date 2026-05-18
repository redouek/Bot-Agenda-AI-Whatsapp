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

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY web/ ./web/

EXPOSE 3000

CMD ["node", "src/index.js"]
