import { planConversationTurn, friendlyAiError } from './gemini.js';
import { createEvent, listEvents, searchEvents, deleteEvent, getUpcomingReminders, getCalendarIds, listCalendars } from './calendar.js';
import { runLookup, getEventWeatherNote } from './knowledge.js';
import { findHolidayOn } from './brasil.js';
import { runTaskAction, completeTask } from './tasks.js';
import { runHomeAction, executeHomeChoice } from './homeassistant.js';
import { getConfig, isContactMode } from './config.js';
import { installMsgKeyShim } from './compat.js';
import pkg from 'whatsapp-web.js';

const { Poll } = pkg;
import { getUser, parseCalendarAliases, updateUserSettings } from './database.js';

const pendingActions = new Map();
const processedMessageIds = new Set();
const sentReminderIds = new Set();
const botSentBodies = new Set();
const reminderIntervals = new Map();
const pollIntervals = new Map();
const selfChatLidByUser = new Map();
const sessionStartTimes = new Map();

// Saude do polling do self-chat. Existe porque 'ready' nao prova que o bot
// responde: em 24/06/2026 o status ficou 'ready' por semanas enquanto o
// polling falhava em toda iteracao e nenhuma mensagem era lida.
const pollHealthByUser = new Map();

export function getSelfChatHealth(userId) {
  const h = pollHealthByUser.get(userId);
  if (!h) return { polling: false, lastOkAt: null, lastError: null, lastErrorAt: null };
  return { polling: pollIntervals.has(userId), ...h };
}

// O self-chat pode aparecer com o id @lid do usuario em vez do @c.us — o
// transcritor usa isto para nao atuar na conversa reservada da agenda.
export function getSelfChatLid(userId) {
  return selfChatLidByUser.get(userId) || null;
}

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
  // "sim N" ou "s N" ou "ok N" — N = numero da agenda escolhida (1..9). Formato
  // antigo, ainda aceito; hoje o pedido e so o numero (ver processIncomingMessage).
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

function detectChooseAll(text = '') {
  const n = normalizeText(text);
  const exact = [
    'ambos', 'ambas', 'todos', 'todas', 'os dois', 'as duas', 'os 2', 'as 2',
    'tudo', 'all', 'both', 'esses dois', 'essas duas', 'esses 2', 'essas 2',
    'os ultimos', 'as ultimas', 'os dois ultimos', 'as duas ultimas',
    'os 2 ultimos', 'as 2 ultimas', 'os ultimos dois', 'as ultimas duas',
  ];
  return exact.includes(n);
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

// Nome mostrado de cada agenda: o apelido do painel, senao o nome do Google.
// Lido a cada uso (sem o cache dos nomes) para o apelido valer na hora.
async function formatCalendarOptions(userId) {
  const ids = await getCalendarIds(userId);
  if (ids.length <= 1) return null;
  const aliases = parseCalendarAliases(await getUser(userId));
  let names = await getCalendarNameMap(userId);
  if (ids.some(id => !aliases[id] && !names.get(id))) {
    names = await getCalendarNameMap(userId, true);
  }
  const labels = ids.map(id => aliases[id] || names.get(id) || shortCalendarLabel(id));
  const lines = labels.map((label, i) => `${i + 1}. ${label}`);
  return { ids, labels, text: lines.join('\n') };
}

// ---------- Enquete de agenda (modo contato) ----------
// No self-chat os votos nunca chegam a sessao web (testado 5x em 14/10/2026);
// numa conversa com o numero do bot o voto vem de outra conta, como nos
// grupos. A enquete e um atalho: responder o numero continua valendo.
// id curto da enquete -> { userId, chatId, yesCount }. As `yesCount` primeiras
// opcoes confirmam (a N-esima = agenda N); as demais cancelam. Some quando o
// pedido se resolve.
const calendarPolls = new Map();

const shortMsgId = key => key?.id || String(key?._serialized || '').split('_')[2] || '';

// Varias agendas: "Confirma? Em qual agenda?" + uma opcao por agenda +
// Cancelar. Uma agenda: "Confirmar o agendamento?" + Sim/Nao.
async function buildConfirmationPoll(userId) {
  const opts = await formatCalendarOptions(userId);
  if (!opts) {
    return { title: 'Confirmar o agendamento?', yes: ['Sim. Agendar'], no: 'Não. Cancelar' };
  }
  // Opcoes repetidas confundiriam o voto; o numero na frente garante unicas
  // e deixa claro que responder o numero digitando tambem vale.
  const yes = opts.labels.map((label, i) => `${i + 1}. ${label}`);
  return { title: 'Confirma? Em qual agenda?', yes, no: 'Cancelar' };
}

// Devolve true se a enquete saiu.
async function offerCalendarPoll(userId, client, chatId) {
  if (!isContactMode()) return false;
  const pendingKey = userScopedKey(userId, chatId);
  const pending = pendingActions.get(pendingKey);
  if (pending?.type !== 'single_event' && pending?.type !== 'multiple_events') return false;

  const { title, yes, no } = await buildConfirmationPoll(userId);
  try {
    const sent = await client.sendMessage(chatId, new Poll(title, [...yes, no]));
    const pollId = shortMsgId(sent?.id);
    if (!pollId) return false;
    trackProcessedMessage(userId, sent);
    calendarPolls.set(pollId, { userId, chatId, yesCount: yes.length });
    pending.pollId = pollId;
    console.log(`[bot:${userId}] Enquete de agenda enviada (${pollId}).`);
    return true;
  } catch (err) {
    console.warn(`[bot:${userId}] Falha ao enviar enquete de agenda:`, err?.message || err);
    return false;
  }
}

// Pede a confirmacao de um agendamento ja guardado em pendingActions. No modo
// contato sao duas mensagens: os detalhes completos e, em seguida, a enquete
// de confirmacao. Se a enquete nao sair, a instrucao vai em texto, como no
// self-chat — nunca fica sem como responder.
// Avisos extras na confirmacao: feriado nacional na data e previsao do tempo no
// horario. So informativo — falha aqui nunca impede o agendamento.
async function getSchedulingContext(pendingAction) {
  const events = pendingAction?.type === 'single_event' ? [pendingAction.event] : (pendingAction?.events || []);
  if (!events.length) return '';
  const quiet = label => error => {
    console.warn(`[bot] Contexto do agendamento (${label}) falhou:`, error?.message || error);
    return null;
  };

  const holidays = await Promise.all(events.map(e => findHolidayOn(e.startDateTime).catch(quiet('feriado'))));
  const lines = [];
  holidays.forEach((holiday, i) => {
    if (!holiday) return;
    const label = events.length > 1 ? `"${events[i].summary}" cai` : 'Essa data cai';
    lines.push(`⚠️ ${label} num feriado nacional (${holiday.name}).`);
  });
  if (events.length === 1) {
    const weather = await getEventWeatherNote(events[0]).catch(quiet('clima'));
    if (weather) lines.push(weather);
  }
  return lines.join('\n');
}

async function sendSchedulingConfirmation(userId, client, message, chatId, pendingAction, prefix = '') {
  const context = await getSchedulingContext(pendingAction);
  if (context) prefix = prefix ? `${prefix}\n\n${context}` : context;
  if (isContactMode()) {
    const details = formatPendingDetails(pendingAction);
    await replyToMessage(userId, client, message, prefix ? `${prefix}\n\n${details}` : details);
    if (await offerCalendarPoll(userId, client, chatId)) return;
    const opts = await formatCalendarOptions(userId);
    await replyToMessage(userId, client, message, opts
      ? `Em qual agenda?\n${opts.text}\n\nResponda o numero da agenda para confirmar, ou "nao" para cancelar.`
      : 'Esta correto? Responda "sim" para agendar ou "nao" para cancelar.');
    return;
  }
  const confirmText = await formatPendingActionForConfirmation(pendingAction, userId);
  await replyToMessage(userId, client, message, prefix ? `${prefix}\n\n${confirmText}` : confirmText);
}

// Evento 'vote_update' do client do bot.
export async function handleCalendarPollVote(client, vote) {
  const pollId = shortMsgId(vote?.parentMsgKey) || shortMsgId(vote?.parentMessage?.id);
  const target = calendarPolls.get(pollId);
  const selected = vote?.selectedOptions || [];
  console.log(`[bot] vote_update: enquete=${pollId || '?'} conhecida=${!!target} opcoes=${JSON.stringify(selected.map(o => o.localId))}`);
  if (!target || selected.length !== 1) return; // desmarcou ou enquete alheia

  const { userId, chatId } = target;
  const pending = pendingActions.get(userScopedKey(userId, chatId));
  if (!pending || pending.pollId !== pollId) {
    calendarPolls.delete(pollId); // ja respondida por texto ou substituida
    return;
  }

  const localId = selected[0].localId;
  const confirmation = localId >= target.yesCount
    ? { decision: 'no', calendarIndex: null }
    : { decision: 'yes', calendarIndex: localId + 1 };
  calendarPolls.delete(pollId);

  // handlePendingConfirmation so usa a mensagem como plano B de resposta.
  const fallbackMessage = { reply: text => client.sendMessage(chatId, text) };
  await handlePendingConfirmation(userId, client, fallbackMessage, chatId, confirmation);
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

// Modo contato: o chat do usuario com o numero do bot, como o WhatsApp o
// identifica (o 9o digito e o @lid fazem o id real divergir do telefone
// cadastrado). Fica estavel porque pendingActions e indexado por ele.
// Guarda tambem o telefone para o qual foi resolvido: se o usuario trocar de
// numero no painel, o chat antigo deixa de valer (senao lembretes seguiriam
// indo para o numero velho ate o proximo restart).
const contactChatIdByUser = new Map();

export function setContactChatId(userId, chatId, phone) {
  if (chatId) contactChatIdByUser.set(userId, { chatId, phone: phone || '' });
}

export function getContactChatId(userId, phone) {
  const entry = contactChatIdByUser.get(userId);
  if (!entry) return null;
  if (phone !== undefined && entry.phone !== (phone || '')) {
    contactChatIdByUser.delete(userId);
    return null;
  }
  return entry.chatId;
}

async function getAssistantChatId(userId) {
  const user = await getUser(userId);
  if (isContactMode()) {
    const resolved = getContactChatId(userId, user?.assistant_chat_id);
    if (resolved) return resolved;
  }
  return user?.assistant_chat_id || '';
}

export async function hydrateSelfChatLidFromDb(userId) {
  const user = await getUser(userId);
  if (user?.self_chat_lid) {
    selfChatLidByUser.set(userId, user.self_chat_lid);
    console.log(`[bot:${userId}] LID self-chat carregado do banco: ${user.self_chat_lid}`);
  }
}

// Os dados do pedido sem cabecalho nem instrucao de resposta — e a pergunta
// da enquete de agenda.
function formatPendingDetails(pendingAction) {
  if (pendingAction?.type === 'multiple_events') {
    return ['Eventos para confirmar:', ...pendingAction.events.map(event => {
      const timeZone = event.timeZone || getTimeZone();
      const line = `• ${event.summary} - ${formatDateOnly(event.startDateTime, timeZone)} ${formatTimeOnly(event.startDateTime, timeZone)}`;
      return event.attendees?.length
        ? `${line}\n   Convidados (recebem o convite por e-mail): ${event.attendees.join(', ')}`
        : line;
    })].join('\n');
  }
  return formatSingleEvent(pendingAction.event).split('\n').slice(1).join('\n');
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
  if (event.attendees?.length) lines.push(`Convidados (recebem o convite por e-mail): ${event.attendees.join(', ')}`);
  return lines.join('\n');
}

function formatInviteNote(attendees) {
  return attendees?.length ? ` Convite enviado para ${attendees.join(', ')}.` : '';
}

async function formatPendingActionForConfirmation(pendingAction, userId) {
  const opts = userId ? await formatCalendarOptions(userId) : null;
  const tail = opts
    ? `\n\nEm qual agenda?\n${opts.text}\n\nResponda o numero da agenda para confirmar, ou "nao" para cancelar.`
    : `\nEsta correto? Responda "sim" para agendar ou "nao" para cancelar.`;

  if (pendingAction?.type === 'multiple_events') {
    const lines = ['Eventos para confirmar:'];
    // Marcador, nao numero: com varias agendas a resposta e um numero, e uma
    // lista numerada de eventos confundiria com a de agendas.
    pendingAction.events.forEach(event => {
      const timeZone = event.timeZone || getTimeZone();
      lines.push(`• ${event.summary} - ${formatDateOnly(event.startDateTime, timeZone)} ${formatTimeOnly(event.startDateTime, timeZone)}`);
      if (event.attendees?.length) lines.push(`   Convidados (recebem o convite por e-mail): ${event.attendees.join(', ')}`);
    });
    return lines.join('\n') + tail;
  }
  if (pendingAction?.type === 'single_event' && pendingAction.event) {
    return `${formatSingleEvent(pendingAction.event)}${tail}`;
  }
  return opts
    ? `Em qual agenda?\n${opts.text}\n\nResponda o numero da agenda para confirmar, ou "nao" para cancelar.`
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

// O container roda em UTC: setHours/new Date('YYYY-MM-DD') caem 3h antes do dia
// de Sao Paulo. Em 15/10/2026 "agenda do dia 19" voltou vazia (intervalo de
// duracao zero) e "semana que vem" veio deslocada. Toda conta de dia e feita
// aqui, em dias-calendario do fuso do usuario.
function localYmd(date, timeZone) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(date).split('-').map(Number);
  return { y, m, d };
}

function addDaysYmd({ y, m, d }, days) {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function weekdayOfYmd({ y, m, d }) {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = domingo
}

// Instante UTC da meia-noite local do dia informado.
function zonedDayStart({ y, m, d }, timeZone) {
  const guess = Date.UTC(y, m - 1, d);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(guess)).map(p => [p.type, p.value]));
  const asLocal = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return new Date(guess - (asLocal - guess));
}

// [inicio do primeiro dia, fim do ultimo dia] em dias locais.
function zonedDaysRange(firstYmd, lastYmd, timeZone) {
  const start = zonedDayStart(firstYmd, timeZone);
  const end = new Date(zonedDayStart(addDaysYmd(lastYmd, 1), timeZone).getTime() - 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function parseYmd(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return match ? { y: +match[1], m: +match[2], d: +match[3] } : null;
}

function getPeriodRange(period, startDate, endDate) {
  const timeZone = getTimeZone();
  const now = new Date();
  const today = localYmd(now, timeZone);
  const fromNow = (lastYmd) => ({
    start: now.toISOString(),
    end: zonedDaysRange(today, lastYmd, timeZone).end,
  });

  if (period === 'today') return fromNow(today);
  if (period === 'tomorrow') {
    const tomorrow = addDaysYmd(today, 1);
    return zonedDaysRange(tomorrow, tomorrow, timeZone);
  }
  if (period === 'this_week') return fromNow(addDaysYmd(today, 7));
  if (period === 'next_week') {
    // Semana brasileira: domingo a sabado. "Semana que vem" = o proximo domingo
    // (estritamente depois de hoje) ate o sabado seguinte.
    const sunday = addDaysYmd(today, 7 - weekdayOfYmd(today));
    return zonedDaysRange(sunday, addDaysYmd(sunday, 6), timeZone);
  }
  if (period === 'date_range' && startDate && endDate) {
    // Data pura ("2026-10-19") vale o dia local inteiro; com horario, respeita o instante.
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
    const start = dateOnly.test(startDate) ? zonedDayStart(parseYmd(startDate), timeZone) : new Date(startDate);
    const end = dateOnly.test(endDate)
      ? new Date(zonedDayStart(addDaysYmd(parseYmd(endDate), 1), timeZone).getTime() - 1)
      : new Date(endDate);
    // Fim igual ou anterior ao inicio (ex: "2026-10-19T00:00" nos dois) -> estende ate o fim do dia.
    if (end <= start) {
      const lastDay = parseYmd(endDate) || localYmd(start, timeZone);
      return { start: start.toISOString(), end: zonedDaysRange(lastDay, lastDay, timeZone).end };
    }
    return { start: start.toISOString(), end: end.toISOString() };
  }
  return fromNow(today);
}

// A mesma mensagem chega com o id serializado de formas diferentes conforme a
// origem: "true_5511...@c.us_3EB0..." pelo evento e "true_1896...@lid_3EB0..."
// pelo polling. So o trecho final (o id da mensagem em si) e estavel — dedup
// pelo id completo deixava a mensagem passar duas vezes. Ver 15/10/2026.
function dedupKeyOf(message) {
  const key = message?.id;
  if (key?.id && typeof key.id === 'string') return key.id;
  const serialized = key?._serialized || key?.$1 || '';
  if (!serialized) return '';
  const parts = serialized.split('_');
  return parts.length >= 3 ? parts[2] : serialized;
}

function trackProcessedMessage(userId, message) {
  const id = dedupKeyOf(message);
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

const PUPPETEER_TRANSIENT = /Execution context was destroyed|detached Frame|Target closed|Session closed|Protocol error/i;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForClientReady(client, timeoutMs = 25000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const state = await client.getState();
      if (state === 'CONNECTED') return true;
    } catch {}
    await sleep(2000);
  }
  return false;
}

async function replyToMessage(userId, client, message, text) {
  if (!text) return;
  const CHAT_ID = await getAssistantChatId(userId);
  if (!CHAT_ID) return;
  trackBotSentBody(userId, text);

  try {
    // Marca a resposta como ja processada pelo id — a defesa principal contra
    // o bot ler a propria mensagem; o botSentBodies e a segunda linha.
    const sent = await client.sendMessage(CHAT_ID, text);
    trackProcessedMessage(userId, sent);
    return;
  } catch (firstErr) {
    const transient = PUPPETEER_TRANSIENT.test(firstErr?.message || '');
    if (!transient) {
      console.warn(`[bot:${userId}] sendMessage falhou (erro nao-transient):`, firstErr?.message?.slice(0, 150));
      try { await message.reply(text); return; } catch {}
      console.error(`[bot:${userId}] Falha total sem ser transient.`);
      return;
    }
    console.warn(`[bot:${userId}] sendMessage falhou (transient), aguardando WhatsApp Web reconectar...`);
  }

  const reconnected = await waitForClientReady(client);
  if (!reconnected) {
    console.error(`[bot:${userId}] WhatsApp Web nao reconectou em 25s. Mensagem perdida.`);
    return;
  }

  const attempts = [500, 2000, 5000];
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    await sleep(attempts[i]);
    try {
      trackProcessedMessage(userId, await client.sendMessage(CHAT_ID, text));
      console.log(`[bot:${userId}] sendMessage recuperou apos reconnect (tentativa ${i + 1}).`);
      return;
    } catch (error) {
      lastErr = error;
      console.warn(`[bot:${userId}] sendMessage pos-reconnect falhou (${i + 1}/${attempts.length}):`, error?.message?.slice(0, 120));
    }
  }

  try {
    await message.reply(text);
    console.log(`[bot:${userId}] fallback message.reply funcionou pos-reconnect.`);
  } catch (err2) {
    console.error(`[bot:${userId}] Falha total pos-reconnect:`, lastErr?.message?.slice(0, 150), '|', err2?.message?.slice(0, 150));
  }
}

async function createMultipleEvents(events, userId, calendarId) {
  const created = [];
  for (const event of events) {
    const result = await createEvent(event, userId, calendarId);
    if (result?.id) created.push({ id: result.id, summary: event.summary, attendees: event.attendees || [] });
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
    // "nao" significa coisas opostas conforme o pedido: num agendamento, nao
    // criar; num cancelamento, MANTER o evento. Responder "Agendamento
    // cancelado." ao manter um evento dava a entender o contrario.
    const keptMsg = pending.type === 'cancel_event'
      ? `Ok, mantive "${pending.summary}" na agenda.`
      : pending.type === 'choice' && pending.action !== 'cancel'
        ? 'Ok, nada foi feito.'
      : pending.type === 'cancel_multiple' || pending.type === 'choice'
        ? 'Ok, nao cancelei nada. Seus eventos continuam na agenda.'
        : 'Ok, nao agendei.';
    await replyToMessage(userId, client, message, keptMsg);
    return true;
  }

  try {
    if (pending.type === 'cancel_event') {
      await deleteEvent(pending.eventId, userId, pending.calendarId);
      pendingActions.delete(pendingKey);
      await replyToMessage(userId, client, message, `Evento "${pending.summary}" cancelado com sucesso.`);
      return true;
    }

    if (pending.type === 'cancel_multiple') {
      const removed = [];
      for (const it of (pending.items || [])) {
        try {
          await deleteEvent(it.eventId, userId, it.calendarId);
          removed.push(it.summary);
        } catch (err) {
          console.warn('[bot] Falha ao cancelar item:', err?.message || err);
        }
      }
      pendingActions.delete(pendingKey);
      if (removed.length) {
        await replyToMessage(userId, client, message, `Cancelei ${removed.length} eventos:\n${removed.map(s => `- ${s}`).join('\n')}`);
      } else {
        await replyToMessage(userId, client, message, 'Nao consegui cancelar os eventos. Tente novamente.');
      }
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
          await replyToMessage(userId, client, message, `Voce tem ${calendarIds.length} agendas. Responda so o numero da agenda para TODOS os eventos:\n${opts.text}`);
          await offerCalendarPoll(userId, client, chatId);
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
        const summary = created
          .map(item => `- ${item.summary}${item.attendees.length ? ` (convite enviado para ${item.attendees.join(', ')})` : ''}`)
          .join('\n');
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
        await replyToMessage(userId, client, message, `Voce tem ${calendarIds.length} agendas. Responda so o numero da agenda:\n${opts.text}`);
        await offerCalendarPoll(userId, client, chatId);
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
      await replyToMessage(userId, client, message, msg + formatInviteNote(pending.event.attendees));
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
      `Quer cancelar "${choice.summary}" (${formatDateOnly(start, timeZone)}${timeStr ? ' ' + timeStr : ''})?\nResponda "sim" para confirmar o cancelamento ou "nao" para manter o agendamento.`
    );
    return true;
  }

  if (pending.action === 'complete_task' || pending.action === 'home') {
    pendingActions.delete(pendingKey);
    await runChoiceAction(userId, client, message, pending, [choice]);
    return true;
  }

  return false;
}

// Conclui tarefas ou aciona dispositivos escolhidos de uma lista ("1", "todos").
async function runChoiceAction(userId, client, message, pending, choices) {
  try {
    if (pending.action === 'complete_task') {
      for (const c of choices) await completeTask(userId, c.taskId);
      await replyToMessage(userId, client, message, `Concluida${choices.length > 1 ? 's' : ''}: ${choices.map(c => c.summary).join(', ')} ✅`);
      return;
    }
    await replyToMessage(userId, client, message, await executeHomeChoice(userId, pending, choices));
  } catch (error) {
    console.error(`[bot:${userId}] Falha ao executar escolha (${pending.action}):`, error?.message || error);
    await replyToMessage(userId, client, message, `Nao consegui concluir: ${error.message}`);
  }
}

async function handlePendingChooseAll(userId, client, message, chatId) {
  const pendingKey = userScopedKey(userId, chatId);
  const pending = pendingActions.get(pendingKey);
  if (!pending || pending.type !== 'choice') return false;
  const choices = pending.choices || [];
  if (!choices.length) return false;

  if (pending.action === 'complete_task' || pending.action === 'home') {
    pendingActions.delete(pendingKey);
    await runChoiceAction(userId, client, message, pending, choices);
    return true;
  }
  if (pending.action !== 'cancel') return false;

  const next = { type: 'cancel_multiple', items: choices, createdAt: Date.now() };
  pendingActions.set(pendingKey, next);
  const lines = choices.map((c, i) => {
    const timeZone = getTimeZone();
    const timeStr = c.start && c.start.includes('T') ? ' ' + formatTimeOnly(c.start, timeZone) : '';
    return `${i + 1}. ${c.summary} (${formatDateOnly(c.start, timeZone)}${timeStr})`;
  });
  await replyToMessage(
    userId, client, message,
    `Quer cancelar TODOS os ${choices.length} eventos abaixo?\n${lines.join('\n')}\nResponda "sim" para confirmar o cancelamento ou "nao" para manter os agendamentos.`
  );
  return true;
}

// `source` identifica por onde a mensagem chegou: 'event:message_create',
// 'event:message' ou 'poll'. Serve para decidir se o polling do self-chat
// (workaround acoplado a interno da lib) ainda e necessario — se o evento
// vencer o dedup de forma consistente, o polling e redundante.
// 'contact' vem do numero proprio do bot: contact.js ja identificou o
// remetente como este usuario, entao nao ha self-chat a conferir.
export async function processIncomingMessage(userId, client, message, source = 'desconhecido') {
  // Verifica self-chat ANTES do dedup (evita adicionar ID e bloquear polling depois)
  let chat;
  try {
    chat = await message.getChat();
  } catch (err) {
    if (source === 'contact') console.warn(`[bot:${userId}] getChat falhou:`, err?.message || err);
    return;
  }

  const rawChatId = chat?.id?._serialized || '';
  const CHAT_ID = await getAssistantChatId(userId);
  if (source !== 'contact') {
    const selfLid = selfChatLidByUser.get(userId);
    const isSelfChat = rawChatId === CHAT_ID || (selfLid && rawChatId === selfLid);
    if (!isSelfChat) return;
  }

  // Ignora mensagens enviadas ANTES da sessao atual ficar pronta
  // (evita que retomar de pausa reprocesse mensagens do periodo offline).
  const sessionStart = sessionStartTimes.get(userId);
  if (sessionStart && message.timestamp) {
    const msgTs = message.timestamp * 1000;
    if (msgTs < sessionStart) return;
  }

  // Normaliza para CHAT_ID em todos os usos downstream (pendingActions, replies, etc.)
  const chatId = CHAT_ID;

  if (trackProcessedMessage(userId, message)) {
    // Duplicata: outra origem chegou primeiro. Registrar o perdedor e o que
    // revela se o message_create dispara no self-chat — sem isso so se ve
    // quem venceu, e um evento que dispara mas perde a corrida some do log.
    console.log(`[bot:${userId}] Duplicata ignorada (source=${source}).`);
    return;
  }

  // NAO apagar a entrada ao ver a resposta: com evento + polling ela chega
  // duas vezes, e na segunda o bot tratava a propria resposta como pedido do
  // usuario — virou um laco em 15/10/2026. O Set ja e limitado a 200.
  if (message.fromMe && message.body && botSentBodies.has(userScopedKey(userId, message.body))) {
    return;
  }

  const body = message.body || '';
  console.log(`[bot:${userId}] Mensagem recebida:`, { chatId, source, body: body.slice(0, 80) });

  // Se ha uma lista pendente de escolha e o user respondeu so um numero, processa selecao
  const choiceIdx = detectNumericChoice(body);
  if (choiceIdx && await handlePendingChoice(userId, client, message, chatId, choiceIdx)) return;

  if (detectChooseAll(body) && await handlePendingChooseAll(userId, client, message, chatId)) return;

  // Com agendamento pendente, um numero sozinho e a escolha da agenda e ja
  // confirma — "2" no lugar de "sim 2". Lista de escolha ('choice') ja foi
  // tratada acima por handlePendingChoice. Com uma agenda so, o numero segue
  // para o Gemini ("14" pode ser correcao de horario, nao um "sim").
  let confirmation = detectConfirmation(body);
  if (!confirmation && choiceIdx) {
    const pendingNow = pendingActions.get(userScopedKey(userId, chatId));
    const isScheduling = pendingNow?.type === 'single_event' || pendingNow?.type === 'multiple_events';
    if (isScheduling && (await getCalendarIds(userId)).length > 1) {
      confirmation = { decision: 'yes', calendarIndex: choiceIdx };
    }
  }
  if (confirmation && await handlePendingConfirmation(userId, client, message, chatId, confirmation)) return;

  const pendingKey = userScopedKey(userId, chatId);
  const history = await getRecentHistory(userId, chat, message?.id?._serialized);
  const pendingAction = pendingActions.get(pendingKey) || null;
  let plan;
  try {
    plan = await planConversationTurn({ message, type: message.type, text: body, history, pendingAction });
  } catch (error) {
    console.error(`[bot:${userId}] Falha na chamada do Gemini:`, error?.status, error?.message);
    await replyToMessage(userId, client, message, friendlyAiError(error));
    return;
  }

  console.log(`[bot:${userId}] Plano Gemini:`, plan.kind, plan.reply?.slice(0, 60));

  if (plan.kind === 'schedule_proposal' && plan.event) {
    const nextPendingAction = {
      type: 'single_event',
      event: plan.event,
      replacePreviousQuery: plan.replacePreviousQuery || '',
      createdAt: Date.now(),
    };
    pendingActions.set(pendingKey, nextPendingAction);
    await sendSchedulingConfirmation(userId, client, message, chatId, nextPendingAction, plan.reply);
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
    await sendSchedulingConfirmation(userId, client, message, chatId, nextPendingAction, plan.reply);
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
          `Quer cancelar "${e.summary}" (${formatDateOnly(start, timeZone)} ${e.start?.dateTime ? formatTimeOnly(start, timeZone) : ''})?\nResponda "sim" para confirmar o cancelamento ou "nao" para manter o agendamento.`
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
        await sendSchedulingConfirmation(userId, client, message, chatId, lookupResult.pendingAction, lookupResult.reply);
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

  if ((plan.kind === 'task' && plan.task) || (plan.kind === 'home' && plan.home)) {
    try {
      const result = plan.kind === 'task'
        ? await runTaskAction(userId, plan.task)
        : await runHomeAction(userId, plan.home);
      if (result.pendingAction) pendingActions.set(pendingKey, result.pendingAction);
      await replyToMessage(userId, client, message, result.reply);
    } catch (error) {
      console.error(`[bot:${userId}] Erro em ${plan.kind}:`, error?.message || error);
      const label = plan.kind === 'task' ? 'suas tarefas' : 'o Home Assistant';
      await replyToMessage(userId, client, message, `Nao consegui acessar ${label} agora. Tente novamente em instantes.`);
    }
    return;
  }

  await replyToMessage(userId, client, message, plan.reply || 'Nao consegui interpretar sua mensagem.');
}

export function startReminderLoop(userId, client) {
  if (reminderIntervals.has(userId)) return;

  const REMINDER_MINUTES = parseInt(getConfig().REMINDER_MINUTES || '15', 10);

  const interval = setInterval(async () => {
    try {
      // Modo contato: telefone nao verificado pode ser de outra pessoa, e o
      // lembrete entregaria a agenda deste usuario a ela.
      if (isContactMode() && !(await getUser(userId))?.phone_verified_at) return;
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
          trackProcessedMessage(userId, await client.sendMessage(CHAT_ID, msg));
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
//
// ATENCAO — acoplamento com internos: le o store de mensagens do WhatsApp Web
// diretamente, nao por API publica da lib. Ha dois caminhos possiveis e o
// codigo tenta ambos:
//   ate 1.34.6: `window.Store`, que a lib montava via moduleRaid (ExposeStore)
//   a partir de 1.34.7: `window.require('WAWebCollections')`, o carregador de
//                       modulos do proprio WhatsApp Web, que a lib tambem usa
// A 1.34.7 apagou o ExposeStore; quem dependia so de `window.Store` passou a
// falhar em silencio (bot conectava e nao respondia). Depender do que o
// upstream mantem, em vez do que ele apagou, e o que da alguma margem aqui.
//
// Este polling existe porque `message_create` NAO dispara no self-chat em
// multi-device — confirmado por instrumentacao em 03/08/2026, com zero eventos
// registrados contra duas mensagens lidas pelo polling. Nao remover sem
// refazer esse teste (o campo `source` do log mostra a origem de cada
// mensagem processada).
// Quanto tempo esperar a propria lib reinjetar o window.WWebJS depois de um
// reload do WhatsApp Web, antes de declarar a pagina perdida. O inject() dela
// espera ate 30s pelo window.Debug; damos o dobro de folga.
const INJECTION_GRACE_MS = 60_000;

export function startSelfChatPolling(userId, client, { onInjectionLost } = {}) {
  // Um 'ready' pode disparar mais de uma vez (whatsapp-web.js reinjeta apos
  // reload interno do WhatsApp Web). Reinicia o polling em vez de sair na
  // primeira chamada: o intervalo antigo ficaria preso a um lastSeenTs velho.
  if (pollIntervals.has(userId)) stopSelfChatPolling(userId);

  // Comeca a partir do instante atual: ignora mensagens da janela offline anterior
  let lastSeenTs = sessionStartTimes.get(userId) || Date.now();
  let lidWarnAt = 0;
  let injectionLostAt = 0;
  let injectionLostReported = false;

  // Acessa o self-chat no modo multi-device.
  // O Mensagens Salvas usa o LID do próprio usuário como chat ID (não @c.us).
  // Descobrimos o LID dinamicamente a partir de qualquer mensagem fromMe.
  const fetchFromStore = async () => {
    // Numa sessao recem-criada (QR novo) o Store.Msg comeca vazio, entao a
    // descoberta por varredura falha. Passamos o LID ja persistido no banco
    // como fallback — sem ele o polling ficava em silencio para sempre.
    const knownLid = selfChatLidByUser.get(userId) || null;
    return client.pupPage.evaluate(async (knownLid) => {
      try {
        // A 1.34.7 removeu o window.Store (que a lib montava via moduleRaid) e
        // passou a usar o carregador de modulos do proprio WhatsApp Web.
        // Resolver as duas formas deixa este bloco independente da versao da
        // lib: subir ou descer de versao nao exige mexer aqui.
        const load = (name) => {
          try { return typeof window.require === 'function' ? window.require(name) : null; }
          catch { return null; }
        };
        const collections = load('WAWebCollections');
        const MsgStore = window.Store?.Msg || collections?.Msg || null;
        const ChatStore = window.Store?.Chat || collections?.Chat || null;
        const WidFactory = window.Store?.WidFactory || load('WAWebWidFactory');
        const MeUser = window.Store?.User || load('WAWebUserPrefsMeUser');

        if (!MsgStore) {
          return { error: 'store de mensagens indisponivel (window.Store e WAWebCollections falharam)' };
        }

        const allMsgs = MsgStore.getModelsArray?.() || [];

        // 1) Via API do proprio WA Web (funciona com store vazio)
        let userLid = null;
        try {
          userLid = MeUser?.getMaybeMeLidUser?.()?._serialized || null;
        } catch {}

        // 2) Varredura por uma mensagem fromMe com remetente @lid
        if (!userLid) {
          const fromMeMsg = allMsgs.find(m => m.id?.fromMe && m.from?._serialized?.endsWith('@lid'));
          userLid = fromMeMsg?.from?._serialized || null;
        }

        // 3) LID persistido no banco de uma sessao anterior
        if (!userLid) userLid = knownLid;

        if (!userLid) {
          return { error: 'LID do usuario nao encontrado (MeUser, store de mensagens e banco)' };
        }

        // Self-chat REAL: mensagens cujo remote === user LID
        const selfChatMsgs = allMsgs.filter(m => m.id?.remote?._serialized === userLid);

        // Tenta achar o chat pelo LID
        let chat = null;
        try {
          const wid = WidFactory.createWid(userLid);
          chat = await ChatStore.find(wid);
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
          messages: recent.map(m => {
            // getMessageById() resolve via Msg.get(id) e, se falhar, exige que
            // o id tenha 3 ou 4 partes separadas por '_'. `_serialized` nem
            // sempre esta presente — devolvemos tambem o toString() do MsgKey
            // e sinalizamos qual forma o proprio store reconhece.
            const serialized = m.id?._serialized || '';
            let asString = '';
            try { asString = typeof m.id?.toString === 'function' ? m.id.toString() : ''; } catch {}
            return {
              id: serialized || asString,
              idAlt: asString && asString !== serialized ? asString : '',
              idInStore: !!(serialized && MsgStore.get?.(serialized))
                || !!(asString && MsgStore.get?.(asString)),
              body: m.body || '',
              timestamp: m.t || 0,
              fromMe: m.id?.fromMe ?? false,
              type: m.type || 'chat',
              hasMedia: !!(m.mediaData || m.isMedia || (m.type && ['audio', 'ptt', 'image', 'video', 'document', 'sticker'].includes(m.type))),
            };
          }),
        };
      } catch (e) {
        return { error: e.message };
      }
    }, knownLid);
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

      // Quando o WhatsApp Web recarrega a pagina, a lib reinjeta o
      // window.WWebJS no 'framenavigated'. Se essa reinjecao falha (em
      // 24/09/2026 lancou 'auth timeout'), o polling abaixo continua lendo
      // via window.require, mas TODO envio quebra com "reading 'getChat'".
      // O bot ficou duas semanas assim: lia, chamava o Gemini e nao respondia.
      let wwebjsOk = null;
      try {
        wwebjsOk = await client.pupPage.evaluate(() => typeof window.WWebJS?.getChat === 'function');
      } catch { /* pagina navegando: inconclusivo, tenta no proximo tick */ }

      if (wwebjsOk === false) {
        const now = Date.now();
        if (!injectionLostAt) {
          injectionLostAt = now;
          console.warn(`[poll:${userId}] window.WWebJS ausente — aguardando reinjecao da lib.`);
        }
        pollHealthByUser.set(userId, {
          ...(pollHealthByUser.get(userId) || {}),
          injectionOk: false,
          lastError: 'window.WWebJS ausente (envio indisponivel)',
          lastErrorAt: now,
        });
        if (now - injectionLostAt >= INJECTION_GRACE_MS && !injectionLostReported) {
          injectionLostReported = true;
          console.error(`[poll:${userId}] window.WWebJS ausente ha ${Math.round((now - injectionLostAt) / 1000)}s — reiniciando instancia.`);
          onInjectionLost?.('window.WWebJS ausente');
        }
        // Nao processa: sem envio a resposta se perderia. Como lastSeenTs nao
        // avanca, as mensagens sao lidas assim que a injecao voltar.
        return;
      }
      if (wwebjsOk === true && injectionLostAt) {
        console.log(`[poll:${userId}] window.WWebJS restaurado apos ${Math.round((Date.now() - injectionLostAt) / 1000)}s.`);
        injectionLostAt = 0;
        injectionLostReported = false;
        pollHealthByUser.set(userId, { ...(pollHealthByUser.get(userId) || {}), injectionOk: true });
      }

      const result = await fetchFromStore();

      if (!result?.chatId) {
        // Nao retorna calado: sem isso um self-chat que nunca resolve o LID
        // parece "conectado mas mudo". Loga no maximo 1x por minuto.
        const now = Date.now();
        const reason = result?.error || 'resposta vazia do Store';
        const health = pollHealthByUser.get(userId) || {};
        pollHealthByUser.set(userId, { ...health, lastError: reason, lastErrorAt: now });
        if (now - lidWarnAt > 60000) {
          lidWarnAt = now;
          console.warn(`[poll:${userId}] Self-chat nao resolvido: ${reason}`);
        }
        return;
      }

      // Resolveu: e o unico sinal confiavel de que o bot consegue mesmo ler
      // o self-chat. O /api/health usa a idade deste timestamp.
      pollHealthByUser.set(userId, {
        ...(pollHealthByUser.get(userId) || {}),
        lastOkAt: Date.now(),
      });

      updateUserLid(result);
      const rawMessages = result.messages;

      for (const raw of rawMessages) {
        const msgTs = raw.timestamp * 1000;
        if (msgTs <= lastSeenTs) continue;
        if (raw.fromMe && botSentBodies.has(userScopedKey(userId, raw.body))) continue;

        console.log(`[poll:${userId}] Nova mensagem: fromMe=${raw.fromMe} type=${raw.type} hasMedia=${raw.hasMedia} body="${raw.body?.slice(0, 60)}"`);

        // Enquete nao e conversa: chegava ao Gemini com body vazio e gerava
        // resposta sem sentido. Tambem nao serve como botao: em 14/10/2026 os
        // votos no self-chat nunca chegaram a sessao web (nem vote_update, nem
        // tabela de votos), criando e votando pelo app ou pelo web.
        if (raw.type === 'poll_creation') continue;

        // Mensagens com mídia (áudio, imagem, video) precisam do downloadMedia funcional.
        // O objeto sintético não tem isso, então busca o Message real via getMessageById.
        if (raw.hasMedia) {
          try {
            // Tenta as formas conhecidas do id: `_serialized` e o toString() do
            // MsgKey. Uma delas pode nao existir dependendo da versao da lib, e
            // getMessageById rejeita id malformado com "Invalid serialized
            // message id specified" — que caia no sintetico sem midia.
            const candidates = [raw.id, raw.idAlt].filter(Boolean);
            let realMessage = null;
            let usedId = null;
            for (const candidate of candidates) {
              try {
                realMessage = await client.getMessageById(candidate);
                if (realMessage) { usedId = candidate; break; }
              } catch (err) {
                console.warn(`[poll:${userId}] getMessageById rejeitou id="${candidate}" (${err?.message}).`);
              }
            }
            if (realMessage) {
              if (usedId !== raw.id) {
                console.log(`[poll:${userId}] Midia resolvida pelo id alternativo: ${usedId}`);
              }
              // downloadMedia() usa this.id._serialized para reencontrar a
              // mensagem na pagina. Se o model veio sem esse campo, o download
              // falha com erro minificado — entao preenche com o id que
              // comprovadamente resolveu.
              if (realMessage.id && !realMessage.id._serialized) {
                realMessage.id._serialized = usedId;
                console.log(`[poll:${userId}] Message.id._serialized ausente; preenchido com ${usedId}`);
              }
              console.log(
                `[poll:${userId}] Midia pronta: type=${realMessage.type} hasMedia=${realMessage.hasMedia} ` +
                `id=${realMessage.id?._serialized || 'AUSENTE'}`
              );
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
              await processIncomingMessage(userId, client, realMessage, 'poll');
              continue;
            }
            // Chegou aqui: nenhuma forma do id resolveu. A midia sera perdida —
            // o sintetico nao tem downloadMedia — entao registra o diagnostico
            // completo em vez de so dizer que falhou.
            console.warn(
              `[poll:${userId}] Midia NAO resolvida. id="${raw.id}" idAlt="${raw.idAlt || '-'}" ` +
              `partes=${String(raw.id).split('_').length} idInStore=${raw.idInStore} type=${raw.type}`
            );
          } catch (err) {
            console.warn(`[poll:${userId}] Falha inesperada ao resolver midia (${err?.message}), fazendo fallback synthetic`);
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

        await processIncomingMessage(userId, client, syntheticMessage, 'poll');
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

// Modo contato: sem self-chat nao ha polling, mas os dois riscos que ele
// vigiava continuam — a pagina recarrega e perde a injecao da lib (bot le e
// nao responde, ver INJECTION_GRACE_MS) ou perde o shim do MsgKey (getChat e
// reply quebram). A cada tick reinstala o shim e confere a injecao; a saude
// fica no mesmo pollHealthByUser que o /api/health ja le.
export function startInjectionWatchdog(sessionId, client, { onInjectionLost } = {}) {
  if (pollIntervals.has(sessionId)) stopSelfChatPolling(sessionId);
  let injectionLostAt = 0;
  let injectionLostReported = false;

  const interval = setInterval(async () => {
    let wwebjsOk = null;
    try {
      wwebjsOk = await client.pupPage.evaluate(() => typeof window.WWebJS?.getChat === 'function');
    } catch { /* pagina navegando: inconclusivo */ }

    const now = Date.now();
    if (wwebjsOk === false) {
      if (!injectionLostAt) {
        injectionLostAt = now;
        console.warn(`[watchdog:${sessionId}] window.WWebJS ausente — aguardando reinjecao da lib.`);
      }
      pollHealthByUser.set(sessionId, {
        ...(pollHealthByUser.get(sessionId) || {}),
        injectionOk: false,
        lastError: 'window.WWebJS ausente (envio indisponivel)',
        lastErrorAt: now,
      });
      if (now - injectionLostAt >= INJECTION_GRACE_MS && !injectionLostReported) {
        injectionLostReported = true;
        console.error(`[watchdog:${sessionId}] window.WWebJS ausente ha ${Math.round((now - injectionLostAt) / 1000)}s — reiniciando instancia.`);
        onInjectionLost?.('window.WWebJS ausente');
      }
      return;
    }
    if (wwebjsOk !== true) return;

    if (injectionLostAt) {
      console.log(`[watchdog:${sessionId}] window.WWebJS restaurado apos ${Math.round((now - injectionLostAt) / 1000)}s.`);
      injectionLostAt = 0;
      injectionLostReported = false;
    }
    try {
      await installMsgKeyShim(client);
    } catch (err) {
      console.warn(`[watchdog:${sessionId}] Falha ao reinstalar o shim do MsgKey:`, err?.message || err);
    }
    pollHealthByUser.set(sessionId, {
      ...(pollHealthByUser.get(sessionId) || {}),
      injectionOk: true,
      lastOkAt: now,
    });
  }, 15_000);

  pollIntervals.set(sessionId, interval);
  console.log(`[watchdog:${sessionId}] Vigia da injecao iniciado (15s).`);
}

export function stopSelfChatPolling(userId) {
  const interval = pollIntervals.get(userId);
  if (!interval) return;
  clearInterval(interval);
  pollIntervals.delete(userId);
  pollHealthByUser.delete(userId);
}
