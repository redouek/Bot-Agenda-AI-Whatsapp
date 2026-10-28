// Transcricao de audio sob demanda — veio do projeto whatsapp-voice-free, que
// rodava como um segundo aparelho conectado no mesmo numero. Aqui ele divide a
// sessao do WhatsApp com a agenda, e os territorios nao se cruzam:
//   • agenda: SO o self-chat (bot.js descarta o resto);
//   • transcricao: qualquer conversa MENOS o self-chat, e so quando o proprio
//     usuario manda a frase-gatilho. Nada e transcrito automaticamente.
// O gatilho transcreve o audio citado (se o gatilho for reply de um audio) ou
// o audio mais recente da conversa.
//
// Liga por usuario via TRANSCRIBER_USERS (e-mails separados por virgula, ou *)
// e exige GROQ_API_KEY.

import { downloadMediaCompat, fixMsgId, installMsgKeyShim, msgId } from './compat.js';
import { getSelfChatLid } from './bot.js';
import { groqChat, hasGroqKey, toGroqAudio, transcribeAudio } from './groq.js';

const cfg = {
  summarize: () => !/^(false|0|no)$/i.test(process.env.TRANSCRIBE_SUMMARIZE || ''),
  summaryThresholdSeconds: () => {
    const n = parseInt(process.env.TRANSCRIBE_SUMMARY_SECONDS || '', 10);
    return Number.isFinite(n) ? n : 90;
  },
  summaryPrompt: () =>
    process.env.TRANSCRIBE_SUMMARY_PROMPT ||
    'Resuma o áudio transcrito de forma concisa, em português do Brasil.',
  // Pensada para ser uma resposta rapida do WhatsApp.
  trigger: () => process.env.TRANSCRIBE_TRIGGER || 'IA, transcreva o áudio por favor',
};

export function isTranscriberEnabled(userId) {
  if (!hasGroqKey()) return false;
  const list = String(process.env.TRANSCRIBER_USERS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes('*') || list.includes(String(userId).toLowerCase());
}

// Comparacao robusta da frase: decompoe, tira acentos, minusculas, sem
// pontuacao. Comparar bytes falhava com "áudio" pre-composto vs decomposto.
function normalize(s) {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Mensagem de voz e "ptt"; arquivo de audio anexado e "audio".
const isAudio = msg => msg?.type === 'ptt' || msg?.type === 'audio';

// A conversa da mensagem: se fomos nos que mandamos, `from` somos nos e a
// conversa e o destinatario (`to`).
const chatIdOf = msg => (msg.fromMe ? msg.to : msg.from);

function audioSeconds(msg) {
  const n = parseInt(String(msg.duration ?? ''), 10);
  return Number.isFinite(n) ? n : 0;
}

// ── Groq ────────────────────────────────────────────────────────────────────

async function summarizeText(text) {
  return groqChat([
    { role: 'system', content: cfg.summaryPrompt() },
    { role: 'user', content: `Resuma este áudio transcrito:\n\n${text}` },
  ]);
}

// ── Fluxo do gatilho ────────────────────────────────────────────────────────

// Dedup leve pelo id do GATILHO, para um evento repetido nao postar duas vezes.
const seen = new Set();
function alreadyHandled(id) {
  if (!id) return false; // sem id, deixa passar em vez de engolir o gatilho
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 1000) seen.delete(seen.values().next().value);
  return false;
}

async function senderName(msg) {
  try {
    const c = await msg.getContact();
    return c.pushname || c.name || c.number || 'alguém';
  } catch {
    return 'alguém';
  }
}

// O audio citado (se o gatilho for reply de um audio), senao o mais recente
// da conversa.
async function findTargetAudio(triggerMsg) {
  if (triggerMsg.hasQuotedMsg) {
    try {
      const q = fixMsgId(await triggerMsg.getQuotedMessage());
      if (isAudio(q)) return q;
    } catch (err) {
      // Citacao quebrada nao pode matar o gatilho: ainda da pra varrer a conversa.
      console.warn('[transcriber] getQuotedMessage falhou, varrendo a conversa:', err?.message || err);
    }
  }
  const chat = await triggerMsg.getChat();
  const msgs = await chat.fetchMessages({ limit: 30 });
  const triggerId = msgId(triggerMsg);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = fixMsgId(msgs[i]);
    if (triggerId && msgId(m) === triggerId) continue;
    if (isAudio(m)) return m;
  }
  return null;
}

async function transcribeAndReply(userId, audioMsg) {
  const media = await downloadMediaCompat(fixMsgId(audioMsg));
  if (!media?.data) throw new Error('download de midia vazio');
  const audio = await toGroqAudio(Buffer.from(media.data, 'base64'), media.mimetype);

  const transcription = await transcribeAudio(audio.data, audio.filename, audio.mimeType);
  if (!transcription) {
    console.log(`[transcriber:${userId}] Groq devolveu transcricao vazia.`);
    return;
  }

  let body = transcription;
  if (cfg.summarize() && audioSeconds(audioMsg) >= cfg.summaryThresholdSeconds()) {
    const summary = await summarizeText(transcription).catch(err => {
      console.warn(`[transcriber:${userId}] Resumo falhou, enviando so a transcricao:`, err?.message || err);
      return '';
    });
    if (summary) body = `*Resumo:*\n${summary}\n\n*Transcrição:*\n${transcription}`;
  }

  // Cabecalho em italico para nao parecer que e o usuario falando.
  const header = `_Transcrição automática via IA do áudio de ${await senderName(audioMsg)}_`;
  await audioMsg.reply(`${header}\n\n${body}`);
  console.log(`[transcriber:${userId}] Audio transcrito (${audioSeconds(audioMsg)}s, ${transcription.length} chars).`);
}

// Registrado junto com os demais handlers do client, antes do `ready`.
// O `message_create` dispara nas conversas normais (so no self-chat ele falha,
// e por isso a agenda usa polling — ver bot.js).
export function registerTranscriber(userId, client) {
  if (!isTranscriberEnabled(userId)) return;
  const trigger = normalize(cfg.trigger());
  console.log(`[transcriber:${userId}] Ativo. Gatilho: "${cfg.trigger()}"`);

  client.on('ready', async () => {
    try {
      console.log(`[transcriber:${userId}] compat MsgKey._serialized: ${await installMsgKeyShim(client)}`);
    } catch (err) {
      console.warn(`[transcriber:${userId}] compat MsgKey._serialized falhou:`, err?.message || err);
    }
  });

  client.on('message_create', async msg => {
    if (!msg.fromMe || msg.type !== 'chat') return;
    if (normalize(msg.body || '') !== trigger) return;

    // Self-chat e da agenda. Ele aparece como o proprio numero (@c.us) ou
    // como o LID do usuario; nos dois casos from === to.
    const chatId = chatIdOf(msg);
    const selfWid = client.info?.wid?._serialized;
    if (chatId === selfWid || chatId === getSelfChatLid(userId) || msg.to === msg.from) return;
    if (alreadyHandled(msgId(msg))) return;

    console.log(`[transcriber:${userId}] Gatilho recebido.`);
    try {
      // O shim vive na pagina: se o WhatsApp Web recarregou desde o `ready`,
      // ele sumiu. Reinstalar e idempotente e barato.
      await installMsgKeyShim(client).catch(() => {});
      const target = await findTargetAudio(msg);
      if (!target) {
        console.log(`[transcriber:${userId}] Nenhum audio recente nesta conversa.`);
        return;
      }
      await transcribeAndReply(userId, target);
    } catch (err) {
      console.error(`[transcriber:${userId}] Erro no gatilho:`, err?.message || err);
      // Falhar em silencio e o pior caso: o usuario manda o gatilho e nunca
      // sabe se o bot recebeu.
      try {
        await msg.reply(
          'Não consegui transcrever esse áudio. Responda (reply) diretamente à mensagem de áudio com o gatilho — isso costuma resolver.',
        );
      } catch (replyErr) {
        console.error(`[transcriber:${userId}] Falha ao avisar o usuario:`, replyErr?.message || replyErr);
      }
    }
  });
}
