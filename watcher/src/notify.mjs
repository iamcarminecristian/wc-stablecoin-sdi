// Notifica al plugin dei pagamenti confermati.
//
// Il plugin resta l'unica autorita' sullo stato dell'ordine: il servizio non
// decide se un pagamento e' valido, si limita ad asserire che un certo importo
// e' arrivato con un certo riferimento e ha raggiunto la finalita' richiesta.
// La verifica dell'importo dovuto e la transizione di stato competono al plugin.
import { PLUGIN_URL, PLUGIN_SECRET } from './config.mjs';

const TIMEOUT_MS = 15000;

export async function notificaPagamento(evento) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${PLUGIN_URL}/payment-confirmed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Segreto condiviso, confrontato dal plugin con hash_equals.
        'X-WCSDI-Secret': PLUGIN_SECRET,
      },
      body: JSON.stringify({
        order_ref: evento.orderRef,
        tx_hash: evento.txHash,
        log_index: evento.logIndex,
        amount: evento.importo,
        payer: evento.payer,
        block_number: Number(evento.blocco),
      }),
      signal: controller.signal,
    });

    const corpo = await res.text();
    if (!res.ok) {
      // Il 404 su ordine inesistente non e' un errore del servizio: significa
      // che il pagamento non corrisponde ad alcun ordine di questo negozio.
      // Va segnalato all'esercente ma non riprovato all'infinito.
      const definitivo = res.status === 404 || res.status === 400;
      return { ok: false, definitivo, dettaglio: `HTTP ${res.status}: ${corpo.slice(0, 300)}` };
    }
    return { ok: true, risposta: corpo ? JSON.parse(corpo) : null };
  } catch (err) {
    // Rete o timeout: transitorio, si riprova al giro successivo.
    return { ok: false, definitivo: false, dettaglio: err.message ?? String(err) };
  } finally {
    clearTimeout(t);
  }
}
