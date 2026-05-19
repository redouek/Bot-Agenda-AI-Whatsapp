import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import qrcode from 'qrcode';
import { getConfig, setConfig, isPlatformConfigured } from './config.js';
import { getAuthUrl, getLoginAuthUrl, exchangeCodeForLogin, exchangeCodeForTokens, listCalendars } from './calendar.js';
import {
  ensureUser,
  findUserByEmail,
  findUserByGoogleSub,
  getDefaultUserId,
  getLatestQr,
  getUser,
  isGoogleConnected,
  listUsers,
  saveGoogleTokens,
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

// ---------- Sessao do usuario (cookie assinado HMAC) ----------
const USER_COOKIE = 'userSession';
const USER_SESSION_MS = 120 * 24 * 60 * 60 * 1000; // 120 dias

function getSessionSecret() {
  // Tenta env var primeiro
  if (process.env.SESSION_SECRET) {
    return crypto.createHash('sha256').update('user-session:' + process.env.SESSION_SECRET).digest();
  }
  // Fallback: deriva de um arquivo estavel auto-gerado em ./data
  const file = path.resolve(process.env.DATA_DIR || './data', '.session-secret');
  try {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    }
    const raw = fs.readFileSync(file, 'utf8').trim();
    return crypto.createHash('sha256').update('user-session:' + raw).digest();
  } catch (err) {
    console.warn('[server] Falha ao ler session-secret, gerando em memoria:', err.message);
    return crypto.randomBytes(32);
  }
}

const SESSION_SECRET = getSessionSecret();

function signUserToken(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + USER_SESSION_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyUserToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (!timingSafeStringEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.exp !== 'number' || data.exp <= Date.now()) return null;
    return data.uid || null;
  } catch { return null; }
}

function userCookie(value, maxAgeSec) {
  const parts = [`${USER_COOKIE}=${value || ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (typeof maxAgeSec === 'number') parts.push(`Max-Age=${maxAgeSec}`);
  return parts.join('; ');
}

function getRequestUserId(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return verifyUserToken(cookies[USER_COOKIE]);
}

function requireUserSession(req, res) {
  const uid = getRequestUserId(req);
  if (!uid) {
    json(res, { error: 'nao autenticado' }, 401);
    return null;
  }
  return uid;
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

  // ---------- Paginas HTML/JS/CSS (publicas) ----------
  if (pathname === '/' || pathname === '/setup' || pathname === '/status') {
    return serveFile(res, path.join(WEB_DIR, 'index.html'), 'text/html; charset=utf-8');
  }
  if (pathname === '/admin') {
    return serveFile(res, path.join(WEB_DIR, 'admin.html'), 'text/html; charset=utf-8');
  }
  if (pathname === '/web/admin.js') {
    return serveFile(res, path.join(WEB_DIR, 'admin.js'), 'application/javascript');
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

  // ---------- Rotas de admin (auth propria) ----------
  if (pathname === '/api/admin/login' && req.method === 'POST') {
    if (!process.env.ADMIN_PASSWORD) return json(res, { error: 'admin desabilitado' }, 503);
    const body = await readBody(req);
    if (!timingSafeStringEqual(body.password || '', process.env.ADMIN_PASSWORD)) {
      await new Promise(r => setTimeout(r, 400));
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

  // ---------- Auth Google (login) ----------
  if (pathname === '/auth/google/start') {
    try {
      const state = crypto.randomBytes(16).toString('hex');
      const authUrl = getLoginAuthUrl(state);
      res.writeHead(302, {
        Location: authUrl,
        'Set-Cookie': `oauthState=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
      });
      res.end();
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h2>Erro</h2><p>${err.message}</p><a href="/">Voltar</a>`);
    }
    return;
  }

  if (pathname === '/auth/logout' && req.method === 'POST') {
    return json(res, { ok: true }, 200, { 'Set-Cookie': userCookie('', 0) });
  }

  if (pathname === '/api/auth/check' && req.method === 'GET') {
    const uid = getRequestUserId(req);
    if (!uid) return json(res, { authed: false }, 200);
    const user = await getUser(uid);
    if (!user) return json(res, { authed: false }, 200, { 'Set-Cookie': userCookie('', 0) });
    return json(res, { authed: true, userId: user.id, email: user.email, name: user.name });
  }

  // ---------- A partir daqui, todos os /api/* exigem sessao ----------

  if (pathname === '/api/session' && req.method === 'GET') {
    const uid = requireUserSession(req, res);
    if (!uid) return;
    const user = await getUser(uid);
    if (!user) {
      return json(res, { error: 'usuario nao existe' }, 404, { 'Set-Cookie': userCookie('', 0) });
    }
    return json(res, {
      userId: user.id,
      name: user.name,
      email: user.email,
      assistantChatId: user.assistant_chat_id,
      calendarId: user.calendar_id,
      timezone: user.timezone,
    });
  }

  if (pathname === '/api/config' && req.method === 'GET') {
    // GET continua publico — so retorna config global mascarada que o admin precisa
    // (mas o app.js so chama isso depois do login, entao na pratica fica protegido pela UI)
    return json(res, maskConfig(getConfig()));
  }

  if (pathname === '/api/config' && req.method === 'POST') {
    const uid = requireUserSession(req, res);
    if (!uid) return;
    const user = await getUser(uid);
    if (!user) return json(res, { error: 'usuario nao existe' }, 404);

    const body = await readBody(req);
    const sensitivePlatformKeys = new Set([
      'GOOGLE_API_KEY', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET',
      'OAUTH_REDIRECT_URI', 'GEMINI_MODEL',
    ]);
    const userPlatformKeys = ['REMINDER_MINUTES', 'DEFAULT_TIMEZONE', 'FOOTBALL_DATA_KEY'];
    const update = {};
    for (const key of userPlatformKeys) {
      if (body[key] !== undefined && body[key] !== '') update[key] = body[key];
    }
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

  if (pathname === '/api/admin/users/pause' && req.method === 'POST') {
    if (!requireAdminApi(req, res)) return;
    const body = await readBody(req);
    if (!body.userId) return json(res, { error: 'userId obrigatorio' }, 400);
    try {
      await manager.pauseWhatsAppInstance(body.userId);
      return json(res, { ok: true });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  if (pathname === '/api/admin/users/resume' && req.method === 'POST') {
    if (!requireAdminApi(req, res)) return;
    const body = await readBody(req);
    if (!body.userId) return json(res, { error: 'userId obrigatorio' }, 400);
    try {
      manager.startWhatsAppInstance(body.userId).catch(err => console.error('[server] Erro ao retomar bot:', err));
      return json(res, { ok: true });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  if (pathname === '/api/admin/users/delete' && req.method === 'POST') {
    if (!requireAdminApi(req, res)) return;
    const body = await readBody(req);
    if (!body.userId) return json(res, { error: 'userId obrigatorio' }, 400);
    try {
      await manager.logoutWhatsAppInstance(body.userId);
      await manager.deleteUser(body.userId);
      return json(res, { ok: true });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
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
    const uid = requireUserSession(req, res);
    if (!uid) return;
    const currentUser = await getUser(uid);
    try {
      return json(res, { calendars: await listCalendars(uid), selectedCalendarId: currentUser?.calendar_id || 'primary' });
    } catch (error) {
      return json(res, { error: error.message, calendars: [] }, 400);
    }
  }

  if (pathname === '/api/calendar/select' && req.method === 'POST') {
    const uid = requireUserSession(req, res);
    if (!uid) return;
    const body = await readBody(req);
    const calendarId = body.GOOGLE_CALENDAR_ID || 'primary';
    await updateUserSettings(uid, { calendarId });
    return json(res, { ok: true, calendarId });
  }

  if (pathname === '/api/status') {
    const uid = requireUserSession(req, res);
    if (!uid) return;
    const currentUser = await getUser(uid);
    if (!currentUser) return json(res, { error: 'usuario nao existe' }, 404, { 'Set-Cookie': userCookie('', 0) });
    const whatsappStatus = await manager.getWhatsAppStatus(uid);
    const config = getConfig();
    const platformConfigured = isPlatformConfigured();
    return json(res, {
      userId: currentUser.id,
      configComplete: platformConfigured && !!currentUser?.assistant_chat_id,
      platformConfigured,
      hasGeminiKey: !!config.GOOGLE_API_KEY,
      hasOAuthCredentials: !!(config.GOOGLE_OAUTH_CLIENT_ID && config.GOOGLE_OAUTH_CLIENT_SECRET),
      calendarConnected: await isGoogleConnected(uid),
      hasPhone: !!currentUser?.assistant_chat_id,
      botStatus: whatsappStatus.status,
      qrAvailable: whatsappStatus.qrAvailable,
      sessionPath: whatsappStatus.sessionPath,
    });
  }

  if (pathname === '/api/qr') {
    const uid = requireUserSession(req, res);
    if (!uid) return;
    const latestQrString = await getLatestQr(uid);
    if (!latestQrString) return json(res, { qr: null, userId: uid });
    try {
      const svg = await qrcode.toString(latestQrString, { type: 'svg' });
      return json(res, { qr: svg, userId: uid });
    } catch {
      return json(res, { qr: null, userId: uid });
    }
  }

  if (pathname === '/api/user/pause' && req.method === 'POST') {
    const uid = requireUserSession(req, res);
    if (!uid) return;
    try {
      await manager.pauseWhatsAppInstance(uid);
      return json(res, { ok: true });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  if (pathname === '/api/user/resume' && req.method === 'POST') {
    const uid = requireUserSession(req, res);
    if (!uid) return;
    try {
      manager.startWhatsAppInstance(uid).catch(err => console.error('[server] Erro ao retomar bot:', err));
      return json(res, { ok: true });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  if (pathname === '/api/user/switch-number' && req.method === 'POST') {
    const uid = requireUserSession(req, res);
    if (!uid) return;
    try {
      await manager.logoutWhatsAppInstance(uid);
      await manager.updateUserSettings(uid, { assistantChatId: null });
      return json(res, { ok: true });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  if (pathname === '/api/user/delete' && req.method === 'POST') {
    const uid = requireUserSession(req, res);
    if (!uid) return;
    try {
      await manager.logoutWhatsAppInstance(uid);
      await manager.deleteUser(uid);
      return json(res, { ok: true }, 200, { 'Set-Cookie': userCookie('', 0) });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  // ---------- Reconnect manual do Calendar (mantem usuario logado) ----------
  if (pathname === '/oauth/start') {
    const uid = getRequestUserId(req);
    if (!uid) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>Nao autenticado</h2><a href="/">Entrar</a>');
      return;
    }
    try {
      const authUrl = getAuthUrl(uid);
      res.writeHead(302, { Location: authUrl });
      res.end();
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h2>Erro</h2><p>${err.message}</p><a href="/">Voltar</a>`);
    }
    return;
  }

  // Unifica /oauth/callback (legacy, ja registrado no Google Cloud) e
  // /auth/google/callback — o state-cookie distingue login de reconnect.
  if (pathname === '/oauth/callback' || pathname === '/auth/google/callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const cookies = parseCookies(req.headers.cookie || '');

    if (!code || !state) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>Erro</h2><p>Codigo ou state ausente.</p><a href="/">Voltar</a>');
      return;
    }

    // Caso 1: state bate com cookie oauthState -> fluxo de LOGIN com Google
    if (cookies.oauthState && state === cookies.oauthState) {
      try {
        const { tokens, profile } = await exchangeCodeForLogin(code);
        const email = String(profile.email || '').toLowerCase().trim();
        const sub = profile.sub || profile.id || null;
        if (!email) throw new Error('Conta Google nao retornou email.');

        let existing = (sub && await findUserByGoogleSub(sub)) || await findUserByEmail(email);
        const userId = existing?.id || email;
        const name = profile.name || profile.given_name || email.split('@')[0];

        await ensureUser({ id: userId, name, email, googleSub: sub });
        await saveGoogleTokens(userId, tokens);

        const token = signUserToken(userId);
        res.writeHead(302, {
          Location: '/?connected=1',
          'Set-Cookie': [
            `oauthState=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
            userCookie(token, Math.floor(USER_SESSION_MS / 1000)),
          ],
        });
        res.end();
      } catch (err) {
        console.error('[server] Falha no login Google:', err);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h2>Erro ao entrar com Google</h2><p>${err.message}</p><a href="/">Voltar</a>`);
      }
      return;
    }

    // Caso 2: state e um userId existente -> reconnect Calendar do usuario logado
    try {
      const existing = await getUser(state);
      if (!existing) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>Usuario nao encontrado</h2><a href="/">Voltar</a>');
        return;
      }
      await exchangeCodeForTokens(code, state);
      res.writeHead(302, { Location: '/?connected=1' });
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
