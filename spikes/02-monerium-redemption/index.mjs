// ============================================================================
// SPIKE 2 — Redemption EURe via API Monerium (sandbox)
//
// Obiettivo dello spike: dimostrare in isolamento (1) l'autenticazione alle
// API sandbox, (2) la lettura degli indirizzi dei contratti EURe per rete
// (input per lo spike 1), (3) la creazione di un ordine di rimborso verso
// IBAN con accredito SEPA simulato.
//
// Prerequisito: credenziali app dalla sandbox monerium.dev (client id/secret).
// Esecuzione:
//   cp ../../.env.example ../../.env   (compilare i valori, una volta sola)
//   npm install && npm start
//
// Criterio di uscita dello spike: ordine di redemption creato in sandbox e
// portato a stato finale, con log degli stati intermedi.
//
// NOTA: i passi (1) e (2) sono implementati; il passo (3) è predisposto ma
// il payload esatto va allineato alla documentazione corrente su
// https://monerium.dev dopo la registrazione (endpoint /orders).
// ============================================================================

// Configurazione dal .env unico alla root del monorepo. Il path e' risolto
// rispetto a questo file, non alla cwd: lo spike parte sia da qui sia dalla root.
// Le variabili gia' presenti nell'ambiente hanno la precedenza (override da shell).
import { config } from 'dotenv';
config({ path: new URL('../../.env', import.meta.url) });

const BASE   = process.env.MONERIUM_BASE_URL ?? 'https://api.monerium.dev';
const ID     = required('MONERIUM_CLIENT_ID');
const SECRET = required('MONERIUM_CLIENT_SECRET');
const WALLET = required('MONERIUM_WALLET_ADDRESS');
const CHAIN  = required('MONERIUM_CHAIN');

function required(name) {
  const v = process.env[name];
  if (!v) { console.error(`Variabile mancante: ${name} (vedi .env.example)`); process.exit(1); }
  return v;
}

// Gli endpoint su profili, indirizzi, IBAN e ordini richiedono l'header di
// versione: senza, l'API risponde 404 al posto di un errore di validazione,
// il che rende la diagnosi fuorviante. Gli endpoint /auth/* non lo vogliono.
const ACCEPT_V2 = 'application/vnd.monerium.api-v2+json';

async function api(path, options = {}, token = null) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      ...(path.startsWith('/auth/') ? {} : { Accept: ACCEPT_V2 }),
      ...(options.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${options.method ?? 'GET'} ${path} -> ${res.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}

// (1) Autenticazione: client credentials -> access token.
async function authenticate() {
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: ID,
    client_secret: SECRET,
  });
  const data = await api('/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  console.log('[AUTH] token ottenuto');
  return data.access_token;
}

// (2) Elenco dei token emessi: fornisce gli indirizzi dei contratti EURe
// per ciascuna rete supportata in sandbox. È l'input di TOKEN_ADDRESS per
// lo spike 1 e la fonte di verità sulle reti disponibili.
async function listTokens(token) {
  const tokens = await api('/tokens', {}, token);
  console.log('[TOKENS]');
  for (const t of tokens) console.log('  ', JSON.stringify(t));

  // La chain configurata è l'unica con IBAN approvato: il suo indirizzo di
  // contratto va incollato in TOKEN_ADDRESS prima di lanciare lo spike 1.
  const scelto = tokens.find((t) => t.chain === CHAIN && t.currency === 'eur');
  if (scelto) {
    console.log(`[TOKEN_ADDRESS] ${CHAIN}: ${scelto.address}  <- incollare nel .env di root`);
  } else {
    console.log(`[TOKEN_ADDRESS] nessun token EURe su ${CHAIN}: verificare MONERIUM_CHAIN.`);
  }
  return tokens;
}

// (2-bis) Profili e IBAN collegati: il redeem ha bisogno dell'IBAN di
// accredito, che qui viene mostrato per poterlo mettere in MONERIUM_IBAN.
// In sandbox il profilo resta kind "unknown" e state "created" perché non
// è richiesto il KYC: non è un errore.
async function listProfiles(token) {
  // L'API incapsula gli elenchi in un oggetto; /tokens invece restituisce
  // un array nudo. Normalizziamo per non dipendere dalla forma.
  const lista = (r, chiave) => (Array.isArray(r) ? r : (r?.[chiave] ?? []));

  const profiles = lista(await api('/profiles', {}, token), 'profiles');
  console.log('[PROFILI]');
  for (const p of profiles) console.log(`   ${p.id} | kind=${p.kind} | state=${p.state}`);

  const ibans = lista(await api('/ibans', {}, token), 'ibans');
  console.log('[IBAN]');
  for (const i of ibans) {
    console.log(`   ${i.iban} | chain=${i.chain} | address=${i.address} | state=${i.state}`);
  }
  return { profiles, ibans };
}

// (3) Redemption: ordine di rimborso dal saldo on-chain verso IBAN (SEPA).
//
// Monerium non si accontenta dell'access token OAuth, che prova soltanto che
// l'applicazione parla per conto dell'account. Bruciare EURe e muovere euro
// verso un IBAN richiede in piu' la prova che chi controlla l'indirizzo sia
// d'accordo: una firma sul messaggio dell'ordine. Il messaggio vincola
// importo, IBAN e istante, quindi non e' riutilizzabile.
//
// Formato imposto dall'API, da rispettare alla lettera:
//   Send <VALUTA> <IMPORTO> to <IBAN> at <TIMESTAMP RFC3339 al minuto>
// Il timestamp non porta i secondi e deve cadere entro cinque minuti da adesso
// oppure nel futuro; lo spostiamo avanti di due minuti per assorbire la
// latenza della chiamata.
const ANTICIPO_MS = 2 * 60 * 1000;

function messaggioOrdine(importo, iban) {
  const t = new Date(Date.now() + ANTICIPO_MS);
  t.setSeconds(0, 0);
  // RFC3339 al minuto: 2026-08-31T17:42Z, senza i secondi che toISOString aggiunge.
  // I secondi restano, azzerati: la documentazione parla di precisione al
  // minuto e questo induce a ometterli, ma l'API rifiuta il timestamp senza.
  const ts = t.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `Send EUR ${importo} to ${iban} at ${ts}`;
}

// Unico punto in cui il sistema esercita la capacita' di firma del merchant,
// isolato di proposito perche' e' l'unica cosa da cambiare se il modello
// evolve. Nel sistema consolidato la chiave vive nel servizio watcher, non
// nel plugin PHP: vedi "Capacita' di firma" in CLAUDE.md. Qui, nello spike,
// arriva da MERCHANT_SIGNER_PRIVATE_KEY perche' e' un banco di prova su testnet
// con fondi simulati.
async function firma(messaggio) {
  const chiave = process.env.MERCHANT_SIGNER_PRIVATE_KEY;
  if (!chiave) {
    throw new Error(
      'Firma non disponibile: manca MERCHANT_SIGNER_PRIVATE_KEY. ' +
      `Messaggio da firmare: ${messaggio}`
    );
  }
  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(chiave.startsWith('0x') ? chiave : `0x${chiave}`);
  if (account.address.toLowerCase() !== WALLET.toLowerCase()) {
    throw new Error(
      `La chiave di firma corrisponde a ${account.address}, non al wallet ${WALLET}.`
    );
  }
  // personal_sign (EIP-191): e' il formato che l'API si aspetta per un EOA.
  return account.signMessage({ message: messaggio });
}

async function redeem(token, importo = '1') {
  const iban = required('MONERIUM_IBAN');
  const messaggio = messaggioOrdine(importo, iban);
  console.log(`[REDEEM] messaggio: ${messaggio}`);

  const signature = await firma(messaggio);

  const ordine = await api('/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'redeem',
      amount: importo,
      currency: 'eur',
      address: WALLET,
      chain: CHAIN,
      message: messaggio,
      signature,
      counterpart: {
        identifier: { standard: 'iban', iban },
        details: { firstName: 'Carmine Cristian', lastName: 'Cruoglio', country: 'IT' },
      },
    }),
  }, token);

  // Lo stato e' un campo di primo livello: dentro meta ci sono solo gli
  // istanti e gli hash delle transazioni.
  console.log(`[REDEEM] ordine creato: ${ordine.id} | stato ${ordine.state}`);
  return attendiStatoFinale(token, ordine.id);
}

// Il criterio di uscita dello spike chiede gli stati intermedi, non solo
// l'esito: l'ordine viene seguito fino a uno stato terminale.
const STATI_FINALI = new Set(['processed', 'rejected', 'declined']);

async function attendiStatoFinale(token, id, tentativi = 30, attesaMs = 5000) {
  let precedente = null;
  for (let i = 0; i < tentativi; i++) {
    const o = await api(`/orders/${id}`, {}, token);
    const stato = o.state;
    if (stato !== precedente) {
      console.log(`[REDEEM] stato: ${stato}`);
      precedente = stato;
    }
    if (STATI_FINALI.has(stato)) return o;
    await new Promise((r) => setTimeout(r, attesaMs));
  }
  console.log('[REDEEM] stato finale non raggiunto entro il tempo di attesa.');
  return null;
}

async function main() {
  const token = await authenticate();
  await listTokens(token);
  await listProfiles(token);
  await redeem(token);
}

main().catch((err) => { console.error('[ERRORE]', err.message ?? err); process.exit(1); });
