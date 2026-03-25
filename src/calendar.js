import fs from 'fs';
import dotenv from 'dotenv';
import { google } from 'googleapis';

dotenv.config();

const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';

let cachedCalendarClient = null;

function parseServiceAccountKey() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;

  if (keyJson) {
    try {
      return JSON.parse(keyJson);
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_JSON inválido. Verifique o JSON.');
    }
  }

  if (keyFile) {
    if (!fs.existsSync(keyFile)) {
      throw new Error(`Arquivo de chave não encontrado: ${keyFile}`);
    }
    try {
      return JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    } catch {
      throw new Error('JSON inválido no arquivo de chave de serviço.');
    }
  }

  throw new Error('Configure GOOGLE_SERVICE_ACCOUNT_KEY_JSON ou GOOGLE_SERVICE_ACCOUNT_KEY_FILE.');
}

async function getCalendarClient() {
  if (cachedCalendarClient) return cachedCalendarClient;

  const parsedKey = parseServiceAccountKey();

  if (!parsedKey.client_email || !parsedKey.private_key) {
    throw new Error('JSON da Service Account inválido: faltam client_email ou private_key.');
  }

  const privateKey = parsedKey.private_key?.replace(/\\n/g, '\n');
  const impersonate = process.env.GOOGLE_IMPERSONATE_EMAIL;

  const jwtClient = new google.auth.JWT(
    parsedKey.client_email,
    undefined,
    privateKey,
    ['https://www.googleapis.com/auth/calendar'],
    impersonate || undefined
  );

  await jwtClient.authorize();

  cachedCalendarClient = google.calendar({ version: 'v3', auth: jwtClient });
  return cachedCalendarClient;
}

export async function createEvent(data) {
  const client = await getCalendarClient();
  const timeZone = data.timeZone || process.env.DEFAULT_TIMEZONE || 'America/Sao_Paulo';

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
  const res = await client.events.insert({ calendarId, requestBody: event });
  return res.data;
}

export async function listEvents(startDateTime, endDateTime) {
  const client = await getCalendarClient();
  const res = await client.events.list({
    calendarId,
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
    calendarId,
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
  await client.events.delete({ calendarId, eventId });
}

export async function getUpcomingReminders(minutesAhead = 15) {
  const now = new Date();
  const future = new Date(now.getTime() + minutesAhead * 60 * 1000);
  const items = await listEvents(now.toISOString(), future.toISOString());
  return items.filter(e => e.start?.dateTime);
}
