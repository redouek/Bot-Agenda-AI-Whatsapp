// Helpers HTTP compartilhados pelas integracoes gratuitas (BrasilAPI, Open-Meteo,
// Home Assistant). O erro carrega `status` para o chamador tratar 403/404.
export async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const error = new Error(`HTTP ${response.status} em ${url}: ${body.slice(0, 200)}`);
      error.status = response.status;
      throw error;
    }

    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeText(value = '') {
  return String(value).normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

// Data local (YYYY-MM-DD) de um instante no fuso informado
export function toLocalDateString(dateValue, timeZone = 'America/Sao_Paulo') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(dateValue));
}
