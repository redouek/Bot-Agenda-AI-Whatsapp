// Remendos para quando o WhatsApp Web muda por baixo da whatsapp-web.js.
// Mesma correcao aplicada no projeto whatsapp-voice-free (src/compat.ts).

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
