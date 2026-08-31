// Notifica al plugin dei pagamenti confermati.
//
// Il plugin resta l'unica autorita' sullo stato dell'ordine: il servizio non
// decide se un pagamento e' valido, si limita ad asserire che un certo importo
// e' arrivato con un certo riferimento e ha raggiunto la finalita' richiesta.
// La verifica dell'importo dovuto e la transizione di stato competono al plugin.
import { PLUGIN_URL, PLUGIN_SECRET } from './config.mjs';

const TIMEOUT_MS = 15000;

/**
 * Comunica al plugin lo stato del rimborso e i marcatori t4 e t5.
 * Il plugin non dialoga con l'emittente, quindi senza questa notifica la
 * latenza di regolamento resterebbe non misurabile.
 */
export async function notificaRimborso(dati) {
  return invia('/redemption-update', {
    order_ref: dati.orderRef,
    stato: dati.stato,
    ordine_id: dati.ordineId,
    t4: dati.t4,
    t5: dati.t5,
  });
}

export async function notificaPagamento(evento) {
  return invia('/payment-confirmed', {
    order_ref: evento.orderRef,
    // Rete effettivamente osservata, che il plugin non puo' conoscere.
    chain_id: evento.chainId,
    tx_hash: evento.txHash,
    log_index: evento.logIndex,
    amount: evento.importo,
    payer: evento.payer,
    block_number: Number(evento.blocco),
    // Criterio di finalita' in vigore al momento della misura. Senza, misure
    // prese con criteri diversi finiscono indistinguibili nello stesso file e
    // la latenza di conferma diventa un aggregato privo di significato.
    conferme: Number(evento.conferme),
    // Marcatori e costo di rete per il protocollo KPI del Capitolo 6.
    // Solo questo servizio li conosce: il plugin non parla con la catena.
    t1: evento.t1,
    t2: evento.t2,
    gas_usato: evento.gasUsato,
    gas_prezzo_wei: evento.gasPrezzo,
    costo_gas: evento.costoGas,
  });
}

async function invia(percorso, payload) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${PLUGIN_URL}${percorso}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Segreto condiviso, confrontato dal plugin con hash_equals.
        'X-WCSDI-Secret': PLUGIN_SECRET,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const risposta = await res.text();
    if (!res.ok) {
      // Il 404 su ordine inesistente non e' un errore del servizio: significa
      // che il pagamento non corrisponde ad alcun ordine di questo negozio.
      // Va segnalato all'esercente ma non riprovato all'infinito.
      const definitivo = res.status === 404 || res.status === 400;
      return { ok: false, definitivo, dettaglio: `HTTP ${res.status}: ${risposta.slice(0, 300)}` };
    }
    return { ok: true, risposta: risposta ? JSON.parse(risposta) : null };
  } catch (err) {
    // Rete o timeout: transitorio, si riprova al giro successivo.
    return { ok: false, definitivo: false, dettaglio: err.message ?? String(err) };
  } finally {
    clearTimeout(t);
  }
}
