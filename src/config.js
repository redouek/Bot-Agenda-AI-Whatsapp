import fs from 'fs';
import path from 'path';

const CONFIG_PATH = process.env.CONFIG_PATH || path.resolve('./data/config.json');
const ENV_CONFIG_KEYS = [
  'GOOGLE_API_KEY',
  'GEMINI_MODEL',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'OAUTH_REDIRECT_URI',
  'GOOGLE_CALENDAR_ID',
  'REMINDER_MINUTES',
  'DEFAULT_TIMEZONE',
];

let _config = {};

export function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      _config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch {
    _config = {};
  }

  for (const key of ENV_CONFIG_KEYS) {
    if (process.env[key]) _config[key] = process.env[key];
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

export function isPlatformConfigured() {
  const c = _config;
  return !!(
    c.GOOGLE_API_KEY &&
    c.GOOGLE_OAUTH_CLIENT_ID &&
    c.GOOGLE_OAUTH_CLIENT_SECRET
  );
}

export function isConfigComplete() {
  return isPlatformConfigured();
}
