import path from 'path';
import qrcode from 'qrcode-terminal';
import pkg from 'whatsapp-web.js';
import dotenv from 'dotenv';
import { planConversationTurn } from './gemini.js';
import { createEvent, listEvents, searchEvents, deleteEvent, getUpcomingReminders } from './calendar.js';
import { runLookup } from './knowledge.js';

const { Client, LocalAuth } = pkg;

dotenv.config();

const CHAT_ID = process.env.GRUPO_ASSISTENTE_ID;
if (!CHAT_ID) {
  console.error('ERRO: Configure GRUPO_ASSISTENTE_ID no .env (pode ser grupo ou self-chat @c.us)');
  process.exit(1);
}

const sessionPath = process.env.SESSION_PATH || path.resolve('./.session');
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'whatsapp-bot', dataPath: sessionPath }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  }
});

const pendingActions = new Map();
const processedMessageIds = new Set();
const sentReminderIds = new Set();

// Textos que o bot enviou — evita loop infinito no self-chat e rotula histórico
const botSentBodies = new Set();

function normalizeText(value = '') {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function detectConfirmation(text = '') {
  const normalized = normalizeText(text);
  if (['sim', 's', 'confirmar', 'confirmo', 'ok', 'pode agendar', 'agendar'].includes(normalized)) {
    return 'yes';
  }

  if (['nao', 'n', 'cancelar', 'cancela', 'cancelo', 'negar'].includes(normalized)) {
    return 'no';
  }

  return null;
}

function formatDateOnly(dateValue, timeZone) {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  }).format(new Date(dateValue));
}

function formatTimeOnly(dateValue, timeZone) {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(dateValue));
}

function formatSingleEvent(event) {
  const timeZone = event.timeZone || process.env.DEFAULT_TIMEZONE || 'America/Sao_Paulo';
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
      const timeZone = event.timeZone || process.env.DEFAULT_TIMEZONE || 'America/Sao_Paulo';
      lines.push(
        `${index + 1}. ${event.summary} - ${formatDateOnly(event.startDateTime, timeZone)} ${formatTimeOnly(event.startDateTime, timeZone)}`
      );
    });
    lines.push('Esta correto? Responda "sim" para agendar ou "nao" para cancelar.');
    return lines.join('\n');
  }

  if (pendingAction?.type === 'single_event' && pendingAction.event) {
    return `${formatSingleEvent(pendingAction.event)}\nEsta correto? Responda "sim" para agendar ou "nao" para cancelar.`;
  }

  return 'Responda "sim" para confirmar ou "nao" para cancelar.';
}

function trackProcessedMessage(message) {
  const id = message?.id?._serialized;
  if (!id) return false;
  if (processedMessageIds.has(id)) return true;
  processedMessageIds.add(id);

  if (processedMessageIds.size > 500) {
    const first = processedMessageIds.values().next().value;
    if (first) processedMessageIds.delete(first);
  }

  return false;
}

function trackBotSentBody(text) {
  if (!text) return;
  botSentBodies.add(text);
  if (botSentBodies.size > 100) {
    const first = botSentBodies.values().next().value;
    if (first) botSentBodies.delete(first);
  }
}

async function getRecentHistory(chat, currentMessageId) {
  try {
    const messages = await chat.fetchMessages({ limit: 8 });
    return messages
      .filter(item => item?.id?._serialized !== currentMessageId)
      .filter(item => (item.body || '').trim() || item.hasMedia)
      .slice(-6)
      .map(item => ({
        // Em self-chat todos fromMe são true — distingue pelo conteúdo enviado pelo bot
        role: (item.fromMe && botSentBodies.has(item.body)) ? 'assistant' : 'user',
        content: item.body || `[${item.type || 'midia'}]`,
      }));
  } catch (error) {
    console.warn('Nao foi possivel buscar historico recente:', error?.message || error);
    return [];
  }
}

async function replyToMessage(message, text) {
  if (!text) return;
  try {
    trackBotSentBody(text);
    await message.reply(text);
  } catch (error) {
    console.error('Falha ao enviar reply', error);
  }
}

async function createMultipleEvents(events) {
  const created = [];
  for (const event of events) {
    const result = await createEvent(event);
    if (result?.id) {
      created.push({ id: result.id, summary: event.summary });
    }
  }
  return created;
}

async function handlePendingConfirmation(message, chatId, decision) {
  const pending = pendingActions.get(chatId);
  if (!pending) return false;

  if (decision === 'no') {
    pendingActions.delete(chatId);
    await replyToMessage(message, 'Agendamento cancelado.');
    return true;
  }

  try {
    if (pending.type === 'cancel_event') {
      await deleteEvent(pending.eventId);
      pendingActions.delete(chatId);
      await replyToMessage(message, `Evento "${pending.summary}" cancelado com sucesso.`);
      return true;
    }

    if (pending.type === 'multiple_events') {
      const created = await createMultipleEvents(pending.events || []);
      pendingActions.delete(chatId);

      if (created.length) {
        const summary = created.map(item => `- ${item.summary} (ID:${item.id})`).join('\n');
        await replyToMessage(message, `Eventos agendados com sucesso:\n${summary}`);
        return true;
      }

      await replyToMessage(message, 'Nao consegui criar os eventos no Google Calendar.');
      return true;
    }

    const created = await createEvent(pending.event);
    pendingActions.delete(chatId);

    if (created?.id) {
      await replyToMessage(
        message,
        `Evento agendado com sucesso: ${pending.event.summary}. ID:${created.id}`
      );
      return true;
    }

    await replyToMessage(message, 'Nao consegui criar o evento no Google Calendar.');
    return true;
  } catch (error) {
    console.error('Erro ao criar evento confirmado:', error);
    await replyToMessage(message, 'Erro ao criar evento no Google Calendar. Verifique os logs.');
    return true;
  }
}

function formatEventsList(events, timeZone) {
  if (!events.length) return 'Nenhum evento encontrado.';
  return events.map((e, i) => {
    const start = e.start?.dateTime || e.start?.date;
    const time = e.start?.dateTime
      ? formatTimeOnly(start, timeZone)
      : 'dia inteiro';
    const date = formatDateOnly(start, timeZone);
    return `${i + 1}. ${e.summary} — ${date} ${time}${e.id ? ` (ID:${e.id.slice(-6)})` : ''}`;
  }).join('\n');
}

function getPeriodRange(period, startDate, endDate) {
  const tz = process.env.DEFAULT_TIMEZONE || 'America/Sao_Paulo';
  const now = new Date();

  const startOfDay = (d) => {
    const s = new Date(d.toLocaleString('en-US', { timeZone: tz }));
    s.setHours(0, 0, 0, 0);
    return new Date(d.getTime() - (new Date(d.toLocaleString('en-US', { timeZone: tz })).getTime() - d.getTime()) + s.getTime() - new Date(d.toLocaleString('en-US', { timeZone: tz })).setHours(0,0,0,0));
  };

  if (period === 'today') {
    const start = new Date(now);
    start.setSeconds(0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  if (period === 'tomorrow') {
    const start = new Date(now);
    start.setDate(start.getDate() + 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  if (period === 'this_week') {
    const start = new Date(now);
    start.setSeconds(0, 0);
    const end = new Date(now);
    end.setDate(end.getDate() + 7);
    end.setHours(23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  if (period === 'date_range' && startDate && endDate) {
    return { start: new Date(startDate).toISOString(), end: new Date(endDate).toISOString() };
  }

  // fallback: hoje
  const start = new Date(now);
  start.setSeconds(0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function startReminderLoop(sendFn) {
  const REMINDER_MINUTES = parseInt(process.env.REMINDER_MINUTES || '15', 10);
  const timeZone = process.env.DEFAULT_TIMEZONE || 'America/Sao_Paulo';

  setInterval(async () => {
    try {
      const upcoming = await getUpcomingReminders(REMINDER_MINUTES);
      for (const event of upcoming) {
        const id = event.id;
        if (!id || sentReminderIds.has(id)) continue;

        const start = event.start?.dateTime;
        const minutesLeft = Math.round((new Date(start) - Date.now()) / 60000);
        if (minutesLeft < 0) continue;

        sentReminderIds.add(id);
        if (sentReminderIds.size > 200) {
          const first = sentReminderIds.values().next().value;
          sentReminderIds.delete(first);
        }

        const msg = `⏰ Lembrete: *${event.summary}* em ${minutesLeft} minuto${minutesLeft !== 1 ? 's' : ''} (${formatTimeOnly(start, timeZone)})${event.location ? `\n📍 ${event.location}` : ''}`;
        await sendFn(msg);
      }
    } catch (error) {
      console.warn('[reminder] Erro ao checar lembretes:', error?.message);
    }
  }, 60 * 1000);
}

client.on('qr', qr => {
  console.log('QR code gerado. Escaneie com seu WhatsApp.');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('WhatsApp autenticado.');
});

client.on('ready', async () => {
  console.log('WhatsApp pronto! Monitorando chat:', CHAT_ID);
  try {
    const state = await client.getState();
    console.log('Estado:', state);
  } catch (error) {
    console.warn('Nao foi possivel consultar estado:', error?.message || error);
  }

  startReminderLoop(async (text) => {
    try {
      trackBotSentBody(text);
      await client.sendMessage(CHAT_ID, text);
    } catch (err) {
      console.error('[reminder] Falha ao enviar lembrete:', err?.message);
    }
  });
});

client.on('auth_failure', error => {
  console.error('Falha de autenticacao:', error);
});

client.on('disconnected', reason => {
  console.warn('WhatsApp desconectado:', reason);
});

async function processIncomingMessage(message) {
  if (trackProcessedMessage(message)) return;

  // Ignorar respostas do proprio bot (evita loop infinito no self-chat)
  if (message.fromMe && message.body && botSentBodies.has(message.body)) {
    botSentBodies.delete(message.body);
    return;
  }

  let chat;
  try {
    chat = await message.getChat();
  } catch {
    return; // ignora tipos não suportados (ex: Canais do WhatsApp)
  }
  const chatId = chat?.id?._serialized || '';

  if (chatId !== CHAT_ID) return;

  const fromId = message.from;
  const body = message.body || '';
  console.log('Mensagem recebida:', { fromId, chatId, body: body.slice(0, 80) });

  const confirmation = detectConfirmation(body);
  if (confirmation && await handlePendingConfirmation(message, chatId, confirmation)) {
    return;
  }

  const history = await getRecentHistory(chat, message?.id?._serialized);
  const pendingAction = pendingActions.get(chatId) || null;
  const plan = await planConversationTurn({
    message,
    type: message.type,
    text: body,
    history,
    pendingAction,
  });

  console.log('Plano Gemini:', plan.kind, plan.reply?.slice(0, 60));

  if (plan.kind === 'schedule_proposal' && plan.event) {
    const nextPendingAction = {
      type: 'single_event',
      event: plan.event,
      createdAt: Date.now(),
    };

    pendingActions.set(chatId, nextPendingAction);
    const responseText = plan.reply
      ? `${plan.reply}\n\n${formatPendingActionForConfirmation(nextPendingAction)}`
      : formatPendingActionForConfirmation(nextPendingAction);

    await replyToMessage(message, responseText);
    return;
  }

  if (plan.kind === 'list_events' && plan.list_events) {
    try {
      const timeZone = process.env.DEFAULT_TIMEZONE || 'America/Sao_Paulo';
      const { start, end } = getPeriodRange(
        plan.list_events.period,
        plan.list_events.startDate,
        plan.list_events.endDate
      );
      const events = await listEvents(start, end);
      const lista = formatEventsList(events, timeZone);
      await replyToMessage(message, lista);
    } catch (error) {
      console.error('Erro ao listar eventos:', error);
      await replyToMessage(message, 'Nao consegui consultar sua agenda agora.');
    }
    return;
  }

  if (plan.kind === 'cancel_event' && plan.cancel_event?.query) {
    try {
      const events = await searchEvents(plan.cancel_event.query);
      if (!events.length) {
        await replyToMessage(message, `Nao encontrei nenhum evento com "${plan.cancel_event.query}".`);
        return;
      }

      const timeZone = process.env.DEFAULT_TIMEZONE || 'America/Sao_Paulo';
      if (events.length === 1) {
        const e = events[0];
        const nextPendingAction = {
          type: 'cancel_event',
          eventId: e.id,
          summary: e.summary,
          createdAt: Date.now(),
        };
        pendingActions.set(chatId, nextPendingAction);
        const start = e.start?.dateTime || e.start?.date;
        await replyToMessage(
          message,
          `Quer cancelar "${e.summary}" (${formatDateOnly(start, timeZone)} ${e.start?.dateTime ? formatTimeOnly(start, timeZone) : ''})?\nResponda "sim" para confirmar ou "nao" para cancelar.`
        );
        return;
      }

      const lista = formatEventsList(events, timeZone);
      await replyToMessage(message, `Encontrei varios eventos. Seja mais especifico:\n${lista}`);
    } catch (error) {
      console.error('Erro ao buscar eventos para cancelar:', error);
      await replyToMessage(message, 'Nao consegui buscar o evento para cancelar.');
    }
    return;
  }

  if (plan.kind === 'lookup' && plan.lookup) {
    try {
      const lookupResult = await runLookup(plan.lookup);
      if (lookupResult.pendingAction) {
        pendingActions.set(chatId, lookupResult.pendingAction);
        const responseText = `${lookupResult.reply}\n\n${formatPendingActionForConfirmation(lookupResult.pendingAction)}`;
        await replyToMessage(message, responseText);
        return;
      }

      await replyToMessage(message, lookupResult.reply);
      return;
    } catch (error) {
      console.error('Erro em lookup externo:', error);
      await replyToMessage(message, `Nao consegui consultar a fonte externa agora. ${error.message}`);
      return;
    }
  }

  await replyToMessage(message, plan.reply || 'Nao consegui interpretar sua mensagem.');
}

client.on('message', async message => {
  try {
    await processIncomingMessage(message);
  } catch (error) {
    console.error('Erro no fluxo de message:', error);
    await replyToMessage(message, 'Erro interno ao processar sua mensagem. Tente novamente.');
  }
});

client.on('message_create', async message => {
  try {
    await processIncomingMessage(message);
  } catch (error) {
    console.error('Erro no fluxo de message_create:', error);
  }
});

client.initialize();
