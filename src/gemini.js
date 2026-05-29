import { GoogleGenerativeAI } from '@google/generative-ai';
import { getConfig } from './config.js';

let _aiClient = null;
let _model = null;
let _cachedApiKey = null;

function getModel() {
  const { GOOGLE_API_KEY, GEMINI_MODEL } = getConfig();
  const modelName = GEMINI_MODEL || 'models/gemini-flash-latest';

  if (!GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY não configurado. Acesse o painel de setup.');

  if (_model && _cachedApiKey === GOOGLE_API_KEY) return _model;

  _aiClient = new GoogleGenerativeAI(GOOGLE_API_KEY);
  _model = _aiClient.getGenerativeModel({ model: modelName });
  _cachedApiKey = GOOGLE_API_KEY;
  return _model;
}

function extractJsonObject(text) {
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) return null;

  try {
    return JSON.parse(text.substring(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

function toISOStringSafe(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function parsePortugueseDate(rawText) {
  if (!rawText) return null;

  const pDia = /(?:dia\s+)?(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i.exec(rawText);
  const pTime = /(?:as|a)\s*(\d{1,2})(?::(\d{2}))?/i.exec(rawText);
  if (!pDia || !pTime) return null;

  let [, d, m, y] = pDia;
  let [, hh, mm = '00'] = pTime;

  if (y.length === 2) y = `20${y}`;

  const start = new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${hh.padStart(2, '0')}:${mm}:00-03:00`);
  if (Number.isNaN(start.getTime())) return null;

  const durationMatch = /(\d+)\s*h/i.exec(rawText);
  const durationHours = durationMatch?.[1] ? parseInt(durationMatch[1], 10) : 1;
  const end = new Date(start.getTime() + durationHours * 60 * 60 * 1000);

  return {
    startDateTime: start.toISOString(),
    endDateTime: end.toISOString(),
  };
}

function normalizeEvent(event, fallbackText = '') {
  if (!event || !event.summary || !event.startDateTime) return null;

  let startDateTime = toISOStringSafe(event.startDateTime);
  if (!startDateTime) return null;

  let endDateTime = toISOStringSafe(event.endDateTime)
    || new Date(new Date(startDateTime).getTime() + 60 * 60 * 1000).toISOString();

  const now = Date.now();
  const startMs = new Date(startDateTime).getTime();
  const endMs = new Date(endDateTime).getTime();
  if (startMs < now && endMs > now && endMs > startMs) {
    startDateTime = endDateTime;
    endDateTime = new Date(endMs + 60 * 60 * 1000).toISOString();
  }

  const timeZone = getConfig().DEFAULT_TIMEZONE || 'America/Sao_Paulo';

  return {
    summary: event.summary,
    description: event.description || fallbackText || event.summary,
    startDateTime,
    endDateTime: new Date(endDateTime) > new Date(startDateTime)
      ? endDateTime
      : new Date(new Date(startDateTime).getTime() + 60 * 60 * 1000).toISOString(),
    location: event.location || '',
    locationSuggestion: event.locationSuggestion || '',
    timeZone: event.timeZone || timeZone,
  };
}

function fallbackScheduleProposal(text) {
  const dateParts = parsePortugueseDate(text);
  if (!dateParts) return null;

  const summary = text
    .replace(/\s+no\s+domingo.*$/i, '')
    .replace(/\s+no\s+sabado.*$/i, '')
    .replace(/\s+dia\s+\d{1,2}\/\d{1,2}\/\d{2,4}.*$/i, '')
    .replace(/\s+as\s+\d{1,2}(:\d{2})?.*$/i, '')
    .replace(/\s+e\s+a\s+festa.*$/i, '')
    .trim();

  return {
    kind: 'schedule_proposal',
    reply: 'Interpretei isso como um pedido de agendamento. Confirma?',
    requiresConfirmation: true,
    event: {
      summary: summary || 'Evento do WhatsApp',
      description: text,
      startDateTime: dateParts.startDateTime,
      endDateTime: dateParts.endDateTime,
      location: '',
      locationSuggestion: '',
      timeZone: getConfig().DEFAULT_TIMEZONE || 'America/Sao_Paulo',
    },
  };
}

function buildPrompt({ history, pendingAction, userText, mediaKind }) {
  const timeZone = getConfig().DEFAULT_TIMEZONE || 'America/Sao_Paulo';
  const now = new Date();
  const todayLocal = now.toLocaleString('pt-BR', { timeZone, hour12: false })
    + ` (${timeZone}, UTC-3)`;

  const historyText = history.length
    ? history.map(item => `[${item.role}] ${item.content}`).join('\n')
    : '(sem historico relevante)';

  const pendingText = pendingAction ? JSON.stringify(pendingAction) : 'nenhuma confirmacao pendente';

  return [
    'Voce e um assistente de WhatsApp que conversa naturalmente, interpreta contexto e ajuda com agenda.',
    'CAPACIDADES: voce TEM acesso ao Google Calendar do usuario (todas as agendas selecionadas) via API. NUNCA diga "nao tenho acesso a sua agenda" ou similar. Se uma busca anterior nao achou algo, ofereca tentar de novo de outra forma ou pedir mais detalhes — nao negue capacidade.',
    'Voce consegue interpretar texto, audio e imagem. Quando vier audio, transcreva mentalmente o conteudo e siga o mesmo fluxo de um texto. Quando vier imagem (ex: foto de convite/cartaz), extraia titulo, data, hora, local e descricao se possivel.',
    'Considere historico recente, a mensagem atual e confirmacoes pendentes.',
    'CONTEXTO/FOLLOW-UP: se a mensagem atual for curta ou eliptica (ex: "e de hoje?", "e amanha?", "essa semana?", "e o outro?", "as 14h", "muda pra 15h"), interprete como continuacao da ULTIMA intencao do usuario no historico. Herde o kind (list_events, schedule_proposal, etc) e ajuste apenas o que mudou (ex: "e de hoje?" apos "compromissos de amanha?" vira list_events com period="today").',
    'Para follow-ups de listagem ("e de hoje?", "e essa semana?", "e amanha?"), responda DIRETAMENTE com list_events do periodo correspondente — nao peca confirmacao nem responda "nao consegui entender".',
    'Se a mensagem for um pedido de agendamento ou trouxer informacoes de evento UNICO, produza schedule_proposal. Se trouxer MULTIPLOS eventos em datas distintas e nao-recorrentes (ex: "segunda e quarta da semana que vem", "dia 5 e dia 10 as 10h"), produza kind=multiple_events com events:[evento1, evento2, ...]. Cada evento DEVE ter summary, startDateTime e endDateTime preenchidos.',
    'EXTRACAO DO TITULO (summary): VERBOS DE COMANDO no inicio da frase NUNCA fazem parte do summary. Remova "agenda/agendar/agende/agendar para mim", "marca/marcar/marque", "anota/anotar/anote", "cria/criar/crie", "adiciona/adicionar/adicione", "coloca/colocar/coloque", "schedule", "book" e variacoes. Tambem remova preposicoes vazias soltas no inicio ("pra", "para", "no", "na", "de", "do", "da") logo apos o verbo. Preserve TODAS as outras palavras na ordem em que aparecem ate encontrar uma referencia de tempo/local. Exemplos: "agenda rara de deodo segunda 11:30" -> summary="Rara de deodo"; "marca dentista terca 14h" -> summary="Dentista"; "anota reuniao com cliente quinta 9h no escritorio" -> summary="Reuniao com cliente"; "agendar consulta odontologica" -> summary="Consulta odontologica". NUNCA produza "Agenda X" como titulo se o usuario comecou com o verbo "agenda".',
    'TOM do reply em schedule_proposal: NUNCA afirme que o evento foi agendado/marcado/criado — ainda esta pendente de confirmacao do usuario. Use linguagem provisoria: "anotei", "entendi", "corrigi", "ajustei", "ok, vou propor isso". Exemplos validos: "Anotei.", "Ok, corrigi o nome para X.", "Entendi, ajustei o horario para 15h.". NUNCA escreva "agendado", "marcado", "criado", "salvo" no reply.',
    `REGRA CRITICA de fuso horario: o usuario esta em ${timeZone} (UTC-3, GMT-3). Qualquer horario mencionado pelo usuario (ex: "14:30", "as tres da tarde") esta SEMPRE nesse fuso. O startDateTime DEVE usar o offset -03:00 (ex: "2026-03-25T14:30:00-03:00"). NUNCA trate horarios do usuario como UTC.`,
    'REGRA CRITICA de horario: o horario mencionado pelo usuario e SEMPRE o startDateTime (hora de inicio). Nunca use o horario mencionado como endDateTime. O endDateTime deve ser startDateTime + duracao mencionada, ou startDateTime + 1 hora por padrao.',
    'Para eventos VERDADEIRAMENTE recorrentes e sem fim definido (ex: "toda segunda" sem "essa semana"/"semana que vem", "todo dia"), adicione recurrence com RRULE (ex: ["RRULE:FREQ=WEEKLY;BYDAY=MO"]). Para varios dias DENTRO de uma semana especifica (ex: "segunda e quarta da semana que vem", "dia 5 e dia 10"), use kind=multiple_events com events: [...] — NAO use recurrence nesse caso.',
    'COERENCIA REPLY x EVENT/EVENTS: o texto do reply DEVE refletir EXATAMENTE o que vai ser agendado. Se o reply diz "segunda e quarta", events DEVE ter 2 itens (ou recurrence cobrindo MO e WE). NUNCA escreva no reply algo diferente do que sera criado.',
    'CORRECAO DE EVENTO RECENTE: se a mensagem corrige/contradiz um evento recem-discutido no historico (ex: "nao era X, era Y", "muda pra Y", "na verdade era Y", "errei, foi Y"), IDENTIFIQUE pelo contexto — NUNCA pergunte "qual evento?" se o historico recente cita um. Produza schedule_proposal (ou multiple_events) com a versao CORRIGIDA herdando titulo/hora/duracao do original e ajustando o que mudou. SE o historico mostra "Evento agendado com sucesso: X" (ou seja, ja foi criado no calendar), inclua o campo replacePreviousQuery com o titulo desse evento antigo (ex: "Acupuntura") — o bot vai cancelar o anterior automaticamente apos voce confirmar o novo. No reply diga: "Anotei a versao corrigida. Vou cancelar o anterior assim que voce confirmar." NUNCA diga apenas "lembre-se de cancelar" — use replacePreviousQuery.',
    'Se a mensagem pedir para ver agenda, compromissos, o que tem marcado, produza list_events com period = "today", "tomorrow", "this_week" ou "date_range" (com startDate e endDate em ISO).',
    'Se a mensagem pedir para cancelar, deletar ou remover um evento, produza cancel_event. O campo query DEVE conter APENAS palavras-chave do nome/descricao do evento (ex: "almoco", "Bovinus", "dentista"). NUNCA inclua datas, horarios ou referencias temporais ("amanha", "hoje", "21/05") no query. Quando o usuario mencionar contexto temporal, coloque essa informacao em period ("today", "tomorrow", "this_week" ou "date_range" com startDate/endDate em ISO). Ex: "cancela o almoço de amanha" -> cancel_event: { query: "almoco", period: "tomorrow" }.',
    'CANCELAMENTO GENERICO (sem citar o nome): se a mensagem usa pronome/referencia generica — "cancela os eventos", "cancela isso", "cancela esses", "cancela tudo", "cancela ambos", "cancela os dois", "cancela os ultimos", "cancela os 2 ultimos", "remove os eventos" — identifique pelo HISTORICO o titulo do(s) evento(s) recem-criado(s) (procure "Eventos agendados com sucesso:" ou "Evento agendado com sucesso: X") e produza cancel_event com query=palavras-chave do titulo. NUNCA pergunte "quais eventos?" se o historico recente cita criacao clara. Use period adequado se souber as datas.',
    'CANCELAMENTO FOLLOW-UP: se o usuario JA cancelou um evento e na sequencia diz "e o de X tambem", "o outro tambem", "o mesmo", "e o de quarta", "e o de amanha", IDENTIFIQUE pelo historico recente o titulo do evento que acabou de ser cancelado (mensagem do bot tipo "Evento X cancelado com sucesso") e produza cancel_event com query=titulo + period adequado ("tomorrow", "this_week", ou date_range com a data implicita). NUNCA pergunte "qual evento?" — herde o titulo do contexto anterior.',
    'Se a mensagem pedir informacao atual sobre futebol, jogos, amistosos, tabela ou proximo jogo, produza lookup com source football. O campo query deve conter APENAS o nome do CLUBE/SELECAO (nunca da cidade!). Para times com nome de cidade (Sao Paulo, Barcelona, Madrid), envie o nome do CLUBE como "Sao Paulo FC", "FC Barcelona", "Real Madrid" — adicionando o sufixo do clube quando ambiguo. Exemplos: pergunta "jogos do sao paulo" -> query="Sao Paulo FC"; "jogos do flamengo" -> query="Flamengo"; "jogos do real madrid" -> query="Real Madrid"; "jogos do barcelona" -> query="FC Barcelona". Nunca envie a pergunta completa.',
    'APELIDOS E SIGLAS de clubes: resolva siglas e apelidos populares para o nome canonico antes de montar o query. Brasil: SPFC/Tricolor Paulista/Sao Paulino -> "Sao Paulo FC"; FLA/Mengao/Mengo/Rubro-Negro -> "Flamengo"; COR/Timao/Corinthia -> "Corinthians"; PAL/Verdao/Porco -> "Palmeiras"; SAN/Peixe -> "Santos"; VAS/Vascao/Gigante da Colina -> "Vasco da Gama"; FLU/Flu/Tricolor Carioca -> "Fluminense"; BOT/Fogao/Glorioso -> "Botafogo"; CRU/Cabuloso/Raposa -> "Cruzeiro"; Galo/Atletico-MG/CAM -> "Atletico Mineiro"; GRE/Tricolor Gaucho/Imortal -> "Gremio"; INT/Colorado/Inter -> "Internacional"; BAH/Esquadrao -> "Bahia"; Coxa/CFC -> "Coritiba". Europa: RM/Real/Merengues -> "Real Madrid"; Barca/FCB/Blaugrana -> "FC Barcelona"; MU/Man United/Red Devils -> "Manchester United"; City -> "Manchester City"; PSG -> "Paris Saint-Germain"; Juve/Bianconeri -> "Juventus"; Bayern -> "Bayern Munich"; Atleti -> "Atletico Madrid". Selecoes: Selecao/Canarinho/Verde-Amarela -> "Brazil".',
    'CLIMA: qualquer mensagem que pergunte sobre clima, tempo, previsao do tempo, temperatura, chuva, sol, vento DEVE virar lookup com source="weather". O campo query deve conter APENAS o nome da cidade (sem acentos extras — pode ter, mas tudo bem). Use period ("today", "tomorrow", "this_week") quando o usuario especificar. Exemplos: "como esta o tempo em SP" -> { kind:"lookup", lookup: { source:"weather", query:"São Paulo" }}; "vai chover amanha no Rio?" -> { kind:"lookup", lookup: { source:"weather", query:"Rio de Janeiro", period:"tomorrow" }}; "previsao da semana" SEM cidade -> kind:"chat" com reply pedindo qual cidade.',
    'Se a mensagem pedir fato geral, historico ou enciclopedico, produza lookup com source wiki.',
    'Se a mensagem for apenas conversa, produza chat.',
    'Responda apenas JSON valido, sem markdown.',
    'Formato:',
    '{"kind":"chat|schedule_proposal|multiple_events|list_events|cancel_event|lookup|none","reply":"texto opcional","requiresConfirmation":true|false,"replacePreviousQuery":"titulo do evento antigo a cancelar (opcional, so para correcoes)","event":{"summary":"","description":"","startDateTime":"","endDateTime":"","location":"","locationSuggestion":"","timeZone":"","recurrence":[]},"events":[{"summary":"","description":"","startDateTime":"","endDateTime":"","location":"","timeZone":""}],"list_events":{"period":"today|tomorrow|this_week|date_range","startDate":"","endDate":""},"cancel_event":{"query":"palavras-chave do nome","period":"today|tomorrow|this_week|date_range","startDate":"","endDate":""},"lookup":{"source":"football|wiki|weather","query":"consulta objetiva","intent":"fixtures|general","period":"today|tomorrow|this_week"}}',
    `Data/hora atual: ${todayLocal}`,
    `Historico recente:\n${historyText}`,
    `Confirmacao pendente: ${pendingText}`,
    `Tipo da entrada atual: ${mediaKind}`,
    `Texto/legenda atual: ${userText || '(vazio)'}`,
  ].join('\n');
}

async function generateJson(parts) {
  const model = getModel();
  const result = await model.generateContent(parts);
  const raw = result?.response?.text?.() || '';
  return extractJsonObject(raw) || { kind: 'none', reply: '', requiresConfirmation: false };
}

async function downloadInlinePart(message) {
  if (!message?.hasMedia) return null;

  const media = await message.downloadMedia();
  if (!media?.mimetype || !media?.data) return null;

  return {
    inlineData: {
      mimeType: media.mimetype,
      data: media.data,
    },
  };
}

export async function planConversationTurn({ message, type, text, history = [], pendingAction = null }) {
  const userText = text || message?.body || '';
  const mediaKind = type || 'text';

  const parts = [buildPrompt({ history, pendingAction, userText, mediaKind })];
  if (mediaKind !== 'chat' && mediaKind !== 'text') {
    const mediaPart = await downloadInlinePart(message);
    if (mediaPart) parts.push(mediaPart);
  }

  const parsed = await generateJson(parts);
  const normalizedEvent = normalizeEvent(parsed.event, userText);

  if (parsed.kind === 'schedule_proposal' && normalizedEvent) {
    return {
      kind: 'schedule_proposal',
      reply: parsed.reply || 'Interpretei isso como um evento. Posso agendar?',
      requiresConfirmation: true,
      event: normalizedEvent,
      replacePreviousQuery: typeof parsed.replacePreviousQuery === 'string' ? parsed.replacePreviousQuery.trim() : '',
    };
  }

  if (parsed.kind === 'multiple_events' && Array.isArray(parsed.events) && parsed.events.length) {
    const normalizedEvents = parsed.events
      .map(e => normalizeEvent(e, userText))
      .filter(Boolean);
    if (normalizedEvents.length) {
      return {
        kind: 'multiple_events',
        reply: parsed.reply || `Interpretei como ${normalizedEvents.length} eventos. Posso agendar?`,
        requiresConfirmation: true,
        events: normalizedEvents,
        replacePreviousQuery: typeof parsed.replacePreviousQuery === 'string' ? parsed.replacePreviousQuery.trim() : '',
      };
    }
  }

  if (parsed.kind === 'list_events' && parsed.list_events) {
    return {
      kind: 'list_events',
      reply: parsed.reply || '',
      requiresConfirmation: false,
      list_events: parsed.list_events,
    };
  }

  if (parsed.kind === 'cancel_event' && parsed.cancel_event?.query) {
    return {
      kind: 'cancel_event',
      reply: parsed.reply || '',
      requiresConfirmation: false,
      cancel_event: parsed.cancel_event,
    };
  }

  if (parsed.kind === 'lookup' && parsed.lookup?.source && parsed.lookup?.query) {
    return {
      kind: 'lookup',
      reply: parsed.reply || '',
      requiresConfirmation: false,
      lookup: {
        source: parsed.lookup.source,
        query: parsed.lookup.query,
        intent: parsed.lookup.intent || 'general',
      },
    };
  }

  if (parsed.kind === 'chat') {
    return {
      kind: 'chat',
      reply: parsed.reply || 'Nao consegui montar uma resposta adequada.',
      requiresConfirmation: false,
    };
  }

  const fallback = fallbackScheduleProposal(userText);
  if (fallback) return fallback;

  return {
    kind: 'chat',
    reply: parsed.reply || 'Nao consegui interpretar sua mensagem com seguranca. Pode reformular?',
    requiresConfirmation: false,
  };
}
