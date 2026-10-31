# WhatsApp Calendar Bot

Bot pessoal de WhatsApp que agenda eventos no Google Calendar usando linguagem natural, powered by Gemini AI.

**Manda uma mensagem para si mesmo** como _"churrasco sábado às 15h"_ e o bot cria o evento automaticamente.

## O que ele faz

- Agenda eventos por texto natural ou áudio
- Eventos recorrentes ("toda segunda às 8h academia")
- Lista agenda (hoje, amanhã, semana)
- Cancela eventos
- Lembretes automáticos X minutos antes
- Consulta jogos de futebol e adiciona na agenda
- Consulta Wikipedia
- Clima e previsão do tempo (Open-Meteo), com aviso de chuva e feriado ao propor um evento
- Feriados nacionais, CEP, CNPJ e DDD (BrasilAPI)
- Tarefas no Google Tasks ("anota comprar pão", "quais minhas tarefas?")
- Controle da casa pelo Home Assistant, só para o dono (opcional, ver abaixo)
- Transcreve áudios de qualquer conversa sob demanda (opcional, ver abaixo)

## Pré-requisitos

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) instalado e rodando
- Conta Google com acesso ao Google Calendar
- Chave da [Gemini API](https://aistudio.google.com/app/apikey) (gratuita)

## Instalação

### 1. Clone o repositório

```bash
git clone https://github.com/redouek/Bot-Agenda-AI-Whatsapp.git
cd Bot-Agenda-AI-Whatsapp
```

### 2. Crie as credenciais OAuth do Google

1. Acesse [console.cloud.google.com](https://console.cloud.google.com)
2. Crie um projeto (ou use um existente)
3. Ative a **Google Calendar API**: APIs & Services → Library → pesquise "Google Calendar API" → Enable
4. Crie credenciais OAuth: APIs & Services → Credentials → **Create Credentials → OAuth 2.0 Client IDs**
   - Application type: **Web application**
   - Authorized redirect URIs: `http://localhost:3000/oauth/callback`
5. Anote o **Client ID** e o **Client Secret**

### 3. Suba o container

```bash
docker compose up --build
```

Na primeira vez demora alguns minutos. Quando aparecer:
```
[server] Painel disponível em http://localhost:3000
```

### 4. Configure pelo painel

Abra [http://localhost:3000](http://localhost:3000) e preencha:

| Campo | Onde obter |
|---|---|
| **Número WhatsApp** | Seu número com DDI, sem +. Ex: `5511999999999@c.us` |
| **Chave Gemini** | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) |
| **OAuth Client ID** | Passo 2 acima |
| **OAuth Client Secret** | Passo 2 acima |
| **ID do Calendário** | Seu e-mail Gmail ou `primary` |
| **Minutos de lembrete** | Padrão: 15 |

Clique **Salvar configuração** → **Conectar Google Calendar** → autorize o acesso.

### 5. Escaneie o QR code

O painel exibirá um QR code. No celular:

> WhatsApp → três pontos → Dispositivos conectados → Conectar dispositivo → aponte a câmera

O bot está pronto. Mande uma mensagem para **si mesmo** no WhatsApp.

## Uso

| Você fala | Bot faz |
|---|---|
| "churrasco sábado às 15h" | Propõe o evento, aguarda confirmação |
| "toda segunda às 8h academia" | Cria evento recorrente |
| "o que tenho hoje?" | Lista agenda do dia |
| "cancela a academia" | Busca e cancela |
| "próximo jogo do Flamengo" | Consulta e oferece adicionar à agenda |
| "o que você pode fazer?" | Lista capacidades |

## Parar / reiniciar

```bash
# Parar
docker compose down

# Reiniciar sem perder sessão WhatsApp e configurações
docker compose up
```

Os dados ficam num volume Docker chamado `bot_data`. A sessão do WhatsApp e as configurações persistem entre reinicializações.

## Custos

| Componente | Custo |
|---|---|
| whatsapp-web.js | Gratuito |
| Gemini API | Gratuito (tier free generoso) |
| Google Calendar API | Gratuito |
| Football-data.org | Gratuito (tier free) |
| Open-Meteo, BrasilAPI, Google Tasks | Gratuitos (Open-Meteo: uso não comercial) |
| Infraestrutura | Seu próprio computador ou ~$5/mês em VPS |

> **Aviso:** o `whatsapp-web.js` funciona simulando o WhatsApp Web e tecnicamente viola os ToS do WhatsApp. O risco de ban é baixo para uso pessoal, mas existe.

## Variáveis de ambiente avançadas

Para usuários que preferem configurar via variáveis de ambiente em vez do painel web, crie um arquivo `.env` na raiz:

```env
PORT=3000
SESSION_PATH=/data/whatsapp-session
CONFIG_PATH=/data/config.json
TOKENS_PATH=/data/google-tokens.json
OAUTH_REDIRECT_URI=http://localhost:3000/oauth/callback
```

## Assistente pessoal: clima, tarefas e casa

**Clima e utilidades** não precisam de chave. Para responder "vai chover amanhã?" sem citar a cidade, defina no `bot.env`:

```env
DEFAULT_CITY=Campinas
```

**Google Tasks** usa o mesmo login Google do Calendar. Na primeira vez que alguém pede uma tarefa, o bot manda o link `/oauth/tasks` para autorizar o acesso às tarefas. Antes, ative a **Google Tasks API** no mesmo projeto do Google Cloud (APIs & Services → Library) e, se a tela de consentimento estiver em verificação, inclua o escopo `.../auth/tasks`.

**Home Assistant** (opcional): controla a casa de **uma pessoa só**, o dono. Crie um token em *Perfil → Segurança → Tokens de acesso de longa duração* no Home Assistant e adicione ao `bot.env`:

```env
HA_URL=https://ha.seudominio.com      # endereco que o container do bot alcanca (ex: o tunel da Cloudflare)
HA_TOKEN=...
# Quem pode controlar a casa (e-mails do painel). Sem a variavel: so os admins.
HA_ALLOWED_EMAILS=voce@gmail.com
# Opcional: dominios liberados. Padrao: luzes, switches, ventiladores, cortinas, ar, midia,
# cenas, scripts, aspirador e sensores. Fechaduras e alarmes ficam bloqueados por padrao.
HA_ALLOWED_DOMAINS=
```

Se o Home Assistant estiver atrás do Cloudflare Access, libere o caminho `/api/` para o bot (por exemplo, com um *service token* ou uma regra de bypass), senão as chamadas recebem a página de login.

## Transcrição de áudio (opcional)

Na mesma sessão do WhatsApp, o bot transcreve áudios de **qualquer conversa que não seja o self-chat**. Nada é automático: você manda a frase-gatilho na conversa e ele responde citando o áudio com a transcrição (e um resumo, se o áudio for longo). Se o gatilho for uma resposta (reply) a um áudio, transcreve esse; senão, o mais recente da conversa. O self-chat continua exclusivo da agenda.

Transcrição via [Groq](https://console.groq.com/keys) (Whisper, free tier). Para ligar, no `bot.env`:

```env
GROQ_API_KEY=...
# E-mails dos usuarios do painel que terao a transcricao (separados por virgula, ou *)
TRANSCRIBER_USERS=voce@gmail.com
```

Ajustes opcionais (com os defaults):

```env
TRANSCRIBE_TRIGGER=IA, transcreva o áudio por favor   # vale cadastrar como resposta rápida no WhatsApp
TRANSCRIBE_LANGUAGE=pt
TRANSCRIBE_SUMMARIZE=true
TRANSCRIBE_SUMMARY_SECONDS=90
TRANSCRIBE_SUMMARY_PROMPT=Resuma o áudio transcrito de forma concisa, em português do Brasil.
GROQ_WHISPER_MODEL=whisper-large-v3-turbo
GROQ_CHAT_MODEL=openai/gpt-oss-120b
```

A comparação do gatilho ignora maiúsculas, acentos e pontuação.
