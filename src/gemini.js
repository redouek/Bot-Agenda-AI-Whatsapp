import { GoogleGenerativeAI } from '@google/generative-ai';
import { getConfig } from './config.js';

let _aiClient = null;
let _model = null;
let _cachedApiKey = null;

function getModel() {
  const { GOOGLE_API_KEY, GEMINI_MODEL } = getConfig();
  const modelName = GEMINI_MODEL || 'models/gemini-flash-latest';

  if (!GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY não configurado. Acesse o painel de setup.');

  if (_model && _cachedApiKey === GOOGLE_API_KEY) return _model;

  _aiClient = new GoogleGenerativeAI(GOOGLE_API_KEY);
  _model = _aiClient.getGenerativeModel({ model: modelName });
  _cachedApiKey = GOOGLE_API_KEY;
  return _model;
}

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

  const now = Date.now();
  const startMs = new Date(startDateTime).getTime();
  const endMs = new Date(endDateTime).getTime();
  if (startMs < now && endMs > now && endMs > startMs) {
    startDateTime = endDateTime;
    endDateTime = new Date(endMs + 60 * 60 * 1000).toISOString();
  }

  const timeZone = getConfig().DEFAULT_TIMEZONE || 'America/Sao_Paulo';

  return {
    summary: event.summary,
    description: event.description || fallbackText || event.summary,
    startDateTime,
    endDateTime: new Date(endDateTime) > new Date(startDateTime)
      ? endDateTime
      : new Date(new Date(startDateTime).getTime() + 60 * 60 * 1000).toISOString(),
    location: event.location || '',
    locationSuggestion: event.locationSuggestion || '',
    timeZone: event.timeZone || timeZone,
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
      timeZone: getConfig().DEFAULT_TIMEZONE || 'America/Sao_Paulo',
    },
  };
}

function buildPrompt({ history, pendingAction, userText, mediaKind }) {
  const timeZone = getConfig().DEFAULT_TIMEZONE || 'America/Sao_Paulo';
  const now = new Date();
  const todayLocal = now.toLocaleString('pt-BR', { timeZone, hour12: false })
    + ` (${timeZone}, UTC-3)`;

  const historyText = history.length
    ? history.map(item => `[${item.role}] ${item.content}`).join('\n')
    : '(sem historico relevante)';

  const pendingText = pendingAction ? JSON.stringify(pendingAction) : 'nenhuma confirmacao pendente';

  return [
    'Voce e um assistente de WhatsApp que conversa naturalmente, interpreta contexto e ajuda com agenda.',
    'CAPACIDADES: voce TEM acesso ao Google Calendar do usuario (todas as agendas selecionadas) via API. NUNCA diga "nao tenho acesso a sua agenda" ou similar. Se uma busca anterior nao achou algo, ofereca tentar de novo de outra forma ou pedir mais detalhes — nao negue capacidade.',
    'Voce consegue interpretar texto, audio e imagem. Quando vier audio, transcreva mentalmente o conteudo e siga o mesmo fluxo de um texto. Quando vier imagem (ex: foto de convite/cartaz), extraia titulo, data, hora, local e descricao se possivel.',
    'Considere historico recente, a mensagem atual e confirmacoes pendentes.',
    'CONTEXTO/FOLLOW-UP: se a mensagem atual for curta ou eliptica (ex: "e de hoje?", "e amanha?", "essa semana?", "e o outro?", "as 14h", "muda pra 15h"), interprete como continuacao da ULTIMA intencao do usuario no historico. Herde o kind (list_events, schedule_proposal, etc) e ajuste apenas o que mudou (ex: "e de hoje?" apos "compromissos de amanha?" vira list_events com period="today").',
    'Para follow-ups de listagem ("e de hoje?", "e essa semana?", "e amanha?"), responda DIRETAMENTE com list_events do periodo correspondente — nao peca confirmacao nem responda "nao consegui entender".',
    'Se a mensagem for um pedido de agendamento ou trouxer informacoes de evento, produza schedule_proposal.',
    'TOM do reply em schedule_proposal: NUNCA afirme que o evento foi agendado/marcado/criado — ainda esta pendente de confirmacao do usuario. Use linguagem provisoria: "anotei", "entendi", "corrigi", "ajustei", "ok, vou propor isso". Exemplos validos: "Anotei.", "Ok, corrigi o nome para X.", "Entendi, ajustei o horario para 15h.". NUNCA escreva "agendado", "marcado", "criado", "salvo" no reply.',
    `REGRA CRITICA de fuso horario: o usuario esta em ${timeZone} (UTC-3, GMT-3). Qualquer horario mencionado pelo usuario (ex: "14:30", "as tres da tarde") esta SEMPRE nesse fuso. O startDateTime DEVE usar o offset -03:00 (ex: "2026-03-25T14:30:00-03:00"). NUNCA trate horarios do usuario como UTC.`,
    'REGRA CRITICA de horario: o horario mencionado pelo usuario e SEMPRE o startDateTime (hora de inicio). Nunca use o horario mencionado como endDateTime. O endDateTime deve ser startDateTime + duracao mencionada, ou startDateTime + 1 hora por padrao.',
    'Para eventos recorrentes (ex: "toda segunda", "todo dia", "toda semana"), adicione o campo recurrence no evento com a regra RRULE (ex: ["RRULE:FREQ=WEEKLY;BYDAY=MO"]).',
    'Se a mensagem pedir para ver agenda, compromissos, o que tem marcado, produza list_events com period = "today", "tomorrow", "this_week" ou "date_range" (com startDate e endDate em ISO).',
    'Se a mensagem pedir para cancelar, deletar ou remover um evento, produza cancel_event. O campo query DEVE conter APENAS palavras-chave do nome/descricao do evento (ex: "almoco", "Bovinus", "dentista"). NUNCA inclua datas, horarios ou referencias temporais ("amanha", "hoje", "21/05") no query. Quando o usuario mencionar contexto temporal, coloque essa informacao em period ("today", "tomorrow", "this_week" ou "date_range" com startDate/endDate em ISO). Ex: "cancela o almoço de amanha" -> cancel_event: { query: "almoco", period: "tomorrow" }.',
    'Se a mensagem pedir informacao atual sobre futebol, jogos, amistosos, tabela ou proximo jogo, produza lookup com source football. O campo query deve conter APENAS o nome do time principal mencionado (ex: "Brazil", "Flamengo", "Real Madrid") — nunca a pergunta completa.',
    'Se a mensagem pedir fato geral, historico ou enciclopedico, produza lookup com source wiki.',
    'Se a mensagem for apenas conversa, produza chat.',
    'Responda apenas JSON valido, sem markdown.',
    'Formato:',
    '{"kind":"chat|schedule_proposal|list_events|cancel_event|lookup|none","reply":"texto opcional","requiresConfirmation":true|false,"event":{"summary":"","description":"","startDateTime":"","endDateTime":"","location":"","locationSuggestion":"","timeZone":"","recurrence":[]},"list_events":{"period":"today|tomorrow|this_week|date_range","startDate":"","endDate":""},"cancel_event":{"query":"palavras-chave do nome","period":"today|tomorrow|this_week|date_range","startDate":"","endDate":""},"lookup":{"source":"football|wiki","query":"consulta objetiva","intent":"fixtures|general"}}',
    `Data/hora atual: ${todayLocal}`,
    `Historico recente:\n${historyText}`,
    `Confirmacao pendente: ${pendingText}`,
    `Tipo da entrada atual: ${mediaKind}`,
    `Texto/legenda atual: ${userText || '(vazio)'}`,
  ].join('\n');
}

async function generateJson(parts) {
  const model = getModel();
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

  if (parsed.kind === 'list_events' && parsed.list_events) {
    return {
      kind: 'list_events',
      reply: parsed.reply || '',
      requiresConfirmation: false,
      list_events: parsed.list_events,
    };
  }

  if (parsed.kind === 'cancel_event' && parsed.cancel_event?.query) {
    return {
      kind: 'cancel_event',
      reply: parsed.reply || '',
      requiresConfirmation: false,
      cancel_event: parsed.cancel_event,
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
  if (fallback) return fallback;

  return {
    kind: 'chat',
    reply: parsed.reply || 'Nao consegui interpretar sua mensagem com seguranca. Pode reformular?',
    requiresConfirmation: false,
  };
}
