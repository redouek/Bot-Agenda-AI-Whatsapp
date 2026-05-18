import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import qrcode from 'qrcode';
import { getConfig, setConfig, isPlatformConfigured } from './config.js';
import { getAuthUrl, exchangeCodeForTokens, listCalendars } from './calendar.js';
import {
  getDefaultUserId,
  getLatestQr,
  getUser,
  isGoogleConnected,
  updateUserSettings,
} from './database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '../web');

function serveFile(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
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
  if (pathname === '/tutorial') {
    return serveFile(res, path.join(WEB_DIR, 'tutorial.html'), 'text/html; charset=utf-8');
  }
  if (pathname === '/web/style.css') {
    return serveFile(res, path.join(WEB_DIR, 'style.css'), 'text/css');
  }
  if (pathname === '/web/app.js') {
    return serveFile(res, path.join(WEB_DIR, 'app.js'), 'application/javascript');
  }
  if (pathname === '/web/admin.js') {
    return serveFile(res, path.join(WEB_DIR, 'admin.js'), 'application/javascript');
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
    const platformKeys = [
      'GOOGLE_API_KEY',
      'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'OAUTH_REDIRECT_URI',
      'FOOTBALL_DATA_KEY', 'REMINDER_MINUTES', 'DEFAULT_TIMEZONE', 'GEMINI_MODEL',
    ];
    const update = {};
    for (const key of platformKeys) {
      if (body[key] !== undefined && body[key] !== '') update[key] = body[key];
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
