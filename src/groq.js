// Cliente da Groq (API compativel com OpenAI). Usado pelo transcritor e como
// reserva do Gemini no planejador da agenda (ver generateJson em gemini.js).

import { spawn } from 'child_process';

const GROQ_BASE = 'https://api.groq.com/openai/v1';

const apiKey = () => process.env.GROQ_API_KEY || '';
const whisperModel = () => process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo';
const language = () => process.env.TRANSCRIBE_LANGUAGE || 'pt';

export const groqChatModel = () => process.env.GROQ_CHAT_MODEL || 'openai/gpt-oss-120b';
export const hasGroqKey = () => !!apiKey();

async function groqError(res) {
  const text = await res.text().catch(() => '');
  const error = new Error(`Groq HTTP ${res.status}: ${text.slice(0, 300)}`);
  error.status = res.status;
  return error;
}

export async function transcribeAudio(data, filename, mimeType) {
  const form = new FormData();
  form.append('file', new Blob([data], { type: mimeType }), filename);
  form.append('model', whisperModel());
  form.append('language', language());
  const res = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}` },
    body: form,
  });
  if (!res.ok) throw await groqError(res);
  const json = await res.json();
  return String(json.text || '').trim();
}

export async function groqChat(messages, { temperature = 0.3, json = false } = {}) {
  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: groqChatModel(),
      temperature,
      messages,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw await groqError(res);
  const body = await res.json();
  return String(body.choices?.[0]?.message?.content || '').trim();
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

export async function toGroqAudio(data, mimetype) {
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
