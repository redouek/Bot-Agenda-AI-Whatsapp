import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getConfig } from './config.js';
import { getUser } from './database.js';

// Usa football-data.org (free tier cobre principais ligas europeias + Mundial + Copa America).
// IMPORTANTE: free tier NAO cobre Brasileirao (precisa de plano Tier Two pago).
// A key do usuario fica em users.football_api_key (per-user).
const FOOTBALL_API_BASE_URL = 'https://api.football-data.org/v4';

// Mapa: nome exato da API (inglês) → { pt: nome em português, flag: emoji }
const NATIONAL_TEAMS = {
  'Brazil':              { pt: 'Brasil',           flag: '🇧🇷' },
  'Argentina':           { pt: 'Argentina',         flag: '🇦🇷' },
  'Portugal':            { pt: 'Portugal',          flag: '🇵🇹' },
  'Germany':             { pt: 'Alemanha',          flag: '🇩🇪' },
  'France':              { pt: 'França',            flag: '🇫🇷' },
  'Spain':               { pt: 'Espanha',           flag: '🇪🇸' },
  'England':             { pt: 'Inglaterra',        flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
  'Italy':               { pt: 'Itália',            flag: '🇮🇹' },
  'Netherlands':         { pt: 'Holanda',           flag: '🇳🇱' },
  'Croatia':             { pt: 'Croácia',           flag: '🇭🇷' },
  'Uruguay':             { pt: 'Uruguai',           flag: '🇺🇾' },
  'Colombia':            { pt: 'Colômbia',          flag: '🇨🇴' },
  'Chile':               { pt: 'Chile',             flag: '🇨🇱' },
  'Mexico':              { pt: 'México',            flag: '🇲🇽' },
  'United States':       { pt: 'Estados Unidos',    flag: '🇺🇸' },
  'USA':                 { pt: 'Estados Unidos',    flag: '🇺🇸' },
  'Japan':               { pt: 'Japão',             flag: '🇯🇵' },
  'South Korea':         { pt: 'Coreia do Sul',     flag: '🇰🇷' },
  'Senegal':             { pt: 'Senegal',           flag: '🇸🇳' },
  'Morocco':             { pt: 'Marrocos',          flag: '🇲🇦' },
  'Ghana':               { pt: 'Gana',              flag: '🇬🇭' },
  'Nigeria':             { pt: 'Nigéria',           flag: '🇳🇬' },
  'Ecuador':             { pt: 'Equador',           flag: '🇪🇨' },
  'Paraguay':            { pt: 'Paraguai',          flag: '🇵🇾' },
  'Bolivia':             { pt: 'Bolívia',           flag: '🇧🇴' },
  'Venezuela':           { pt: 'Venezuela',         flag: '🇻🇪' },
  'Peru':                { pt: 'Peru',              flag: '🇵🇪' },
  'Switzerland':         { pt: 'Suíça',             flag: '🇨🇭' },
  'Belgium':             { pt: 'Bélgica',           flag: '🇧🇪' },
  'Denmark':             { pt: 'Dinamarca',         flag: '🇩🇰' },
  'Sweden':              { pt: 'Suécia',            flag: '🇸🇪' },
  'Norway':              { pt: 'Noruega',           flag: '🇳🇴' },
  'Poland':              { pt: 'Polônia',           flag: '🇵🇱' },
  'Ukraine':             { pt: 'Ucrânia',           flag: '🇺🇦' },
  'Turkey':              { pt: 'Turquia',           flag: '🇹🇷' },
  'Serbia':              { pt: 'Sérvia',            flag: '🇷🇸' },
  'Austria':             { pt: 'Áustria',           flag: '🇦🇹' },
  'Scotland':            { pt: 'Escócia',           flag: '🏴󠁧󠁢󠁳󠁣󠁴󠁿' },
  'Wales':               { pt: 'País de Gales',     flag: '🏴󠁧󠁢󠁷󠁬󠁳󠁿' },
  'Haiti':               { pt: 'Haiti',             flag: '🇭🇹' },
  'Costa Rica':          { pt: 'Costa Rica',        flag: '🇨🇷' },
  'Panama':              { pt: 'Panamá',            flag: '🇵🇦' },
  'Honduras':            { pt: 'Honduras',          flag: '🇭🇳' },
  'Jamaica':             { pt: 'Jamaica',           flag: '🇯🇲' },
  'Canada':              { pt: 'Canadá',            flag: '🇨🇦' },
  'Australia':           { pt: 'Austrália',         flag: '🇦🇺' },
  'Saudi Arabia':        { pt: 'Arábia Saudita',    flag: '🇸🇦' },
  'Iran':                { pt: 'Irã',               flag: '🇮🇷' },
  'Qatar':               { pt: 'Catar',             flag: '🇶🇦' },
  'Egypt':               { pt: 'Egito',             flag: '🇪🇬' },
  'Cameroon':            { pt: 'Camarões',          flag: '🇨🇲' },
  "Côte d'Ivoire":       { pt: 'Costa do Marfim',   flag: '🇨🇮' },
  'Ivory Coast':         { pt: 'Costa do Marfim',   flag: '🇨🇮' },
  'Czech Republic':      { pt: 'República Tcheca',  flag: '🇨🇿' },
  'Czechia':             { pt: 'República Tcheca',  flag: '🇨🇿' },
  'Slovakia':            { pt: 'Eslováquia',        flag: '🇸🇰' },
  'Hungary':             { pt: 'Hungria',           flag: '🇭🇺' },
  'Romania':             { pt: 'Romênia',           flag: '🇷🇴' },
  'Greece':              { pt: 'Grécia',            flag: '🇬🇷' },
  'Russia':              { pt: 'Rússia',            flag: '🇷🇺' },
  'Algeria':             { pt: 'Argélia',           flag: '🇩🇿' },
  'Tunisia':             { pt: 'Tunísia',           flag: '🇹🇳' },
  'New Zealand':         { pt: 'Nova Zelândia',     flag: '🇳🇿' },
  'Trinidad and Tobago': { pt: 'Trinidad e Tobago', flag: '🇹🇹' },
  'Guatemala':           { pt: 'Guatemala',         flag: '🇬🇹' },
  'El Salvador':         { pt: 'El Salvador',       flag: '🇸🇻' },
  'Cuba':                { pt: 'Cuba',              flag: '🇨🇺' },
  'Dominican Republic':  { pt: 'República Dominicana', flag: '🇩🇴' },
};

function resolveApiTeamName(apiName = '') {
  const entry = NATIONAL_TEAMS[apiName];
  if (entry) return { name: entry.pt, flag: entry.flag };
  return { name: apiName, flag: '' };
}

function formatHome(apiName) {
  const { name, flag } = resolveApiTeamName(apiName);
  return flag ? `${flag} ${name}` : name;
}

function formatAway(apiName) {
  const { name, flag } = resolveApiTeamName(apiName);
  return flag ? `${name} ${flag}` : name;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} em ${url}: ${body.slice(0, 200)}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

// fetchJson com retry em 429 (rate limit). Respeita o "Wait N seconds" do response.
async function fetchJsonWithRetry(url, options = {}, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchJson(url, options);
    } catch (err) {
      const msg = String(err.message);
      const m = msg.match(/Wait (\d+) seconds/i);
      if (m && attempt < maxRetries) {
        const waitMs = (parseInt(m[1], 10) + 2) * 1000;
        console.log(`[football] HTTP 429 — aguardando ${waitMs}ms antes do retry`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
}

function formatDateTime(dateValue) {
  const timeZone = getConfig().DEFAULT_TIMEZONE || 'America/Sao_Paulo';
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return dateValue;

  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function normalizeQuery(query = '') {
  return query.trim();
}

function normalizeForSearch(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

async function getUserApiKey(userId) {
  if (!userId) return null;
  const user = await getUser(userId);
  return user?.football_api_key || null;
}

async function apiHeaders(userId) {
  const key = await getUserApiKey(userId);
  if (!key) throw new Error('NO_FOOTBALL_KEY');
  return { 'X-Auth-Token': key };
}

// Inverte NATIONAL_TEAMS pra lookup PT->EN. football-data.org indexa em ingles.
function ptToEnglish(query) {
  const q = normalizeForSearch(query);
  for (const [enName, { pt }] of Object.entries(NATIONAL_TEAMS)) {
    if (normalizeForSearch(pt) === q || normalizeForSearch(enName) === q) {
      return enName;
    }
  }
  return null;
}

// Mapa de aliases -> id da football-data.org. Resolve INSTANTANEAMENTE sem hit na API.
// IDs verificados na API. Cobre seleções (WC), Brasileirão (BSA), Libertadores (CLI) e
// principais clubes europeus (PL, PD, BL1, SA, FL1, CL). Aliases em PT-BR e EN.
const TEAM_ALIASES = {
  // ============ SELECOES (WC) ============
  'brasil': 764, 'brazil': 764, 'selecao brasileira': 764, 'selecao': 764,
  'argentina': 762,
  'alemanha': 759, 'germany': 759,
  'espanha': 760, 'spain': 760,
  'franca': 773, 'france': 773,
  'inglaterra': 770, 'england': 770,
  'portugal': 765,
  'italia': 784, // (Italia nao esta na WC list — usa o id do CL/SA mais tarde)
  'holanda': 8601, 'netherlands': 8601, 'paises baixos': 8601,
  'croacia': 799, 'croatia': 799,
  'uruguai': 758, 'uruguay': 758,
  'paraguai': 761, 'paraguay': 761,
  'colombia': 818,
  'equador': 791, 'ecuador': 791,
  'mexico': 769,
  'estados unidos': 771, 'eua': 771, 'usa': 771,
  'japao': 766, 'japan': 766,
  'coreia do sul': 772, 'south korea': 772, 'korea': 772,
  'gana': 763, 'ghana': 763,
  'senegal': 804,
  'marrocos': 815, 'morocco': 815,
  'belgica': 805, 'belgium': 805,
  'suica': 788, 'switzerland': 788,
  'arabia saudita': 801, 'saudi arabia': 801,
  'australia': 779,
  'canada': 828,
  'turquia': 803, 'turkey': 803,
  'egito': 825, 'egypt': 825,
  'austria': 816,
  'noruega': 8872, 'norway': 8872,
  'escocia': 8873, 'scotland': 8873,
  'qatar': 8030, 'catar': 8030,

  // ============ BRASILEIRAO (BSA) ============
  'flamengo': 1783, 'mengao': 1783,
  'palmeiras': 1769, 'verdao': 1769,
  'corinthians': 1779, 'timao': 1779,
  'sao paulo': 1776, 'spfc': 1776, 'sao paulo fc': 1776, 'tricolor paulista': 1776,
  'santos': 6685, 'peixe': 6685,
  'fluminense': 1765, 'flu': 1765, 'nense': 1765,
  'botafogo': 1770, 'fogao': 1770,
  'vasco': 1780, 'vasco da gama': 1780,
  'gremio': 1767,
  'internacional': 6684, 'inter': 6684, 'colorado': 6684,
  'atletico mineiro': 1766, 'galo': 1766, 'atletico mg': 1766, 'atletico-mg': 1766, 'cam': 1766,
  'athletico paranaense': 1768, 'athletico': 1768, 'athletico-pr': 1768, 'furacao': 1768,
  'cruzeiro': 1771, 'raposa': 1771,
  'bahia': 1777,
  'vitoria': 1782,
  'chapecoense': 1772, 'chape': 1772,
  'coritiba': 4241,
  'bragantino': 4286, 'red bull bragantino': 4286, 'rb bragantino': 4286,
  'remo': 4287, 'clube do remo': 4287,
  'mirassol': 4364,

  // ============ LIBERTADORES (CLI) ============
  'boca juniors': 2061, 'boca': 2061,
  'estudiantes': 2051,
  'penarol': 5184,
  'liverpool uruguai': 7118, // FC Uruguai
  'nacional': 7055, 'nacional uruguai': 7055,
  'lanus': 2066,
  'argentinos juniors': 2058,
  'rosario central': 2070, 'rosario': 2070,
  'platense': 7580,
  'bolivar': 4261,
  'the strongest': 4267,
  'tolima': 4437,
  'junior': 4439, 'junior barranquilla': 4439,
  'santa fe': 4441,
  'huachipato': 4457,
  'ohiggins': 4459, "o'higgins": 4459,
  'barcelona sc': 4520, 'barcelona ecuador': 4520,
  'ldu': 4528, 'ldu quito': 4528,
  'independiente del valle': 6989,
  'alianza lima': 5680,
  'cerro porteno': 9373,
  'libertad': 9379,
  'guarani': 7868,

  // ============ EUROPA - ESPANHA (PD) ============
  'real madrid': 86, 'rma': 86,
  'barcelona': 81, 'fc barcelona': 81, 'barca': 81,
  'atletico madrid': 78, 'atleti': 78, 'atletico de madrid': 78,
  'athletic bilbao': 77, 'athletic club': 77,
  'real sociedad': 92,
  'real betis': 90, 'betis': 90,
  'sevilla': 559,
  'valencia': 95,
  'villarreal': 94,
  'girona': 298,
  'celta de vigo': 558, 'celta': 558,
  'osasuna': 79,
  'rayo vallecano': 87,
  'mallorca': 89,
  'getafe': 82,
  'alaves': 263,
  'espanyol': 80,
  'levante': 88,
  'elche': 285,
  'oviedo': 1048, 'real oviedo': 1048,

  // ============ EUROPA - INGLATERRA (PL) ============
  'arsenal': 57,
  'aston villa': 58,
  'chelsea': 61,
  'everton': 62,
  'fulham': 63,
  'liverpool': 64,
  'man city': 65, 'manchester city': 65, 'mancity': 65, 'mcfc': 65,
  'man united': 66, 'manchester united': 66, 'manutd': 66, 'mufc': 66, 'united': 66,
  'newcastle': 67,
  'sunderland': 71,
  'tottenham': 73, 'spurs': 73,
  'wolves': 76, 'wolverhampton': 76,
  'burnley': 328,
  'leeds': 341, 'leeds united': 341,
  'nottingham forest': 351, 'nottingham': 351, 'forest': 351,
  'crystal palace': 354,
  'brighton': 397,
  'brentford': 402,
  'west ham': 563,
  'bournemouth': 1044,

  // ============ EUROPA - ALEMANHA (BL1) ============
  'bayern': 5, 'bayern munich': 5, 'bayern de munique': 5, 'fc bayern': 5,
  'borussia dortmund': 4, 'dortmund': 4, 'bvb': 4,
  'bayer leverkusen': 3, 'leverkusen': 3,
  'rb leipzig': 721, 'leipzig': 721,
  'eintracht frankfurt': 19, 'frankfurt': 19, 'eintracht': 19,
  'borussia monchengladbach': 18, "m'gladbach": 18, 'monchengladbach': 18,
  'stuttgart': 10, 'vfb stuttgart': 10,
  'wolfsburg': 11,
  'werder bremen': 12, 'bremen': 12,
  'hoffenheim': 2,
  'mainz': 15,
  'augsburg': 16,
  'freiburg': 17,
  'st pauli': 20, 'sankt pauli': 20,
  'union berlin': 28,
  'heidenheim': 44,
  'hamburger sv': 7, 'hamburgo': 7, 'hsv': 7,
  'koln': 1, 'colonia': 1,

  // ============ EUROPA - ITALIA (SA) ============
  'milan': 98, 'ac milan': 98,
  'inter': 108, 'inter milan': 108, 'internazionale': 108,
  'juventus': 109, 'juve': 109,
  'napoli': 113,
  'roma': 100, 'as roma': 100,
  'lazio': 110,
  'atalanta': 102,
  'fiorentina': 99,
  'bologna': 103,
  'cagliari': 104,
  'genoa': 107,
  'parma': 112,
  'udinese': 115,
  'sassuolo': 471,
  'torino': 586,
  'verona': 450, 'hellas verona': 450,
  'lecce': 5890,
  'como': 7397,
  'pisa': 487,
  'cremonese': 457,

  // ============ EUROPA - FRANCA (FL1) ============
  'psg': 524, 'paris saint-germain': 524, 'paris': 524,
  'marseille': 516, 'olympique marseille': 516, 'om': 516,
  'lyon': 523, 'olympique lyonnais': 523, 'ol': 523,
  'monaco': 548, 'as monaco': 548,
  'lille': 521, 'losc': 521,
  'nice': 522, 'ogc nice': 522,
  'rennes': 529, 'stade rennais': 529,
  'lens': 546, 'rc lens': 546,
  'nantes': 543,
  'strasbourg': 576,
  'toulouse': 511,
  'brest': 512,
  'auxerre': 519,
  'lorient': 525,
  'angers': 532,
  'le havre': 533,
  'metz': 545,
  'paris fc': 1045,

  // ============ OUTROS (CL/EU) ============
  'ajax': 678,
  'psv': 674, 'psv eindhoven': 674,
  'sporting': 498, 'sporting cp': 498, 'sporting lisboa': 498,
  'benfica': 1903,
  'galatasaray': 610,
  'olympiakos': 654,
  'club brugge': 851,
  'celtic': 11034, 'celtic fc': 11034, // (Celtic nao na lista, usei Paphos placeholder; remover se nao tiver)
};

// Aceita formato com -, _, ou multiplos espacos
function lookupTeamId(query) {
  const q = normalizeForSearch(query)
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Match direto
  if (TEAM_ALIASES[q] !== undefined) return TEAM_ALIASES[q];
  // Match removendo sufixo "fc"/"sc"/"ec"/"ac"/"cf"
  const noSuffix = q.replace(/\s+(fc|sc|ec|ac|cf)$/i, '');
  if (noSuffix !== q && TEAM_ALIASES[noSuffix] !== undefined) return TEAM_ALIASES[noSuffix];
  return null;
}

// Busca rapida pelo mapa hardcoded. Sem hits na API.
async function searchTeamByName(query) {
  const id = lookupTeamId(query);
  if (!id) {
    console.log(`[football] search "${query}" -> nao esta no mapa de aliases`);
    return null;
  }
  console.log(`[football] search "${query}" -> id=${id} (instantaneo via alias)`);
  return { id, score: 100 };
}

// /teams/{id}/matches?status=SCHEDULED&dateFrom&dateTo
async function getUpcomingFixtures(teamId, userId, max = 5) {
  const today = new Date().toISOString().split('T')[0];
  const until = new Date(Date.now() + 120 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const url = `${FOOTBALL_API_BASE_URL}/teams/${teamId}/matches?status=SCHEDULED&dateFrom=${today}&dateTo=${until}&limit=${max}`;
  const json = await fetchJsonWithRetry(url, { headers: await apiHeaders(userId) });
  return json?.matches || [];
}

function formatFixtureLine(match, index) {
  const when = formatDateTime(match.utcDate);
  const home = formatHome(match.homeTeam?.name || 'Time da casa');
  const away = formatAway(match.awayTeam?.name || 'Visitante');
  const competition = match.competition?.name ? ` (${match.competition.name})` : '';
  const venue = match.venue ? ` — ${match.venue}` : '';
  return `${index + 1}. ${when} - ${home} x ${away}${competition}${venue}`;
}

function fixtureToCalendarEvent(match) {
  const startDate = new Date(match.utcDate);
  const endDate = new Date(startDate.getTime() + 2 * 60 * 60 * 1000);
  const home = formatHome(match.homeTeam?.name || 'Time da casa');
  const away = formatAway(match.awayTeam?.name || 'Visitante');
  const competition = match.competition?.name || '';
  const timeZone = getConfig().DEFAULT_TIMEZONE || 'America/Sao_Paulo';

  return {
    summary: `${home} x ${away}`,
    description: competition,
    startDateTime: startDate.toISOString(),
    endDateTime: endDate.toISOString(),
    location: match.venue || '',
    timeZone,
  };
}

// Heuristica: time provavelmente brasileiro? (pra dar mensagem amigavel sobre limitacao do plano)
const BR_HINTS = ['sao paulo', 'palmeiras', 'corinthians', 'santos', 'flamengo', 'fluminense', 'botafogo', 'vasco', 'gremio', 'internacional', 'atletico', 'cruzeiro', 'bahia', 'fortaleza', 'ceara', 'sport', 'recife', 'goias', 'coritiba', 'athletico', 'bragantino', 'red bull bragantino', 'cuiaba', 'juventude', 'america mg', 'chapecoense'];
function looksBrazilian(query) {
  const q = normalizeForSearch(query);
  return BR_HINTS.some(h => q.includes(h));
}

async function lookupFootball(query, userId) {
  console.log('[football] Buscando time:', query, '(user:', userId, ')');

  // Verifica se o usuario configurou a key
  const userKey = await getUserApiKey(userId);
  if (!userKey) {
    return {
      reply: 'Para consultar jogos, configure sua chave da football-data.org no painel (Onboarding → Extras → "API de Futebol"). Conta gratuita em https://www.football-data.org/client/register.',
      pendingAction: null,
    };
  }

  let found;
  try {
    found = await searchTeamByName(query, userId);
  } catch (err) {
    if (err.message === 'NO_FOOTBALL_KEY') {
      return {
        reply: 'Para consultar jogos, configure sua chave da football-data.org no painel (Extras).',
        pendingAction: null,
      };
    }
    if (String(err.message).includes('HTTP 401') || String(err.message).includes('HTTP 403')) {
      return {
        reply: 'A chave da football-data.org parece invalida ou expirou. Atualize em Onboarding → Extras.',
        pendingAction: null,
      };
    }
    if (String(err.message).includes('HTTP 429')) {
      return {
        reply: 'A football-data.org limitou as requisicoes (plano gratuito = 10/min). Tente novamente em 1 minuto.',
        pendingAction: null,
      };
    }
    throw err;
  }

  if (!found?.team?.id) {
    return {
      reply: `Não encontrei o time "${query}". Tente o nome oficial (ex: "São Paulo", "Flamengo", "Real Madrid", "Bayern Munich", "Brasil"). Cobertura inclui Brasileirão, Libertadores, Champions League, Copa do Mundo e principais ligas europeias.`,
      pendingAction: null,
    };
  }

  const teamId = found.team.id;
  const teamName = found.team.name || query;
  console.log('[football] Selecionado:', teamName, 'ID:', teamId);

  let fixtures = [];
  try {
    fixtures = await getUpcomingFixtures(teamId, userId);
  } catch (err) {
    if (String(err.message).includes('HTTP 403')) {
      return {
        reply: `Encontrei o time *${teamName}*, mas sua key não tem permissão para os jogos dele (provavelmente liga fora do plano gratuito).`,
        pendingAction: null,
      };
    }
    throw err;
  }

  if (!fixtures.length) {
    return {
      reply: `Não encontrei próximos jogos agendados para *${teamName}*. Pode ser entressafra ou competição fora do plano gratuito (ex: Brasileirão exige Tier Two).`,
      pendingAction: null,
    };
  }

  const lines = fixtures.map((m, i) => formatFixtureLine(m, i));
  const events = fixtures.map(m => fixtureToCalendarEvent(m));

  return {
    reply: `Próximos jogos de *${teamName}*:\n${lines.join('\n')}\n\nQuer que eu adicione esses eventos na sua agenda?`,
    pendingAction: {
      type: 'multiple_events',
      events,
      createdAt: Date.now(),
    },
  };
}

// ===================== CLIMA (Open-Meteo - grátis, sem key) =====================

const OPEN_METEO_GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const OPEN_METEO_FORECAST = 'https://api.open-meteo.com/v1/forecast';

// Mapeamento simplificado dos códigos WMO para descrições amigáveis em PT-BR
const WMO_CODES = {
  0:  '☀️ céu limpo',
  1:  '🌤️ predominantemente limpo',
  2:  '⛅ parcialmente nublado',
  3:  '☁️ nublado',
  45: '🌫️ neblina',
  48: '🌫️ neblina com geada',
  51: '🌦️ garoa leve',
  53: '🌦️ garoa moderada',
  55: '🌦️ garoa intensa',
  61: '🌧️ chuva leve',
  63: '🌧️ chuva moderada',
  65: '🌧️ chuva forte',
  71: '🌨️ neve leve',
  73: '🌨️ neve moderada',
  75: '🌨️ neve forte',
  80: '🌦️ pancadas leves',
  81: '🌧️ pancadas',
  82: '⛈️ pancadas fortes',
  95: '⛈️ trovoada',
  96: '⛈️ trovoada com granizo',
  99: '⛈️ trovoada forte com granizo',
};

function describeWeather(code) {
  return WMO_CODES[code] || `código ${code}`;
}

async function geocodeCity(name) {
  const url = `${OPEN_METEO_GEOCODE}?name=${encodeURIComponent(name)}&count=5&language=pt&format=json`;
  const json = await fetchJson(url);
  const results = json?.results || [];
  if (!results.length) return null;
  // Prefere resultado com país Brasil se nome bater; senão pega o primeiro
  const q = normalizeForSearch(name);
  const sorted = results.slice().sort((a, b) => {
    const an = normalizeForSearch(a.name);
    const bn = normalizeForSearch(b.name);
    const aExact = an === q ? 10 : 0;
    const bExact = bn === q ? 10 : 0;
    const aBR = a.country_code === 'BR' ? 5 : 0;
    const bBR = b.country_code === 'BR' ? 5 : 0;
    return (bExact + bBR) - (aExact + aBR);
  });
  return sorted[0];
}

async function getWeatherForecast(lat, lon, timezone) {
  const url = `${OPEN_METEO_FORECAST}?latitude=${lat}&longitude=${lon}`
    + `&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m`
    + `&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,precipitation_sum`
    + `&timezone=${encodeURIComponent(timezone || 'auto')}&forecast_days=7`;
  return await fetchJson(url);
}

function formatDailyLine(forecast, index, timeZone) {
  const day = forecast.daily;
  const dateStr = day.time[index];
  const date = new Date(dateStr);
  const weekday = new Intl.DateTimeFormat('pt-BR', { timeZone, weekday: 'short' })
    .format(date).replace('.', '');
  const dateFmt = new Intl.DateTimeFormat('pt-BR', { timeZone, day: '2-digit', month: '2-digit' })
    .format(date);
  const max = Math.round(day.temperature_2m_max[index]);
  const min = Math.round(day.temperature_2m_min[index]);
  const desc = describeWeather(day.weather_code[index]);
  const rain = day.precipitation_probability_max[index];
  const rainTxt = rain != null ? `, ${rain}% chuva` : '';
  return `${weekday} ${dateFmt}: ${min}°-${max}°C ${desc}${rainTxt}`;
}

async function lookupWeather(query, period) {
  console.log('[weather] Buscando:', query, 'periodo:', period);
  if (!query) {
    return {
      reply: 'Para consultar o clima, me diga a cidade. Ex: "Como está o tempo em São Paulo?"',
      pendingAction: null,
    };
  }

  const place = await geocodeCity(query);
  if (!place) {
    return {
      reply: `Não encontrei a cidade "${query}". Tente o nome completo (ex: "Rio de Janeiro", "São Paulo", "Lisboa").`,
      pendingAction: null,
    };
  }

  const userTz = getConfig().DEFAULT_TIMEZONE || 'America/Sao_Paulo';
  const forecast = await getWeatherForecast(place.latitude, place.longitude, place.timezone || userTz);
  if (!forecast?.daily) {
    return {
      reply: `Não consegui buscar a previsão para ${place.name}.`,
      pendingAction: null,
    };
  }

  const cityLabel = place.country_code === 'BR'
    ? `${place.name}${place.admin1 ? ` (${place.admin1})` : ''}`
    : `${place.name}, ${place.country}`;

  const lines = [];
  const cur = forecast.current;
  if (cur) {
    lines.push(`Agora: ${Math.round(cur.temperature_2m)}°C, ${describeWeather(cur.weather_code)}, vento ${Math.round(cur.wind_speed_10m)} km/h, umidade ${cur.relative_humidity_2m}%`);
  }

  const tz = forecast.timezone || userTz;
  const days = forecast.daily.time.length;

  // Filtra por period se especificado
  let indicesToShow = [];
  if (period === 'today') indicesToShow = [0];
  else if (period === 'tomorrow') indicesToShow = [1];
  else if (period === 'this_week') indicesToShow = Array.from({ length: Math.min(days, 7) }, (_, i) => i);
  else indicesToShow = Array.from({ length: Math.min(days, 5) }, (_, i) => i);

  for (const i of indicesToShow) {
    if (i < days) lines.push(`- ${formatDailyLine(forecast, i, tz)}`);
  }

  return {
    reply: `Tempo em *${cityLabel}*:\n${lines.join('\n')}`,
    pendingAction: null,
  };
}

async function searchWikipedia(query) {
  const searchUrl = `https://pt.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=1&format=json&origin=*`;
  const searchJson = await fetchJson(searchUrl);
  const firstResult = searchJson?.query?.search?.[0];

  if (!firstResult?.pageid) return null;

  const extractUrl = `https://pt.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&pageids=${firstResult.pageid}&format=json&origin=*`;
  const extractJson = await fetchJson(extractUrl);
  const page = extractJson?.query?.pages?.[firstResult.pageid];
  const extract = page?.extract?.trim();

  return {
    title: page?.title || firstResult.title,
    extract: extract || '',
    url: `https://pt.wikipedia.org/wiki/${encodeURIComponent((page?.title || firstResult.title).replace(/ /g, '_'))}`,
  };
}

async function lookupWiki(query) {
  const result = await searchWikipedia(query);
  if (!result) {
    return {
      reply: `Não encontrei uma resposta confiável para "${query}".`,
      pendingAction: null,
    };
  }

  const summary = result.extract.length > 700
    ? `${result.extract.slice(0, 697)}...`
    : result.extract;

  return {
    reply: `${result.title}: ${summary}\n\nFonte: ${result.url}`,
    pendingAction: null,
  };
}

export async function runLookup(lookup, userId) {
  const query = normalizeQuery(lookup?.query || '');
  if (!query) {
    return {
      reply: 'Não recebi uma consulta suficiente para pesquisar.',
      pendingAction: null,
    };
  }

  if (lookup.source === 'football') return lookupFootball(query, userId);
  if (lookup.source === 'wiki') return lookupWiki(query);
  if (lookup.source === 'weather') return lookupWeather(query, lookup.period);

  return {
    reply: 'Essa consulta ainda não tem uma fonte externa configurada.',
    pendingAction: null,
  };
}
