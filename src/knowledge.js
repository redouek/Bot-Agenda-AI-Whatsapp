import { getConfig } from './config.js';

const FOOTBALL_DATA_BASE_URL = 'https://api.football-data.org/v4';

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

function formatCalendarName(apiName) {
  const { name } = resolveApiTeamName(apiName);
  return name;
}

// IDs apenas de selecoes nacionais (verificados via competicao FIFA World Cup).
// Clubes (especialmente brasileiros) sao resolvidos via searchTeamByName porque os
// IDs podem mudar e a busca textual do football-data.org costuma achar o time certo.
const KNOWN_TEAM_IDS = {
  'brazil': 764,
  'brasil': 764,
  'selecao brasileira': 764,
  'seleção brasileira': 764,
  'selecao do brasil': 764,
  'argentina': 762,
  'portugal': 765,
  'germany': 759,
  'alemanha': 759,
  'france': 773,
  'franca': 773,
  'frança': 773,
  'spain': 760,
  'espanha': 760,
  'england': 770,
  'inglaterra': 770,
  'italy': 784,
  'italia': 784,
  'itália': 784,
  'netherlands': 779,
  'holanda': 779,
  'croatia': 799,
  'croacia': 799,
  'croácia': 799,
};

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

function resolveTeam(query) {
  const lower = query.trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  for (const [key, id] of Object.entries(KNOWN_TEAM_IDS)) {
    const normKey = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (normKey === lower) return { id, name: key };
  }

  for (const [key, id] of Object.entries(KNOWN_TEAM_IDS)) {
    const normKey = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (normKey.includes(lower) || lower.includes(normKey)) return { id, name: key };
  }

  return null;
}

function normalizeForSearch(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

async function searchTeamByName(query) {
  const key = getConfig().FOOTBALL_DATA_KEY;
  if (!key) throw new Error('Configure FOOTBALL_DATA_KEY no painel de setup.');

  const url = `${FOOTBALL_DATA_BASE_URL}/teams?search=${encodeURIComponent(query)}&limit=10`;
  const json = await fetchJson(url, { headers: { 'X-Auth-Token': key } });
  const teams = json?.teams || [];
  if (!teams.length) return null;

  // Scoring: prefere match exato no nome/shortName/TLA. Penaliza times sem clube real (ex: arenas).
  const q = normalizeForSearch(query);
  const scored = teams.map(t => {
    const name = normalizeForSearch(t.name);
    const shortName = normalizeForSearch(t.shortName);
    const tla = normalizeForSearch(t.tla);
    let score = 0;
    if (name === q || shortName === q) score += 100;
    else if (name === `${q} fc` || shortName === `${q} fc`) score += 90;
    else if (name.startsWith(q) || shortName.startsWith(q)) score += 50;
    else if (name.includes(q) || shortName.includes(q)) score += 20;
    if (tla === q.toUpperCase().slice(0, 3).toLowerCase()) score += 30;
    // Bonus se o time tem founded year (e um clube real, nao uma entidade genérica)
    if (t.founded) score += 5;
    return { team: t, score };
  });

  scored.sort((a, b) => b.score - a.score);
  console.log('[football] search "%s" candidatos:', query, scored.slice(0, 3).map(s => `${s.team.name} (id=${s.team.id} score=${s.score})`));
  return scored[0]?.team || teams[0];
}

async function getUpcomingMatches(teamId) {
  const key = getConfig().FOOTBALL_DATA_KEY;
  if (!key) throw new Error('Configure FOOTBALL_DATA_KEY no painel de setup.');

  const today = new Date().toISOString().split('T')[0];
  const until = new Date(Date.now() + 120 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const url = `${FOOTBALL_DATA_BASE_URL}/teams/${teamId}/matches?status=SCHEDULED&dateFrom=${today}&dateTo=${until}&limit=5`;
  const json = await fetchJson(url, { headers: { 'X-Auth-Token': key } });
  return json?.matches || [];
}

function formatMatchLine(match, index) {
  const when = formatDateTime(match.utcDate);
  const home = formatHome(match.homeTeam?.name || 'Time da casa');
  const away = formatAway(match.awayTeam?.name || 'Visitante');
  const competition = match.competition?.name ? ` (${match.competition.name})` : '';
  const venue = match.venue ? ` — ${match.venue}` : '';
  return `${index + 1}. ${when} - ${home} x ${away}${competition}${venue}`;
}

function matchToCalendarEvent(match) {
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

async function lookupFootball(query) {
  const known = resolveTeam(query);
  let teamId = known?.id;
  let teamName = known?.name || query;

  if (!teamId) {
    console.log('[football] Time não encontrado no mapa, buscando na API:', query);
    const found = await searchTeamByName(query);
    if (found?.id) {
      teamId = found.id;
      // Usa o nome completo da API (ex: "São Paulo FC") em vez do query
      teamName = found.name || found.shortName || query;
      console.log('[football] Selecionado:', teamName, 'ID:', teamId);
    }
  }

  if (!teamId) {
    return {
      reply: `Não encontrei o time "${query}". Tente usar o nome em português ou inglês (ex: "Flamengo", "Brazil", "Palmeiras").`,
      pendingAction: null,
    };
  }

  console.log('[football] Buscando jogos para:', teamName, 'ID:', teamId);

  const matches = await getUpcomingMatches(teamId);

  if (!matches.length) {
    return {
      reply: `Não encontrei próximos jogos agendados para ${teamName}. Pode ser que os jogos ainda não estejam publicados na base de dados.`,
      pendingAction: null,
    };
  }

  const lines = matches.map((m, i) => formatMatchLine(m, i));
  const events = matches.map(m => matchToCalendarEvent(m));

  return {
    reply: `Próximos jogos de *${teamName}*:\n${lines.join('\n')}\n\nQuer que eu adicione esses eventos na sua agenda?`,
    pendingAction: {
      type: 'multiple_events',
      events,
      createdAt: Date.now(),
    },
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

export async function runLookup(lookup) {
  const query = normalizeQuery(lookup?.query || '');
  if (!query) {
    return {
      reply: 'Não recebi uma consulta suficiente para pesquisar.',
      pendingAction: null,
    };
  }

  if (lookup.source === 'football') return lookupFootball(query);
  if (lookup.source === 'wiki') return lookupWiki(query);

  return {
    reply: 'Essa consulta ainda não tem uma fonte externa configurada.',
    pendingAction: null,
  };
}
