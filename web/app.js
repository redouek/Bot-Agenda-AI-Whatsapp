/* global state */
let currentStatus = null;

const $ = id => document.getElementById(id);

function show(sectionId) {
  ['section-setup', 'section-qr', 'section-ready', 'section-disconnected'].forEach(id => {
    $(id).classList.add('hidden');
  });
  $(sectionId).classList.remove('hidden');
}

function updateStatusLabel(botStatus) {
  const labels = {
    stopped: 'Parado',
    initializing: 'Inicializando...',
    awaiting_qr: 'Aguardando QR scan',
    ready: 'Rodando',
    disconnected: 'Desconectado',
  };
  $('status-label').textContent = labels[botStatus] || botStatus;
}

function updateCalendarStatus(connected) {
  const icon = $('calendar-icon');
  const label = $('calendar-label');
  if (connected) {
    icon.textContent = '✅';
    label.textContent = 'Google Calendar conectado';
    $('status-calendar').classList.add('ok');
  } else {
    icon.textContent = '⚠️';
    label.textContent = 'Google Calendar não conectado — acesse o setup';
    $('status-calendar').classList.remove('ok');
  }
}

async function renderQr() {
  const container = $('qr-container');
  try {
    const res = await fetch('/api/qr');
    const data = await res.json();
    if (data.qr) {
      container.innerHTML = data.qr;
    } else {
      container.innerHTML = '<p class="loading">Aguardando QR code...</p>';
    }
  } catch {
    container.innerHTML = '<p class="loading">Erro ao carregar QR.</p>';
  }
}

async function pollStatus() {
  try {
    const res = await fetch('/api/status');
    const status = await res.json();
    currentStatus = status;

    updateStatusLabel(status.botStatus);

    if (!status.configComplete) {
      show('section-setup');
      return;
    }

    if (status.botStatus === 'awaiting_qr') {
      show('section-qr');
      await renderQr();
      return;
    }

    if (status.botStatus === 'ready') {
      show('section-ready');
      updateCalendarStatus(status.calendarConnected);
      return;
    }

    if (status.botStatus === 'disconnected') {
      show('section-disconnected');
      return;
    }

    // initializing / stopped — mostra setup ou aguarda
    if (status.configComplete) {
      show('section-setup');
      loadCurrentConfig();
    } else {
      show('section-setup');
    }
  } catch {
    $('status-label').textContent = 'Sem conexão com o servidor';
  }
}

async function loadCurrentConfig() {
  try {
    const res = await fetch('/api/config');
    const config = await res.json();
    const form = $('form-setup');
    for (const [key, value] of Object.entries(config)) {
      const input = form.elements[key];
      if (input && !value.includes('••••••')) input.value = value;
    }

    // Habilita botão OAuth se client ID e secret estiverem preenchidos
    updateOAuthButton(config);
  } catch {}
}

function updateOAuthButton(config) {
  const hasCredentials = config.GOOGLE_OAUTH_CLIENT_ID && config.GOOGLE_OAUTH_CLIENT_SECRET;
  const btn = $('btn-oauth');
  const msg = $('calendar-status-msg');

  if (currentStatus?.calendarConnected) {
    msg.textContent = '✅ Google Calendar conectado!';
    btn.textContent = 'Reconectar';
    btn.disabled = !hasCredentials;
  } else if (hasCredentials) {
    msg.textContent = 'Clique para autorizar o acesso ao seu Google Calendar.';
    btn.disabled = false;
  } else {
    msg.textContent = 'Preencha o Client ID e Client Secret acima primeiro.';
    btn.disabled = true;
  }
}

// Formulário de setup
$('form-setup').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = {};
  for (const el of form.elements) {
    if (el.name && el.value.trim()) data[el.name] = el.value.trim();
  }

  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    const feedback = $('save-feedback');
    feedback.classList.remove('hidden');
    setTimeout(() => feedback.classList.add('hidden'), 3000);

    updateOAuthButton(data);
    pollStatus();
  } catch {
    alert('Erro ao salvar configuração.');
  }
});

// Botão OAuth
$('btn-oauth').addEventListener('click', () => {
  window.location.href = '/oauth/start';
});

// Mostra setup manualmente (botão "Reconfigurar")
window.showSetup = function () {
  show('section-setup');
  loadCurrentConfig();
};

// Detecta retorno do OAuth
if (new URLSearchParams(location.search).get('connected') === '1') {
  history.replaceState({}, '', '/');
  pollStatus();
}

// Inicia polling
loadCurrentConfig();
pollStatus();
setInterval(pollStatus, 3000);
