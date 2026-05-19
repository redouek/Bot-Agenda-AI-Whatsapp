import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const DB_PATH = process.env.DB_PATH || path.resolve('./data/app.sqlite');
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID || 'renato';
const DEFAULT_USER_NAME = process.env.DEFAULT_USER_NAME || 'Renato';

let dbPromise = null;

function ensureDataDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeUserId(value) {
  // Aceita email (com @ e .) ou identificador simples. So padroniza para lowercase + trim.
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || DEFAULT_USER_ID;
}

// Converte userId em nome de pasta seguro para o filesystem (sessoes do whatsapp).
function userIdToFolder(userId) {
  return String(userId || '')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || DEFAULT_USER_ID;
}

async function getDb() {
  if (!dbPromise) {
    ensureDataDir();
    dbPromise = open({
      filename: DB_PATH,
      driver: sqlite3.Database,
    });
  }
  return dbPromise;
}

export async function initDatabase() {
  const db = await getDb();
  await db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      calendar_id TEXT,
      assistant_chat_id TEXT,
      self_chat_lid TEXT,
      timezone TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS google_tokens (
      user_id TEXT PRIMARY KEY,
      access_token TEXT,
      refresh_token TEXT,
      scope TEXT,
      token_type TEXT,
      expiry_date INTEGER,
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      user_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'stopped',
      latest_qr TEXT,
      session_path TEXT,
      last_ready_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Migration: adiciona self_chat_lid em bancos antigos
  try {
    await db.exec('ALTER TABLE users ADD COLUMN self_chat_lid TEXT');
  } catch {
    // Coluna ja existe — segue o jogo
  }
  // Migration: adiciona google_sub para mapear identidade Google
  try {
    await db.exec('ALTER TABLE users ADD COLUMN google_sub TEXT');
  } catch {
    // Coluna ja existe
  }

  await ensureUser({
    id: DEFAULT_USER_ID,
    name: DEFAULT_USER_NAME,
  });

  return db;
}

export function getDefaultUserId() {
  return DEFAULT_USER_ID;
}

export async function ensureUser(input = {}) {
  const db = await getDb();
  const id = normalizeUserId(input.id || input.userId || DEFAULT_USER_ID);
  const name = input.name || (id === DEFAULT_USER_ID ? DEFAULT_USER_NAME : id);
  const timestamp = nowIso();

  await db.run(
    `
      INSERT INTO users (id, name, email, google_sub, calendar_id, assistant_chat_id, timezone, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = COALESCE(excluded.name, users.name),
        email = COALESCE(excluded.email, users.email),
        google_sub = COALESCE(excluded.google_sub, users.google_sub),
        calendar_id = COALESCE(excluded.calendar_id, users.calendar_id),
        assistant_chat_id = COALESCE(excluded.assistant_chat_id, users.assistant_chat_id),
        timezone = COALESCE(excluded.timezone, users.timezone),
        updated_at = excluded.updated_at
    `,
    [
      id,
      name,
      input.email || null,
      input.googleSub || input.google_sub || null,
      input.calendarId || input.calendar_id || null,
      input.assistantChatId || input.assistant_chat_id || null,
      input.timezone || null,
      timestamp,
      timestamp,
    ]
  );

  await ensureWhatsAppSession(id);
  return getUser(id);
}

export async function findUserByEmail(email) {
  if (!email) return null;
  const db = await getDb();
  return db.get('SELECT * FROM users WHERE lower(email) = lower(?)', email);
}

export async function findUserByGoogleSub(sub) {
  if (!sub) return null;
  const db = await getDb();
  return db.get('SELECT * FROM users WHERE google_sub = ?', sub);
}

export async function getUser(userId = DEFAULT_USER_ID) {
  const db = await getDb();
  return db.get('SELECT * FROM users WHERE id = ?', normalizeUserId(userId));
}

export async function deleteUser(userId) {
  const db = await getDb();
  const id = normalizeUserId(userId);
  // FK ON DELETE CASCADE remove google_tokens e whatsapp_sessions automaticamente
  await db.run('DELETE FROM users WHERE id = ?', id);
}

export async function listUsers() {
  const db = await getDb();
  return db.all('SELECT * FROM users ORDER BY created_at ASC');
}

export async function updateUserSettings(userId, settings = {}) {
  const db = await getDb();
  const id = normalizeUserId(userId);
  await ensureUser({ id });

  const current = await getUser(id);
  const next = {
    name: settings.name ?? current.name,
    email: settings.email ?? current.email,
    calendar_id: settings.calendarId ?? settings.calendar_id ?? current.calendar_id,
    assistant_chat_id: settings.assistantChatId ?? settings.assistant_chat_id ?? current.assistant_chat_id,
    self_chat_lid: settings.selfChatLid ?? settings.self_chat_lid ?? current.self_chat_lid,
    timezone: settings.timezone ?? current.timezone,
  };

  await db.run(
    `
      UPDATE users
      SET name = ?, email = ?, calendar_id = ?, assistant_chat_id = ?, self_chat_lid = ?, timezone = ?, updated_at = ?
      WHERE id = ?
    `,
    [next.name, next.email, next.calendar_id, next.assistant_chat_id, next.self_chat_lid, next.timezone, nowIso(), id]
  );

  return getUser(id);
}

export async function saveGoogleTokens(userId, tokens) {
  const db = await getDb();
  const id = normalizeUserId(userId);
  await ensureUser({ id });

  const current = await getGoogleTokens(id);
  const merged = { ...(current?.raw || {}), ...tokens };
  const timestamp = nowIso();

  await db.run(
    `
      INSERT INTO google_tokens
        (user_id, access_token, refresh_token, scope, token_type, expiry_date, raw_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = COALESCE(excluded.refresh_token, google_tokens.refresh_token),
        scope = excluded.scope,
        token_type = excluded.token_type,
        expiry_date = excluded.expiry_date,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
    `,
    [
      id,
      merged.access_token || null,
      merged.refresh_token || null,
      merged.scope || null,
      merged.token_type || null,
      merged.expiry_date || null,
      JSON.stringify(merged),
      timestamp,
      timestamp,
    ]
  );

  return getGoogleTokens(id);
}

export async function getGoogleTokens(userId = DEFAULT_USER_ID) {
  const db = await getDb();
  const row = await db.get('SELECT * FROM google_tokens WHERE user_id = ?', normalizeUserId(userId));
  if (!row) return null;

  let raw = {};
  try {
    raw = JSON.parse(row.raw_json || '{}');
  } catch {
    raw = {};
  }

  return {
    ...raw,
    access_token: row.access_token || raw.access_token,
    refresh_token: row.refresh_token || raw.refresh_token,
    scope: row.scope || raw.scope,
    token_type: row.token_type || raw.token_type,
    expiry_date: row.expiry_date || raw.expiry_date,
    raw,
  };
}

export async function isGoogleConnected(userId = DEFAULT_USER_ID) {
  const tokens = await getGoogleTokens(userId);
  return !!tokens?.refresh_token;
}

export async function ensureWhatsAppSession(userId = DEFAULT_USER_ID) {
  const db = await getDb();
  const id = normalizeUserId(userId);
  const sessionPath = getWhatsAppSessionPath(id);
  const timestamp = nowIso();

  await db.run(
    `
      INSERT INTO whatsapp_sessions (user_id, status, latest_qr, session_path, last_ready_at, created_at, updated_at)
      VALUES (?, 'stopped', NULL, ?, NULL, ?, ?)
      ON CONFLICT(user_id) DO NOTHING
    `,
    [id, sessionPath, timestamp, timestamp]
  );

  return getWhatsAppSession(id);
}

export function getWhatsAppSessionPath(userId = DEFAULT_USER_ID) {
  const id = normalizeUserId(userId);
  return path.resolve(process.env.SESSIONS_ROOT || './data/whatsapp-sessions', userIdToFolder(id));
}

export async function updateWhatsAppSession(userId, partial = {}) {
  const db = await getDb();
  const id = normalizeUserId(userId);
  await ensureWhatsAppSession(id);

  const current = await getWhatsAppSession(id);
  await db.run(
    `
      UPDATE whatsapp_sessions
      SET status = ?, latest_qr = ?, session_path = ?, last_ready_at = ?, updated_at = ?
      WHERE user_id = ?
    `,
    [
      partial.status ?? current.status,
      partial.latestQr === undefined ? current.latest_qr : partial.latestQr,
      partial.sessionPath ?? current.session_path,
      partial.lastReadyAt === undefined ? current.last_ready_at : partial.lastReadyAt,
      nowIso(),
      id,
    ]
  );

  return getWhatsAppSession(id);
}

export async function getWhatsAppSession(userId = DEFAULT_USER_ID) {
  const db = await getDb();
  return db.get('SELECT * FROM whatsapp_sessions WHERE user_id = ?', normalizeUserId(userId));
}

export async function getLatestQr(userId = DEFAULT_USER_ID) {
  const session = await getWhatsAppSession(userId);
  return session?.latest_qr || null;
}

