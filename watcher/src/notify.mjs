// Dialogo con il plugin: notifiche dei pagamenti confermati, esiti del
// riscatto, battito di vita e lettura della configurazione.
//
// Il plugin resta l'unica autorita' sullo stato dell'ordine: il servizio non
// decide se un pagamento e' valido, si limita ad asserire che un certo importo
// e' arrivato con un certo riferimento e ha soddisfatto il criterio di
// conferma. La verifica dell'importo dovuto e la transizione di stato
// competono al plugin.
import { PLUGIN_URL, PLUGIN_SECRET } from './config.mjs';

const TIMEOUT_MS = 15000;

/**
 * Comunica al plugin lo stato del riscatto e i marcatori t4 e t5.
 * Il plugin non dialoga con l'emittente, quindi senza questa notifica la
 * latenza di regolamento resterebbe non misurabile.
 */
export async function notificaRimborso(dati) {
  return invia('/redemption-update', {
    order_ref: dati.orderRef,
    stato: dati.stato,
    ordine_id: dati.ordineId,
    motivo: dati.motivo,
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
    block_hash: evento.blockHash,
    tx_index: evento.txIndex,
    // Criterio di conferma in vigore al momento della misura. Senza, misure
    // prese con criteri diversi finiscono indistinguibili nello stesso file e
    // la latenza di conferma diventa un aggregato privo di significato.
    conferme: Number(evento.conferme),
    criterio: String(evento.criterio ?? 'confirmations'),
    // Marcatori e costo di rete per il protocollo KPI del Capitolo 6.
    // Solo questo servizio li conosce: il plugin non parla con la catena.
    t1: evento.t1,
    t2: evento.t2,
    gas_usato: evento.gasUsato,
    gas_prezzo_wei: evento.gasPrezzo,
    costo_gas: evento.costoGas,
    l1_fee_wei: evento.l1Fee,
    costo_totale: evento.costoTotale,
  });
}

/** Battito di vita: il silenzio di un servizio fermo deve essere visibile. */
export async function heartbeat(dati) {
  const esito = await invia('/heartbeat', dati);
  if (!esito.ok) console.error(`[HEARTBEAT]  non recapitato: ${esito.dettaglio}`);
  return esito.ok;
}

/** Configurazione del gateway, come impostata dall'esercente nel pannello. */
export async function leggiConfigurazione() {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${PLUGIN_URL}/config`, {
      headers: { 'X-WCSDI-Secret': PLUGIN_SECRET },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, dettaglio: `HTTP ${res.status}` };
    return { ok: true, config: await res.json() };
  } catch (err) {
    return { ok: false, dettaglio: err.message ?? String(err) };
  } finally {
    clearTimeout(t);
  }
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
      // Definitivo e' solo cio' che non migliora riprovando: un ordine che
      // il negozio non ha emesso (404 con il codice del plugin), una
      // richiesta malformata (400), una rete diversa da quella dell'ordine
      // (409). Un 404 qualsiasi, per esempio da un plugin disattivato o da
      // un percorso errato, e' transitorio: marcare l'evento come chiuso
      // perderebbe pagamenti reali.
      let codice = '';
      try { codice = JSON.parse(risposta)?.code ?? ''; } catch { /* corpo non JSON */ }
      const definitivo = (res.status === 404 && codice === 'wcsdi_order_not_found')
        || res.status === 400 || res.status === 409;
      return { ok: false, definitivo, codice, stato: res.status, dettaglio: `HTTP ${res.status}: ${risposta.slice(0, 300)}` };
    }
    return { ok: true, risposta: risposta ? JSON.parse(risposta) : null };
  } catch (err) {
    // Rete o timeout: transitorio, si riprova al giro successivo.
    return { ok: false, definitivo: false, codice: '', dettaglio: err.message ?? String(err) };
  } finally {
    clearTimeout(t);
  }
}
