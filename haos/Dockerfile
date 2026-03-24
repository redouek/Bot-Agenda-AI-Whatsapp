FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    wget \
    ca-certificates \
    gnupg \
    chromium \
    jq \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copia dependências e instala
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copia o código fonte
COPY src/ ./src/

# Script de inicialização
COPY haos/run.sh /run.sh
RUN chmod +x /run.sh

CMD ["/run.sh"]
