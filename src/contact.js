// Modo contato (AGENDA_MODE=contact): a agenda atende por um numero proprio, e
// cada usuario conversa com ele como um contato normal. Substitui o self-chat,
// de onde vinham o polling, o LID e os eventos que nao disparavam.
//
// Quem pode falar com o bot: so quem tem telefone cadastrado no painel
// (users.assistant_chat_id). Qualquer outro numero e ignorado em silencio —
// responder estranhos expoe a agenda e conta contra o numero no WhatsApp.

import { getWhatsAppSession, listUsers } from './database.js';
import { processIncomingMessage, setContactChatId, getContactChatId, startReminderLoop } from './bot.js';
import { fixMsgId } from './compat.js';

const digitsOf = value => String(value || '').split('@')[0].replace(/\D/g, '');

// Celulares brasileiros ganharam o 9o digito entre 2012 e 2016, mas contas
// antigas continuam registradas sem ele no WhatsApp: o mesmo telefone aparece
// como 5511994783997 (cadastro) e 551194783997 (WhatsApp). So celular antigo
// (6-9 depois do DDD) tem as duas formas: um fixo (2-5) nunca ganhou o 9.
function phoneVariants(value) {
  const d = digitsOf(value);
  if (!d) return [];
  const variants = new Set([d]);
  if (d.startsWith('55')) {
    if (d.length === 13 && d[4] === '9' && /[6-9]/.test(d[5])) variants.add(d.slice(0, 4) + d.slice(5));
    if (d.length === 12 && /[6-9]/.test(d[4])) variants.add(`${d.slice(0, 4)}9${d.slice(4)}`);
  }
  return [...variants];
}

export function samePhone(a, b) {
  const right = new Set(phoneVariants(b));
  return phoneVariants(a).some(v => right.has(v));
}

// O remetente pode vir como telefone (@c.us) ou como LID (@lid), um id
// interno do WhatsApp sem relacao com o numero. LID nao resolvido = remetente
// desconhecido, e o bot nao responderia nem ao dono.
const phoneByLid = new Map();

async function senderPhone(client, message) {
  const from = message.from || '';
  if (from.endsWith('@c.us')) return digitsOf(from);
  if (!from.endsWith('@lid')) return '';
  if (phoneByLid.has(from)) return phoneByLid.get(from);

  let phone = '';
  try {
    const [res] = await client.getContactLidAndPhone([from]);
    phone = digitsOf(res?.pn);
  } catch (err) {
    console.warn('[agenda-bot] getContactLidAndPhone falhou:', err?.message || err);
  }
  if (!phone) {
    try {
      phone = digitsOf((await message.getContact())?.number);
    } catch { /* sem contato resolvido */ }
  }
  if (phone) phoneByLid.set(from, phone);
  return phone;
}

async function findUserBySender(client, message) {
  const users = (await listUsers()).filter(u => u.assistant_chat_id);
  // Atalho: o LID do usuario ja conhecido do modo self-chat.
  const byLid = users.find(u => u.self_chat_lid && u.self_chat_lid === message.from);
  if (byLid) return { user: byLid, phone: digitsOf(byLid.assistant_chat_id) };

  const phone = await senderPhone(client, message);
  const user = phone ? users.find(u => samePhone(u.assistant_chat_id, phone)) : null;
  return { user: user || null, phone };
}

async function isPaused(userId) {
  return (await getWhatsAppSession(userId))?.status === 'paused';
}

// Fixa o chat do usuario com o bot no id que o WhatsApp reconhece. getNumberId
// devolve a forma registrada (resolve o 9o digito); sem ele, o telefone cru.
async function primeContactChat(client, user) {
  if (getContactChatId(user.id)) return;
  let chatId = '';
  try {
    chatId = (await client.getNumberId(digitsOf(user.assistant_chat_id)))?._serialized || '';
  } catch (err) {
    console.warn(`[agenda-bot] getNumberId falhou para ${user.id}:`, err?.message || err);
  }
  if (!chatId) {
    console.warn(`[agenda-bot] Telefone de ${user.id} nao encontrado no WhatsApp — lembretes vao para o numero cadastrado.`);
    return;
  }
  setContactChatId(user.id, chatId);
}

// Liga um usuario ao client do bot: chat resolvido e lembretes rodando.
export async function attachUserToBot(client, user) {
  if (!client || !user?.assistant_chat_id) return;
  if (await isPaused(user.id)) return;
  await primeContactChat(client, user);
  startReminderLoop(user.id, client);
}

export async function attachAllUsersToBot(client) {
  const users = (await listUsers()).filter(u => u.assistant_chat_id);
  for (const user of users) {
    await attachUserToBot(client, user).catch(err => {
      console.warn(`[agenda-bot] Falha ao ligar ${user.id} ao bot:`, err?.message || err);
    });
  }
  return users.map(u => u.id);
}

// Evento 'message' do client do bot: so mensagens recebidas (nao fromMe).
export async function handleContactMessage(client, message, { sessionStart } = {}) {
  fixMsgId(message);
  if (message.fromMe || message.isStatus) return;
  // So conversas individuais: grupos (@g.us), status e canais ficam de fora.
  if (!/@(c\.us|lid)$/.test(message.from || '')) return;
  // Mensagens da janela em que o bot estava fora nao sao reprocessadas.
  if (sessionStart && message.timestamp && message.timestamp * 1000 < sessionStart) return;

  const { user, phone } = await findUserBySender(client, message);
  if (!user) {
    // Final do numero basta para diagnostico sem gravar telefone de terceiro.
    console.log(`[agenda-bot] Mensagem de numero nao cadastrado ignorada (final ${phone ? phone.slice(-4) : '????'}).`);
    return;
  }
  if (await isPaused(user.id)) {
    console.log(`[agenda-bot] ${user.id} esta pausado; mensagem ignorada.`);
    return;
  }

  // Primeira mensagem antes do getNumberId resolver: usa o proprio chat.
  if (!getContactChatId(user.id)) setContactChatId(user.id, message.from);
  await processIncomingMessage(user.id, client, message, 'contact');
}
