import { planConversationTurn } from './gemini.js';
import { createEvent, listEvents, searchEvents, deleteEvent, getUpcomingReminders, getCalendarIds, listCalendars } from './calendar.js';
import { runLookup } from './knowledge.js';
import { getConfig } from './config.js';
import { getUser, updateUserSettings } from './database.js';

const pendingActions = new Map();
const processedMessageIds = new Set();
const sentReminderIds = new Set();
const botSentBodies = new Set();
const reminderIntervals = new Map();
const pollIntervals = new Map();
const selfChatLidByUser = new Map();
const sessionStartTimes = new Map();

export function setSessionStart(userId, ts = Date.now()) {
  sessionStartTimes.set(userId, ts);
  console.log(`[bot:${userId}] sessao iniciada em ${new Date(ts).toISOString()} — mensagens anteriores serao ignoradas.`);
}

export function clearSessionStart(userId) {
  sessionStartTimes.delete(userId);
}

function userScopedKey(userId, value) {
  return `${userId}:${value}`;
}

function normalizeText(value = '') {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function detectConfirmation(text = '') {
  const normalized = normalizeText(text);
  // "sim N" ou "s N" ou "ok N" — N = numero da agenda escolhida (1..9)
  const withIndex = normalized.match(/^(sim|s|ok|confirmar|confirmo)\s+(\d+)$/);
  if (withIndex) return { decision: 'yes', calendarIndex: parseInt(withIndex[2], 10) };
  if (['sim', 's', 'confirmar', 'confirmo', 'ok', 'pode agendar', 'agendar'].includes(normalized)) return { decision: 'yes', calendarIndex: null };
  if (['nao', 'n', 'cancelar', 'cancela', 'cancelo', 'negar'].includes(normalized)) return { decision: 'no', calendarIndex: null };
  return null;
}

// Detecta resposta puramente numerica (selecao de item de uma lista oferecida pelo bot)
function detectNumericChoice(text = '') {
  const m = String(text).trim().match(/^(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

// Pega nome amigavel das agendas (cache simples em memoria por userId)
const calendarNamesCache = new Map();
async function getCalendarNameMap(userId, forceRefresh = false) {
  if (!forceRefresh && calendarNamesCache.has(userId)) return calendarNamesCache.get(userId);
  try {
    const list = await listCalendars(userId);
    const map = new Map(list.map(c => [c.id, c.summary]));
    calendarNamesCache.set(userId, map);
    setTimeout(() => calendarNamesCache.delete(userId), 5 * 60 * 1000); // expira em 5min
    return map;
  } catch { return new Map(); }
}

function shortCalendarLabel(id) {
  if (!id) return 'Agenda';
  if (id === 'primary') return 'Agenda principal';
  if (id.includes('@group.calendar.google.com')) return 'Agenda compartilhada';
  return id; // ex: e-mail pessoal
}

async function formatCalendarOptions(userId) {
  const ids = await getCalendarIds(userId);
  if (ids.length <= 1) return null;
  let names = await getCalendarNameMap(userId);
  if (ids.some(id => !names.get(id))) {
    names = await getCalendarNameMap(userId, true);
  }
  const lines = ids.map((id, i) => `${i + 1}. ${names.get(id) || shortCalendarLabel(id)}`);
  return { ids, text: lines.join('\n') };
}

function formatDateOnly(dateValue, timeZone) {
  // Ex: "qui, 25/05/26"
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  }).formatToParts(new Date(dateValue));
  const get = (type) => parts.find(p => p.type === type)?.value || '';
  const weekday = get('weekday').replace('.', ''); // "qui." -> "qui"
  return `${weekday}, ${get('day')}/${get('month')}/${get('year')}`;
}

function formatTimeOnly(dateValue, timeZone) {
  return new Intl.DateTimeFormat('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(dateValue));
}

function getTimeZone() {
  return getConfig().DEFAULT_TIMEZONE || 'America/Sao_Paulo';
}

async function getAssistantChatId(userId) {
  const user = await getUser(userId);
  return user?.assistant_chat_id || '';
}

export async function hydrateSelfChatLidFromDb(userId) {
  const user = await getUser(userId);
  if (user?.self_chat_lid) {
    selfChatLidByUser.set(userId, user.self_chat_lid);
    console.log(`[bot:${userId}] LID self-chat carregado do banco: ${user.self_chat_lid}`);
  }
}

function formatSingleEvent(event) {
  const timeZone = event.timeZone || getTimeZone();
  const lines = [
    'Mensagem de confirmacao:',
    `Evento: ${event.summary}`,
    `Data: ${formatDateOnly(event.startDateTime, timeZone)}`,
    `Hora inicio: ${formatTimeOnly(event.startDateTime, timeZone)}`,
    `Hora termino: ${formatTimeOnly(event.endDateTime, timeZone)}`,
  ];
  if (event.location) lines.push(`Local: ${event.location}`);
  if (event.locationSuggestion) lines.push(`Sugestao de endereco: ${event.locationSuggestion}`);
  if (event.description && event.description !== event.summary) lines.push(`Descricao: ${event.description}`);
  return lines.join('\n');
}

async function formatPendingActionForConfirmation(pendingAction, userId) {
  const opts = userId ? await formatCalendarOptions(userId) : null;
  const tail = opts
    ? `\n\nEm qual agenda?\n${opts.text}\n\nResponda "sim N" (ex: "sim 1") ou "nao" para cancelar.`
    : `\nEsta correto? Responda "sim" para agendar ou "nao" para cancelar.`;

  if (pendingAction?.type === 'multiple_events') {
    const lines = ['Eventos para confirmar:'];
    pendingAction.events.forEach((event, index) => {
      const timeZone = event.timeZone || getTimeZone();
      lines.push(`${index + 1}. ${event.summary} - ${formatDateOnly(event.startDateTime, timeZone)} ${formatTimeOnly(event.startDateTime, timeZone)}`);
    });
    return lines.join('\n') + tail;
  }
  if (pendingAction?.type === 'single_event' && pendingAction.event) {
    return `${formatSingleEvent(pendingAction.event)}${tail}`;
  }
  return opts
    ? `Em qual agenda?\n${opts.text}\n\nResponda "sim N" ou "nao" para cancelar.`
    : 'Responda "sim" para confirmar ou "nao" para cancelar.';
}

function formatLongWeekday(dateValue, timeZone) {
  const parts = new Intl.DateTimeFormat('pt-BR', { timeZone, weekday: 'long' }).formatToParts(new Date(dateValue));
  const w = parts.find(p => p.type === 'weekday')?.value || '';
  const first = w.split('-')[0]; // "segunda-feira" -> "segunda"
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function formatShortDate(dateValue, timeZone) {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone, day: '2-digit', month: '2-digit', year: '2-digit',
  }).formatToParts(new Date(dateValue));
  const get = (type) => parts.find(p => p.type === type)?.value || '';
  return `${get('day')}/${get('month')}/${get('year')}`;
}

function getDayKey(dateValue, timeZone) {
  // Chave ISO local pra agrupar (ex: "2026-05-25" no fuso do usuario)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(dateValue));
  const get = (type) => parts.find(p => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Lista numerada por evento (nao agrupada por dia) — usada quando precisa de selecao por numero
function formatNumberedEvents(events, timeZone) {
  return events.map((e, i) => {
    const start = e.start?.dateTime || e.start?.date;
    const weekday = formatLongWeekday(start, timeZone);
    const date = formatShortDate(start, timeZone);
    const time = e.start?.dateTime ? formatTimeOnly(start, timeZone) : 'dia inteiro';
    return `${i + 1}. ${e.summary} — ${weekday} ${date} ${time}`;
  }).join('\n');
}

function formatEventsList(events, timeZone) {
  if (!events.length) return 'Nenhum evento encontrado.';

  // Agrupa por dia
  const byDay = new Map();
  for (const e of events) {
    const start = e.start?.dateTime || e.start?.date;
    if (!start) continue;
    const key = getDayKey(start, timeZone);
    if (!byDay.has(key)) byDay.set(key, { firstStart: start, events: [] });
    byDay.get(key).events.push(e);
  }

  // Dias em ordem cronologica
  const days = Array.from(byDay.entries()).sort(([a], [b]) => a.localeCompare(b));

  return days.map(([, { firstStart, events: dayEvents }], i) => {
    const weekday = formatLongWeekday(firstStart, timeZone);
    const shortDate = formatShortDate(firstStart, timeZone);

    // Eventos do dia ordenados por hora de inicio
    const sorted = dayEvents.slice().sort((a, b) => {
      const sa = a.start?.dateTime || a.start?.date || '';
      const sb = b.start?.dateTime || b.start?.date || '';
      return sa.localeCompare(sb);
    });

    const lines = sorted.map(e => {
      const start = e.start?.dateTime || e.start?.date;
      if (e.start?.dateTime) {
        return `- ${formatTimeOnly(start, timeZone)} ${e.summary}`;
      }
      return `- ${e.summary} (dia inteiro)`;
    }).join('\n');

    return `${i + 1}. ${weekday} ${shortDate}\n${lines}`;
  }).join('\n\n');
}

function getPeriodRange(period, startDate, endDate) {
  const now = new Date();
  if (period === 'today') {
    const start = new Date(now); start.setSeconds(0, 0);
    const end = new Date(now); end.setHours(23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (period === 'tomorrow') {
    const start = new Date(now); start.setDate(start.getDate() + 1); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setHours(23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (period === 'this_week') {
    const start = new Date(now); start.setSeconds(0, 0);
    const end = new Date(now); end.setDate(end.getDate() + 7); end.setHours(23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (period === 'date_range' && startDate && endDate) {
    return { start: new Date(startDate).toISOString(), end: new Date(endDate).toISOString() };
  }
  const start = new Date(now); start.setSeconds(0, 0);
  const end = new Date(now); end.setHours(23, 59, 59, 999);
  return { start: start.toISOString(), end: end.toISOString() };
}

function trackProcessedMessage(userId, message) {
  const id = message?.id?._serialized;
  if (!id) return false;
  const key = userScopedKey(userId, id);
  if (processedMessageIds.has(key)) return true;
  processedMessageIds.add(key);
  if (processedMessageIds.size > 1000) {
    const first = processedMessageIds.values().next().value;
    if (first) processedMessageIds.delete(first);
  }
  return false;
}

function trackBotSentBody(userId, text) {
  if (!text) return;
  botSentBodies.add(userScopedKey(userId, text));
  if (botSentBodies.size > 200) {
    const first = botSentBodies.values().next().value;
    if (first) botSentBodies.delete(first);
  }
}

async function getRecentHistory(userId, chat, currentMessageId) {
  try {
    const messages = await chat.fetchMessages({ limit: 8 });
    return messages
      .filter(item => item?.id?._serialized !== currentMessageId)
      .filter(item => (item.body || '').trim() || item.hasMedia)
      .slice(-6)
      .map(item => ({
        role: (item.fromMe && botSentBodies.has(userScopedKey(userId, item.body))) ? 'assistant' : 'user',
        content: item.body || `[${item.type || 'midia'}]`,
      }));
  } catch (error) {
    console.warn('Nao foi possivel buscar historico recente:', error?.message || error);
    return [];
  }
}

async function replyToMessage(userId, client, message, text) {
  if (!text) return;
  const CHAT_ID = await getAssistantChatId(userId);
  if (!CHAT_ID) return;
  try {
    trackBotSentBody(userId, text);
    await client.sendMessage(CHAT_ID, text);
  } catch (error) {
    console.error('Falha ao enviar mensagem via sendMessage:', error?.message);
    try {
      await message.reply(text);
    } catch (err2) {
      console.error('Falha tambem no fallback reply:', err2?.message);
    }
  }
}

async function createMultipleEvents(events, userId, calendarId) {
  const created = [];
  for (const event of events) {
    const result = await createEvent(event, userId, calendarId);
    if (result?.id) created.push({ id: result.id, summary: event.summary });
  }
  return created;
}

function normalizeTitle(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

async function cancelPreviousByQuery(userId, query) {
  try {
    const results = await searchEvents(query, 60, userId);
    const target = normalizeTitle(query);
    const tenMinAgo = Date.now() - 30 * 60 * 1000;
    const matches = results.filter(e => {
      if (normalizeTitle(e.summary) !== target) return false;
      const createdMs = e.created ? new Date(e.created).getTime() : 0;
      return createdMs >= tenMinAgo;
    });
    let lastSummary = '';
    for (const ev of matches) {
      try {
        await deleteEvent(ev.id, userId, ev.calendarId);
        lastSummary = ev.summary;
      } catch (err) {
        console.warn('[bot] Falha ao cancelar evento anterior:', err?.message || err);
      }
    }
    return lastSummary;
  } catch (err) {
    console.warn('[bot] Falha ao buscar evento anterior para cancelar:', err?.message || err);
    return '';
  }
}

async function handlePendingConfirmation(userId, client, message, chatId, confirmation) {
  const pendingKey = userScopedKey(userId, chatId);
  const pending = pendingActions.get(pendingKey);
  if (!pending) return false;

  const decision = confirmation?.decision || confirmation; // compat
  const calendarIndex = confirmation?.calendarIndex ?? null;

  if (decision === 'no') {
    pendingActions.delete(pendingKey);
    await replyToMessage(userId, client, message, 'Agendamento cancelado.');
    return true;
  }

  try {
    if (pending.type === 'cancel_event') {
      await deleteEvent(pending.eventId, userId, pending.calendarId);
      pendingActions.delete(pendingKey);
      await replyToMessage(userId, client, message, `Evento "${pending.summary}" cancelado com sucesso.`);
      return true;
    }

    let replacedSummary = '';
    if (pending.replacePreviousQuery && (pending.type === 'single_event' || pending.type === 'multiple_events')) {
      replacedSummary = await cancelPreviousByQuery(userId, pending.replacePreviousQuery);
    }

    if (pending.type === 'multiple_events') {
      // Para multiplos eventos, usa default ou o indice escolhido pra TODOS
      const calendarIds = await getCalendarIds(userId);
      let targetCalendarId = null;
      if (calendarIds.length > 1) {
        if (!calendarIndex) {
          // Pede pra escolher
          const opts = await formatCalendarOptions(userId);
          await replyToMessage(userId, client, message, `Voce tem ${calendarIds.length} agendas. Responda novamente com o numero da agenda desejada para TODOS os eventos:\n${opts.text}\n\nEx: "sim 1"`);
          return true;
        }
        targetCalendarId = calendarIds[calendarIndex - 1];
        if (!targetCalendarId) {
          await replyToMessage(userId, client, message, `Numero ${calendarIndex} fora do intervalo. Responda com 1 a ${calendarIds.length}.`);
          return true;
        }
      }
      const created = await createMultipleEvents(pending.events || [], userId, targetCalendarId);
      pendingActions.delete(pendingKey);
      if (created.length) {
        const summary = created.map(item => `- ${item.summary}`).join('\n');
        const prefix = replacedSummary ? `Cancelei "${replacedSummary}" e agendei a versao corrigida:\n` : 'Eventos agendados com sucesso:\n';
        await replyToMessage(userId, client, message, `${prefix}${summary}`);
        return true;
      }
      await replyToMessage(userId, client, message, 'Nao consegui criar os eventos no Google Calendar.');
      return true;
    }

    // Single event: se ha >1 agenda e usuario nao escolheu, pede
    const calendarIds = await getCalendarIds(userId);
    let targetCalendarId = null;
    if (calendarIds.length > 1) {
      if (!calendarIndex) {
        const opts = await formatCalendarOptions(userId);
        await replyToMessage(userId, client, message, `Voce tem ${calendarIds.length} agendas. Responda novamente com o numero da agenda desejada:\n${opts.text}\n\nEx: "sim 1"`);
        return true;
      }
      targetCalendarId = calendarIds[calendarIndex - 1];
      if (!targetCalendarId) {
        await replyToMessage(userId, client, message, `Numero ${calendarIndex} fora do intervalo. Responda com 1 a ${calendarIds.length}.`);
        return true;
      }
    }

    const created = await createEvent(pending.event, userId, targetCalendarId);
    pendingActions.delete(pendingKey);
    if (created?.id) {
      const msg = replacedSummary
        ? `Cancelei "${replacedSummary}" e agendei a versao corrigida: ${pending.event.summary}.`
        : `Evento agendado com sucesso: ${pending.event.summary}.`;
      await replyToMessage(userId, client, message, msg);
      return true;
    }
    await replyToMessage(userId, client, message, 'Nao consegui criar o evento no Google Calendar.');
    return true;
  } catch (error) {
    console.error('Erro ao criar evento confirmado:', error?.response?.data || error);
    const friendly = friendlyCalendarError(error);
    await replyToMessage(userId, client, message, friendly);
    return true;
  }
}

function friendlyCalendarError(error) {
  const status = error?.code || error?.response?.status;
  const gErr = error?.response?.data?.error;
  const reason = gErr?.errors?.[0]?.reason || '';
  const msg = gErr?.message || error?.message || '';

  if (status === 401 || /invalid_grant|invalid_token/i.test(msg)) {
    return 'A conexao com o Google Calendar expirou. Abra o painel de setup e clique novamente em "Conectar Google".';
  }
  if (status === 403) {
    if (/quota|rateLimit|userRateLimit/i.test(reason)) {
      return 'Limite de uso do Google Calendar atingido. Tente novamente em alguns minutos.';
    }
    return 'Sem permissao para escrever nessa agenda. Verifique se a agenda escolhida permite que voce crie eventos.';
  }
  if (status === 404) {
    return 'Agenda nao encontrada. Ela pode ter sido removida da sua conta — atualize a selecao no painel de setup.';
  }
  if (status === 400) {
    return `Os dados do evento foram recusados pelo Google${msg ? ` (${msg})` : ''}. Tente reformular a mensagem com data e hora claras.`;
  }
  if (msg) return `Nao consegui criar o evento. Motivo: ${msg}.`;
  return 'Nao consegui criar o evento no Google Calendar. Tente novamente em instantes.';
}

// Processa selecao numerica quando ha uma lista pendente (ex: "Encontrei 2 eventos. Responda 1 ou 2")
async function handlePendingChoice(userId, client, message, chatId, index) {
  const pendingKey = userScopedKey(userId, chatId);
  const pending = pendingActions.get(pendingKey);
  if (!pending || pending.type !== 'choice') return false;

  const choice = pending.choices?.[index - 1];
  if (!choice) {
    await replyToMessage(userId, client, message, `Numero ${index} fora do intervalo. Tente entre 1 e ${pending.choices?.length || 0}.`);
    return true;
  }

  if (pending.action === 'cancel') {
    // Promove para um cancel_event pendente de confirmacao "sim/nao"
    const timeZone = getTimeZone();
    const next = { type: 'cancel_event', eventId: choice.eventId, calendarId: choice.calendarId, summary: choice.summary, createdAt: Date.now() };
    pendingActions.set(pendingKey, next);
    const start = choice.start;
    const timeStr = start && start.includes('T') ? formatTimeOnly(start, timeZone) : '';
    await replyToMessage(
      userId, client, message,
      `Quer cancelar "${choice.summary}" (${formatDateOnly(start, timeZone)}${timeStr ? ' ' + timeStr : ''})?\nResponda "sim" para confirmar ou "nao" para cancelar.`
    );
    return true;
  }

  return false;
}

export async function processIncomingMessage(userId, client, message) {
  // Verifica self-chat ANTES do dedup (evita adicionar ID e bloquear polling depois)
  let chat;
  try {
    chat = await message.getChat();
  } catch {
    return;
  }

  const rawChatId = chat?.id?._serialized || '';
  const CHAT_ID = await getAssistantChatId(userId);
  const selfLid = selfChatLidByUser.get(userId);
  const isSelfChat = rawChatId === CHAT_ID || (selfLid && rawChatId === selfLid);
  if (!isSelfChat) return;

  // Ignora mensagens enviadas ANTES da sessao atual ficar pronta
  // (evita que retomar de pausa reprocesse mensagens do periodo offline).
  const sessionStart = sessionStartTimes.get(userId);
  if (sessionStart && message.timestamp) {
    const msgTs = message.timestamp * 1000;
    if (msgTs < sessionStart) return;
  }

  // Normaliza para CHAT_ID em todos os usos downstream (pendingActions, replies, etc.)
  const chatId = CHAT_ID;

  if (trackProcessedMessage(userId, message)) return;

  if (message.fromMe && message.body && botSentBodies.has(userScopedKey(userId, message.body))) {
    botSentBodies.delete(userScopedKey(userId, message.body));
    return;
  }

  const body = message.body || '';
  console.log(`[bot:${userId}] Mensagem recebida:`, { chatId, body: body.slice(0, 80) });

  // Se ha uma lista pendente de escolha e o user respondeu so um numero, processa selecao
  const choiceIdx = detectNumericChoice(body);
  if (choiceIdx && await handlePendingChoice(userId, client, message, chatId, choiceIdx)) return;

  const confirmation = detectConfirmation(body);
  if (confirmation && await handlePendingConfirmation(userId, client, message, chatId, confirmation)) return;

  const pendingKey = userScopedKey(userId, chatId);
  const history = await getRecentHistory(userId, chat, message?.id?._serialized);
  const pendingAction = pendingActions.get(pendingKey) || null;
  const plan = await planConversationTurn({ message, type: message.type, text: body, history, pendingAction });

  console.log(`[bot:${userId}] Plano Gemini:`, plan.kind, plan.reply?.slice(0, 60));

  if (plan.kind === 'schedule_proposal' && plan.event) {
    const nextPendingAction = {
      type: 'single_event',
      event: plan.event,
      replacePreviousQuery: plan.replacePreviousQuery || '',
      createdAt: Date.now(),
    };
    pendingActions.set(pendingKey, nextPendingAction);
    const confirmText = await formatPendingActionForConfirmation(nextPendingAction, userId);
    const responseText = plan.reply ? `${plan.reply}\n\n${confirmText}` : confirmText;
    await replyToMessage(userId, client, message, responseText);
    return;
  }

  if (plan.kind === 'multiple_events' && Array.isArray(plan.events) && plan.events.length) {
    const nextPendingAction = {
      type: 'multiple_events',
      events: plan.events,
      replacePreviousQuery: plan.replacePreviousQuery || '',
      createdAt: Date.now(),
    };
    pendingActions.set(pendingKey, nextPendingAction);
    const confirmText = await formatPendingActionForConfirmation(nextPendingAction, userId);
    const responseText = plan.reply ? `${plan.reply}\n\n${confirmText}` : confirmText;
    await replyToMessage(userId, client, message, responseText);
    return;
  }

  if (plan.kind === 'list_events' && plan.list_events) {
    try {
      const timeZone = getTimeZone();
      const { start, end } = getPeriodRange(plan.list_events.period, plan.list_events.startDate, plan.list_events.endDate);
      const events = await listEvents(start, end, userId);
      await replyToMessage(userId, client, message, formatEventsList(events, timeZone));
    } catch (error) {
      console.error('Erro ao listar eventos:', error);
      await replyToMessage(userId, client, message, 'Nao consegui consultar sua agenda agora.');
    }
    return;
  }

  if (plan.kind === 'cancel_event' && plan.cancel_event?.query) {
    try {
      const rawQuery = plan.cancel_event.query;
      // Tira data/hora que o Gemini possa ter colocado no query indevidamente (defensivo)
      const cleanQuery = rawQuery
        .replace(/\b\d{1,2}[\/-]\d{1,2}([\/-]\d{2,4})?\b/g, ' ')   // datas
        .replace(/\b\d{1,2}:\d{2}h?\b/g, ' ')                       // horas
        .replace(/\b(sabado|domingo|segunda|terca|quarta|quinta|sexta|hoje|amanha|semana|mes|proximo|proxima)\b/gi, ' ')
        .replace(/\b(no|na|do|da|de|o|a|os|as|um|uma)\b/gi, ' ')
        .replace(/\s+/g, ' ').trim();

      const queryNorm = normalizeText(cleanQuery);
      const matchesQuery = (e) => {
        if (!queryNorm) return true;
        const hay = normalizeText([e.summary, e.description, e.location].filter(Boolean).join(' '));
        return hay.includes(queryNorm);
      };

      let events = [];

      // Estrategia 1: se ha period, lista a janela e filtra LOCALMENTE
      // (mais confiavel que a busca textual do Google que erra com acentos)
      if (plan.cancel_event.period) {
        const { start: periodStart, end: periodEnd } = getPeriodRange(
          plan.cancel_event.period,
          plan.cancel_event.startDate,
          plan.cancel_event.endDate
        );
        const inWindow = await listEvents(periodStart, periodEnd, userId);
        events = inWindow.filter(matchesQuery);
      }

      // Estrategia 2: sem period (ou filtro local da janela nao achou nada) — busca textual ampla
      if (!events.length) {
        let broad = await searchEvents(cleanQuery, 60, userId);
        if (!broad.length && cleanQuery !== rawQuery) broad = await searchEvents(rawQuery, 60, userId);
        if (!broad.length) {
          const firstWord = cleanQuery.split(' ')[0];
          if (firstWord && firstWord !== cleanQuery) broad = await searchEvents(firstWord, 60, userId);
        }
        // Mesmo no fallback, se period foi pedido, respeita
        if (broad.length && plan.cancel_event.period) {
          const { start: periodStart, end: periodEnd } = getPeriodRange(
            plan.cancel_event.period,
            plan.cancel_event.startDate,
            plan.cancel_event.endDate
          );
          const startMs = new Date(periodStart).getTime();
          const endMs = new Date(periodEnd).getTime();
          broad = broad.filter(e => {
            const ts = new Date(e.start?.dateTime || e.start?.date).getTime();
            return ts >= startMs && ts <= endMs;
          });
        }
        events = broad;
      }

      if (!events.length) {
        await replyToMessage(userId, client, message, `Nao encontrei nenhum evento com "${cleanQuery}".`);
        return;
      }

      const timeZone = getTimeZone();
      if (events.length === 1) {
        const e = events[0];
        const nextPendingAction = { type: 'cancel_event', eventId: e.id, calendarId: e.calendarId, summary: e.summary, createdAt: Date.now() };
        pendingActions.set(pendingKey, nextPendingAction);
        const start = e.start?.dateTime || e.start?.date;
        await replyToMessage(
          userId,
          client,
          message,
          `Quer cancelar "${e.summary}" (${formatDateOnly(start, timeZone)} ${e.start?.dateTime ? formatTimeOnly(start, timeZone) : ''})?\nResponda "sim" para confirmar ou "nao" para cancelar.`
        );
        return;
      }

      // Multiplos eventos: salva como pending choice e pede numero
      const choices = events.map(e => ({
        eventId: e.id, calendarId: e.calendarId, summary: e.summary,
        start: e.start?.dateTime || e.start?.date,
      }));
      pendingActions.set(pendingKey, { type: 'choice', action: 'cancel', choices, createdAt: Date.now() });
      await replyToMessage(userId, client, message, `Encontrei ${events.length} eventos. Responda apenas o numero do que deseja cancelar:\n${formatNumberedEvents(events, timeZone)}`);
    } catch (error) {
      console.error('Erro ao buscar eventos para cancelar:', error);
      await replyToMessage(userId, client, message, 'Nao consegui buscar o evento para cancelar.');
    }
    return;
  }

  if (plan.kind === 'lookup' && plan.lookup) {
    try {
      const lookupResult = await runLookup(plan.lookup, userId);
      if (lookupResult.pendingAction) {
        pendingActions.set(pendingKey, lookupResult.pendingAction);
        const confirmText = await formatPendingActionForConfirmation(lookupResult.pendingAction, userId);
        await replyToMessage(userId, client, message, `${lookupResult.reply}\n\n${confirmText}`);
        return;
      }
      await replyToMessage(userId, client, message, lookupResult.reply);
      return;
    } catch (error) {
      console.error('Erro em lookup externo:', error);
      await replyToMessage(userId, client, message, `Nao consegui consultar a fonte externa agora. ${error.message}`);
      return;
    }
  }

  await replyToMessage(userId, client, message, plan.reply || 'Nao consegui interpretar sua mensagem.');
}

export function startReminderLoop(userId, client) {
  if (reminderIntervals.has(userId)) return;

  const REMINDER_MINUTES = parseInt(getConfig().REMINDER_MINUTES || '15', 10);

  const interval = setInterval(async () => {
    try {
      const CHAT_ID = await getAssistantChatId(userId);
      if (!CHAT_ID) return;

      const upcoming = await getUpcomingReminders(REMINDER_MINUTES, userId);
      for (const event of upcoming) {
        const reminderKey = userScopedKey(userId, event.id);
        if (!event.id || sentReminderIds.has(reminderKey)) continue;
        const start = event.start?.dateTime;
        const minutesLeft = Math.round((new Date(start) - Date.now()) / 60000);
        if (minutesLeft < 0) continue;
        sentReminderIds.add(reminderKey);
        if (sentReminderIds.size > 400) {
          const first = sentReminderIds.values().next().value;
          sentReminderIds.delete(first);
        }
        const timeZone = getTimeZone();
        const msg = `Lembrete: *${event.summary}* em ${minutesLeft} minuto${minutesLeft !== 1 ? 's' : ''} (${formatTimeOnly(start, timeZone)})${event.location ? `\nLocal: ${event.location}` : ''}`;
        try {
          trackBotSentBody(userId, msg);
          await client.sendMessage(CHAT_ID, msg);
        } catch (err) {
          console.error(`[reminder:${userId}] Falha ao enviar lembrete:`, err?.message);
        }
      }
    } catch (error) {
      console.warn(`[reminder:${userId}] Erro ao checar lembretes:`, error?.message);
    }
  }, 60 * 1000);

  reminderIntervals.set(userId, interval);
}

export function stopReminderLoop(userId) {
  const interval = reminderIntervals.get(userId);
  if (!interval) return;
  clearInterval(interval);
  reminderIntervals.delete(userId);
}

// Polling de mensagens — workaround para message_create não disparar no self-chat
// em modo multi-device do whatsapp-web.js.
// Acessa o store interno do WA via pupPage.evaluate() porque getChats() não expõe
// o self-chat (Mensagens Salvas) no modo multi-device (@lid).
export function startSelfChatPolling(userId, client) {
  if (pollIntervals.has(userId)) return;

  // Comeca a partir do instante atual: ignora mensagens da janela offline anterior
  let lastSeenTs = sessionStartTimes.get(userId) || Date.now();

  // Acessa o self-chat no modo multi-device.
  // O Mensagens Salvas usa o LID do próprio usuário como chat ID (não @c.us).
  // Descobrimos o LID dinamicamente a partir de qualquer mensagem fromMe.
  const fetchFromStore = async () => {
    return client.pupPage.evaluate(async () => {
      try {
        const Store = window.Store;
        const allMsgs = Store.Msg?.getModelsArray?.() || [];

        // Descobre o LID do próprio usuário a partir de uma fromMe message
        const fromMeMsg = allMsgs.find(m => m.id?.fromMe && m.from?._serialized?.endsWith('@lid'));
        const userLid = fromMeMsg?.from?._serialized;

        if (!userLid) {
          return { error: 'LID do usuario nao encontrado em Store.Msg' };
        }

        // Self-chat REAL: mensagens cujo remote === user LID
        const selfChatMsgs = allMsgs.filter(m => m.id?.remote?._serialized === userLid);

        // Tenta achar o chat via Chat.find com o LID
        let chat = null;
        try {
          const wid = Store.WidFactory.createWid(userLid);
          chat = await Store.Chat.find(wid);
        } catch {}

        const chatMsgs = chat?.msgs?.getModelsArray?.() || [];

        // Usa a fonte que tiver mais mensagens
        const useMsgs = chatMsgs.length >= selfChatMsgs.length ? chatMsgs : selfChatMsgs;
        const recent = useMsgs.slice(-15);

        return {
          chatId: chat?.id?._serialized || userLid,
          userLid,
          chatMsgsCount: chatMsgs.length,
          selfChatMsgsInStore: selfChatMsgs.length,
          totalStoreMsgs: allMsgs.length,
          messages: recent.map(m => ({
            id: m.id?._serialized || '',
            body: m.body || '',
            timestamp: m.t || 0,
            fromMe: m.id?.fromMe ?? false,
            type: m.type || 'chat',
            hasMedia: !!(m.mediaData || m.isMedia || (m.type && ['audio', 'ptt', 'image', 'video', 'document', 'sticker'].includes(m.type))),
          })),
        };
      } catch (e) {
        return { error: e.message };
      }
    });
  };

  const updateUserLid = (result) => {
    if (result?.userLid && selfChatLidByUser.get(userId) !== result.userLid) {
      selfChatLidByUser.set(userId, result.userLid);
      console.log(`[poll:${userId}] LID do self-chat registrado: ${result.userLid}`);
      updateUserSettings(userId, { selfChatLid: result.userLid }).catch(err => {
        console.warn(`[poll:${userId}] Falha ao persistir LID:`, err?.message);
      });
    }
  };

  const interval = setInterval(async () => {
    try {
      const CHAT_ID = await getAssistantChatId(userId);
      if (!CHAT_ID) return;

      const result = await fetchFromStore();

      if (!result?.chatId) {
        return;
      }

      updateUserLid(result);
      const rawMessages = result.messages;

      for (const raw of rawMessages) {
        const msgTs = raw.timestamp * 1000;
        if (msgTs <= lastSeenTs) continue;
        if (raw.fromMe && botSentBodies.has(userScopedKey(userId, raw.body))) continue;

        console.log(`[poll:${userId}] Nova mensagem: fromMe=${raw.fromMe} type=${raw.type} hasMedia=${raw.hasMedia} body="${raw.body?.slice(0, 60)}"`);

        // Mensagens com mídia (áudio, imagem, video) precisam do downloadMedia funcional.
        // O objeto sintético não tem isso, então busca o Message real via getMessageById.
        if (raw.hasMedia) {
          try {
            const realMessage = await client.getMessageById(raw.id);
            if (realMessage) {
              // Patch getChat para devolver o CHAT_ID do banco (evita o problema @lid vs @c.us)
              const origGetChat = realMessage.getChat?.bind(realMessage);
              realMessage.getChat = async () => {
                try { return await origGetChat?.(); }
                catch {
                  return {
                    id: { _serialized: CHAT_ID },
                    fetchMessages: async ({ limit = 8 } = {}) =>
                      rawMessages.slice(-limit).map(m => ({
                        id: { _serialized: m.id }, fromMe: m.fromMe, body: m.body,
                        type: m.type || 'chat', hasMedia: !!m.hasMedia,
                      })),
                  };
                }
              };
              await processIncomingMessage(userId, client, realMessage);
              continue;
            }
            console.warn(`[poll:${userId}] getMessageById retornou null para ${raw.id}, fazendo fallback`);
          } catch (err) {
            console.warn(`[poll:${userId}] getMessageById falhou (${err?.message}), fazendo fallback synthetic`);
          }
        }

        // Texto puro (ou fallback se getMessageById falhou): objeto sintético leve.
        const rawHistory = rawMessages;
        const syntheticMessage = {
          id: { _serialized: raw.id },
          fromMe: raw.fromMe,
          body: raw.body,
          type: raw.type || 'chat',
          timestamp: raw.timestamp,
          hasMedia: false,
          getChat: async () => ({
            id: { _serialized: CHAT_ID },
            fetchMessages: async ({ limit = 8 } = {}) =>
              rawHistory.slice(-limit).map(m => ({
                id: { _serialized: m.id },
                fromMe: m.fromMe,
                body: m.body,
                type: m.type || 'chat',
                hasMedia: false,
              })),
          }),
          reply: async (text) => client.sendMessage(CHAT_ID, text),
        };

        await processIncomingMessage(userId, client, syntheticMessage);
      }

      if (rawMessages.length > 0) {
        const maxTs = Math.max(...rawMessages.map(m => m.timestamp * 1000));
        if (maxTs > lastSeenTs) lastSeenTs = maxTs;
      }
    } catch (err) {
      console.warn(`[poll:${userId}] Erro:`, err?.message);
    }
  }, 4000);

  pollIntervals.set(userId, interval);
  console.log(`[poll:${userId}] Polling de self-chat iniciado (4s).`);
}

export function stopSelfChatPolling(userId) {
  const interval = pollIntervals.get(userId);
  if (!interval) return;
  clearInterval(interval);
  pollIntervals.delete(userId);
}
