import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { getConfig } from './config.js';

const TOKENS_PATH = process.env.TOKENS_PATH || path.resolve('./data/google-tokens.json');

let cachedCalendarClient = null;

function getOAuthClient() {
  const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET } = getConfig();
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new Error('Configure GOOGLE_OAUTH_CLIENT_ID e GOOGLE_OAUTH_CLIENT_SECRET no painel de setup.');
  }

  const redirectUri = process.env.OAUTH_REDIRECT_URI || 'http://localhost:3000/oauth/callback';

  return new google.auth.OAuth2(
    GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri
  );
}

export function getAuthUrl() {
  const oauth2Client = getOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar'],
  });
}

export async function exchangeCodeForTokens(code) {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  saveTokens(tokens);
  cachedCalendarClient = null;
  return tokens;
}

export function saveTokens(tokens) {
  const dir = path.dirname(TOKENS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), 'utf8');
  cachedCalendarClient = null;
}

function loadTokens() {
  if (!fs.existsSync(TOKENS_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function getCalendarClient() {
  if (cachedCalendarClient) return cachedCalendarClient;

  const tokens = loadTokens();
  if (!tokens?.access_token || !tokens?.refresh_token) {
    throw new Error('Google Calendar não conectado. Acesse o painel de setup e clique em "Conectar Google".');
  }

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials(tokens);

  // Persiste tokens renovados automaticamente
  oauth2Client.on('tokens', (newTokens) => {
    const current = loadTokens() || {};
    saveTokens({ ...current, ...newTokens });
  });

  cachedCalendarClient = google.calendar({ version: 'v3', auth: oauth2Client });
  return cachedCalendarClient;
}

function getCalendarId() {
  return getConfig().GOOGLE_CALENDAR_ID || 'primary';
}

export async function createEvent(data) {
  const client = await getCalendarClient();
  const timeZone = data.timeZone || getConfig().DEFAULT_TIMEZONE || 'America/Sao_Paulo';

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

  console.log('[calendar] Criando evento - summary:', event.summary);
  const res = await client.events.insert({ calendarId: getCalendarId(), requestBody: event });
  return res.data;
}

export async function listEvents(startDateTime, endDateTime) {
  const client = await getCalendarClient();
  const res = await client.events.list({
    calendarId: getCalendarId(),
    timeMin: startDateTime,
    timeMax: endDateTime,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 20,
  });
  return res.data.items || [];
}

export async function searchEvents(query, daysAhead = 60) {
  const client = await getCalendarClient();
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
  const res = await client.events.list({
    calendarId: getCalendarId(),
    q: query,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 10,
  });
  return res.data.items || [];
}

export async function deleteEvent(eventId) {
  const client = await getCalendarClient();
  await client.events.delete({ calendarId: getCalendarId(), eventId });
}

export async function getUpcomingReminders(minutesAhead = 15) {
  const now = new Date();
  const future = new Date(now.getTime() + minutesAhead * 60 * 1000);
  const items = await listEvents(now.toISOString(), future.toISOString());
  return items.filter(e => e.start?.dateTime);
}
