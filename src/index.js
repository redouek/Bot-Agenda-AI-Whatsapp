import fs from 'fs';
import path from 'path';
import pkg from 'whatsapp-web.js';
import { loadConfig, isPlatformConfigured } from './config.js';
import { startServer } from './server.js';
import { processIncomingMessage, startReminderLoop, stopReminderLoop, startSelfChatPolling, stopSelfChatPolling, hydrateSelfChatLidFromDb, setSessionStart, clearSessionStart } from './bot.js';
import {
  deleteUser,
  ensureUser,
  getDefaultUserId,
  getWhatsAppSession,
  getWhatsAppSessionPath,
  initDatabase,
  listUsers,
  updateUserSettings,
  updateWhatsAppSession,
  userIdToFolder,
} from './database.js';

const { Client, LocalAuth } = pkg;

const whatsappInstances = new Map();

const PUPPETEER_RECOVERABLE = /Execution context was destroyed|detached Frame|Target closed|Session closed|Most likely the page has been closed/i;

process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  if (PUPPETEER_RECOVERABLE.test(msg)) {
    console.warn('[process] unhandledRejection recuperavel ignorada:', msg.slice(0, 200));
    return;
  }
  console.error('[process] unhandledRejection NAO recuperavel:', reason);
});

process.on('uncaughtException', (err) => {
  const msg = err?.message || String(err);
  if (PUPPETEER_RECOVERABLE.test(msg)) {
    console.warn('[process] uncaughtException recuperavel ignorada:', msg.slice(0, 200));
    return;
  }
  console.error('[process] uncaughtException NAO recuperavel:', err);
});

// Puppeteer aborta um comando CDP depois deste tempo. O default (180s) fazia o
// painel ficar "carregando" varios minutos antes de mostrar erro.
const PROTOCOL_TIMEOUT_MS = 90_000;
// Se a inicializacao nao chegar nem a emitir QR neste prazo, e travamento.
const INIT_TIMEOUT_MS = 90_000;

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

// Um Chromium vivo mantem o SingletonLock do profile. Apagar o lock as cegas
// deixa um SEGUNDO Chromium abrir o MESMO user-data-dir — profile corrompido e
// processos multiplicando. So limpa quando ninguem esta usando o profile.
function isProfileInUse(sessionPath) {
  let pids;
  try {
    pids = fs.readdirSync('/proc');
  } catch {
    return false; // /proc indisponivel (ex: Windows) — mantem comportamento antigo
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (cmdline.includes('--user-data-dir=') && cmdline.includes(sessionPath)) return true;
    } catch { /* processo morreu ou sem permissao */ }
  }
  return false;
}

function clearChromiumLocks(sessionPath) {
  if (isProfileInUse(sessionPath)) {
    console.warn(`[index] Chromium ainda ativo em ${sessionPath}; preservando locks do profile.`);
    return;
  }
  try {
    if (!fs.existsSync(sessionPath)) return;
    const subdirs = fs.readdirSync(sessionPath, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith('session-'));
    for (const d of subdirs) {
      const dir = path.join(sessionPath, d.name);
      for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        const f = path.join(dir, name);
        try { fs.unlinkSync(f); } catch {}
      }
    }
  } catch (err) {
    console.warn('[index] Falha ao limpar locks do Chromium:', err?.message || err);
  }
}

function getExistingRuntime(userId) {
  return whatsappInstances.get(userId) || null;
}

// Fecha o browser de um runtime. Toda saida de startWhatsAppInstance que
// descarta um client PRECISA passar por aqui — um client descartado sem destroy
// deixa ~11 processos Chromium orfaos que so morrem junto com o container.
async function destroyRuntime(runtime, reason) {
  if (!runtime?.client) return;
  try {
    await runtime.client.destroy();
    console.log(`[index] Client de ${runtime.userId} encerrado (${reason}).`);
  } catch (error) {
    console.warn(`[index] Falha ao encerrar client de ${runtime.userId} (${reason}):`, error?.message || error);
  }
}

// initialize() pode ficar pendurado indefinidamente quando o Chromium sobe sem
// recursos. O watchdog so dispara se nem o QR saiu — depois disso a demora e
// legitima (o usuario ainda esta escaneando).
async function initializeWithWatchdog(client, runtime, ms) {
  let timer;
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (runtime.status !== 'initializing') return;
      reject(new Error(`Inicializacao travada em 'initializing' apos ${Math.round(ms / 1000)}s`));
    }, ms);
    timer.unref?.();
  });

  try {
    await Promise.race([client.initialize(), watchdog]);
  } finally {
    clearTimeout(timer);
  }
}

function isRunningStatus(status) {
  return ['initializing', 'awaiting_qr', 'authenticated', 'ready'].includes(status);
}

// Quantos clients deveriam ter um Chromium vivo agora. O /api/health compara
// com os browsers realmente em execucao: sobra e vazamento.
export function getActiveInstanceCount() {
  let count = 0;
  for (const runtime of whatsappInstances.values()) {
    if (isRunningStatus(runtime.status)) count += 1;
  }
  return count;
}

export async function getOrCreateCurrentUser(userId = getDefaultUserId()) {
  return ensureUser({
    id: userId,
    name: userId === getDefaultUserId() ? 'Renato' : userId,
  });
}

export async function startWhatsAppInstance(userId = getDefaultUserId()) {
  const user = await getOrCreateCurrentUser(userId);
  const existing = getExistingRuntime(user.id);

  if (!user.assistant_chat_id) {
    console.log(`[index] Usuario ${user.id} ainda nao informou telefone. WhatsApp nao sera iniciado.`);
    await updateWhatsAppSession(user.id, { status: 'stopped', latestQr: null });
    return {
      userId: user.id,
      client: null,
      status: 'stopped',
      qr: null,
      sessionPath: getWhatsAppSessionPath(user.id),
    };
  }

  if (existing && isRunningStatus(existing.status)) {
    console.log(`[index] Instancia WhatsApp ja ativa para usuario ${user.id}.`);
    return existing;
  }

  // Runtime existente porem parado (error/disconnected/auth_failure): o browser
  // dele continua vivo. O whatsappInstances.set() mais abaixo sobrescreveria a
  // entrada e a referencia ao client antigo se perderia para sempre.
  if (existing) {
    await destroyRuntime(existing, `substituindo instancia em '${existing.status}'`);
    whatsappInstances.delete(user.id);
  }

  const sessionPath = getWhatsAppSessionPath(user.id);
  ensureDir(sessionPath);
  clearChromiumLocks(sessionPath);

  await hydrateSelfChatLidFromDb(user.id);

  await updateWhatsAppSession(user.id, {
    status: 'initializing',
    latestQr: null,
    sessionPath,
  });

  console.log(`[index] Iniciando WhatsApp para usuario ${user.id} em ${sessionPath}`);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: userIdToFolder(user.id), dataPath: sessionPath }),
    puppeteer: {
      headless: true,
      protocolTimeout: PROTOCOL_TIMEOUT_MS,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        // Sem isto cada aba em segundo plano segura RAM que nunca volta.
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    },
  });

  const runtime = {
    userId: user.id,
    client,
    status: 'initializing',
    qr: null,
    sessionPath,
    startedAt: new Date().toISOString(),
  };

  whatsappInstances.set(user.id, runtime);

  client.on('qr', async qr => {
    console.log(`[bot:${user.id}] QR code gerado.`);
    runtime.status = 'awaiting_qr';
    runtime.qr = qr;
    await updateWhatsAppSession(user.id, { status: 'awaiting_qr', latestQr: qr, sessionPath });
  });

  client.on('authenticated', async () => {
    console.log(`[bot:${user.id}] WhatsApp autenticado.`);
    runtime.status = 'authenticated';
    runtime.qr = null;
    await updateWhatsAppSession(user.id, { status: 'authenticated', latestQr: null, sessionPath });
  });

  client.on('ready', async () => {
    console.log(`[bot:${user.id}] WhatsApp pronto.`);
    runtime.status = 'ready';
    runtime.qr = null;
    setSessionStart(user.id);
    await updateWhatsAppSession(user.id, {
      status: 'ready',
      latestQr: null,
      sessionPath,
      lastReadyAt: new Date().toISOString(),
    });
    startReminderLoop(user.id, client);
    startSelfChatPolling(user.id, client);
  });

  client.on('auth_failure', async error => {
    console.error(`[bot:${user.id}] Falha de autenticacao:`, error);
    runtime.status = 'auth_failure';
    await updateWhatsAppSession(user.id, { status: 'auth_failure', latestQr: null, sessionPath });
  });

  client.on('disconnected', async reason => {
    console.warn(`[bot:${user.id}] WhatsApp desconectado:`, reason);
    runtime.status = 'disconnected';
    runtime.qr = null;
    stopReminderLoop(user.id);
    stopSelfChatPolling(user.id);
    clearSessionStart(user.id);
    await updateWhatsAppSession(user.id, { status: 'disconnected', latestQr: null, sessionPath });
  });

  client.on('message', async message => {
    try {
      await processIncomingMessage(user.id, client, message, 'event:message');
    } catch (error) {
      console.error(`[bot:${user.id}] Erro no fluxo de message:`, error);
    }
  });

  client.on('message_create', async message => {
    try {
      await processIncomingMessage(user.id, client, message, 'event:message_create');
    } catch (error) {
      console.error(`[bot:${user.id}] Erro no fluxo de message_create:`, error);
    }
  });

  try {
    await initializeWithWatchdog(client, runtime, INIT_TIMEOUT_MS);
  } catch (error) {
    runtime.status = 'error';
    // O destroy aqui e o que impede o vazamento: sem ele, cada tentativa de
    // reconectar pelo painel deixava mais um Chromium vivo, ate a RAM do host
    // acabar e o proximo initialize() estourar por timeout.
    await destroyRuntime(runtime, 'falha na inicializacao');
    whatsappInstances.delete(user.id);
    await updateWhatsAppSession(user.id, { status: 'error', latestQr: null, sessionPath });
    throw error;
  }

  return runtime;
}

export async function stopWhatsAppInstance(userId = getDefaultUserId(), finalStatus = 'stopped') {
  const runtime = whatsappInstances.get(userId);
  await destroyRuntime(runtime, `parada solicitada (${finalStatus})`);

  stopReminderLoop(userId);
  stopSelfChatPolling(userId);
  clearSessionStart(userId);
  whatsappInstances.delete(userId);
  await updateWhatsAppSession(userId, { status: finalStatus, latestQr: null });
}

export async function pauseWhatsAppInstance(userId = getDefaultUserId()) {
  await stopWhatsAppInstance(userId, 'paused');
}

// Faz logout no WhatsApp (desvincula o dispositivo) e remove a pasta de sessao.
// Necessario antes de trocar de numero ou excluir conta.
export async function logoutWhatsAppInstance(userId = getDefaultUserId()) {
  const runtime = whatsappInstances.get(userId);
  if (runtime?.client) {
    try {
      await runtime.client.logout();
    } catch (error) {
      console.warn(`[index] Falha no logout ${userId}:`, error?.message || error);
    }
    // logout() nao fecha o browser — sem destroy o Chromium fica orfao.
    await destroyRuntime(runtime, 'logout');
  }
  stopReminderLoop(userId);
  stopSelfChatPolling(userId);
  clearSessionStart(userId);
  whatsappInstances.delete(userId);

  // Remove arquivos da sessao em disco
  const sessionPath = getWhatsAppSessionPath(userId);
  try {
    await fs.promises.rm(sessionPath, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[index] Falha ao apagar sessao ${sessionPath}:`, err?.message);
  }
  await updateWhatsAppSession(userId, { status: 'stopped', latestQr: null });
}

export async function getWhatsAppStatus(userId = getDefaultUserId()) {
  const runtime = whatsappInstances.get(userId);
  if (runtime) {
    return {
      status: runtime.status,
      qrAvailable: !!runtime.qr,
      sessionPath: runtime.sessionPath,
    };
  }

  const session = await getWhatsAppSession(userId);
  return {
    status: session?.status || 'stopped',
    qrAvailable: !!session?.latest_qr,
    sessionPath: session?.session_path || getWhatsAppSessionPath(userId),
  };
}

async function startConfiguredInstances() {
  await getOrCreateCurrentUser();

  if (!isPlatformConfigured()) {
    console.log('[index] Configuracao incompleta. Acesse o painel web para configurar.');
    return;
  }

  const users = await listUsers();
  for (const user of users) {
    if (!user.assistant_chat_id) {
      console.log(`[index] Usuario ${user.id} sem telefone. Aguardando onboarding.`);
      continue;
    }

    const session = await getWhatsAppSession(user.id);
    if (session?.status === 'paused') {
      console.log(`[index] Usuario ${user.id} esta com bot pausado. Pulando autostart.`);
      continue;
    }

    startWhatsAppInstance(user.id).catch(err => {
      console.error(`[index] Erro ao iniciar bot do usuario ${user.id}:`, err);
    });
  }
}

async function main() {
  loadConfig();
  await initDatabase();

  const PORT = parseInt(process.env.PORT || '3000', 10);
  startServer(PORT, {
    getOrCreateCurrentUser,
    getWhatsAppStatus,
    getActiveInstanceCount,
    startWhatsAppInstance,
    stopWhatsAppInstance,
    pauseWhatsAppInstance,
    logoutWhatsAppInstance,
    deleteUser,
    updateUserSettings,
  });

  await startConfiguredInstances();
}

main().catch(error => {
  console.error('[index] Falha fatal ao iniciar aplicacao:', error);
  process.exit(1);
});
