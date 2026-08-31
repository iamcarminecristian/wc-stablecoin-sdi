// Rimborso alla pari verso l'IBAN dell'esercente (RF-05), consolidato dallo
// spike 2. E' l'unico punto del sistema che esercita la capacita' di firma
// dell'esercente: vive qui, non nel plugin, per le ragioni discusse nel
// paragrafo 4.4 della tesi.
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

let tokenCache = { valore: null, scadenza: 0 };

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
  if (!res.ok) throw new Error(`${options.method ?? 'GET'} ${path} -> ${res.status}: ${corpo.slice(0, 300)}`);
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
//   Send <VALUTA> <IMPORTO> to <IBAN> at <TIMESTAMP RFC3339 al minuto>
function messaggioOrdine(importo, iban) {
  const t = new Date(Date.now() + ANTICIPO_MS);
  t.setSeconds(0, 0);
  // I secondi restano, azzerati: la documentazione parla di precisione al
  // minuto e questo induce a ometterli, ma l'API rifiuta il timestamp senza.
  const ts = t.toISOString().replace(/\.\d{3}Z$/, 'Z');
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

/// Dispone il rimborso dell'importo incassato e restituisce l'ordine creato.
/// Non attende lo stato finale: la sincronizzazione avviene per interrogazione
/// separata, cosi' che il ciclo di osservazione non resti bloccato.
export async function disponiRimborso(importo) {
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

/// Stati oltre i quali il rimborso non evolve piu'.
const STATI_FINALI = new Set(['processed', 'rejected', 'declined']);

/// Segue il rimborso fino a uno stato terminale e restituisce l'istante in cui
/// e' stato lavorato, che e' il marcatore t5 del protocollo: gli euro sono
/// usciti verso l'IBAN. L'istante e' quello dichiarato dall'emittente, non
/// quello in cui il servizio se ne accorge.
export async function attendiRimborso(id, tentativi = 20, attesaMs = 5000) {
  for (let i = 0; i < tentativi; i++) {
    const o = await statoRimborso(id);
    if (STATI_FINALI.has(o.state)) {
      const lavorato = o.meta?.processedAt ?? o.meta?.rejectedAt ?? null;
      return {
        stato: o.state,
        t5: lavorato ? Date.parse(lavorato) / 1000 : Date.now() / 1000,
        txHashes: o.meta?.txHashes ?? [],
      };
    }
    await new Promise((r) => setTimeout(r, attesaMs));
  }
  return null;
}
