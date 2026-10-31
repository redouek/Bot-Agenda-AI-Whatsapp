import { getUser } from './database.js';
import { fetchJson, normalizeText } from './http.js';

// Controle da casa pela API REST do Home Assistant (HA_URL + HA_TOKEN, token de
// longa duracao criado no perfil do HA). E uma casa so — a do dono: apenas os
// e-mails de HA_ALLOWED_EMAILS (ou, sem a variavel, os admins) podem usar.
const haUrl = () => (process.env.HA_URL || '').trim().replace(/\/+$/, '');
const haToken = () => (process.env.HA_TOKEN || '').trim();

// Fechaduras e alarmes ficam de fora por padrão: não devem ser acionados por texto livre
const DEFAULT_ALLOWED_DOMAINS = [
  'light', 'switch', 'fan', 'cover', 'climate', 'media_player', 'scene', 'script',
  'input_boolean', 'vacuum', 'sensor', 'binary_sensor',
];
function allowedDomains() {
  const fromEnv = (process.env.HA_ALLOWED_DOMAINS || '').split(',').map(d => d.trim()).filter(Boolean);
  return new Set(fromEnv.length ? fromEnv : DEFAULT_ALLOWED_DOMAINS);
}

const READ_ONLY_DOMAINS = new Set(['sensor', 'binary_sensor']);
const STATES_CACHE_MS = 30 * 1000;

const DOMAIN_HINTS = [
  [/\b(luz|luzes|lampada|lampadas|abajur|iluminacao|led|leds|spot|spots|pendente)\b/, ['light', 'switch']],
  [/\b(ar|ar condicionado|condicionado|climatizador|termostato|aquecedor)\b/, ['climate']],
  [/\b(ventilador|ventiladores|exaustor)\b/, ['fan', 'switch']],
  [/\b(cortina|cortinas|persiana|persianas|portao|garagem|toldo)\b/, ['cover']],
  [/\b(tomada|tomadas|interruptor)\b/, ['switch']],
  [/\b(tv|televisao|televisor|som|caixa de som|alexa|chromecast|spotify)\b/, ['media_player']],
  [/\b(cena|modo)\b/, ['scene']],
  [/\b(rotina|script|automacao)\b/, ['script']],
  [/\b(aspirador|robo)\b/, ['vacuum']],
  [/\b(temperatura|umidade|sensor|consumo|energia|bateria|porta aberta|janela aberta)\b/, ['sensor', 'binary_sensor', 'climate']],
];

const STOPWORDS = new Set([
  'o', 'a', 'os', 'as', 'do', 'da', 'dos', 'das', 'de', 'no', 'na', 'nos', 'nas', 'em', 'e',
  'meu', 'minha', 'todas', 'todos', 'toda', 'todo', 'luz', 'luzes', 'lampada', 'ar',
  'condicionado', 'sensor', 'temperatura',
]);

const STATE_LABELS = {
  on: 'ligado', off: 'desligado', open: 'aberto', closed: 'fechado', opening: 'abrindo',
  closing: 'fechando', unavailable: 'indisponível', unknown: 'desconhecido', playing: 'tocando',
  paused: 'pausado', idle: 'ocioso', standby: 'em espera', heat: 'aquecendo', cool: 'resfriando',
  auto: 'automático', dry: 'desumidificando', fan_only: 'só ventilação', heat_cool: 'automático',
  cleaning: 'limpando', docked: 'na base', returning: 'voltando para a base',
};

let statesCache = { at: 0, items: [] };

export function isHomeAssistantConfigured() {
  return Boolean(haUrl() && haToken());
}

export async function canUseHomeAssistant(userId) {
  const user = await getUser(userId);
  if (!user) return false;
  const allowed = (process.env.HA_ALLOWED_EMAILS || '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  if (allowed.length) return Boolean(user.email && allowed.includes(user.email.toLowerCase()));
  return Boolean(user.is_admin);
}

async function haRequest(path, options = {}) {
  if (!isHomeAssistantConfigured()) {
    throw new Error('Home Assistant nao configurado: defina HA_URL e HA_TOKEN.');
  }
  return fetchJson(`${haUrl()}/api${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${haToken()}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

async function getStates(force = false) {
  if (!force && Date.now() - statesCache.at < STATES_CACHE_MS) return statesCache.items;
  const items = await haRequest('/states');
  const allowed = allowedDomains();
  statesCache = {
    at: Date.now(),
    items: (items || []).filter(s => allowed.has(s.entity_id.split('.')[0])),
  };
  return statesCache.items;
}

function domainOf(entity) {
  return entity.entity_id.split('.')[0];
}

function displayName(entity) {
  return entity.attributes?.friendly_name || entity.entity_id;
}

function searchableText(entity) {
  return normalizeText(`${displayName(entity)} ${entity.entity_id.replace(/[._]/g, ' ')}`);
}

// O primeiro domínio de cada dica é o principal (ex: "luz" -> light; switch só como alternativa)
function hintedDomains(normTarget) {
  const domains = new Set();
  const primary = new Set();
  for (const [pattern, list] of DOMAIN_HINTS) {
    if (!pattern.test(normTarget)) continue;
    list.forEach(d => domains.add(d));
    primary.add(list[0]);
  }
  return { domains, primary };
}

// Retorna as entidades mais compatíveis com o texto (ex: "luz da sala")
export function matchEntities(states, target = '', { all = false, preferWritable = false } = {}) {
  const normTarget = normalizeText(target).replace(/-/g, ' ');
  const { domains: hints, primary } = hintedDomains(normTarget);
  let pool = hints.size ? states.filter(s => hints.has(domainOf(s))) : states;
  if (!pool.length) pool = states;
  if (preferWritable) {
    const writable = pool.filter(s => !READ_ONLY_DOMAINS.has(domainOf(s)));
    if (writable.length) pool = writable;
  }

  const tokens = normTarget.split(/\s+/).filter(t => t && !STOPWORDS.has(t));

  // Ex: "apaga todas as luzes" — sem nome específico, considera todo o domínio principal sugerido
  if (!tokens.length) {
    if (!hints.size) return [];
    const primaryPool = pool.filter(s => primary.has(domainOf(s)));
    return primaryPool.length ? primaryPool : pool;
  }

  const scored = pool
    .map(entity => {
      const text = searchableText(entity);
      const name = normalizeText(displayName(entity));
      let score = tokens.filter(t => text.includes(t)).length;
      if (name === normTarget || name === tokens.join(' ')) score += 3;
      else if (name.includes(normTarget)) score += 2;
      return { entity, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return [];
  if (all) return scored.filter(item => item.score >= tokens.length).map(item => item.entity);
  const best = scored[0].score;
  return scored.filter(item => item.score === best).map(item => item.entity);
}

function formatState(entity) {
  const domain = domainOf(entity);
  const attrs = entity.attributes || {};
  const state = STATE_LABELS[entity.state] || entity.state;
  const name = displayName(entity);

  if (domain === 'sensor') {
    return `${name}: ${entity.state}${attrs.unit_of_measurement ? ` ${attrs.unit_of_measurement}` : ''}`;
  }
  if (domain === 'climate') {
    const parts = [`${name}: ${state}`];
    if (attrs.current_temperature != null) parts.push(`ambiente ${attrs.current_temperature}°C`);
    if (attrs.temperature != null && entity.state !== 'off') parts.push(`ajustado para ${attrs.temperature}°C`);
    return parts.join(', ');
  }
  if (domain === 'light' && entity.state === 'on' && attrs.brightness != null) {
    return `${name}: ligada, brilho ${Math.round((attrs.brightness / 255) * 100)}%`;
  }
  if (domain === 'cover' && attrs.current_position != null) {
    return `${name}: ${state} (${attrs.current_position}%)`;
  }
  return `${name}: ${state}`;
}

function resolveService(domain, action, value) {
  if (domain === 'cover') {
    const map = { turn_on: 'open_cover', turn_off: 'close_cover', toggle: 'toggle' };
    if (action === 'set_value' && value != null) return { service: 'set_cover_position', data: { position: Number(value) } };
    return map[action] ? { service: map[action], data: {} } : null;
  }
  if (domain === 'scene' || domain === 'script') {
    return action === 'turn_on' || action === 'toggle' ? { service: 'turn_on', data: {} } : null;
  }
  if (domain === 'vacuum') {
    const map = { turn_on: 'start', turn_off: 'return_to_base', toggle: 'start' };
    return map[action] ? { service: map[action], data: {} } : null;
  }
  if (domain === 'climate' && action === 'set_value' && value != null) {
    return { service: 'set_temperature', data: { temperature: Number(value) } };
  }
  if (domain === 'light' && action === 'set_value' && value != null) {
    return { service: 'turn_on', data: { brightness_pct: Math.min(Math.max(Number(value), 1), 100) } };
  }
  if (domain === 'light' && action === 'turn_on' && value != null) {
    return { service: 'turn_on', data: { brightness_pct: Math.min(Math.max(Number(value), 1), 100) } };
  }
  if (domain === 'fan' && action === 'set_value' && value != null) {
    return { service: 'set_percentage', data: { percentage: Number(value) } };
  }
  if (domain === 'media_player' && action === 'set_value' && value != null) {
    return { service: 'volume_set', data: { volume_level: Math.min(Math.max(Number(value), 0), 100) / 100 } };
  }
  if (['turn_on', 'turn_off', 'toggle'].includes(action) && !READ_ONLY_DOMAINS.has(domain)) {
    return { service: action, data: {} };
  }
  return null;
}

const ACTION_LABELS = {
  turn_on: 'Ligado', turn_off: 'Desligado', toggle: 'Alternado', set_value: 'Ajustado',
  open_cover: 'Aberto', close_cover: 'Fechado', set_cover_position: 'Posicionado',
  start: 'Iniciado', return_to_base: 'Enviado para a base', set_temperature: 'Temperatura ajustada',
};

export async function executeOnEntities(entities, action, value = null) {
  const done = [];
  const skipped = [];

  for (const entity of entities) {
    const domain = domainOf(entity);
    const resolved = resolveService(domain, action, value);
    if (!resolved) {
      skipped.push(displayName(entity));
      continue;
    }
    await haRequest(`/services/${domain}/${resolved.service}`, {
      method: 'POST',
      body: JSON.stringify({ entity_id: entity.entity_id, ...resolved.data }),
    });
    const valueText = value != null && action === 'set_value'
      ? ` (${value}${domain === 'climate' ? '°C' : '%'})`
      : '';
    done.push(`${ACTION_LABELS[resolved.service] || ACTION_LABELS[action] || 'Executado'}: ${displayName(entity)}${valueText}`);
  }

  statesCache.at = 0;
  const lines = [...done];
  if (skipped.length) lines.push(`Não sei executar essa ação em: ${skipped.join(', ')}`);
  return lines.join('\n') || 'Nada foi executado.';
}

function formatEntityChoice(entities) {
  return entities.map((e, i) => `${i + 1}. ${displayName(e)} (${STATE_LABELS[e.state] || e.state})`).join('\n');
}

// home: { action: "turn_on|turn_off|toggle|set_value|status|list", target, value, all }
export async function runHomeAction(userId, home = {}) {
  if (!isHomeAssistantConfigured() || !await canUseHomeAssistant(userId)) {
    return { reply: 'O controle da casa nao esta disponivel para a sua conta.', pendingAction: null };
  }

  const action = home.action || 'status';
  const states = await getStates(action === 'status' || action === 'list');

  if (action === 'list') {
    const writable = states.filter(s => !READ_ONLY_DOMAINS.has(domainOf(s)));
    const pool = home.target ? matchEntities(writable, home.target, { all: true }) : writable;
    if (!pool.length) return { reply: 'Não encontrei dispositivos controláveis.', pendingAction: null };
    const shown = pool.slice(0, 30).map(e => `- ${formatState(e)}`);
    const more = pool.length > shown.length ? `\n...e mais ${pool.length - shown.length}` : '';
    return { reply: `Dispositivos:\n${shown.join('\n')}${more}`, pendingAction: null };
  }

  const isWrite = action !== 'status';
  const matches = matchEntities(states, home.target || '', { all: Boolean(home.all), preferWritable: isWrite });

  if (!matches.length) {
    return {
      reply: `Não encontrei nenhum dispositivo para "${home.target || ''}". Diga "lista meus dispositivos" para ver os nomes.`,
      pendingAction: null,
    };
  }

  if (!isWrite) {
    return { reply: matches.slice(0, 15).map(formatState).join('\n'), pendingAction: null };
  }

  if (matches.length > 1 && !home.all) {
    return {
      reply: `Encontrei ${matches.length} dispositivos para "${home.target}". Responda o numero, ou "todos":\n${formatEntityChoice(matches)}`,
      pendingAction: {
        type: 'choice',
        action: 'home',
        homeAction: action,
        value: home.value ?? null,
        choices: matches.map(e => ({ entityId: e.entity_id, summary: displayName(e) })),
        createdAt: Date.now(),
      },
    };
  }

  return { reply: await executeOnEntities(matches, action, home.value ?? null), pendingAction: null };
}

// Resposta numerica ("1", "todos") a um pedido ambiguo. Confere a permissao de
// novo: a escolha pendente nao deve sobreviver a uma mudanca de HA_ALLOWED_EMAILS.
export async function executeHomeChoice(userId, pending, choices) {
  if (!await canUseHomeAssistant(userId)) return 'O controle da casa nao esta disponivel para a sua conta.';
  const ids = choices.map(c => c.entityId);
  const states = await getStates(true);
  const entities = states.filter(s => ids.includes(s.entity_id));
  return executeOnEntities(entities, pending.homeAction, pending.value);
}
