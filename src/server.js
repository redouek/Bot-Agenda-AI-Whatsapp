import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import qrcode from 'qrcode';
import { getConfig, setConfig, isPlatformConfigured } from './config.js';
import { getAuthUrl, exchangeCodeForTokens, listCalendars } from './calendar.js';
import {
  getDefaultUserId,
  getLatestQr,
  getUser,
  isGoogleConnected,
  listUsers,
  updateUserSettings,
  getWhatsAppSession,
} from './database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '../web');

const ASSET_VERSION = String(Date.now());

function serveFile(res, filePath, contentType) {
  try {
    let content = fs.readFileSync(filePath);
    // Cache-busting nos HTMLs: anexa ?v=ASSET_VERSION a /web/style.css, /web/app.js, /web/admin.js
    if (contentType.startsWith('text/html')) {
      content = Buffer.from(
        content.toString('utf8').replace(/(\/web\/(?:style\.css|app\.js|admin\.js))(?:\?[^"']*)?/g, `$1?v=${ASSET_VERSION}`)
      );
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function json(res, data, status = 200, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function parseCookies(cookieHeader = '') {
  return cookieHeader.split(';').reduce((cookies, item) => {
    const [rawKey, ...rest] = item.trim().split('=');
    if (!rawKey) return cookies;
    cookies[rawKey] = decodeURIComponent(rest.join('=') || '');
    return cookies;
  }, {});
}

function getRequestUserId(req, url) {
  const cookies = parseCookies(req.headers.cookie || '');
  return url.searchParams.get('userId') || cookies.userId || getDefaultUserId();
}

function timingSafeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const ADMIN_COOKIE = 'adminSession';
const ADMIN_SESSION_MS = 120 * 24 * 60 * 60 * 1000;

function getAdminSecret() {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return null;
  return crypto.createHash('sha256').update('admin-session:' + pw).digest();
}

function signAdminToken() {
  const secret = getAdminSecret();
  if (!secret) return null;
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + ADMIN_SESSION_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return false;
  const secret = getAdminSecret();
  if (!secret) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (!timingSafeStringEqual(sig, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof data.exp === 'number' && data.exp > Date.now();
  } catch { return false; }
}

function isAdminAuthed(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return verifyAdminToken(cookies[ADMIN_COOKIE]);
}

function adminCookie(value, maxAgeSec) {
  const parts = [`${ADMIN_COOKIE}=${value || ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (typeof maxAgeSec === 'number') parts.push(`Max-Age=${maxAgeSec}`);
  return parts.join('; ');
}

// Gate para endpoints de API admin — responde 401 JSON ou 503 se admin desabilitado.
function requireAdminApi(req, res) {
  if (!process.env.ADMIN_PASSWORD) {
    json(res, { error: 'admin desabilitado' }, 503);
    return false;
  }
  if (!isAdminAuthed(req)) {
    json(res, { error: 'nao autenticado' }, 401);
    return false;
  }
  return true;
}

function userCookie(userId) {
  return `userId=${encodeURIComponent(userId)}; Path=/; SameSite=Lax; Max-Age=31536000`;
}

function maskConfig(config) {
  const masked = { ...config };
  const sensitiveKeys = ['GOOGLE_API_KEY', 'GOOGLE_OAUTH_CLIENT_SECRET', 'FOOTBALL_DATA_KEY'];
  for (const key of sensitiveKeys) {
    if (masked[key]) masked[key] = `${masked[key].slice(0, 6)}******`;
  }
  return masked;
}

function normalizeWhatsAppChatId(value = '') {
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return '';
  return `${digits}@c.us`;
}

function buildWhatsAppNumber(body) {
  const rawNumber = String(body.WHATSAPP_NUMBER || body.GRUPO_ASSISTENTE_ID || '').replace(/\D/g, '');
  const ddi = String(body.WHATSAPP_DDI || '').replace(/\D/g, '');
  if (!rawNumber) return '';
  if (!ddi || rawNumber.startsWith(ddi)) return rawNumber;
  return `${ddi}${rawNumber}`;
}

async function fetchGeminiModels(apiKey) {
  if (!apiKey) return [];
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
  if (!response.ok) {
    throw new Error('Nao foi possivel carregar os modelos Gemini.');
  }

  const data = await response.json();
  return (data.models || [])
    .filter(model => (model.supportedGenerationMethods || []).includes('generateContent'))
    .map(model => ({
      name: model.name,
      displayName: model.displayName || model.name.replace(/^models\//, ''),
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

async function handleRequest(req, res, manager) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const userId = getRequestUserId(req, url);

  if (pathname === '/' || pathname === '/setup' || pathname === '/status') {
    await manager.getOrCreateCurrentUser(userId);
    res.setHeader('Set-Cookie', userCookie(userId));
    return serveFile(res, path.join(WEB_DIR, 'index.html'), 'text/html; charset=utf-8');
  }
  if (pathname === '/admin') {
    return serveFile(res, path.join(WEB_DIR, 'admin.html'), 'text/html; charset=utf-8');
  }
  if (pathname === '/web/admin.js') {
    return serveFile(res, path.join(WEB_DIR, 'admin.js'), 'application/javascript');
  }

  if (pathname === '/api/admin/login' && req.method === 'POST') {
    if (!process.env.ADMIN_PASSWORD) return json(res, { error: 'admin desabilitado' }, 503);
    const body = await readBody(req);
    if (!timingSafeStringEqual(body.password || '', process.env.ADMIN_PASSWORD)) {
      await new Promise(r => setTimeout(r, 400)); // anti brute-force
      return json(res, { error: 'senha incorreta' }, 401);
    }
    const token = signAdminToken();
    return json(res, { ok: true }, 200, { 'Set-Cookie': adminCookie(token, Math.floor(ADMIN_SESSION_MS / 1000)) });
  }

  if (pathname === '/api/admin/logout' && req.method === 'POST') {
    return json(res, { ok: true }, 200, { 'Set-Cookie': adminCookie('', 0) });
  }

  if (pathname === '/api/admin/check' && req.method === 'GET') {
    if (!process.env.ADMIN_PASSWORD) return json(res, { authed: false, enabled: false }, 200);
    return json(res, { authed: isAdminAuthed(req), enabled: true }, 200);
  }
  if (pathname === '/tutorial') {
    return serveFile(res, path.join(WEB_DIR, 'tutorial.html'), 'text/html; charset=utf-8');
  }
  if (pathname === '/web/style.css') {
    return serveFile(res, path.join(WEB_DIR, 'style.css'), 'text/css');
  }
  if (pathname === '/web/app.js') {
    return serveFile(res, path.join(WEB_DIR, 'app.js'), 'application/javascript');
  }

  if (pathname === '/api/session' && req.method === 'GET') {
    const user = await manager.getOrCreateCurrentUser(userId);
    return json(res, {
      userId: user.id,
      name: user.name,
      assistantChatId: user.assistant_chat_id,
      calendarId: user.calendar_id,
      timezone: user.timezone,
    }, 200, { 'Set-Cookie': userCookie(user.id) });
  }

  if (pathname === '/api/config' && req.method === 'GET') {
    return json(res, maskConfig(getConfig()));
  }

  if (pathname === '/api/config' && req.method === 'POST') {
    const body = await readBody(req);
    const user = await manager.getOrCreateCurrentUser(userId);
    // Chaves sensiveis de plataforma — so podem ser alteradas via /api/admin/config (com auth)
    const sensitivePlatformKeys = new Set([
      'GOOGLE_API_KEY', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET',
      'OAUTH_REDIRECT_URI', 'GEMINI_MODEL',
    ]);
    // Chaves de plataforma que usuarios podem ajustar (lembrete, fuso)
    const userPlatformKeys = ['REMINDER_MINUTES', 'DEFAULT_TIMEZONE', 'FOOTBALL_DATA_KEY'];
    const update = {};
    for (const key of userPlatformKeys) {
      if (body[key] !== undefined && body[key] !== '') update[key] = body[key];
    }
    // Silently drop sensitive keys se chegaram aqui
    for (const key of Object.keys(body)) {
      if (sensitivePlatformKeys.has(key)) {
        console.warn(`[server] Tentativa de set chave sensivel ${key} via /api/config bloqueada`);
      }
    }
    if (Object.keys(update).length > 0) setConfig(update);

    let assistantChatId;
    if (body.WHATSAPP_NUMBER || body.GRUPO_ASSISTENTE_ID) {
      assistantChatId = normalizeWhatsAppChatId(buildWhatsAppNumber(body));
    }

    await updateUserSettings(user.id, {
      assistantChatId,
      calendarId: body.GOOGLE_CALENDAR_ID || undefined,
      timezone: update.DEFAULT_TIMEZONE || undefined,
    });

    if (isPlatformConfigured() && assistantChatId) {
      manager.startWhatsAppInstance(user.id).catch(err => console.error('[server] Erro ao iniciar bot:', err));
    }

    return json(res, { ok: true, userId: user.id });
  }

  if (pathname === '/api/admin/config' && req.method === 'POST') {
    if (!requireAdminApi(req, res)) return;
    const body = await readBody(req);
    const platformKeys = [
      'GOOGLE_API_KEY', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET',
      'OAUTH_REDIRECT_URI', 'GEMINI_MODEL',
      'FOOTBALL_DATA_KEY', 'REMINDER_MINUTES', 'DEFAULT_TIMEZONE',
    ];
    const update = {};
    for (const key of platformKeys) {
      if (body[key] !== undefined && body[key] !== '') update[key] = body[key];
    }
    if (Object.keys(update).length > 0) setConfig(update);
    return json(res, { ok: true });
  }

  if (pathname === '/api/admin/users' && req.method === 'GET') {
    if (!requireAdminApi(req, res)) return;
    const users = await listUsers();
    const enriched = await Promise.all(users.map(async u => {
      const session = await getWhatsAppSession(u.id).catch(() => null);
      const runtime = manager.getWhatsAppStatus ? await manager.getWhatsAppStatus(u.id).catch(() => null) : null;
      return {
        id: u.id,
        name: u.name,
        phone: u.assistant_chat_id || null,
        selfChatLid: u.self_chat_lid || null,
        calendarId: u.calendar_id || null,
        calendarConnected: await isGoogleConnected(u.id),
        botStatus: runtime?.status || session?.status || 'stopped',
        lastReadyAt: session?.last_ready_at || null,
        createdAt: u.created_at,
        updatedAt: u.updated_at,
      };
    }));
    return json(res, { users: enriched });
  }

  if (pathname === '/api/gemini/models' && req.method === 'POST') {
    const body = await readBody(req);
    const apiKey = body.GOOGLE_API_KEY || getConfig().GOOGLE_API_KEY;
    try {
      return json(res, { models: await fetchGeminiModels(apiKey) });
    } catch (error) {
      return json(res, { error: error.message, models: [] }, 400);
    }
  }

  if (pathname === '/api/calendars' && req.method === 'GET') {
    const user = await manager.getOrCreateCurrentUser(userId);
    const currentUser = await getUser(user.id);
    try {
      return json(res, { calendars: await listCalendars(user.id), selectedCalendarId: currentUser?.calendar_id || 'primary' });
    } catch (error) {
      return json(res, { error: error.message, calendars: [] }, 400);
    }
  }

  if (pathname === '/api/calendar/select' && req.method === 'POST') {
    const body = await readBody(req);
    const user = await manager.getOrCreateCurrentUser(userId);
    const calendarId = body.GOOGLE_CALENDAR_ID || 'primary';
    await updateUserSettings(user.id, { calendarId });
    return json(res, { ok: true, calendarId });
  }

  if (pathname === '/api/status') {
    const user = await manager.getOrCreateCurrentUser(userId);
    const currentUser = await getUser(user.id);
    const whatsappStatus = await manager.getWhatsAppStatus(user.id);
    const config = getConfig();
    const platformConfigured = isPlatformConfigured();
    return json(res, {
      userId: user.id,
      configComplete: platformConfigured && !!currentUser?.assistant_chat_id,
      platformConfigured,
      hasGeminiKey: !!config.GOOGLE_API_KEY,
      hasOAuthCredentials: !!(config.GOOGLE_OAUTH_CLIENT_ID && config.GOOGLE_OAUTH_CLIENT_SECRET),
      calendarConnected: await isGoogleConnected(user.id),
      hasPhone: !!currentUser?.assistant_chat_id,
      botStatus: whatsappStatus.status,
      qrAvailable: whatsappStatus.qrAvailable,
      sessionPath: whatsappStatus.sessionPath,
    });
  }

  if (pathname === '/api/qr') {
    const user = await manager.getOrCreateCurrentUser(userId);
    const latestQrString = await getLatestQr(user.id);
    if (!latestQrString) return json(res, { qr: null, userId: user.id });
    try {
      const svg = await qrcode.toString(latestQrString, { type: 'svg' });
      return json(res, { qr: svg, userId: user.id });
    } catch {
      return json(res, { qr: null, userId: user.id });
    }
  }

  if (pathname === '/oauth/start') {
    try {
      const user = await manager.getOrCreateCurrentUser(userId);
      const authUrl = getAuthUrl(user.id);
      res.writeHead(302, { Location: authUrl, 'Set-Cookie': userCookie(user.id) });
      res.end();
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h2>Erro</h2><p>${err.message}</p><a href="/">Voltar</a>`);
    }
    return;
  }

  if (pathname === '/oauth/callback') {
    const code = url.searchParams.get('code');
    const callbackUserId = url.searchParams.get('state') || userId;
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>Erro</h2><p>Codigo de autorizacao nao recebido.</p><a href="/">Voltar</a>');
      return;
    }
    try {
      await manager.getOrCreateCurrentUser(callbackUserId);
      await exchangeCodeForTokens(code, callbackUserId);
      res.writeHead(302, { Location: '/?connected=1', 'Set-Cookie': userCookie(callbackUserId) });
      res.end();
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h2>Erro ao conectar Google</h2><p>${err.message}</p><a href="/">Voltar</a>`);
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

export function startServer(port = 3000, manager) {
  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, manager);
    } catch (err) {
      console.error('[server] Erro interno:', err);
      res.writeHead(500);
      res.end('Internal server error');
    }
  });

  server.listen(port, () => {
    console.log(`[server] Painel disponivel em http://localhost:${port}`);
  });
}
