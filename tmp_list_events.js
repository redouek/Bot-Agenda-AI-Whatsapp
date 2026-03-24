import { google } from 'googleapis';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const key = JSON.parse(fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, 'utf8'));
const jwt = new google.auth.JWT(
  key.client_email,
  undefined,
  key.private_key.replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/calendar']
);
await jwt.authorize();
const cal = google.calendar({ version: 'v3', auth: jwt });
const now = new Date('2026-03-20T00:00:00Z').toISOString();
const later = new Date('2026-04-02T00:00:00Z').toISOString();
const res = await cal.events.list({
  calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
  timeMin: now,
  timeMax: later,
  maxResults: 50,
  singleEvents: true,
  orderBy: 'startTime',
});
for (const e of res.data.items || []) {
  console.log(e.id, e.summary, e.start?.dateTime || e.start?.date);
}
