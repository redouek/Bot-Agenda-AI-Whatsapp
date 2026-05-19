import fs from 'fs';
import pkg from 'whatsapp-web.js';
import { loadConfig, isPlatformConfigured } from './config.js';
import { startServer } from './server.js';
import { processIncomingMessage, startReminderLoop, stopReminderLoop, startSelfChatPolling, stopSelfChatPolling, hydrateSelfChatLidFromDb } from './bot.js';
import {
  ensureUser,
  getDefaultUserId,
  getWhatsAppSession,
  getWhatsAppSessionPath,
  initDatabase,
  listUsers,
  updateWhatsAppSession,
} from './database.js';

const { Client, LocalAuth } = pkg;

const whatsappInstances = new Map();

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function getExistingRuntime(userId) {
  return whatsappInstances.get(userId) || null;
}

function isRunningStatus(status) {
  return ['initializing', 'awaiting_qr', 'authenticated', 'ready'].includes(status);
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

  const sessionPath = getWhatsAppSessionPath(user.id);
  ensureDir(sessionPath);

  await hydrateSelfChatLidFromDb(user.id);

  await updateWhatsAppSession(user.id, {
    status: 'initializing',
    latestQr: null,
    sessionPath,
  });

  console.log(`[index] Iniciando WhatsApp para usuario ${user.id} em ${sessionPath}`);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: user.id, dataPath: sessionPath }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
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
    await updateWhatsAppSession(user.id, { status: 'disconnected', latestQr: null, sessionPath });
  });

  client.on('message', async message => {
    try {
      await processIncomingMessage(user.id, client, message);
    } catch (error) {
      console.error(`[bot:${user.id}] Erro no fluxo de message:`, error);
    }
  });

  client.on('message_create', async message => {
    try {
      await processIncomingMessage(user.id, client, message);
    } catch (error) {
      console.error(`[bot:${user.id}] Erro no fluxo de message_create:`, error);
    }
  });

  try {
    await client.initialize();
  } catch (error) {
    runtime.status = 'error';
    await updateWhatsAppSession(user.id, { status: 'error', latestQr: null, sessionPath });
    throw error;
  }

  return runtime;
}

export async function stopWhatsAppInstance(userId = getDefaultUserId()) {
  const runtime = whatsappInstances.get(userId);
  if (runtime?.client) {
    try {
      await runtime.client.destroy();
    } catch (error) {
      console.warn(`[index] Falha ao destruir client ${userId}:`, error?.message || error);
    }
  }

  stopReminderLoop(userId);
  stopSelfChatPolling(userId);
  whatsappInstances.delete(userId);
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
    startWhatsAppInstance,
    stopWhatsAppInstance,
  });

  await startConfiguredInstances();
}

main().catch(error => {
  console.error('[index] Falha fatal ao iniciar aplicacao:', error);
  process.exit(1);
});
