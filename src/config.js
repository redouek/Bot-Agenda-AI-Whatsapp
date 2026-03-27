import fs from 'fs';
import path from 'path';

const CONFIG_PATH = process.env.CONFIG_PATH || path.resolve('./data/config.json');

let _config = {};

export function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      _config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch {
    _config = {};
  }
}

export function getConfig() {
  return _config;
}

export function setConfig(partial) {
  _config = { ..._config, ...partial };
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(_config, null, 2), 'utf8');
}

export function isConfigComplete() {
  const c = _config;
  return !!(
    c.GRUPO_ASSISTENTE_ID &&
    c.GOOGLE_API_KEY &&
    c.GOOGLE_CALENDAR_ID &&
    c.GOOGLE_OAUTH_CLIENT_ID &&
    c.GOOGLE_OAUTH_CLIENT_SECRET
  );
}

export function isCalendarConnected() {
  const tokensPath = process.env.TOKENS_PATH || path.resolve('./data/google-tokens.json');
  if (!fs.existsSync(tokensPath)) return false;
  try {
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
    return !!(tokens.access_token && tokens.refresh_token);
  } catch {
    return false;
  }
}
