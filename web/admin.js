const form = document.getElementById('admin-form');
const feedback = document.getElementById('admin-feedback');
const usersStatus = document.getElementById('users-status');
const refreshUsersBtn = document.getElementById('btn-refresh-users');
const loginSection = document.getElementById('admin-login');
const loginForm = document.getElementById('admin-login-form');
const loginError = document.getElementById('admin-login-error');
const passwordInput = document.getElementById('admin-password');
const disabledSection = document.getElementById('admin-disabled');
const contentSection = document.getElementById('admin-content');
const logoutBtn = document.getElementById('btn-admin-logout');

const STATUS_LABELS = {
  stopped: 'Parado',
  initializing: 'Iniciando',
  authenticated: 'Autenticado',
  awaiting_qr: 'Aguardando QR',
  ready: 'Rodando',
  disconnected: 'Desconectado',
  auth_failure: 'Falha auth',
  error: 'Erro',
};

let pollHandle = null;

function show(state) {
  loginSection.classList.toggle('hidden', state !== 'login');
  disabledSection.classList.toggle('hidden', state !== 'disabled');
  contentSection.classList.toggle('hidden', state !== 'authed');
  logoutBtn.classList.toggle('hidden', state !== 'authed');
}

function formatPhone(chatId) {
  if (!chatId) return '-';
  return chatId.replace('@c.us', '').replace(/(\d{2})(\d{2})(\d{5})(\d{4})/, '+$1 ($2) $3-$4');
}

function formatDate(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('pt-BR');
  } catch { return iso; }
}

async function loadUsers() {
  try {
    const res = await fetch('/api/admin/users', { credentials: 'include' });
    if (res.status === 401) {
      stopPolling();
      show('login');
      return;
    }
    if (!res.ok) throw new Error('Falha ao carregar usuarios (HTTP ' + res.status + ')');
    const { users } = await res.json();

    if (!users || users.length === 0) {
      usersStatus.innerHTML = '<p class="loading">Nenhum usuario cadastrado.</p>';
      return;
    }

    const escape = (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
    const rows = users.map(u => {
      const statusLabel = STATUS_LABELS[u.botStatus] || u.botStatus;
      const lidBadge = u.selfChatLid ? '<span class="badge ok">LID OK</span>' : '<span class="badge warn">LID pendente</span>';
      const calBadge = u.calendarConnected ? '<span class="badge ok">Calendar OK</span>' : '<span class="badge warn">Sem Calendar</span>';
      const isPaused = u.botStatus === 'paused';
      const pauseBtn = isPaused
        ? `<button type="button" class="row-action" data-action="resume" data-uid="${escape(u.id)}">Retomar</button>`
        : `<button type="button" class="row-action" data-action="pause" data-uid="${escape(u.id)}">Pausar</button>`;
      const adminBtn = u.isAdmin
        ? `<button type="button" class="row-action" data-action="unset-admin" data-uid="${escape(u.id)}">Remover admin</button>`
        : `<button type="button" class="row-action" data-action="set-admin" data-uid="${escape(u.id)}">Promover admin</button>`;
      const deleteBtn = `<button type="button" class="row-action danger" data-action="delete" data-uid="${escape(u.id)}" data-name="${escape(u.name || u.id)}">Excluir</button>`;
      const adminBadge = u.isAdmin ? ' <span class="badge admin">Admin</span>' : '';
      return `
        <tr>
          <td><strong>${escape(u.name || u.id)}</strong>${adminBadge}<br><small>${escape(u.email || u.id)}</small></td>
          <td>${formatPhone(u.phone)}</td>
          <td>${calBadge}</td>
          <td>${lidBadge}</td>
          <td>${statusLabel}</td>
          <td><small>${formatDate(u.lastReadyAt)}</small></td>
          <td class="row-actions">${pauseBtn} ${adminBtn} ${deleteBtn}</td>
        </tr>
      `;
    }).join('');

    usersStatus.innerHTML = `
      <table class="users-table">
        <thead>
          <tr>
            <th>Usuario</th>
            <th>Telefone</th>
            <th>Calendar</th>
            <th>LID</th>
            <th>Bot</th>
            <th>Ultimo ready</th>
            <th>Acoes</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    // Wire dos botoes de acao
    usersStatus.querySelectorAll('.row-action').forEach(btn => {
      btn.addEventListener('click', () => handleUserAction(btn));
    });
  } catch (err) {
    usersStatus.innerHTML = `<p class="loading">Erro: ${err.message}</p>`;
  }
}

async function handleUserAction(btn) {
  const action = btn.dataset.action;
  const userId = btn.dataset.uid;
  const name = btn.dataset.name || userId;
  if (!action || !userId) return;

  if (action === 'delete') {
    const ok = confirm(`Excluir o usuario "${name}"?\n\nIsso vai:\n- Desvincular o WhatsApp do dispositivo\n- Apagar a sessao em disco\n- Apagar tokens Google e configuracoes\n\nAcao irreversivel.`);
    if (!ok) return;
  }

  // Mapeia acoes para endpoint + body
  let endpoint = '';
  let body = { userId };
  if (action === 'set-admin' || action === 'unset-admin') {
    endpoint = '/api/admin/users/set-admin';
    body = { userId, isAdmin: action === 'set-admin' };
  } else {
    endpoint = `/api/admin/users/${action}`;
  }

  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '...';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    });
    if (res.status === 401) { stopPolling(); show('login'); return; }
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { msg = (await res.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    await loadUsers();
  } catch (err) {
    alert('Erro: ' + err.message);
    btn.textContent = original;
    btn.disabled = false;
  }
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config', { credentials: 'include' });
    const config = await res.json();
    for (const [key, value] of Object.entries(config)) {
      const input = form.elements[key];
      if (input && typeof value === 'string' && !value.includes('******')) {
        input.value = value;
      }
    }
    if (!form.elements.OAUTH_REDIRECT_URI.value) {
      form.elements.OAUTH_REDIRECT_URI.value = `${location.origin}/oauth/callback`;
    }
  } catch {}
}

function startPolling() {
  if (pollHandle) return;
  pollHandle = setInterval(loadUsers, 15000);
}

function stopPolling() {
  if (!pollHandle) return;
  clearInterval(pollHandle);
  pollHandle = null;
}

async function enterAuthedMode() {
  show('authed');
  await loadConfig();
  await loadUsers();
  startPolling();
}

async function checkSession() {
  try {
    const res = await fetch('/api/admin/check', { credentials: 'include' });
    const data = await res.json();
    if (!data.enabled) {
      show('disabled');
      return;
    }
    if (data.authed) {
      await enterAuthedMode();
    } else {
      show('login');
      passwordInput?.focus();
    }
  } catch {
    show('login');
  }
}

loginForm?.addEventListener('submit', async event => {
  event.preventDefault();
  loginError.classList.add('hidden');
  const password = passwordInput.value;
  if (!password) return;
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
      credentials: 'include',
    });
    if (res.status === 401) {
      loginError.textContent = 'Senha incorreta.';
      loginError.classList.remove('hidden');
      return;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    passwordInput.value = '';
    await enterAuthedMode();
  } catch (err) {
    loginError.textContent = 'Erro: ' + err.message;
    loginError.classList.remove('hidden');
  }
});

logoutBtn?.addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST', credentials: 'include' });
  stopPolling();
  show('login');
  passwordInput?.focus();
});

refreshUsersBtn?.addEventListener('click', loadUsers);

form.addEventListener('submit', async event => {
  event.preventDefault();
  const data = {};
  for (const el of form.elements) {
    if (el.name && el.value.trim()) data[el.name] = el.value.trim();
  }

  try {
    const res = await fetch('/api/admin/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      credentials: 'include',
    });
    if (res.status === 401) {
      stopPolling();
      show('login');
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    feedback.classList.remove('hidden');
    setTimeout(() => feedback.classList.add('hidden'), 4000);
  } catch (err) {
    alert('Nao foi possivel salvar a plataforma: ' + err.message);
  }
});

checkSession();
