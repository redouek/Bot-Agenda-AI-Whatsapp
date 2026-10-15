// Remendos para quando o WhatsApp Web muda por baixo da whatsapp-web.js.
// Mesma correcao aplicada no projeto whatsapp-voice-free (src/compat.ts).

// Ago/2026: o WhatsApp Web passou a serializar o MsgKey com o campo `$1` no
// lugar de `_serialized`, que a whatsapp-web.js 1.34.7 le em ~130 pontos
// (getQuotedMessage, reply, downloadMedia...). Sao dois lados: o objeto que
// chega no Node (fixMsgId) e o store dentro da pagina (installMsgKeyShim).

const widOf = v => (typeof v === 'string' ? v : v?._serialized);

// Reconstroi "fromMe_remote_id[_participant]" a partir das partes — usado se o
// WhatsApp renomear `$1` de novo (o formato em si e estavel ha anos).
function rebuildMsgKey(key) {
  const remote = widOf(key.remote);
  if (!remote || !key.id) return undefined;
  const parts = [String(!!key.fromMe), remote, key.id];
  const participant = widOf(key.participant);
  if (participant) parts.push(participant);
  return parts.join('_');
}

// Devolve a mesma Message, com `id._serialized` garantido. Idempotente.
export function fixMsgId(msg) {
  const key = msg?.id;
  if (key && typeof key === 'object' && !key._serialized) {
    const serialized = key.$1 ?? rebuildMsgKey(key);
    if (serialized) key._serialized = serialized;
  }
  return msg;
}

// O id serializado da mensagem, ou '' se nem der pra reconstruir.
export function msgId(msg) {
  return fixMsgId(msg)?.id?._serialized ?? '';
}

// O mesmo bug, do lado da pagina: `WWebJS.getChatModel` faz
// `Msg.get(chat.lastReceivedKey._serialized)` — com `undefined` o IndexedDB
// levanta DataError e derruba getChat(). O MsgKey mantem um `toString()` que
// devolve o formato serializado, entao da pra repor `_serialized` como getter
// nao-enumeravel no prototipo (serialize/JSON.stringify do WhatsApp intactos).
// Idempotente; precisa ser refeito se a pagina recarregar.
export async function installMsgKeyShim(client) {
  const page = client?.pupPage;
  if (!page) return 'pupPage indisponivel';
  return page.evaluate(() => {
    let proto = null;
    try {
      // MsgKey descartavel so pra alcancar o prototipo — nao depende de ja
      // haver mensagem carregada no store.
      const key = window.require('WAWebMsgKey').fromString('false_0@c.us_0');
      proto = key ? Object.getPrototypeOf(key) : null;
    } catch { /* cai na amostra abaixo */ }
    if (!proto) {
      const sample = window.require('WAWebCollections').Msg.getModelsArray()[0];
      proto = sample?.id ? Object.getPrototypeOf(sample.id) : null;
    }
    if (!proto) return 'prototipo do MsgKey nao encontrado';
    if (Object.getOwnPropertyDescriptor(proto, '_serialized')) return 'ja presente';
    Object.defineProperty(proto, '_serialized', {
      configurable: true,
      get() { return this.$1 ?? this.toString(); },
    });
    return 'instalado';
  });
}

// Out/2026: o `downloadManager.downloadAndMaybeDecrypt` do WhatsApp Web passou
// a validar o tipo do arquivo. Sem `mimetype` nos argumentos ele assume
// application/octet-stream e levanta `InvalidMediaFileType: Unexpected mimetype
// application/octet-stream for media type ptt`. A `downloadMedia()` da
// whatsapp-web.js 1.34.7 (a ultima publicada) nao passa esse campo, entao TODO
// audio falhava — e no Node o erro chegava minificado, so "t".
// Esta e a mesma rotina da lib (structures/Message.js) com `mimetype`
// acrescentado e o erro da pagina re-lancado com nome+mensagem legiveis.
export async function downloadMediaCompat(message) {
  if (!message?.hasMedia) return undefined;

  const page = message.client?.pupPage;
  const id = message.id?._serialized;
  if (!page || !id) return message.downloadMedia();

  const result = await page.evaluate(async (msgId) => {
    const load = (name) => {
      try { return typeof window.require === 'function' ? window.require(name) : null; }
      catch { return null; }
    };
    const MsgStore = window.Store?.Msg || load('WAWebCollections')?.Msg || null;
    if (!MsgStore) throw new Error('store de mensagens indisponivel');

    const msg = MsgStore.get(msgId) || (await MsgStore.getMessagesById([msgId]))?.messages?.[0];

    // REUPLOADING = midia expirada, o botao de download fica girando.
    if (!msg || !msg.mediaData || msg.mediaData.mediaStage === 'REUPLOADING') return null;
    if (msg.mediaData.mediaStage !== 'RESOLVED') {
      await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
    }
    const stage = msg.mediaData.mediaStage;
    if (stage.includes('ERROR') || stage === 'FETCHING') return null;

    const mockQpl = {
      addAnnotations() { return this; },
      addPoint() { return this; },
    };
    try {
      const decrypted = await load('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt({
        directPath: msg.directPath,
        encFilehash: msg.encFilehash,
        filehash: msg.filehash,
        mediaKey: msg.mediaKey,
        mediaKeyTimestamp: msg.mediaKeyTimestamp,
        type: msg.type,
        mimetype: msg.mimetype,
        signal: new AbortController().signal,
        downloadQpl: mockQpl,
      });
      return {
        data: await window.WWebJS.arrayBufferToBase64Async(decrypted),
        mimetype: msg.mimetype,
      };
    } catch (e) {
      if (e?.status === 404) return null;
      throw new Error(`${e?.name}: ${e?.message}`);
    }
  }, id);

  return result ?? undefined;
}
