// Riscatto alla pari verso l'IBAN dell'esercente (RF-05), consolidato dallo
// spike 2. E' l'unico punto del sistema che esercita la capacita' di firma
// dell'esercente: vive qui, non nel plugin, per le ragioni discusse nel
// paragrafo 4.4 della tesi.
//
// La firma per ordine e' un controllo dell'API dell'emittente. A livello di
// contratto, le funzioni di distruzione e recupero dei saldi riservate ai
// system account dell'emittente verificano la firma del messaggio di
// collegamento dell'indirizzo, apposta una volta in onboarding: e' quella,
// non questa, l'autorizzazione permanente che rende possibile il riscatto.
import {
  MONERIUM_BASE_URL, MONERIUM_CLIENT_ID, MONERIUM_CLIENT_SECRET,
  MONERIUM_CHAIN, MONERIUM_IBAN, MERCHANT_ADDRESS, MERCHANT_SIGNER_KEY,
  MERCHANT_FIRST_NAME, MERCHANT_LAST_NAME, MERCHANT_COUNTRY,
} from './config.mjs';

// Gli endpoint autenticati richiedono l'header di versione: senza, l'API
// risponde 404 invece di un errore di validazione. Gli /auth/* non lo vogliono.
const ACCEPT_V2 = 'application/vnd.monerium.api-v2+json';

// Il timestamp del messaggio deve cadere entro cinque minuti da adesso oppure
// nel futuro; lo si sposta avanti per assorbire la latenza della chiamata.
const ANTICIPO_MS = 2 * 60 * 1000;

// Importo oltre il quale l'emittente richiede un documento giustificativo
// allegato all'ordine (supportingDocumentId): il riscatto automatico non lo
// produce e il caso va all'esercente.
export const SOGLIA_DOCUMENTO_EUR = 15000;

let tokenCache = { valore: null, scadenza: 0 };

// Ultimo istante usato in un messaggio: due riscatti di pari importo maturati
// nello stesso secondo produrrebbero lo stesso messaggio firmato e il secondo
// verrebbe respinto come duplicato. Gli istanti sono resi strettamente
// crescenti.
let ultimoIstante = 0;

export function configurazioneRimborsoCompleta() {
  return Boolean(
    MONERIUM_CLIENT_ID && MONERIUM_CLIENT_SECRET &&
    MONERIUM_CHAIN && MONERIUM_IBAN && MERCHANT_ADDRESS && MERCHANT_SIGNER_KEY &&
    MERCHANT_FIRST_NAME && MERCHANT_LAST_NAME
  );
}

async function api(path, options = {}, token = null) {
  const res = await fetch(`${MONERIUM_BASE_URL}${path}`, {
    ...options,
    headers: {
      ...(path.startsWith('/auth/') ? {} : { Accept: ACCEPT_V2 }),
      ...(options.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const corpo = await res.text();
  if (!res.ok) {
    const err = new Error(`${options.method ?? 'GET'} ${path} -> ${res.status}: ${corpo.slice(0, 300)}`);
    // I 5xx e il 429 sono transitori; un 4xx non migliora riprovando, salvo
    // il 401, che segnala un token scaduto e va rinnovato.
    err.transitorio = res.status === 429 || res.status >= 500 || res.status === 401;
    if (res.status === 401) tokenCache = { valore: null, scadenza: 0 };
    throw err;
  }
  return corpo ? JSON.parse(corpo) : null;
}

async function accessToken() {
  if (tokenCache.valore && Date.now() < tokenCache.scadenza) return tokenCache.valore;

  const dati = await api('/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: MONERIUM_CLIENT_ID,
      client_secret: MONERIUM_CLIENT_SECRET,
    }),
  });

  // Si rinnova con un margine, per non usare un token scaduto in volo.
  const durata = Number(dati.expires_in ?? 3600);
  tokenCache = { valore: dati.access_token, scadenza: Date.now() + (durata - 60) * 1000 };
  return tokenCache.valore;
}

// Formato imposto dall'API, da rispettare alla lettera:
//   Send <VALUTA> <IMPORTO> to <IBAN> at <TIMESTAMP RFC3339 con i secondi>
function messaggioOrdine(importo, iban) {
  let istante = Math.floor((Date.now() + ANTICIPO_MS) / 1000);
  if (istante <= ultimoIstante) istante = ultimoIstante + 1;
  ultimoIstante = istante;
  const ts = new Date(istante * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `Send EUR ${importo} to ${iban} at ${ts}`;
}

async function firma(messaggio) {
  const { privateKeyToAccount } = await import('viem/accounts');
  const chiave = MERCHANT_SIGNER_KEY.startsWith('0x') ? MERCHANT_SIGNER_KEY : `0x${MERCHANT_SIGNER_KEY}`;
  const account = privateKeyToAccount(chiave);

  // Una chiave che non corrisponde all'indirizzo di incasso produrrebbe ordini
  // rifiutati a ogni tentativo: meglio fermarsi subito e dirlo.
  if (account.address.toLowerCase() !== MERCHANT_ADDRESS.toLowerCase()) {
    throw new Error(
      `La chiave di firma corrisponde a ${account.address}, non all'indirizzo di incasso ${MERCHANT_ADDRESS}`
    );
  }
  return account.signMessage({ message: messaggio });
}

/// Dispone il riscatto dell'importo incassato e restituisce l'ordine creato.
/// Non attende lo stato finale, per non bloccare il ciclo di osservazione.
export async function disponiRimborso(importo, orderRef = null) {
  if (Number(importo) >= SOGLIA_DOCUMENTO_EUR) {
    const err = new Error(`Importo ${importo} EUR: oltre ${SOGLIA_DOCUMENTO_EUR} l'emittente richiede un documento giustificativo, il riscatto va disposto manualmente`);
    err.transitorio = false;
    throw err;
  }
  const token = await accessToken();
  const messaggio = messaggioOrdine(importo, MONERIUM_IBAN);
  const signature = await firma(messaggio);

  return api('/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'redeem',
      amount: importo,
      currency: 'eur',
      address: MERCHANT_ADDRESS,
      chain: MONERIUM_CHAIN,
      message: messaggio,
      signature,
      // Rende il riscatto riconducibile alla transazione senza accoppiarli
      // per importo e istante, che sarebbe ambiguo.
      ...(orderRef ? { memo: `wcsdi:${orderRef}` } : {}),
      counterpart: {
        identifier: { standard: 'iban', iban: MONERIUM_IBAN },
        details: {
          firstName: MERCHANT_FIRST_NAME,
          lastName: MERCHANT_LAST_NAME,
          ...(MERCHANT_COUNTRY ? { country: MERCHANT_COUNTRY } : {}),
        },
      },
    }),
  }, token);
}

export async function statoRimborso(id) {
  return api(`/orders/${id}`, {}, await accessToken());
}

/// Stati oltre i quali il riscatto non evolve piu'.
export const STATI_FINALI = new Set(['processed', 'rejected', 'declined']);

/// Interpreta la risposta dell'emittente su un ordine. Se terminale,
/// restituisce lo stato, il motivo di un eventuale rifiuto e l'istante di
/// lavorazione, che e' il marcatore t5 del protocollo: quello dichiarato
/// dall'emittente, non quello in cui il servizio se ne accorge.
export function esitoOrdine(o) {
  if (!STATI_FINALI.has(o.state)) return null;
  const lavorato = o.meta?.processedAt ?? o.meta?.rejectedAt ?? null;
  return {
    stato: o.state,
    motivo: o.rejectedReason ?? o.meta?.rejectedReason ?? '',
    t5: lavorato ? Date.parse(lavorato) / 1000 : Date.now() / 1000,
    txHashes: o.meta?.txHashes ?? [],
  };
}

/// Verifica di avvio: l'IBAN configurato deve risultare collegato
/// all'indirizzo di incasso sulla rete in uso, altrimenti i riscatti verranno
/// respinti uno per uno e il forwarder, immutabile, continuera' a convogliare
/// pagamenti su un indirizzo da cui il riscatto non e' disponibile.
export async function ibanCollegato() {
  const dati = await api('/ibans', {}, await accessToken());
  const elenco = Array.isArray(dati) ? dati : (dati?.ibans ?? dati?.data ?? []);
  const norm = (s) => String(s ?? '').replace(/\s+/g, '').toUpperCase();
  return elenco.some((i) =>
    norm(i.iban) === norm(MONERIUM_IBAN)
    && String(i.address ?? '').toLowerCase() === MERCHANT_ADDRESS.toLowerCase()
    && (!i.chain || String(i.chain).toLowerCase() === MONERIUM_CHAIN.toLowerCase())
  );
}
