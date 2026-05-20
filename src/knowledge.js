import { getConfig } from './config.js';
import { getUser } from './database.js';

// Migrado para api-football.com (api-sports.io) — free tier inclui Brasileirão.
// FOOTBALL_DATA_KEY (nome do env mantido por compat) agora deve ser a key do api-sports.io.
const FOOTBALL_API_BASE_URL = 'https://v3.football.api-sports.io';

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
  return { 'x-apisports-key': key };
}

// Busca time via api-sports.io: retorna { team, venue, score } do melhor match
async function searchTeamByName(query, userId) {
  const url = `${FOOTBALL_API_BASE_URL}/teams?search=${encodeURIComponent(query)}`;
  const json = await fetchJson(url, { headers: await apiHeaders(userId) });
  const items = json?.response || []; // [{ team, venue }]
  if (!items.length) return null;

  const q = normalizeForSearch(query);
  const scored = items.map(item => {
    const t = item.team || {};
    const name = normalizeForSearch(t.name);
    const code = normalizeForSearch(t.code);
    let score = 0;
    if (name === q) score += 100;
    else if (name === `${q} fc` || name === `${q} sc` || name === `${q} ec`) score += 90;
    else if (name.startsWith(q)) score += 50;
    else if (name.includes(q)) score += 20;
    if (code && code === q.slice(0, 3)) score += 30;
    if (t.founded) score += 5;          // ano de fundacao = clube real
    if (t.national) score -= 10;        // ao buscar clube, penaliza selecao
    return { team: t, venue: item.venue, score };
  });

  scored.sort((a, b) => b.score - a.score);
  console.log('[football] search "%s" -> top:', query, scored.slice(0, 3).map(s => `${s.team.name} (${s.team.country}, id=${s.team.id}, score=${s.score})`));
  return scored[0] || null;
}

// /fixtures?team={id}&next={n} retorna os proximos N jogos
async function getUpcomingFixtures(teamId, userId, max = 5) {
  const url = `${FOOTBALL_API_BASE_URL}/fixtures?team=${teamId}&next=${max}`;
  const json = await fetchJson(url, { headers: await apiHeaders(userId) });
  return json?.response || [];
}

function formatFixtureLine(fixture, index) {
  const f = fixture.fixture || {};
  const teams = fixture.teams || {};
  const league = fixture.league || {};
  const when = formatDateTime(f.date);
  const home = formatHome(teams.home?.name || 'Time da casa');
  const away = formatAway(teams.away?.name || 'Visitante');
  const competition = league.name ? ` (${league.name})` : '';
  const venue = f.venue?.name ? ` — ${f.venue.name}${f.venue.city ? `/${f.venue.city}` : ''}` : '';
  return `${index + 1}. ${when} - ${home} x ${away}${competition}${venue}`;
}

function fixtureToCalendarEvent(fixture) {
  const f = fixture.fixture || {};
  const teams = fixture.teams || {};
  const league = fixture.league || {};
  const startDate = new Date(f.date);
  const endDate = new Date(startDate.getTime() + 2 * 60 * 60 * 1000);
  const home = formatHome(teams.home?.name || 'Time da casa');
  const away = formatAway(teams.away?.name || 'Visitante');
  const competition = league.name || '';
  const timeZone = getConfig().DEFAULT_TIMEZONE || 'America/Sao_Paulo';

  return {
    summary: `${home} x ${away}`,
    description: competition,
    startDateTime: startDate.toISOString(),
    endDateTime: endDate.toISOString(),
    location: f.venue?.name ? `${f.venue.name}${f.venue.city ? ` - ${f.venue.city}` : ''}` : '',
    timeZone,
  };
}

async function lookupFootball(query, userId) {
  console.log('[football] Buscando time:', query, '(user:', userId, ')');

  // Verifica se o usuario configurou a key
  const userKey = await getUserApiKey(userId);
  if (!userKey) {
    return {
      reply: 'Para consultar jogos, configure sua chave da api-sports.io no painel (Onboarding → Extras → "API de Futebol"). Conta gratuita em https://dashboard.api-football.com/register.',
      pendingAction: null,
    };
  }

  let found;
  try {
    found = await searchTeamByName(query, userId);
  } catch (err) {
    if (err.message === 'NO_FOOTBALL_KEY') {
      return {
        reply: 'Para consultar jogos, configure sua chave da api-sports.io no painel (Extras).',
        pendingAction: null,
      };
    }
    throw err;
  }

  if (!found?.team?.id) {
    return {
      reply: `Não encontrei o time "${query}". Tente o nome oficial (ex: "Sao Paulo", "Flamengo", "Real Madrid", "Manchester City").`,
      pendingAction: null,
    };
  }

  if (found.score < 20) {
    return {
      reply: `Não encontrei nenhum time chamado "${query}" com confiança suficiente. Tente especificar mais (ex: "Sao Paulo FC", "Atletico MG").`,
      pendingAction: null,
    };
  }

  const teamId = found.team.id;
  const teamName = found.team.name || query;
  const country = found.team.country ? ` (${found.team.country})` : '';
  console.log('[football] Selecionado:', teamName, country, 'ID:', teamId);

  const fixtures = await getUpcomingFixtures(teamId, userId);

  if (!fixtures.length) {
    return {
      reply: `Não encontrei próximos jogos agendados para ${teamName}${country}. Pode ser que ainda não estejam publicados.`,
      pendingAction: null,
    };
  }

  const lines = fixtures.map((m, i) => formatFixtureLine(m, i));
  const events = fixtures.map(m => fixtureToCalendarEvent(m));

  return {
    reply: `Próximos jogos de *${teamName}*${country}:\n${lines.join('\n')}\n\nQuer que eu adicione esses eventos na sua agenda?`,
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
