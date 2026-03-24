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
    start: {
      dateTime: data.startDateTime,
      timeZone,
    },
    end: {
      dateTime: data.endDateTime || new Date(new Date(data.startDateTime).getTime() + 60 * 60 * 1000).toISOString(),
      timeZone,
    },
    location: data.location || '',
  };

  console.log('[calendar] Criando evento - summary:', event.summary);
  const res = await client.events.insert({
    calendarId,
    requestBody: event,
  });

  return res.data;
}
