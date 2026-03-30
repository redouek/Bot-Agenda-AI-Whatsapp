import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import qrcode from 'qrcode';
import { getConfig, setConfig, isConfigComplete, isCalendarConnected } from './config.js';
import { getAuthUrl, exchangeCodeForTokens } from './calendar.js';
import { startBot, getBotStatus, setQrCallback } from './bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '../web');

let latestQrString = null;

setQrCallback((qr) => {
  latestQrString = qr;
});

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

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
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

function maskConfig(config) {
  const masked = { ...config };
  const sensitiveKeys = ['GOOGLE_API_KEY', 'GOOGLE_OAUTH_CLIENT_SECRET', 'FOOTBALL_DATA_KEY'];
  for (const key of sensitiveKeys) {
    if (masked[key]) masked[key] = masked[key].slice(0, 6) + '••••••';
  }
  return masked;
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Arquivos estáticos
  if (pathname === '/' || pathname === '/setup' || pathname === '/status') {
    return serveFile(res, path.join(WEB_DIR, 'index.html'), 'text/html; charset=utf-8');
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

  // API — configuração
  if (pathname === '/api/config' && req.method === 'GET') {
    return json(res, maskConfig(getConfig()));
  }

  if (pathname === '/api/config' && req.method === 'POST') {
    const body = await readBody(req);
    const allowed = [
      'GRUPO_ASSISTENTE_ID', 'GOOGLE_API_KEY', 'GOOGLE_CALENDAR_ID',
      'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'OAUTH_REDIRECT_URI',
      'FOOTBALL_DATA_KEY', 'REMINDER_MINUTES', 'DEFAULT_TIMEZONE', 'GEMINI_MODEL',
    ];
    const update = {};
    for (const key of allowed) {
      if (body[key] !== undefined && body[key] !== '') update[key] = body[key];
    }
    setConfig(update);

    if (isConfigComplete() && getBotStatus() === 'stopped') {
      startBot().catch(err => console.error('[server] Erro ao iniciar bot:', err));
    }

    return json(res, { ok: true });
  }

  // API — status
  if (pathname === '/api/status') {
    return json(res, {
      configComplete: isConfigComplete(),
      calendarConnected: isCalendarConnected(),
      botStatus: getBotStatus(),
      qrAvailable: !!latestQrString,
    });
  }

  // API — QR code como SVG
  if (pathname === '/api/qr') {
    if (!latestQrString) return json(res, { qr: null });
    try {
      const svg = await qrcode.toString(latestQrString, { type: 'svg' });
      return json(res, { qr: svg });
    } catch {
      return json(res, { qr: null });
    }
  }

  // OAuth — iniciar
  if (pathname === '/oauth/start') {
    try {
      const authUrl = getAuthUrl();
      res.writeHead(302, { Location: authUrl });
      res.end();
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h2>Erro</h2><p>${err.message}</p><a href="/">Voltar</a>`);
    }
    return;
  }

  // OAuth — callback
  if (pathname === '/oauth/callback') {
    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>Erro</h2><p>Código de autorização não recebido.</p><a href="/">Voltar</a>');
      return;
    }
    try {
      await exchangeCodeForTokens(code);
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

export function startServer(port = 3000) {
  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (err) {
      console.error('[server] Erro interno:', err);
      res.writeHead(500);
      res.end('Internal server error');
    }
  });

  server.listen(port, () => {
    console.log(`[server] Painel disponível em http://localhost:${port}`);
  });
}
