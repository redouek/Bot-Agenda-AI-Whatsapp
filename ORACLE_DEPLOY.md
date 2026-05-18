# Deploy na Oracle Cloud Always Free

Este projeto foi preparado para rodar em uma VM pequena na Oracle Cloud com Docker e volume persistente local.

## Arquitetura

- App Node.js na porta `3000`
- SQLite em `/data/app.sqlite`
- Configuracao do Admin em `/data/config.json`
- Sessoes WhatsApp em `/data/whatsapp-sessions`
- Docker Compose com volume `bot_data`

## Antes de subir

1. Crie uma conta Oracle Cloud Free Tier.
2. Crie uma VM Always Free, preferencialmente Ampere A1 se houver capacidade.
3. Abra a porta `3000` na Security List ou Network Security Group.
4. Instale Docker e Docker Compose na VM.
5. Clone ou envie este repositorio para a VM.

## Subir o app

```bash
docker compose up -d --build
```

Ver logs:

```bash
docker compose logs -f bot
```

Parar sem perder dados:

```bash
docker compose down
```

## URL publica

Teste inicial:

```text
http://IP_PUBLICO:3000
```

Admin:

```text
http://IP_PUBLICO:3000/admin
```

## Google OAuth

Quando sair do localhost, adicione uma nova URL autorizada no Google Cloud:

```text
http://IP_PUBLICO:3000/oauth/callback
```

Se usar dominio com HTTPS:

```text
https://SEU_DOMINIO/oauth/callback
```

Depois, entre no `/admin` do app em producao e atualize a URL de redirecionamento para a mesma URL cadastrada no Google.

## Persistencia

O volume `bot_data` guarda configuracao, banco SQLite, refresh tokens do Google e sessoes do WhatsApp. Nao remova esse volume a menos que queira resetar o SaaS.

## Proximo passo recomendado

Depois que a VM estiver funcionando por IP, colocar dominio e HTTPS com proxy reverso. Isso melhora a confiabilidade do OAuth e deixa a experiencia pronta para usuarios reais.
