# WhatsApp Assistant (Gemini + Google Calendar)

Bot de WhatsApp para conversar, interpretar mensagens em texto, audio e imagem, consultar fontes externas sem custo extra e confirmar agendamentos antes de criar eventos no Google Calendar.

## Como usar

1. Copie `.env.example` para `.env`.
2. Preencha `GRUPO_ASSISTENTE_ID`, `GOOGLE_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_KEY_JSON` ou `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`.
3. Para consultas de futebol, preencha `API_FOOTBALL_KEY`.
4. Instale dependencias: `npm install`.
5. Rode: `npm start`.

## Arquitetura

- `src/index.js`: inicializa o cliente WhatsApp, usa historico recente do grupo, controla confirmacoes pendentes e roteia entre Gemini, busca externa e Google Calendar.
- `src/gemini.js`: interpreta texto, audio e imagem com Gemini e decide entre conversa, lookup externo e proposta de agendamento.
- `src/knowledge.js`: integra API-Football para jogos atuais e Wikipedia para consultas gerais/historicas.
- `src/calendar.js`: autentica no Google Calendar e cria eventos confirmados.
- `haos/`: add-on do Home Assistant.
