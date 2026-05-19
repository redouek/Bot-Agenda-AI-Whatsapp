import { planConversationTurn } from './gemini.js';
import { createEvent, listEvents, searchEvents, deleteEvent, getUpcomingReminders } from './calendar.js';
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

function userScopedKey(userId, value) {
  return `${userId}:${value}`;
}

function normalizeText(value = '') {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function detectConfirmation(text = '') {
  const normalized = normalizeText(text);
  if (['sim', 's', 'confirmar', 'confirmo', 'ok', 'pode agendar', 'agendar'].includes(normalized)) return 'yes';
  if (['nao', 'n', 'cancelar', 'cancela', 'cancelo', 'negar'].includes(normalized)) return 'no';
  return null;
}

function formatDateOnly(dateValue, timeZone) {
  return new Intl.DateTimeFormat('pt-BR', { timeZone, day: '2-digit', month: '2-digit', year: '2-digit' }).format(new Date(dateValue));
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

function formatPendingActionForConfirmation(pendingAction) {
  if (pendingAction?.type === 'multiple_events') {
    const lines = ['Eventos para confirmar:'];
    pendingAction.events.forEach((event, index) => {
      const timeZone = event.timeZone || getTimeZone();
      lines.push(`${index + 1}. ${event.summary} - ${formatDateOnly(event.startDateTime, timeZone)} ${formatTimeOnly(event.startDateTime, timeZone)}`);
    });
    lines.push('Esta correto? Responda "sim" para agendar ou "nao" para cancelar.');
    return lines.join('\n');
  }
  if (pendingAction?.type === 'single_event' && pendingAction.event) {
    return `${formatSingleEvent(pendingAction.event)}\nEsta correto? Responda "sim" para agendar ou "nao" para cancelar.`;
  }
  return 'Responda "sim" para confirmar ou "nao" para cancelar.';
}

function formatEventsList(events, timeZone) {
  if (!events.length) return 'Nenhum evento encontrado.';
  return events.map((e, i) => {
    const start = e.start?.dateTime || e.start?.date;
    const time = e.start?.dateTime ? formatTimeOnly(start, timeZone) : 'dia inteiro';
    const date = formatDateOnly(start, timeZone);
    return `${i + 1}. ${e.summary} - ${date} ${time}${e.id ? ` (ID:${e.id.slice(-6)})` : ''}`;
  }).join('\n');
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

async function createMultipleEvents(events, userId) {
  const created = [];
  for (const event of events) {
    const result = await createEvent(event, userId);
    if (result?.id) created.push({ id: result.id, summary: event.summary });
  }
  return created;
}

async function handlePendingConfirmation(userId, client, message, chatId, decision) {
  const pendingKey = userScopedKey(userId, chatId);
  const pending = pendingActions.get(pendingKey);
  if (!pending) return false;

  if (decision === 'no') {
    pendingActions.delete(pendingKey);
    await replyToMessage(userId, client, message, 'Agendamento cancelado.');
    return true;
  }

  try {
    if (pending.type === 'cancel_event') {
      await deleteEvent(pending.eventId, userId);
      pendingActions.delete(pendingKey);
      await replyToMessage(userId, client, message, `Evento "${pending.summary}" cancelado com sucesso.`);
      return true;
    }

    if (pending.type === 'multiple_events') {
      const created = await createMultipleEvents(pending.events || [], userId);
      pendingActions.delete(pendingKey);
      if (created.length) {
        const summary = created.map(item => `- ${item.summary} (ID:${item.id})`).join('\n');
        await replyToMessage(userId, client, message, `Eventos agendados com sucesso:\n${summary}`);
        return true;
      }
      await replyToMessage(userId, client, message, 'Nao consegui criar os eventos no Google Calendar.');
      return true;
    }

    const created = await createEvent(pending.event, userId);
    pendingActions.delete(pendingKey);
    if (created?.id) {
      await replyToMessage(userId, client, message, `Evento agendado com sucesso: ${pending.event.summary}. ID:${created.id}`);
      return true;
    }
    await replyToMessage(userId, client, message, 'Nao consegui criar o evento no Google Calendar.');
    return true;
  } catch (error) {
    console.error('Erro ao criar evento confirmado:', error);
    await replyToMessage(userId, client, message, 'Erro ao criar evento no Google Calendar. Verifique os logs.');
    return true;
  }
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

  // Normaliza para CHAT_ID em todos os usos downstream (pendingActions, replies, etc.)
  const chatId = CHAT_ID;

  if (trackProcessedMessage(userId, message)) return;

  if (message.fromMe && message.body && botSentBodies.has(userScopedKey(userId, message.body))) {
    botSentBodies.delete(userScopedKey(userId, message.body));
    return;
  }

  const body = message.body || '';
  console.log(`[bot:${userId}] Mensagem recebida:`, { chatId, body: body.slice(0, 80) });

  const confirmation = detectConfirmation(body);
  if (confirmation && await handlePendingConfirmation(userId, client, message, chatId, confirmation)) return;

  const pendingKey = userScopedKey(userId, chatId);
  const history = await getRecentHistory(userId, chat, message?.id?._serialized);
  const pendingAction = pendingActions.get(pendingKey) || null;
  const plan = await planConversationTurn({ message, type: message.type, text: body, history, pendingAction });

  console.log(`[bot:${userId}] Plano Gemini:`, plan.kind, plan.reply?.slice(0, 60));

  if (plan.kind === 'schedule_proposal' && plan.event) {
    const nextPendingAction = { type: 'single_event', event: plan.event, createdAt: Date.now() };
    pendingActions.set(pendingKey, nextPendingAction);
    const responseText = plan.reply
      ? `${plan.reply}\n\n${formatPendingActionForConfirmation(nextPendingAction)}`
      : formatPendingActionForConfirmation(nextPendingAction);
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
      const cleanQuery = rawQuery
        .replace(/\b(no|na|do|da|de|o|a|os|as|um|uma)\b/gi, ' ')
        .replace(/\b(sabado|domingo|segunda|terca|quarta|quinta|sexta|hoje|amanha|semana|mes|proximo|proxima)\b/gi, ' ')
        .replace(/\s+/g, ' ').trim();

      let events = await searchEvents(cleanQuery, 60, userId);
      if (!events.length && cleanQuery !== rawQuery) events = await searchEvents(rawQuery, 60, userId);
      if (!events.length) {
        const firstWord = cleanQuery.split(' ')[0];
        if (firstWord && firstWord !== cleanQuery) events = await searchEvents(firstWord, 60, userId);
      }
      if (!events.length) {
        await replyToMessage(userId, client, message, `Nao encontrei nenhum evento com "${cleanQuery}".`);
        return;
      }

      const timeZone = getTimeZone();
      if (events.length === 1) {
        const e = events[0];
        const nextPendingAction = { type: 'cancel_event', eventId: e.id, summary: e.summary, createdAt: Date.now() };
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

      await replyToMessage(userId, client, message, `Encontrei varios eventos. Seja mais especifico:\n${formatEventsList(events, timeZone)}`);
    } catch (error) {
      console.error('Erro ao buscar eventos para cancelar:', error);
      await replyToMessage(userId, client, message, 'Nao consegui buscar o evento para cancelar.');
    }
    return;
  }

  if (plan.kind === 'lookup' && plan.lookup) {
    try {
      const lookupResult = await runLookup(plan.lookup);
      if (lookupResult.pendingAction) {
        pendingActions.set(pendingKey, lookupResult.pendingAction);
        await replyToMessage(userId, client, message, `${lookupResult.reply}\n\n${formatPendingActionForConfirmation(lookupResult.pendingAction)}`);
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

  let lastSeenTs = Date.now() - 60000;

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

        console.log(`[poll:${userId}] Nova mensagem: fromMe=${raw.fromMe} body="${raw.body?.slice(0, 60)}"`);

        // Cria um objeto de mensagem sintético compatível com processIncomingMessage.
        // getChat() retorna um chat com o CHAT_ID do banco (evita incompatibilidade @lid vs @c.us).
        // fetchMessages() devolve o histórico já carregado do store.
        const rawHistory = rawMessages; // closure — lista atual de mensagens do store
        const syntheticMessage = {
          id: { _serialized: raw.id },
          fromMe: raw.fromMe,
          body: raw.body,
          type: raw.type || 'chat',
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
