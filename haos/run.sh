#!/usr/bin/env bash
set -e

OPTIONS="/data/options.json"

# Lê as opções configuradas no HAOS e exporta como variáveis de ambiente
export GRUPO_ASSISTENTE_ID=$(jq --raw-output '.GRUPO_ASSISTENTE_ID' "$OPTIONS")
export GOOGLE_API_KEY=$(jq --raw-output '.GOOGLE_API_KEY' "$OPTIONS")
export GOOGLE_CALENDAR_ID=$(jq --raw-output '.GOOGLE_CALENDAR_ID' "$OPTIONS")
export GOOGLE_SERVICE_ACCOUNT_KEY_JSON=$(jq --raw-output '.GOOGLE_SERVICE_ACCOUNT_KEY_JSON' "$OPTIONS")
export GEMINI_MODEL=$(jq --raw-output '.GEMINI_MODEL' "$OPTIONS")
export DEFAULT_TIMEZONE=$(jq --raw-output '.DEFAULT_TIMEZONE' "$OPTIONS")
export FOOTBALL_DATA_KEY=$(jq --raw-output '.FOOTBALL_DATA_KEY' "$OPTIONS")
export GOOGLE_IMPERSONATE_EMAIL=$(jq --raw-output '.GOOGLE_IMPERSONATE_EMAIL' "$OPTIONS")
export REMINDER_MINUTES=$(jq --raw-output '.REMINDER_MINUTES // 15' "$OPTIONS")

# Sessão do WhatsApp persiste em /data para sobreviver a reinicializações
export SESSION_PATH=/data/whatsapp-session

echo "Iniciando WhatsApp Calendar Bot..."
echo "Chat monitorado: $GRUPO_ASSISTENTE_ID"

cd /app
exec node src/index.js
