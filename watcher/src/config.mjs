// Configurazione del servizio, letta dal .env unico alla root del monorepo.
// Il path e' risolto rispetto a questo file, non alla cwd.
//
// Il criterio di conferma e la rete possono arrivare anche dal plugin, che li
// espone su GET /config: e' l'esercente a configurarli nel pannello, e due
// sorgenti di verita' che nessuno tiene allineate producono ordini che restano
// in attesa per sempre. Le variabili d'ambiente, se presenti, hanno la
// precedenza: servono al banco di prova, che varia il criterio per campagna.
import { config } from 'dotenv';
config({ path: new URL('../../.env', import.meta.url) });

import { getAddress } from 'viem';

function richiesta(nome) {
  const v = process.env[nome];
  if (!v) {
    console.error(`Variabile mancante: ${nome} (vedi .env.example alla root)`);
    process.exit(1);
  }
  return v;
}

export const RPC_URL = richiesta('RPC_URL');
export const CHAIN_ID = Number(process.env.CHAIN_ID ?? '0');

// Contratto di inoltro: e' la fonte degli eventi di pagamento. Ogni OrderPaid
// che emette e' per definizione un incasso dell'esercente, quindi il servizio
// non ha bisogno di sapere in anticipo quali ordini attendere.
export const FORWARDER = getAddress(richiesta('FORWARDER_ADDRESS'));

// Contratto del token: serve alle verifiche di avvio (indirizzo di incasso
// non in lista nera presso il validatore dell'emittente). Facoltativo.
export const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS ? getAddress(process.env.TOKEN_ADDRESS) : null;

// Criterio di conferma. Contare le conferme e' il criterio giusto su una rete
// di primo livello, dove la profondita' approssima il costo di riscrivere la
// storia. Su una rete di secondo livello non lo e': i blocchi che il sequencer
// produce non derivano dai dati pubblicati sul primo livello e restano
// revocabili finche' non lo sono, e nessun numero di conferme accorcia quella
// attesa. Il protocollo espone due etichette che nominano i due passaggi:
//
//   confirmations  profondita' in blocchi. Non offre alcuna garanzia ancorata
//                  al primo livello: adatto a una rete di primo livello, o a
//                  una scelta consapevole di fidarsi del sequencer.
//   safe           il blocco e' ricostruibile dai dati pubblicati sul primo
//                  livello. Puo' ancora decadere se decade il blocco di primo
//                  livello che li contiene.
//   finalized      il blocco di primo livello e' finalizzato. Revocarlo
//                  richiederebbe una violazione della finalita' del consenso
//                  sottostante, con la relativa penalizzazione.
//
// Il valore predefinito, in assenza di configurazione dal plugin e da
// ambiente, e' 'finalized': e' l'unico che offre una garanzia dimostrabile,
// e la conferma qui innesca due azioni irreversibili fuori dalla catena, il
// riscatto verso l'IBAN e la trasmissione al SdI.
export const CRITERI = ['confirmations', 'safe', 'finalized'];
export const FINALITY_MODE_ENV = process.env.FINALITY_MODE ?? null;
if (FINALITY_MODE_ENV && !CRITERI.includes(FINALITY_MODE_ENV)) {
  console.error(`FINALITY_MODE non riconosciuto: ${FINALITY_MODE_ENV}`);
  process.exit(1);
}
export const CONFIRMATIONS_ENV = process.env.CONFIRMATIONS ? BigInt(process.env.CONFIRMATIONS) : null;

// Intervallo di sondaggio. Con il conteggio delle conferme la profondita'
// cresce a ogni blocco e vale la pena guardare spesso; con le etichette
// l'attesa e' di minuti e un sondaggio fitto consuma solo la quota del
// provider (tredicimila richieste al giorno a cinque secondi).
export const POLL_MS_ENV = process.env.POLL_MS ? Number(process.env.POLL_MS) : null;
export const DECIMALS = Number(process.env.TOKEN_DECIMALS ?? '18');

// Ampiezza massima di una singola query sui log: i provider RPC pubblici
// limitano l'intervallo di blocchi interrogabile in una volta sola.
export const MAX_BLOCK_SPAN = BigInt(process.env.MAX_BLOCK_SPAN ?? '500');

// Endpoint REST del plugin e segreto condiviso per autenticare le notifiche.
export const PLUGIN_URL = richiesta('WCSDI_PLUGIN_URL').replace(/\/+$/, '');
export const PLUGIN_SECRET = richiesta('WCSDI_SHARED_SECRET');

// Stato persistente: ultimo blocco elaborato, eventi in attesa e notificati,
// riscatti in corso, eventi orfani.
export const STATE_FILE = process.env.WATCHER_STATE_FILE
  ?? new URL('../state.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// Blocco da cui iniziare alla primissima accensione. Senza, si parte dalla
// testa della catena: gli eventi anteriori non verrebbero mai visti.
export const START_BLOCK = process.env.START_BLOCK ? BigInt(process.env.START_BLOCK) : null;

// Riscatto automatico verso l'IBAN dell'esercente (RF-05). Disattivabile,
// perche' la fatturazione non dipende dall'esito del riscatto.
export const REDEEM_ENABLED = (process.env.AUTO_REDEEM ?? 'true') !== 'false';
export const MONERIUM_BASE_URL = process.env.MONERIUM_BASE_URL ?? 'https://api.monerium.dev';
export const MONERIUM_CLIENT_ID = process.env.MONERIUM_CLIENT_ID ?? '';
export const MONERIUM_CLIENT_SECRET = process.env.MONERIUM_CLIENT_SECRET ?? '';
export const MONERIUM_CHAIN = process.env.MONERIUM_CHAIN ?? '';
export const MONERIUM_IBAN = process.env.MONERIUM_IBAN ?? '';
export const MERCHANT_ADDRESS = process.env.MONERIUM_WALLET_ADDRESS ?? '';

// Ritentativi del riscatto: un guasto transitorio dell'emittente non deve
// lasciare euro tokenizzati fermi sull'indirizzo di incasso senza che nessuno
// ci riprovi. Oltre l'ultimo tentativo il caso passa all'esercente.
export const RISCATTO_BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000, 10_800_000, 21_600_000, 21_600_000, 21_600_000];
export const RISCATTO_POLL_MS = Number(process.env.RISCATTO_POLL_MS ?? '15000');

// Anagrafica del beneficiario del riscatto, che e' l'esercente stesso.
// L'emittente la esige: un ordine di riscatto senza counterpart.details viene
// rifiutato con 400 «Details attribute is missing from JSON», e con i soli
// nome e cognome mancanti con «field is required» su entrambi. Il paese e'
// facoltativo e viene inviato solo se configurato.
export const MERCHANT_FIRST_NAME = process.env.MERCHANT_FIRST_NAME ?? '';
export const MERCHANT_LAST_NAME = process.env.MERCHANT_LAST_NAME ?? '';
export const MERCHANT_COUNTRY = process.env.MERCHANT_COUNTRY ?? '';

// Unica chiave privata presente nel sistema: quella dell'esercente sul proprio
// indirizzo di incasso, necessaria a firmare gli ordini di riscatto. Vive qui
// e non nel plugin, per le ragioni discusse nel paragrafo 4.4 della tesi.
export const MERCHANT_SIGNER_KEY = process.env.MERCHANT_SIGNER_PRIVATE_KEY ?? '';
