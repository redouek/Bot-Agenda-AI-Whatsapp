import { getConfig } from './config.js';
import { fetchJson, normalizeText, toLocalDateString } from './http.js';

// BrasilAPI: gratuita e sem chave (https://brasilapi.com.br)
const BRASIL_API_BASE_URL = process.env.BRASIL_API_BASE_URL || 'https://brasilapi.com.br/api';

const timeZone = () => getConfig().DEFAULT_TIMEZONE || 'America/Sao_Paulo';

const holidayCache = new Map();

function onlyDigits(value = '') {
  return String(value).replace(/\D/g, '');
}

function formatDateBR(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

export async function getHolidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const holidays = await fetchJson(`${BRASIL_API_BASE_URL}/feriados/v1/${year}`);
  holidayCache.set(year, holidays || []);
  return holidays || [];
}

// Retorna o feriado nacional na data do evento, se houver
export async function findHolidayOn(dateValue) {
  const localDate = toLocalDateString(dateValue, timeZone());
  const holidays = await getHolidays(Number(localDate.slice(0, 4)));
  return holidays.find(h => h.date === localDate) || null;
}

export async function lookupHolidays(query = '') {
  const currentYear = Number(toLocalDateString(new Date(), timeZone()).slice(0, 4));
  const yearMatch = /\b(19|20)\d{2}\b/.exec(query);
  const year = yearMatch ? Number(yearMatch[0]) : currentYear;
  const holidays = await getHolidays(year);

  if (!holidays.length) {
    return { reply: `Não encontrei feriados nacionais para ${year}.`, pendingAction: null };
  }

  const today = toLocalDateString(new Date(), timeZone());
  const wantsNext = /\bproxim/.test(normalizeText(query));
  if (wantsNext) {
    const upcoming = [...holidays, ...(year === currentYear ? await getHolidays(year + 1) : [])]
      .find(h => h.date >= today);
    if (upcoming) {
      return {
        reply: `Próximo feriado nacional: *${upcoming.name}* em ${formatDateBR(upcoming.date)}${upcoming.weekday ? ` (${upcoming.weekday})` : ''}.`,
        pendingAction: null,
      };
    }
  }

  const lines = holidays.map(h => {
    const past = year === currentYear && h.date < today ? ' ✓' : '';
    return `- ${formatDateBR(h.date)} ${h.weekday ? `(${h.weekday}) ` : ''}— ${h.name}${past}`;
  });

  return {
    reply: `Feriados nacionais de ${year}:\n${lines.join('\n')}`,
    pendingAction: null,
  };
}

export async function getCep(cep) {
  return fetchJson(`${BRASIL_API_BASE_URL}/cep/v2/${onlyDigits(cep)}`);
}

export async function lookupCep(query) {
  const cep = onlyDigits(query);
  if (cep.length !== 8) {
    return { reply: 'Me envie um CEP com 8 dígitos (ex: 01310-100).', pendingAction: null };
  }

  try {
    const data = await getCep(cep);
    const parts = [data.street, data.neighborhood, `${data.city} - ${data.state}`].filter(Boolean);
    return {
      reply: `CEP ${cep.slice(0, 5)}-${cep.slice(5)}: ${parts.join(', ')}`,
      pendingAction: null,
    };
  } catch (error) {
    if (error.status === 404) return { reply: `Não encontrei o CEP ${cep}.`, pendingAction: null };
    throw error;
  }
}

export async function lookupCnpj(query) {
  const cnpj = onlyDigits(query);
  if (cnpj.length !== 14) {
    return { reply: 'Me envie um CNPJ com 14 dígitos.', pendingAction: null };
  }

  try {
    const data = await fetchJson(`${BRASIL_API_BASE_URL}/cnpj/v1/${cnpj}`);
    const address = [
      [data.logradouro, data.numero].filter(Boolean).join(', '),
      data.bairro,
      data.municipio && data.uf ? `${data.municipio} - ${data.uf}` : '',
    ].filter(Boolean).join(', ');

    const lines = [
      `*${data.razao_social}*`,
      data.nome_fantasia ? `Nome fantasia: ${data.nome_fantasia}` : '',
      `Situação: ${data.descricao_situacao_cadastral || 'não informada'}`,
      data.cnae_fiscal_descricao ? `Atividade: ${data.cnae_fiscal_descricao}` : '',
      data.data_inicio_atividade ? `Abertura: ${formatDateBR(data.data_inicio_atividade)}` : '',
      address ? `Endereço: ${address}` : '',
      data.ddd_telefone_1 ? `Telefone: ${data.ddd_telefone_1}` : '',
    ].filter(Boolean);

    return { reply: lines.join('\n'), pendingAction: null };
  } catch (error) {
    if (error.status === 404) return { reply: `Não encontrei o CNPJ ${cnpj}.`, pendingAction: null };
    if (error.status === 403 || error.status === 429) {
      return { reply: 'A consulta de CNPJ da BrasilAPI recusou a requisição agora. Tente novamente mais tarde.', pendingAction: null };
    }
    throw error;
  }
}

export async function lookupDdd(query) {
  const ddd = onlyDigits(query).slice(0, 2);
  if (ddd.length !== 2) {
    return { reply: 'Me envie um DDD com 2 dígitos (ex: 11).', pendingAction: null };
  }

  try {
    const data = await fetchJson(`${BRASIL_API_BASE_URL}/ddd/v1/${ddd}`);
    const cities = (data.cities || []).slice().sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const shown = cities.slice(0, 15).map(c => c.charAt(0) + c.slice(1).toLowerCase());
    const more = cities.length > shown.length ? ` e mais ${cities.length - shown.length}` : '';
    return {
      reply: `DDD ${ddd} (${data.state}): ${shown.join(', ')}${more}.`,
      pendingAction: null,
    };
  } catch (error) {
    if (error.status === 404) return { reply: `Não encontrei o DDD ${ddd}.`, pendingAction: null };
    throw error;
  }
}
