import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

const API_KEY = process.env.GOOGLE_API_KEY;
if (!API_KEY) {
  console.warn('Aviso: configure GOOGLE_API_KEY no .env para Gemini');
}

const aiClient = new GoogleGenerativeAI(API_KEY || '');
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'models/gemini-flash-latest';
const model = aiClient.getGenerativeModel({ model: GEMINI_MODEL });

function extractJsonObject(text) {
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) return null;

  try {
    return JSON.parse(text.substring(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

function toISOStringSafe(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function parsePortugueseDate(rawText) {
  if (!rawText) return null;

  const pDia = /(?:dia\s+)?(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i.exec(rawText);
  const pTime = /(?:as|a)\s*(\d{1,2})(?::(\d{2}))?/i.exec(rawText);
  if (!pDia || !pTime) return null;

  let [, d, m, y] = pDia;
  let [, hh, mm = '00'] = pTime;

  if (y.length === 2) y = `20${y}`;

  const start = new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${hh.padStart(2, '0')}:${mm}:00-03:00`);
  if (Number.isNaN(start.getTime())) return null;

  const durationMatch = /(\d+)\s*h/i.exec(rawText);
  const durationHours = durationMatch?.[1] ? parseInt(durationMatch[1], 10) : 1;
  const end = new Date(start.getTime() + durationHours * 60 * 60 * 1000);

  return {
    startDateTime: start.toISOString(),
    endDateTime: end.toISOString(),
  };
}

function normalizeEvent(event, fallbackText = '') {
  if (!event || !event.summary || !event.startDateTime) return null;

  let startDateTime = toISOStringSafe(event.startDateTime);
  if (!startDateTime) return null;

  let endDateTime = toISOStringSafe(event.endDateTime)
    || new Date(new Date(startDateTime).getTime() + 60 * 60 * 1000).toISOString();

  // Corrige inversão: se o Gemini colocou o horário do usuário no endDateTime
  // e o startDateTime ficou no passado ou muito antes, troca os dois
  const now = Date.now();
  const startMs = new Date(startDateTime).getTime();
  const endMs = new Date(endDateTime).getTime();
  if (startMs < now && endMs > now && endMs > startMs) {
    // startDateTime parece errado (no passado), endDateTime parece ser o horário real
    startDateTime = endDateTime;
    endDateTime = new Date(endMs + 60 * 60 * 1000).toISOString();
  }

  return {
    summary: event.summary,
    description: event.description || fallbackText || event.summary,
    startDateTime,
    endDateTime: new Date(endDateTime) > new Date(startDateTime)
      ? endDateTime
      : new Date(new Date(startDateTime).getTime() + 60 * 60 * 1000).toISOString(),
    location: event.location || '',
    locationSuggestion: event.locationSuggestion || '',
    timeZone: event.timeZone || process.env.DEFAULT_TIMEZONE || 'America/Sao_Paulo',
  };
}

function fallbackScheduleProposal(text) {
  const dateParts = parsePortugueseDate(text);
  if (!dateParts) return null;

  const summary = text
    .replace(/\s+no\s+domingo.*$/i, '')
    .replace(/\s+no\s+sabado.*$/i, '')
    .replace(/\s+dia\s+\d{1,2}\/\d{1,2}\/\d{2,4}.*$/i, '')
    .replace(/\s+as\s+\d{1,2}(:\d{2})?.*$/i, '')
    .replace(/\s+e\s+a\s+festa.*$/i, '')
    .trim();

  return {
    kind: 'schedule_proposal',
    reply: 'Interpretei isso como um pedido de agendamento. Confirma?',
    requiresConfirmation: true,
    event: {
      summary: summary || 'Evento do WhatsApp',
      description: text,
      startDateTime: dateParts.startDateTime,
      endDateTime: dateParts.endDateTime,
      location: '',
      locationSuggestion: '',
      timeZone: process.env.DEFAULT_TIMEZONE || 'America/Sao_Paulo',
    },
  };
}

function buildPrompt({ history, pendingAction, userText, mediaKind }) {
  const today = new Date().toISOString();
  const historyText = history.length
    ? history.map(item => `[${item.role}] ${item.content}`).join('\n')
    : '(sem historico relevante)';

  const pendingText = pendingAction ? JSON.stringify(pendingAction) : 'nenhuma confirmacao pendente';

  return [
    'Voce e um assistente de WhatsApp que conversa naturalmente, interpreta contexto e ajuda com agenda.',
    'Voce consegue interpretar texto, audio e imagem.',
    'Considere historico recente, a mensagem atual e confirmacoes pendentes.',
    'Se a mensagem for um pedido de agendamento ou trouxer informacoes de evento, produza schedule_proposal.',
    'REGRA CRITICA de horario: o horario mencionado pelo usuario e SEMPRE o startDateTime (hora de inicio). Nunca use o horario mencionado como endDateTime. O endDateTime deve ser startDateTime + duracao mencionada, ou startDateTime + 1 hora por padrao.',
    'Se a mensagem pedir informacao atual sobre futebol, jogos, amistosos, tabela ou proximo jogo, produza lookup com source football. O campo query deve conter APENAS o nome do time principal mencionado (ex: "Brazil", "Flamengo", "Real Madrid") — nunca a pergunta completa.',
    'Se a mensagem pedir fato geral, historico ou enciclopedico, produza lookup com source wiki.',
    'Se a mensagem for apenas conversa, produza chat.',
    'Responda apenas JSON valido, sem markdown.',
    'Formato:',
    '{"kind":"chat|schedule_proposal|lookup|none","reply":"texto opcional","requiresConfirmation":true|false,"event":{"summary":"","description":"","startDateTime":"","endDateTime":"","location":"","locationSuggestion":"","timeZone":""},"lookup":{"source":"football|wiki","query":"consulta objetiva","intent":"fixtures|general"}}',
    `Data atual ISO: ${today}`,
    `Historico recente:\n${historyText}`,
    `Confirmacao pendente: ${pendingText}`,
    `Tipo da entrada atual: ${mediaKind}`,
    `Texto/legenda atual: ${userText || '(vazio)'}`,
  ].join('\n');
}

async function generateJson(parts) {
  const result = await model.generateContent(parts);
  const raw = result?.response?.text?.() || '';
  return extractJsonObject(raw) || { kind: 'none', reply: '', requiresConfirmation: false };
}

async function downloadInlinePart(message) {
  if (!message?.hasMedia) return null;

  const media = await message.downloadMedia();
  if (!media?.mimetype || !media?.data) return null;

  return {
    inlineData: {
      mimeType: media.mimetype,
      data: media.data,
    },
  };
}

export async function planConversationTurn({ message, type, text, history = [], pendingAction = null }) {
  const userText = text || message?.body || '';
  const mediaKind = type || 'text';

  const parts = [buildPrompt({ history, pendingAction, userText, mediaKind })];
  if (mediaKind !== 'chat' && mediaKind !== 'text') {
    const mediaPart = await downloadInlinePart(message);
    if (mediaPart) parts.push(mediaPart);
  }

  const parsed = await generateJson(parts);
  const normalizedEvent = normalizeEvent(parsed.event, userText);

  if (parsed.kind === 'schedule_proposal' && normalizedEvent) {
    return {
      kind: 'schedule_proposal',
      reply: parsed.reply || 'Interpretei isso como um evento. Posso agendar?',
      requiresConfirmation: true,
      event: normalizedEvent,
    };
  }

  if (parsed.kind === 'lookup' && parsed.lookup?.source && parsed.lookup?.query) {
    return {
      kind: 'lookup',
      reply: parsed.reply || '',
      requiresConfirmation: false,
      lookup: {
        source: parsed.lookup.source,
        query: parsed.lookup.query,
        intent: parsed.lookup.intent || 'general',
      },
    };
  }

  if (parsed.kind === 'chat') {
    return {
      kind: 'chat',
      reply: parsed.reply || 'Nao consegui montar uma resposta adequada.',
      requiresConfirmation: false,
    };
  }

  const fallback = fallbackScheduleProposal(userText);
  if (fallback) {
    return fallback;
  }

  return {
    kind: 'chat',
    reply: parsed.reply || 'Nao consegui interpretar sua mensagem com seguranca. Pode reformular?',
    requiresConfirmation: false,
  };
}
