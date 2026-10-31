// Google Tasks com o mesmo OAuth do Calendar. A permissao de tarefas e pedida
// so na primeira vez que o usuario usa o recurso (ver getTasksAuthUrl).
import { google } from 'googleapis';
import { getConfig } from './config.js';
import { getGoogleTokens } from './database.js';
import { getUserAuthClient, TASKS_SCOPE } from './calendar.js';
import { normalizeText, toLocalDateString } from './http.js';

const TASKLIST_ID = '@default';

function publicBaseUrl() {
  const redirect = getConfig().OAUTH_REDIRECT_URI || process.env.OAUTH_REDIRECT_URI || 'http://localhost:3000/oauth/callback';
  try {
    return new URL(redirect).origin;
  } catch {
    return 'http://localhost:3000';
  }
}

function needsTasksConsent() {
  return {
    reply: `Para eu cuidar das suas tarefas, autorize o Google Tasks (uma vez so):\n${publicBaseUrl()}/oauth/tasks`,
    pendingAction: null,
  };
}

async function hasTasksScope(userId) {
  const tokens = await getGoogleTokens(userId);
  return String(tokens?.scope || '').split(/\s+/).includes(TASKS_SCOPE);
}

function isScopeError(error) {
  const status = error?.code || error?.response?.status;
  const msg = error?.response?.data?.error?.message || error?.message || '';
  return status === 403 && /insufficient|scope|permission/i.test(msg);
}

async function getTasksClient(userId) {
  const auth = await getUserAuthClient(userId);
  return google.tasks({ version: 'v1', auth });
}

function formatDue(due) {
  if (!due) return '';
  // O Google Tasks guarda so a data (horario sempre 00:00 UTC)
  const [y, m, d] = due.slice(0, 10).split('-');
  return ` (ate ${d}/${m}${y !== String(new Date().getFullYear()) ? `/${y}` : ''})`;
}

function formatTaskList(tasks) {
  return tasks.map((t, i) => `${i + 1}. ${t.title}${formatDue(t.due)}`).join('\n');
}

async function addTask(userId, { title, notes = '', due = '' }) {
  const client = await getTasksClient(userId);
  const requestBody = { title, notes: notes || undefined };
  if (/^\d{4}-\d{2}-\d{2}/.test(due)) {
    const timeZone = getConfig().DEFAULT_TIMEZONE || 'America/Sao_Paulo';
    const localDate = due.length > 10 ? toLocalDateString(due, timeZone) : due.slice(0, 10);
    requestBody.due = `${localDate}T00:00:00.000Z`;
  }
  const res = await client.tasks.insert({ tasklist: TASKLIST_ID, requestBody });
  return res.data;
}

async function listTasks(userId) {
  const client = await getTasksClient(userId);
  const res = await client.tasks.list({
    tasklist: TASKLIST_ID,
    showCompleted: false,
    showHidden: false,
    maxResults: 50,
  });
  const items = (res.data.items || []).filter(t => t.title?.trim());
  // Com prazo primeiro, em ordem de data; depois as sem prazo
  return items.sort((a, b) => {
    if (a.due && b.due) return a.due.localeCompare(b.due);
    if (a.due) return -1;
    if (b.due) return 1;
    return (a.position || '').localeCompare(b.position || '');
  });
}

export async function completeTask(userId, taskId) {
  const client = await getTasksClient(userId);
  const res = await client.tasks.patch({
    tasklist: TASKLIST_ID,
    task: taskId,
    requestBody: { status: 'completed' },
  });
  return res.data;
}

function findMatchingTasks(tasks, query) {
  const normQuery = normalizeText(query);
  if (!normQuery) return [];
  const exact = tasks.filter(t => normalizeText(t.title) === normQuery);
  if (exact.length) return exact;

  const words = normQuery.split(/\s+/).filter(w => w.length > 2);
  return tasks.filter(t => {
    const title = normalizeText(t.title);
    return title.includes(normQuery) || (words.length && words.every(w => title.includes(w)));
  });
}

// task: { action: "add|list|complete", title, items, notes, due, query }
export async function runTaskAction(userId, task = {}) {
  if (!await hasTasksScope(userId)) return needsTasksConsent();

  try {
    return await runAuthorizedTaskAction(userId, task);
  } catch (error) {
    if (isScopeError(error)) return needsTasksConsent();
    throw error;
  }
}

async function runAuthorizedTaskAction(userId, task) {
  const action = task.action || 'list';

  if (action === 'add') {
    const titles = (Array.isArray(task.items) && task.items.length ? task.items : [task.title])
      .map(t => String(t || '').trim())
      .filter(Boolean);
    if (!titles.length) return { reply: 'Qual tarefa devo anotar?', pendingAction: null };

    for (const title of titles) {
      await addTask(userId, { title, notes: task.notes, due: task.due });
    }
    const dueText = task.due ? formatDue(task.due) : '';
    return {
      reply: titles.length === 1
        ? `Tarefa anotada: *${titles[0]}*${dueText}`
        : `${titles.length} tarefas anotadas${dueText}:\n${titles.map(t => `- ${t}`).join('\n')}`,
      pendingAction: null,
    };
  }

  const tasks = await listTasks(userId);

  if (action === 'complete') {
    const query = task.query || task.title || '';
    const matches = findMatchingTasks(tasks, query);
    if (!matches.length) {
      return { reply: `Nao encontrei nenhuma tarefa pendente com "${query}".`, pendingAction: null };
    }
    if (matches.length === 1) {
      await completeTask(userId, matches[0].id);
      return { reply: `Tarefa concluida: ~${matches[0].title}~ ✅`, pendingAction: null };
    }
    return {
      reply: `Encontrei ${matches.length} tarefas parecidas. Responda o numero da que devo concluir, ou "todas":\n${formatTaskList(matches)}`,
      pendingAction: {
        type: 'choice',
        action: 'complete_task',
        choices: matches.map(t => ({ taskId: t.id, summary: t.title })),
        createdAt: Date.now(),
      },
    };
  }

  if (!tasks.length) return { reply: 'Voce nao tem tarefas pendentes. 🎉', pendingAction: null };
  return { reply: `Tarefas pendentes:\n${formatTaskList(tasks)}`, pendingAction: null };
}
