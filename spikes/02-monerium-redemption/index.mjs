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
// TODO(spike): allineare il payload alla documentazione corrente delle API
// (monerium.dev, sezione Orders) dopo l'ottenimento delle credenziali:
// campi tipici attesi: address di provenienza, chain, amount, currency,
// counterpart { identifier: { standard: 'iban', iban }, details { name } },
// e firma/messaggio ove richiesto dal flusso sandbox.
async function redeem(token) {
  console.log('[REDEEM] stub: implementare dopo verifica payload su monerium.dev');
  // const order = await api('/orders', {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify({ /* payload da documentazione */ }),
  // }, token);
  // console.log('[REDEEM] ordine creato:', order.id, order.meta?.state);
}

async function main() {
  const token = await authenticate();
  await listTokens(token);
  await listProfiles(token);
  await redeem(token);
}

main().catch((err) => { console.error('[ERRORE]', err.message ?? err); process.exit(1); });
