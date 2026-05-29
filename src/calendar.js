import { google } from 'googleapis';
import { getConfig } from './config.js';
import { getGoogleTokens, getUser, saveGoogleTokens } from './database.js';

const cachedCalendarClients = new Map();

function getOAuthClient() {
  const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET } = getConfig();
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new Error('Configure GOOGLE_OAUTH_CLIENT_ID e GOOGLE_OAUTH_CLIENT_SECRET no painel de setup.');
  }

  const redirectUri = getConfig().OAUTH_REDIRECT_URI || process.env.OAUTH_REDIRECT_URI || 'http://localhost:3000/oauth/callback';

  return new google.auth.OAuth2(
    GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri
  );
}

const LOGIN_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar',
];

// Url para fluxo de LOGIN — pede identidade (email/sub) alem do Calendar.
export function getLoginAuthUrl(state) {
  const oauth2Client = getOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: LOGIN_SCOPES,
    state,
  });
}

// Url legacy mantida para reconnect manual do Calendar (continua funcionando).
export function getAuthUrl(userId) {
  const oauth2Client = getOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar'],
    state: userId,
  });
}

// Troca o code do callback de LOGIN por tokens + perfil Google (sub, email, name).
export async function exchangeCodeForLogin(code) {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  // Decodifica id_token sem verificar assinatura local (vem direto do Google via HTTPS)
  let profile = {};
  if (tokens.id_token) {
    const parts = tokens.id_token.split('.');
    if (parts.length === 3) {
      try {
        profile = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      } catch {}
    }
  }

  // Fallback: chama o endpoint userinfo se nao veio id_token decodificavel
  if (!profile.email) {
    try {
      const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
      const me = await oauth2.userinfo.get();
      profile = { ...profile, ...me.data };
    } catch {}
  }

  return { tokens, profile };
}

export async function exchangeCodeForTokens(code, userId) {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  await saveGoogleTokens(userId, tokens);
  cachedCalendarClients.delete(userId);
  return tokens;
}

async function getCalendarClient(userId) {
  if (cachedCalendarClients.has(userId)) return cachedCalendarClients.get(userId);

  const tokens = await getGoogleTokens(userId);
  if (!tokens?.refresh_token) {
    throw new Error('Google Calendar nao conectado. Acesse o painel de setup e clique em "Conectar Google".');
  }

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials(tokens);

  oauth2Client.on('tokens', async (newTokens) => {
    try {
      await saveGoogleTokens(userId, newTokens);
      cachedCalendarClients.delete(userId);
    } catch (error) {
      console.warn('[calendar] Falha ao persistir tokens renovados:', error?.message || error);
    }
  });

  const client = google.calendar({ version: 'v3', auth: oauth2Client });
  cachedCalendarClients.set(userId, client);
  return client;
}

async function getCalendarId(userId) {
  const user = await getUser(userId);
  return user?.calendar_id || getConfig().GOOGLE_CALENDAR_ID || 'primary';
}

// Retorna todas as agendas selecionadas pelo usuario (array). Primeira = default.
export async function getCalendarIds(userId) {
  const user = await getUser(userId);
  if (user?.calendar_ids) {
    try {
      const arr = JSON.parse(user.calendar_ids);
      if (Array.isArray(arr) && arr.length) return arr;
    } catch {}
  }
  // Fallback: usa calendar_id antigo (compat)
  const fallback = user?.calendar_id || getConfig().GOOGLE_CALENDAR_ID || 'primary';
  return [fallback];
}

// Resolve um calendarId pra criacao: usa o passado OU o default (primeiro da lista).
async function resolveCreateCalendarId(userId, requestedCalendarId) {
  if (requestedCalendarId) return requestedCalendarId;
  const ids = await getCalendarIds(userId);
  return ids[0];
}

async function getUserTimeZone(userId, fallback) {
  const user = await getUser(userId);
  return fallback || user?.timezone || getConfig().DEFAULT_TIMEZONE || 'America/Sao_Paulo';
}

export async function createEvent(data, userId, calendarId) {
  const client = await getCalendarClient(userId);
  const timeZone = await getUserTimeZone(userId, data.timeZone);
  const targetCalendarId = await resolveCreateCalendarId(userId, calendarId);

  const event = {
    summary: data.summary || 'Evento WhatsApp',
    description: data.description || 'Criado pelo bot de WhatsApp',
    start: { dateTime: data.startDateTime, timeZone },
    end: {
      dateTime: data.endDateTime || new Date(new Date(data.startDateTime).getTime() + 60 * 60 * 1000).toISOString(),
      timeZone,
    },
    location: data.location || '',
  };

  if (data.recurrence) {
    event.recurrence = Array.isArray(data.recurrence) ? data.recurrence : [data.recurrence];
  }

  console.log('[calendar] Criando evento em', targetCalendarId, '- summary:', event.summary);
  try {
    const res = await client.events.insert({ calendarId: targetCalendarId, requestBody: event });
    return { ...res.data, calendarId: targetCalendarId };
  } catch (err) {
    const status = err?.code || err?.response?.status;
    const gErr = err?.response?.data?.error;
    console.error(
      `[calendar] events.insert falhou em ${targetCalendarId} | status=${status} | reason=${gErr?.errors?.[0]?.reason || ''} | msg=${gErr?.message || err?.message}`
    );
    throw err;
  }
}

// Agrega eventos de TODAS as agendas do usuario, ordenados por start time
export async function listEvents(startDateTime, endDateTime, userId) {
  const client = await getCalendarClient(userId);
  const calendarIds = await getCalendarIds(userId);

  const settled = await Promise.allSettled(calendarIds.map(calId =>
    client.events.list({
      calendarId: calId,
      timeMin: startDateTime,
      timeMax: endDateTime,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 20,
    }).then(res => (res.data.items || []).map(e => ({ ...e, calendarId: calId })))
  ));

  const all = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.warn(`[calendar] Falha ao listar ${calendarIds[i]}:`, r.reason?.message);
  });

  // Ordena por start time
  all.sort((a, b) => {
    const sa = a.start?.dateTime || a.start?.date || '';
    const sb = b.start?.dateTime || b.start?.date || '';
    return sa.localeCompare(sb);
  });

  return all;
}

export async function listCalendars(userId) {
  const client = await getCalendarClient(userId);
  const res = await client.calendarList.list({
    minAccessRole: 'writer',
    showHidden: false,
  });

  return (res.data.items || []).map(calendar => ({
    id: calendar.id,
    summary: calendar.summary || calendar.id,
    primary: !!calendar.primary,
    accessRole: calendar.accessRole,
  }));
}

export async function searchEvents(query, daysAhead = 60, userId) {
  const client = await getCalendarClient(userId);
  const calendarIds = await getCalendarIds(userId);
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();

  const settled = await Promise.allSettled(calendarIds.map(calId =>
    client.events.list({
      calendarId: calId,
      q: query,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 10,
    }).then(res => (res.data.items || []).map(e => ({ ...e, calendarId: calId })))
  ));

  const all = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.warn(`[calendar] Falha ao buscar em ${calendarIds[i]}:`, r.reason?.message);
  });

  all.sort((a, b) => {
    const sa = a.start?.dateTime || a.start?.date || '';
    const sb = b.start?.dateTime || b.start?.date || '';
    return sa.localeCompare(sb);
  });

  return all;
}

// deleteEvent: precisa do calendarId onde o evento esta. Se nao passar, tenta cada agenda.
export async function deleteEvent(eventId, userId, calendarId) {
  const client = await getCalendarClient(userId);
  if (calendarId) {
    await client.events.delete({ calendarId, eventId });
    return;
  }
  // Fallback: tenta em cada agenda ate uma funcionar
  const calendarIds = await getCalendarIds(userId);
  let lastErr = null;
  for (const calId of calendarIds) {
    try {
      await client.events.delete({ calendarId: calId, eventId });
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Evento nao encontrado em nenhuma agenda');
}

export async function getUpcomingReminders(minutesAhead = 15, userId) {
  const now = new Date();
  const future = new Date(now.getTime() + minutesAhead * 60 * 1000);
  const items = await listEvents(now.toISOString(), future.toISOString(), userId);
  return items.filter(e => e.start?.dateTime);
}
