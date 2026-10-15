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

import { spawn } from 'child_process';
import { downloadMediaCompat, fixMsgId, installMsgKeyShim, msgId } from './compat.js';
import { getSelfChatLid } from './bot.js';

const GROQ_BASE = 'https://api.groq.com/openai/v1';

const cfg = {
  apiKey: () => process.env.GROQ_API_KEY || '',
  whisperModel: () => process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo',
  chatModel: () => process.env.GROQ_CHAT_MODEL || 'openai/gpt-oss-120b',
  language: () => process.env.TRANSCRIBE_LANGUAGE || 'pt',
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
  if (!cfg.apiKey()) return false;
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

// ── Groq (API compativel com OpenAI) ────────────────────────────────────────

async function groqError(res) {
  const text = await res.text().catch(() => '');
  return new Error(`Groq HTTP ${res.status}: ${text.slice(0, 300)}`);
}

async function transcribeAudio(data, filename, mimeType) {
  const form = new FormData();
  form.append('file', new Blob([data], { type: mimeType }), filename);
  form.append('model', cfg.whisperModel());
  form.append('language', cfg.language());
  const res = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey()}` },
    body: form,
  });
  if (!res.ok) throw await groqError(res);
  const json = await res.json();
  return String(json.text || '').trim();
}

async function summarizeText(text) {
  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.chatModel(),
      temperature: 0.3,
      messages: [
        { role: 'system', content: cfg.summaryPrompt() },
        { role: 'user', content: `Resuma este áudio transcrito:\n\n${text}` },
      ],
    }),
  });
  if (!res.ok) throw await groqError(res);
  const json = await res.json();
  return String(json.choices?.[0]?.message?.content || '').trim();
}

// ── Formato do audio ────────────────────────────────────────────────────────
// A Groq so aceita [flac mp3 mp4 mpeg mpga m4a ogg opus wav webm] e confere a
// extensao do nome do arquivo. Mensagem de voz vem em ogg/opus; "arquivo de
// audio" pode vir como audio/aac em ADTS cru, que a Groq recusa — esse e
// convertido para ogg/opus.
const ACCEPTED = {
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};

// Demuxer do ffmpeg FIXO: o arquivo vem de terceiros, e deixar o ffmpeg
// autodetectar abriria a porta para um "audio" que e playlist HLS/concat e faz
// o servidor buscar URLs (SSRF). Por isso tambem `-protocol_whitelist pipe`.
const CONVERT = {
  'audio/aac': 'aac',
  'audio/x-aac': 'aac',
  'audio/amr': 'amr',
};

async function toGroqAudio(data, mimetype) {
  const base = String(mimetype || '').split(';')[0].trim().toLowerCase();
  const ext = ACCEPTED[base];
  if (ext) return { data, filename: `audio.${ext}`, mimeType: base };
  const demuxer = CONVERT[base];
  if (!demuxer) throw new Error(`formato de audio nao suportado: ${mimetype}`);
  return { data: await ffmpegToOpus(data, demuxer), filename: 'audio.ogg', mimeType: 'audio/ogg' };
}

function ffmpegToOpus(input, demuxer) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-protocol_whitelist', 'pipe',
      '-f', demuxer,
      '-i', 'pipe:0',
      '-vn', '-ac', '1', '-c:a', 'libopus', '-b:a', '32k',
      '-f', 'ogg', 'pipe:1',
    ]);
    const out = [];
    let err = '';
    ff.stdout.on('data', c => out.push(c));
    ff.stderr.on('data', c => { err += c.toString(); });
    ff.on('error', reject);
    ff.on('close', code =>
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg saiu com ${code}: ${err.trim()}`)));
    // EPIPE se o ffmpeg morrer antes de ler tudo — o erro real vem no "close".
    ff.stdin.on('error', () => {});
    ff.stdin.end(input);
  });
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
