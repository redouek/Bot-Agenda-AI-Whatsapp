let currentStatus = null;
let currentUserId = null;
let currentStep = 1;
let latestConfig = {};
let calendarsLoaded = false;
let finalizingSetup = false;
let selfChatConfirmed = false;
let editingConfig = false;

const $ = id => document.getElementById(id);
const tabs = Array.from(document.querySelectorAll('.step-tab'));
const pages = Array.from(document.querySelectorAll('.step-page'));
const COUNTRIES = [
  ['af', '93', 'Afeganistão'], ['za', '27', 'África do Sul'], ['al', '355', 'Albânia'], ['de', '49', 'Alemanha'],
  ['ad', '376', 'Andorra'], ['ao', '244', 'Angola'], ['ai', '1', 'Anguilla'], ['ag', '1', 'Antígua e Barbuda'],
  ['sa', '966', 'Arábia Saudita'], ['dz', '213', 'Argélia'], ['ar', '54', 'Argentina'], ['am', '374', 'Armênia'],
  ['aw', '297', 'Aruba'], ['au', '61', 'Austrália'], ['at', '43', 'Áustria'], ['az', '994', 'Azerbaijão'],
  ['bs', '1', 'Bahamas'], ['bh', '973', 'Bahrein'], ['bd', '880', 'Bangladesh'], ['bb', '1', 'Barbados'],
  ['be', '32', 'Bélgica'], ['bz', '501', 'Belize'], ['bj', '229', 'Benin'], ['bm', '1', 'Bermudas'],
  ['by', '375', 'Bielorrússia'], ['bo', '591', 'Bolívia'], ['ba', '387', 'Bósnia e Herzegovina'], ['bw', '267', 'Botsuana'],
  ['br', '55', 'Brasil'], ['bn', '673', 'Brunei'], ['bg', '359', 'Bulgária'], ['bf', '226', 'Burkina Faso'],
  ['bi', '257', 'Burundi'], ['bt', '975', 'Butão'], ['cv', '238', 'Cabo Verde'], ['cm', '237', 'Camarões'],
  ['kh', '855', 'Camboja'], ['ca', '1', 'Canadá'], ['qa', '974', 'Catar'], ['kz', '7', 'Cazaquistão'],
  ['td', '235', 'Chade'], ['cl', '56', 'Chile'], ['cn', '86', 'China'], ['cy', '357', 'Chipre'],
  ['co', '57', 'Colômbia'], ['km', '269', 'Comores'], ['cg', '242', 'Congo'], ['cd', '243', 'Congo, República Democrática'],
  ['kr', '82', 'Coreia do Sul'], ['kp', '850', 'Coreia do Norte'], ['ci', '225', 'Costa do Marfim'], ['cr', '506', 'Costa Rica'],
  ['hr', '385', 'Croácia'], ['cu', '53', 'Cuba'], ['cw', '599', 'Curaçao'], ['dk', '45', 'Dinamarca'],
  ['dj', '253', 'Djibuti'], ['dm', '1', 'Dominica'], ['eg', '20', 'Egito'], ['sv', '503', 'El Salvador'],
  ['ae', '971', 'Emirados Árabes Unidos'], ['ec', '593', 'Equador'], ['er', '291', 'Eritreia'], ['sk', '421', 'Eslováquia'],
  ['si', '386', 'Eslovênia'], ['es', '34', 'Espanha'], ['us', '1', 'Estados Unidos'], ['ee', '372', 'Estônia'],
  ['sz', '268', 'Essuatíni'], ['et', '251', 'Etiópia'], ['fj', '679', 'Fiji'], ['ph', '63', 'Filipinas'],
  ['fi', '358', 'Finlândia'], ['fr', '33', 'França'], ['ga', '241', 'Gabão'], ['gm', '220', 'Gâmbia'],
  ['gh', '233', 'Gana'], ['ge', '995', 'Geórgia'], ['gi', '350', 'Gibraltar'], ['gd', '1', 'Granada'],
  ['gr', '30', 'Grécia'], ['gl', '299', 'Groenlândia'], ['gp', '590', 'Guadalupe'], ['gu', '1', 'Guam'],
  ['gt', '502', 'Guatemala'], ['gg', '44', 'Guernsey'], ['gy', '592', 'Guiana'], ['gf', '594', 'Guiana Francesa'],
  ['gn', '224', 'Guiné'], ['gq', '240', 'Guiné Equatorial'], ['gw', '245', 'Guiné-Bissau'], ['ht', '509', 'Haiti'],
  ['hn', '504', 'Honduras'], ['hk', '852', 'Hong Kong'], ['hu', '36', 'Hungria'], ['ye', '967', 'Iêmen'],
  ['ky', '1', 'Ilhas Cayman'], ['ck', '682', 'Ilhas Cook'], ['fo', '298', 'Ilhas Faroe'], ['fk', '500', 'Ilhas Malvinas'],
  ['mp', '1', 'Ilhas Marianas do Norte'], ['mh', '692', 'Ilhas Marshall'], ['sb', '677', 'Ilhas Salomão'], ['tc', '1', 'Ilhas Turks e Caicos'],
  ['vg', '1', 'Ilhas Virgens Britânicas'], ['vi', '1', 'Ilhas Virgens Americanas'], ['in', '91', 'Índia'], ['id', '62', 'Indonésia'],
  ['ir', '98', 'Irã'], ['iq', '964', 'Iraque'], ['ie', '353', 'Irlanda'], ['is', '354', 'Islândia'],
  ['il', '972', 'Israel'], ['it', '39', 'Itália'], ['jm', '1', 'Jamaica'], ['jp', '81', 'Japão'],
  ['je', '44', 'Jersey'], ['jo', '962', 'Jordânia'], ['xk', '383', 'Kosovo'], ['kw', '965', 'Kuwait'],
  ['la', '856', 'Laos'], ['ls', '266', 'Lesoto'], ['lv', '371', 'Letônia'], ['lb', '961', 'Líbano'],
  ['lr', '231', 'Libéria'], ['ly', '218', 'Líbia'], ['li', '423', 'Liechtenstein'], ['lt', '370', 'Lituânia'],
  ['lu', '352', 'Luxemburgo'], ['mo', '853', 'Macau'], ['mk', '389', 'Macedônia do Norte'], ['mg', '261', 'Madagascar'],
  ['my', '60', 'Malásia'], ['mw', '265', 'Malawi'], ['mv', '960', 'Maldivas'], ['ml', '223', 'Mali'],
  ['mt', '356', 'Malta'], ['ma', '212', 'Marrocos'], ['mq', '596', 'Martinica'], ['mu', '230', 'Maurício'],
  ['mr', '222', 'Mauritânia'], ['yt', '262', 'Mayotte'], ['mx', '52', 'México'], ['fm', '691', 'Micronésia'],
  ['mz', '258', 'Moçambique'], ['md', '373', 'Moldávia'], ['mc', '377', 'Mônaco'], ['mn', '976', 'Mongólia'],
  ['me', '382', 'Montenegro'], ['ms', '1', 'Montserrat'], ['mm', '95', 'Myanmar'], ['na', '264', 'Namíbia'],
  ['nr', '674', 'Nauru'], ['np', '977', 'Nepal'], ['ni', '505', 'Nicarágua'], ['ne', '227', 'Níger'],
  ['ng', '234', 'Nigéria'], ['nu', '683', 'Niue'], ['no', '47', 'Noruega'], ['nc', '687', 'Nova Caledônia'],
  ['nz', '64', 'Nova Zelândia'], ['om', '968', 'Omã'], ['nl', '31', 'Países Baixos'], ['pw', '680', 'Palau'],
  ['ps', '970', 'Palestina'], ['pa', '507', 'Panamá'], ['pg', '675', 'Papua-Nova Guiné'], ['pk', '92', 'Paquistão'],
  ['py', '595', 'Paraguai'], ['pe', '51', 'Peru'], ['pf', '689', 'Polinésia Francesa'], ['pl', '48', 'Polônia'],
  ['pr', '1', 'Porto Rico'], ['pt', '351', 'Portugal'], ['ke', '254', 'Quênia'], ['kg', '996', 'Quirguistão'],
  ['ki', '686', 'Quiribati'], ['gb', '44', 'Reino Unido'], ['cf', '236', 'República Centro-Africana'], ['cz', '420', 'República Tcheca'],
  ['do', '1', 'República Dominicana'], ['re', '262', 'Reunião'], ['ro', '40', 'Romênia'], ['rw', '250', 'Ruanda'],
  ['ru', '7', 'Rússia'], ['ws', '685', 'Samoa'], ['as', '1', 'Samoa Americana'], ['sm', '378', 'San Marino'],
  ['sh', '290', 'Santa Helena'], ['lc', '1', 'Santa Lúcia'], ['bl', '590', 'São Bartolomeu'], ['kn', '1', 'São Cristóvão e Nevis'],
  ['mf', '590', 'São Martinho'], ['pm', '508', 'São Pedro e Miquelão'], ['st', '239', 'São Tomé e Príncipe'], ['vc', '1', 'São Vicente e Granadinas'],
  ['sn', '221', 'Senegal'], ['sl', '232', 'Serra Leoa'], ['rs', '381', 'Sérvia'], ['sc', '248', 'Seychelles'],
  ['sg', '65', 'Singapura'], ['sx', '1', 'Sint Maarten'], ['sy', '963', 'Síria'], ['so', '252', 'Somália'],
  ['lk', '94', 'Sri Lanka'], ['sd', '249', 'Sudão'], ['ss', '211', 'Sudão do Sul'], ['se', '46', 'Suécia'],
  ['ch', '41', 'Suíça'], ['sr', '597', 'Suriname'], ['tj', '992', 'Tajiquistão'], ['th', '66', 'Tailândia'],
  ['tw', '886', 'Taiwan'], ['tz', '255', 'Tanzânia'], ['tl', '670', 'Timor-Leste'], ['tg', '228', 'Togo'],
  ['to', '676', 'Tonga'], ['tt', '1', 'Trinidad e Tobago'], ['tn', '216', 'Tunísia'], ['tm', '993', 'Turcomenistão'],
  ['tr', '90', 'Turquia'], ['tv', '688', 'Tuvalu'], ['ua', '380', 'Ucrânia'], ['ug', '256', 'Uganda'],
  ['uy', '598', 'Uruguai'], ['uz', '998', 'Uzbequistão'], ['vu', '678', 'Vanuatu'], ['va', '39', 'Vaticano'],
  ['ve', '58', 'Venezuela'], ['vn', '84', 'Vietnã'], ['wf', '681', 'Wallis e Futuna'], ['zm', '260', 'Zâmbia'],
  ['zw', '263', 'Zimbábue'],
].sort((a, b) => a[2].localeCompare(b[2], 'pt-BR'));
const PREFERRED_DDI_ISO = { 1: 'us', 39: 'it', 44: 'gb', 55: 'br', 590: 'gp' };
const PREFERRED_TIMEZONES = [
  'America/Sao_Paulo',
  'America/Manaus',
  'America/Cuiaba',
  'America/Fortaleza',
  'America/Recife',
  'America/Rio_Branco',
  'America/New_York',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/Bogota',
  'America/Argentina/Buenos_Aires',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Australia/Sydney',
];
const TIMEZONE_DISPLAY_NAMES = {
  'America/Sao_Paulo': 'Brasil - Sao Paulo/Brasilia',
  'America/Manaus': 'Brasil - Manaus',
  'America/Cuiaba': 'Brasil - Cuiaba',
  'America/Fortaleza': 'Brasil - Fortaleza',
  'America/Recife': 'Brasil - Recife',
  'America/Rio_Branco': 'Brasil - Rio Branco',
  'America/New_York': 'EUA - New York',
  'America/Los_Angeles': 'EUA - Los Angeles',
  'America/Mexico_City': 'Mexico - Cidade do Mexico',
  'America/Bogota': 'Colombia - Bogota',
  'America/Argentina/Buenos_Aires': 'Argentina - Buenos Aires',
  'Europe/Lisbon': 'Portugal - Lisboa',
  'Europe/London': 'Reino Unido - Londres',
  'Europe/Madrid': 'Espanha - Madrid',
  'Europe/Paris': 'Franca - Paris',
  'Europe/Berlin': 'Alemanha - Berlin',
  'Asia/Tokyo': 'Japao - Tokyo',
  'Australia/Sydney': 'Australia - Sydney',
};

function apiPath(path) {
  if (!currentUserId) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}userId=${encodeURIComponent(currentUserId)}`;
}

function digitsOnly(value = '') {
  return String(value).replace(/\D/g, '');
}

function chatIdToPhone(value = '') {
  return digitsOnly(value);
}

function formatPhone(value = '') {
  const digits = digitsOnly(value).slice(0, 11);
  if (digits.length <= 2) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

function splitPhoneByDdi(value = '') {
  const digits = digitsOnly(value);
  const options = Array.from(document.querySelectorAll('#country-list [data-ddi]')).map(option => option.dataset.ddi).sort((a, b) => b.length - a.length);
  const ddi = options.find(code => digits.startsWith(code)) || '55';
  return { ddi, number: digits.startsWith(ddi) ? digits.slice(ddi.length) : digits };
}

function flagUrl(iso) {
  return `https://flagcdn.com/w40/${iso}.png`;
}

function renderCountryOptions() {
  const list = $('country-list');
  if (!list) return;

  const ordered = [
    ...COUNTRIES.filter(country => country[0] === 'br'),
    ...COUNTRIES.filter(country => country[0] !== 'br'),
  ];

  list.innerHTML = '';
  ordered.forEach(([iso, ddi, name]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'option');
    button.dataset.ddi = ddi;
    button.dataset.iso = iso;
    button.dataset.label = `${ddi} - ${name}`;
    button.innerHTML = `<img class="flag" src="${flagUrl(iso)}" alt="" loading="lazy" />${ddi} - ${name}`;
    list.appendChild(button);
  });
}

function getTimezoneOffsetMinutes(timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'shortOffset',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date());
    const label = parts.find(part => part.type === 'timeZoneName')?.value || 'GMT';
    const match = label.match(/^GMT(?:(?<sign>[+-])(?<hours>\d{1,2})(?::(?<minutes>\d{2}))?)?$/);
    if (!match) return 0;
    const sign = match.groups.sign === '-' ? -1 : 1;
    const hours = Number(match.groups.hours || 0);
    const minutes = Number(match.groups.minutes || 0);
    return sign * ((hours * 60) + minutes);
  } catch {
    return 0;
  }
}

function formatGmtOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, '0');
  const mins = String(abs % 60).padStart(2, '0');
  return `GMT${sign}${hours}:${mins}`;
}

function formatTimezoneLabel(timeZone) {
  const offset = getTimezoneOffsetMinutes(timeZone);
  const fallbackName = timeZone.split('/').pop().replace(/_/g, ' ');
  return `${formatGmtOffset(offset)} - ${TIMEZONE_DISPLAY_NAMES[timeZone] || fallbackName}`;
}

function renderTimezoneOptions() {
  const select = $('timezone-select');
  if (!select) return;

  const browserZones = typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : [];
  const zones = Array.from(new Set([...PREFERRED_TIMEZONES, ...browserZones]))
    .filter(Boolean)
    .sort((a, b) => {
      const offsetDiff = getTimezoneOffsetMinutes(a) - getTimezoneOffsetMinutes(b);
      if (offsetDiff !== 0) return offsetDiff;
      const aPreferred = PREFERRED_TIMEZONES.includes(a) ? 0 : 1;
      const bPreferred = PREFERRED_TIMEZONES.includes(b) ? 0 : 1;
      if (aPreferred !== bPreferred) return aPreferred - bPreferred;
      return formatTimezoneLabel(a).localeCompare(formatTimezoneLabel(b), 'pt-BR');
    });

  select.innerHTML = '';
  zones.forEach(zone => {
    const option = document.createElement('option');
    option.value = zone;
    option.textContent = formatTimezoneLabel(zone);
    select.appendChild(option);
  });
  select.value = 'America/Sao_Paulo';
}

function selectCountryByDdi(ddi) {
  const options = Array.from(document.querySelectorAll('#country-list [data-ddi]'));
  const preferredIso = PREFERRED_DDI_ISO[ddi];
  const option = options.find(item => item.dataset.ddi === ddi && item.dataset.iso === preferredIso)
    || options.find(item => item.dataset.ddi === ddi);
  if (!option) return;

  const input = $('whatsapp-ddi');
  const trigger = $('country-trigger');
  input.value = option.dataset.ddi;
  trigger.querySelector('.flag').src = flagUrl(option.dataset.iso);
  trigger.querySelector('.country-label').textContent = option.dataset.label;

  document.querySelectorAll('#country-list [data-ddi]').forEach(item => {
    item.classList.toggle('active', item === option);
  });
}

function closeCountryList() {
  $('country-list').classList.add('hidden');
  $('country-trigger').setAttribute('aria-expanded', 'false');
}

function show(sectionId) {
  ['section-login', 'section-setup', 'section-qr', 'section-ready', 'section-disconnected'].forEach(id => {
    const el = $(id);
    if (el) el.classList.add('hidden');
  });
  $(sectionId)?.classList.remove('hidden');
  const stepper = $('stepper');
  if (stepper) stepper.classList.toggle('hidden', sectionId !== 'section-setup');
}

function showStep(step) {
  currentStep = Math.max(1, Math.min(4, step));
  tabs.forEach(tab => tab.classList.toggle('active', Number(tab.dataset.step) === currentStep));
  pages.forEach(page => page.classList.toggle('active', Number(page.dataset.stepPage) === currentStep));

  $('btn-prev').classList.toggle('hidden', currentStep === 1);
  $('btn-next').classList.toggle('hidden', currentStep === 4);
  $('btn-save').classList.toggle('hidden', currentStep !== 4);
}

function hasLocalPhoneInput() {
  const phoneInput = $('form-setup')?.elements?.WHATSAPP_NUMBER;
  return digitsOnly(phoneInput?.value || '').length >= 10;
}

function canShowWhatsAppQr(status) {
  return Boolean(status?.configComplete && status?.calendarConnected && (hasLocalPhoneInput() || status?.hasPhone));
}

function updateStatusLabel(botStatus) {
  const labels = {
    stopped: 'Aguardando configuracao',
    initializing: 'Iniciando WhatsApp',
    authenticated: 'WhatsApp autenticado',
    awaiting_qr: 'Aguardando QR Code',
    ready: 'Rodando',
    paused: 'Pausado',
    disconnected: 'Desconectado',
    auth_failure: 'Falha de autenticacao',
    error: 'Erro',
  };
  $('status-label').textContent = labels[botStatus] || botStatus;
}

const STEP4_STATE_COPY = {
  initializing: {
    title: 'Iniciando o WhatsApp...',
    detail: 'Estamos abrindo o WhatsApp Web no servidor. Isso leva uns 10-30 segundos.',
  },
  awaiting_qr: {
    title: 'QR Code pronto',
    detail: 'Abra o WhatsApp do celular, va em Aparelhos conectados e escaneie o QR abaixo.',
  },
  authenticated: {
    title: 'Quase la, conectando...',
    detail: 'WhatsApp autenticado. Finalizando a configuracao.',
  },
  ready: {
    title: 'Bot conectado!',
    detail: 'Pronto. Voce ja pode usar o bot pelo seu chat consigo mesmo no WhatsApp.',
  },
};

const STEP4_ERROR_COPY = {
  error: 'Falha inesperada ao iniciar o WhatsApp. Confira os logs no servidor.',
  auth_failure: 'A autenticacao do WhatsApp falhou. Tente escanear o QR de novo.',
  disconnected: 'O WhatsApp desconectou. Pode ter sido encerrado no celular ou houve erro de rede.',
};

function updateStep4State(status) {
  if (currentStep !== 4) return;
  const card = $('step4-state-card');
  const errCard = $('step4-error-card');
  const hint = $('final-hint');
  const footer = $('form-footer');
  const qrInline = $('qr-inline');
  const spinner = $('state-spinner');

  if (!finalizingSetup) {
    card?.classList.add('hidden');
    errCard?.classList.add('hidden');
    return;
  }

  // Esconde botoes Voltar/Salvar quando ja salvou
  footer?.classList.add('hidden');
  hint?.classList.add('hidden');

  const bot = status?.botStatus;

  // Estados de erro
  if (bot === 'error' || bot === 'auth_failure' || bot === 'disconnected') {
    card?.classList.add('hidden');
    errCard?.classList.remove('hidden');
    $('state-error-msg').textContent = STEP4_ERROR_COPY[bot] || `Status: ${bot}`;
    return;
  }

  // Estados de progresso
  const copy = STEP4_STATE_COPY[bot];
  if (copy) {
    errCard?.classList.add('hidden');
    card?.classList.remove('hidden');
    $('state-title').textContent = copy.title;
    $('state-detail').textContent = copy.detail;
    if (bot === 'ready') {
      spinner?.classList.add('done');
    } else {
      spinner?.classList.remove('done');
    }
  }
}

function updateReadyView(status) {
  const isPaused = status?.botStatus === 'paused';
  const eyebrow = $('ready-eyebrow');
  const title = $('ready-title');
  const whatsappLabel = $('whatsapp-label');
  const whatsappIcon = $('whatsapp-icon');
  const whatsappCard = $('status-whatsapp');
  const btnPause = $('btn-pause');

  if (isPaused) {
    if (eyebrow) eyebrow.textContent = 'Em pausa';
    if (title) title.textContent = 'Bot pausado';
    if (whatsappLabel) whatsappLabel.textContent = 'WhatsApp pausado';
    if (whatsappIcon) whatsappIcon.textContent = '||';
    whatsappCard?.classList.remove('ok');
    if (btnPause) {
      btnPause.querySelector('.action-title').textContent = 'Retomar bot';
      btnPause.querySelector('.action-sub').textContent = 'Voltar a responder mensagens e enviar lembretes.';
      btnPause.dataset.action = 'resume';
    }
  } else {
    if (eyebrow) eyebrow.textContent = 'Tudo pronto';
    if (title) title.textContent = 'Bot conectado';
    if (whatsappLabel) whatsappLabel.textContent = 'WhatsApp conectado';
    if (whatsappIcon) whatsappIcon.textContent = 'OK';
    whatsappCard?.classList.add('ok');
    if (btnPause) {
      btnPause.querySelector('.action-title').textContent = 'Pausar bot';
      btnPause.querySelector('.action-sub').textContent = 'Bot para de responder. Pode retomar a qualquer momento.';
      btnPause.dataset.action = 'pause';
    }
  }
}

function openConfirm({ title, message, confirmLabel = 'Confirmar', danger = false, requireCheck = null, onConfirm }) {
  const backdrop = $('confirm-modal');
  const okBtn = $('btn-confirm-ok');
  const checksWrap = $('confirm-checks');
  const checkbox = $('confirm-check-input');
  const checkLabel = $('confirm-check-label');

  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  okBtn.textContent = confirmLabel;
  okBtn.classList.toggle('btn-danger', danger);
  okBtn.classList.toggle('btn-primary', !danger);

  if (requireCheck) {
    checksWrap.classList.remove('hidden');
    checkLabel.textContent = requireCheck;
    checkbox.checked = false;
    okBtn.disabled = true;
    checkbox.onchange = () => { okBtn.disabled = !checkbox.checked; };
  } else {
    checksWrap.classList.add('hidden');
    okBtn.disabled = false;
  }

  const close = () => {
    backdrop.classList.add('hidden');
    okBtn.onclick = null;
    $('btn-confirm-cancel').onclick = null;
    checkbox.onchange = null;
  };

  okBtn.onclick = async () => {
    okBtn.disabled = true;
    try { await onConfirm(); } finally { close(); }
  };
  $('btn-confirm-cancel').onclick = close;

  backdrop.classList.remove('hidden');
}

async function postJson(url) {
  const res = await fetch(apiPath(url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

$('btn-pause')?.addEventListener('click', async () => {
  const action = $('btn-pause').dataset.action || 'pause';
  try {
    await postJson(action === 'pause' ? '/api/user/pause' : '/api/user/resume');
    await pollStatus();
  } catch (err) {
    alert('Nao foi possivel ' + (action === 'pause' ? 'pausar' : 'retomar') + ': ' + err.message);
  }
});

$('btn-switch-number')?.addEventListener('click', () => {
  openConfirm({
    title: 'Trocar numero',
    message: 'Vamos desvincular este WhatsApp e te levar de volta para informar o novo numero. Seu Google Calendar continua conectado.',
    confirmLabel: 'Trocar numero',
    onConfirm: async () => {
      try {
        await postJson('/api/user/switch-number');
        // Volta para step 2 (informar novo numero)
        showSetup();
        showStep(2);
      } catch (err) {
        alert('Nao foi possivel trocar o numero: ' + err.message);
      }
    },
  });
});

$('btn-review-config')?.addEventListener('click', () => {
  showSetup();
});

$('btn-delete')?.addEventListener('click', () => {
  openConfirm({
    title: 'Excluir conta',
    message: 'Isso vai desvincular seu WhatsApp, apagar a sessao, remover seus tokens Google e apagar suas configuracoes do banco. Nao da pra desfazer.',
    confirmLabel: 'Excluir tudo',
    danger: true,
    requireCheck: 'Entendo que esta acao e irreversivel.',
    onConfirm: async () => {
      try {
        await postJson('/api/user/delete');
        // Redireciona para a home (onboarding zerado)
        location.href = '/';
      } catch (err) {
        alert('Nao foi possivel excluir: ' + err.message);
      }
    },
  });
});

function updateCalendarStatus(connected) {
  const icon = $('calendar-icon');
  const label = $('calendar-label');
  if (connected) {
    icon.textContent = 'OK';
    label.textContent = 'Google Calendar conectado';
    $('status-calendar').classList.add('ok');
  } else {
    icon.textContent = '!';
    label.textContent = 'Google Calendar ainda precisa ser conectado';
    $('status-calendar').classList.remove('ok');
  }
}

function getFormData() {
  const form = $('form-setup');
  const data = {};
  for (const el of form.elements) {
    if (el.name && el.value.trim()) data[el.name] = el.value.trim();
  }
  if (data.WHATSAPP_NUMBER) data.WHATSAPP_NUMBER = digitsOnly(data.WHATSAPP_NUMBER);
  if (!data.GOOGLE_CALENDAR_ID) data.GOOGLE_CALENDAR_ID = 'primary';
  if (!data.DEFAULT_TIMEZONE) data.DEFAULT_TIMEZONE = 'America/Sao_Paulo';
  return data;
}

function ensureModelOption(value, label = value) {
  const select = $('gemini-model-select');
  if (!select || !value) return;
  const exists = Array.from(select.options).some(option => option.value === value);
  if (!exists) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }
  select.value = value;
}

async function loadGeminiModels() {
  const status = $('gemini-models-status');
  const select = $('gemini-model-select');
  const apiKey = getFormData().GOOGLE_API_KEY;

  if (!apiKey && !latestConfig.GOOGLE_API_KEY) {
    alert('Cole sua chave Gemini primeiro.');
    return;
  }

  status.textContent = 'Buscando modelos...';

  try {
    const res = await fetch(apiPath('/api/gemini/models'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ GOOGLE_API_KEY: apiKey }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Nao foi possivel buscar modelos.');

    const currentValue = select.value;
    select.innerHTML = '<option value="">Padrao recomendado</option>';
    data.models.forEach(model => {
      const option = document.createElement('option');
      option.value = model.name;
      option.textContent = model.displayName;
      select.appendChild(option);
    });
    if (currentValue) ensureModelOption(currentValue);
    status.textContent = data.models.length ? 'Modelos carregados.' : 'Nenhum modelo encontrado.';
  } catch (error) {
    status.textContent = error.message;
  }
}

function setCalendarOptions(calendars = [], selectedCalendarId = 'primary') {
  const select = $('calendar-select');
  if (!select) return;
  select.innerHTML = '';

  if (!calendars.length) {
    select.innerHTML = '<option value="primary">Agenda principal</option>';
    select.value = selectedCalendarId || 'primary';
    return;
  }

  calendars.forEach(calendar => {
    const option = document.createElement('option');
    option.value = calendar.id;
    option.textContent = calendar.primary ? `${calendar.summary} (principal)` : calendar.summary;
    select.appendChild(option);
  });

  const exists = Array.from(select.options).some(option => option.value === selectedCalendarId);
  select.value = exists ? selectedCalendarId : (calendars.find(item => item.primary)?.id || calendars[0].id);
}

async function loadCalendars() {
  const status = $('calendar-picker-status');
  const card = $('calendar-picker-card');
  if (!currentStatus?.calendarConnected) {
    if (card) card.classList.add('hidden');
    calendarsLoaded = false;
    return;
  }

  if (card) card.classList.remove('hidden');
  status.textContent = 'Carregando calendários...';

  try {
    const res = await fetch(apiPath('/api/calendars'));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Não foi possível carregar calendários.');
    setCalendarOptions(data.calendars, data.selectedCalendarId);
    status.textContent = 'Escolha onde os eventos serão criados.';
    calendarsLoaded = true;
  } catch (error) {
    status.textContent = error.message;
  }
}

async function saveSelectedCalendar() {
  const select = $('calendar-select');
  if (!select?.value) return;
  const res = await fetch(apiPath('/api/calendar/select'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ GOOGLE_CALENDAR_ID: select.value }),
  });
  if (!res.ok) throw new Error('Não foi possível salvar o calendário.');
  $('calendar-picker-status').textContent = 'Calendário salvo.';
}

function validateStep(step) {
  const data = getFormData();
  if (step === 1 && !currentStatus?.calendarConnected) {
    if (!currentStatus?.platformConfigured) {
      alert('A plataforma ainda precisa ser ativada pelo administrador.');
      return false;
    }
    alert('Conecte sua agenda Google para continuar.');
    return false;
  }
  if (step === 2) {
    if (!selfChatConfirmed && !currentStatus?.hasPhone) {
      alert('Confirme primeiro que voce ja enviou uma mensagem para o seu proprio contato no WhatsApp.');
      return false;
    }
    if ((!data.WHATSAPP_NUMBER || data.WHATSAPP_NUMBER.length < 10) && !currentStatus?.hasPhone) {
      alert('Digite seu numero de WhatsApp.');
      return false;
    }
  }
  return true;
}

function revealPhoneFields() {
  selfChatConfirmed = true;
  const gate = $('selfchat-gate');
  const fields = $('phone-fields');
  if (gate) gate.classList.add('hidden');
  if (fields) fields.classList.remove('hidden');
}

async function loadSession() {
  try {
    const res = await fetch('/api/session');
    const session = await res.json();
    currentUserId = session.userId;
    const form = $('form-setup');
    if (session.assistantChatId && form.elements.WHATSAPP_NUMBER) {
      const phone = splitPhoneByDdi(session.assistantChatId);
      selectCountryByDdi(phone.ddi);
      form.elements.WHATSAPP_NUMBER.value = formatPhone(phone.number || chatIdToPhone(session.assistantChatId));
      // Usuario ja tinha cadastrado o numero antes — pula o gate
      revealPhoneFields();
    }
    if (session.calendarId && form.elements.GOOGLE_CALENDAR_ID) {
      form.elements.GOOGLE_CALENDAR_ID.value = session.calendarId;
    }
    if (session.timezone && form.elements.DEFAULT_TIMEZONE) {
      form.elements.DEFAULT_TIMEZONE.value = session.timezone;
    }
  } catch {
    currentUserId = 'renato';
  }
}

async function renderQrInto(containerId) {
  const container = $(containerId);
  try {
    const res = await fetch(apiPath('/api/qr'));
    const data = await res.json();
    if (data.userId) currentUserId = data.userId;
    container.innerHTML = data.qr || '<p class="loading">Aguardando QR code...</p>';
  } catch {
    container.innerHTML = '<p class="loading">Erro ao carregar QR.</p>';
  }
}

async function renderQr() {
  await renderQrInto('qr-container-standalone');
  const inline = $('qr-inline');
  if (inline) {
    inline.classList.remove('hidden');
    await renderQrInto('qr-container');
  }
}

async function pollStatus() {
  try {
    const res = await fetch(apiPath('/api/status'));
    if (res.status === 401) {
      // Sessao expirou — volta para login
      show('section-login');
      $('user-info').classList.add('hidden');
      return;
    }
    const status = await res.json();
    currentStatus = status;
    if (status.userId) currentUserId = status.userId;

    updateStatusLabel(status.botStatus);
    updateOAuthButton(latestConfig);
    if (status.calendarConnected && !calendarsLoaded) loadCalendars();
    updateCalendarConnectState();
    updateStep4State(status);

    if (status.botStatus === 'awaiting_qr') {
      show('section-setup');
      if (currentStep === 4 && canShowWhatsAppQr(status)) {
        $('final-hint').textContent = 'Escaneie o QR Code para concluir.';
        await renderQr();
      }
      return;
    }

    if (status.botStatus === 'ready' || status.botStatus === 'paused') {
      // Usuario configurado — tela principal vira o painel de gestao
      // (a menos que esteja editando configuracoes propositalmente)
      if ((status.hasPhone || finalizingSetup) && !editingConfig) {
        show('section-ready');
        updateReadyView(status);
        updateCalendarStatus(status.calendarConnected);
        return;
      }
      show('section-setup');
      return;
    }

    if (finalizingSetup && (status.botStatus === 'disconnected' || status.botStatus === 'auth_failure' || status.botStatus === 'error')) {
      show('section-disconnected');
      return;
    }

    show('section-setup');
  } catch {
    $('status-label').textContent = 'Sem conexao com o servidor';
  }
}

async function loadCurrentConfig() {
  try {
    const res = await fetch(apiPath('/api/config'));
    const config = await res.json();
    latestConfig = config;
    const form = $('form-setup');

    for (const [key, value] of Object.entries(config)) {
      if (typeof value !== 'string' || value.includes('******')) continue;
      const input = form.elements[key];
      if (input) input.value = value;
    }

    if (config.GRUPO_ASSISTENTE_ID && form.elements.WHATSAPP_NUMBER) {
      const phone = splitPhoneByDdi(config.GRUPO_ASSISTENTE_ID);
      selectCountryByDdi(phone.ddi);
      form.elements.WHATSAPP_NUMBER.value = formatPhone(phone.number || chatIdToPhone(config.GRUPO_ASSISTENTE_ID));
    }
    if (form.elements.OAUTH_REDIRECT_URI && !form.elements.OAUTH_REDIRECT_URI.value) {
      form.elements.OAUTH_REDIRECT_URI.value = `${location.origin}/oauth/callback`;
    }
    if (form.elements.GOOGLE_CALENDAR_ID && !form.elements.GOOGLE_CALENDAR_ID.value) form.elements.GOOGLE_CALENDAR_ID.value = 'primary';
    if (form.elements.DEFAULT_TIMEZONE && !form.elements.DEFAULT_TIMEZONE.value) form.elements.DEFAULT_TIMEZONE.value = 'America/Sao_Paulo';
    if ($('gemini-model-select') && config.GEMINI_MODEL) ensureModelOption(config.GEMINI_MODEL);

    updateOAuthButton(config);
  } catch {}
}

function updateOAuthButton(config = {}) {
  const hasCredentials = Boolean(currentStatus?.hasOAuthCredentials);

  const btn = $('btn-oauth');
  const mainBtn = $('btn-oauth-main');
  const msg = $('calendar-status-msg');

  if (currentStatus?.calendarConnected) {
    if (msg) msg.textContent = 'Google Calendar conectado pela sua conta.';
    if (btn) {
      btn.textContent = 'Reconectar Google';
      btn.disabled = !hasCredentials;
    }
    if (mainBtn) {
      mainBtn.textContent = 'Google conectado';
      mainBtn.disabled = true;
    }
  } else if (hasCredentials) {
    if (msg) msg.textContent = 'Reconecte para autorizar acesso ao Calendar.';
    if (btn) btn.disabled = false;
    if (mainBtn) {
      mainBtn.textContent = 'Reconectar Calendar';
      mainBtn.disabled = false;
    }
  } else {
    if (msg) msg.textContent = 'Plataforma ainda nao configurada.';
    if (btn) btn.disabled = true;
    if (mainBtn) {
      mainBtn.textContent = 'Aguardando ativacao';
      mainBtn.disabled = true;
    }
  }
}

function updateCalendarConnectState() {
  const msg = $('calendar-connect-msg');
  if (!msg) return;

  if (currentStatus?.calendarConnected) {
    msg.textContent = 'Agenda conectada.';
    $('platform-warning')?.classList.add('hidden');
    return;
  }

  if (currentStatus?.platformConfigured) {
    msg.textContent = 'Clique para autorizar pelo Google.';
    $('platform-warning')?.classList.add('hidden');
  } else {
    msg.textContent = 'A plataforma ainda precisa ser ativada.';
    $('platform-warning')?.classList.remove('hidden');
  }
}

async function saveConfig() {
  const data = getFormData();
  await fetch(apiPath('/api/config'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  latestConfig = { ...latestConfig, ...data };
  updateOAuthButton(latestConfig);
}

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const target = Number(tab.dataset.step);
    if (target > currentStep) {
      for (let step = currentStep; step < target; step += 1) {
        if (!validateStep(step)) return;
      }
    }
    showStep(target);
  });
});

$('btn-next').addEventListener('click', async () => {
  if (!validateStep(currentStep)) return;
  if (currentStep === 1 && currentStatus?.calendarConnected) {
    await saveSelectedCalendar().catch(() => {});
  }
  showStep(currentStep + 1);
});

$('btn-prev').addEventListener('click', () => {
  // Se estiver em estado finalizado e clicar voltar, reseta o estado de finalizacao
  if (finalizingSetup) {
    finalizingSetup = false;
    $('form-footer')?.classList.remove('hidden');
    $('final-hint')?.classList.remove('hidden');
    $('step4-state-card')?.classList.add('hidden');
    $('step4-error-card')?.classList.add('hidden');
  }
  showStep(currentStep - 1);
});

$('btn-selfchat-confirm')?.addEventListener('click', revealPhoneFields);

$('btn-retry-save')?.addEventListener('click', async () => {
  // Re-tenta: limpa o erro, reabre o footer e dispara o submit
  $('step4-error-card')?.classList.add('hidden');
  $('form-footer')?.classList.remove('hidden');
  finalizingSetup = false;
  $('form-setup').requestSubmit();
});

$('btn-load-models')?.addEventListener('click', loadGeminiModels);
$('btn-load-calendars').addEventListener('click', () => {
  calendarsLoaded = false;
  loadCalendars();
});
$('calendar-select').addEventListener('change', () => {
  saveSelectedCalendar().catch(error => {
    $('calendar-picker-status').textContent = error.message;
  });
});

$('country-trigger').addEventListener('click', () => {
  const list = $('country-list');
  const isHidden = list.classList.toggle('hidden');
  $('country-trigger').setAttribute('aria-expanded', String(!isHidden));
});

document.addEventListener('click', event => {
  if (!$('country-combo').contains(event.target)) closeCountryList();
});

$('country-list').addEventListener('click', event => {
  const option = event.target.closest('[data-ddi]');
  if (option) {
    selectCountryByDdi(option.dataset.ddi);
    closeCountryList();
  }
});

$('form-setup').addEventListener('input', () => {
  updateOAuthButton(latestConfig);
});

$('form-setup').elements.WHATSAPP_NUMBER?.addEventListener('input', event => {
  event.target.value = formatPhone(event.target.value);
});

$('form-setup').addEventListener('submit', async (e) => {
  e.preventDefault();
  for (let step = 1; step <= 2; step += 1) {
    if (!validateStep(step)) {
      showStep(step);
      return;
    }
  }

  try {
    finalizingSetup = true;
    editingConfig = false;
    await saveConfig();
    const feedback = $('save-feedback');
    feedback.classList.remove('hidden');
    setTimeout(() => feedback.classList.add('hidden'), 5000);
    showStep(4);
    await pollStatus();
  } catch {
    finalizingSetup = false;
    alert('Erro ao salvar configuracao.');
  }
});

$('btn-oauth')?.addEventListener('click', async () => {
  try {
    await saveConfig();
    window.location.href = apiPath('/oauth/start');
  } catch {
    alert('Salve a configuracao antes de conectar o Google.');
  }
});

$('btn-oauth-main').addEventListener('click', async () => {
  try {
    if (!currentStatus?.platformConfigured) {
      alert('A plataforma ainda precisa ser ativada pelo administrador.');
      return;
    }
    await saveConfig();
    window.location.href = apiPath('/oauth/start');
  } catch {
    alert('Nao foi possivel iniciar a conexao com Google.');
  }
});

window.showSetup = function () {
  editingConfig = true;
  show('section-setup');
  showStep(1);
  loadCurrentConfig();
};

if (new URLSearchParams(location.search).get('connected') === '1') {
  history.replaceState({}, '', '/');
  showStep(1);
}

async function checkAuthAndBoot() {
  try {
    const res = await fetch('/api/auth/check', { credentials: 'include' });
    const data = await res.json();
    if (!data.authed) {
      show('section-login');
      $('status-label').textContent = 'Nao conectado';
      return false;
    }
    $('user-info').classList.remove('hidden');
    $('user-email').textContent = data.email || data.userId;
    return true;
  } catch {
    show('section-login');
    return false;
  }
}

$('btn-logout')?.addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
  location.href = '/';
});

async function boot() {
  renderCountryOptions();
  renderTimezoneOptions();
  selectCountryByDdi('55');

  const authed = await checkAuthAndBoot();
  if (!authed) return;

  showStep(1);
  await loadSession();
  await loadCurrentConfig();
  await pollStatus();
  setInterval(pollStatus, 3000);
}

boot();
