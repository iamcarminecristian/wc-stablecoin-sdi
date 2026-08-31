// Configurazione del servizio, letta dal .env unico alla root del monorepo.
// Il path e' risolto rispetto a questo file, non alla cwd.
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

export const CONFIRMATIONS = BigInt(process.env.CONFIRMATIONS ?? '12');
export const POLL_MS = Number(process.env.POLL_MS ?? '5000');
export const DECIMALS = Number(process.env.TOKEN_DECIMALS ?? '18');

// Ampiezza massima di una singola query sui log: i provider RPC pubblici
// limitano l'intervallo di blocchi interrogabile in una volta sola.
export const MAX_BLOCK_SPAN = BigInt(process.env.MAX_BLOCK_SPAN ?? '500');

// Endpoint REST del plugin e segreto condiviso per autenticare le notifiche.
export const PLUGIN_URL = richiesta('WCSDI_PLUGIN_URL').replace(/\/+$/, '');
export const PLUGIN_SECRET = richiesta('WCSDI_SHARED_SECRET');

// Stato persistente: ultimo blocco elaborato ed eventi gia' notificati.
export const STATE_FILE = process.env.WATCHER_STATE_FILE
  ?? new URL('../state.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// Blocco da cui iniziare alla primissima accensione. Senza, si parte dalla
// testa della catena: gli eventi anteriori non verrebbero mai visti.
export const START_BLOCK = process.env.START_BLOCK ? BigInt(process.env.START_BLOCK) : null;

// Rimborso automatico verso l'IBAN dell'esercente (RF-05). Disattivabile,
// perche' la fatturazione non dipende dall'esito del rimborso.
export const REDEEM_ENABLED = (process.env.AUTO_REDEEM ?? 'true') !== 'false';
export const MONERIUM_BASE_URL = process.env.MONERIUM_BASE_URL ?? 'https://api.monerium.dev';
export const MONERIUM_CLIENT_ID = process.env.MONERIUM_CLIENT_ID ?? '';
export const MONERIUM_CLIENT_SECRET = process.env.MONERIUM_CLIENT_SECRET ?? '';
export const MONERIUM_CHAIN = process.env.MONERIUM_CHAIN ?? '';
export const MONERIUM_IBAN = process.env.MONERIUM_IBAN ?? '';
export const MERCHANT_ADDRESS = process.env.MONERIUM_WALLET_ADDRESS ?? '';

// Unica chiave privata presente nel sistema: quella dell'esercente sul proprio
// indirizzo di incasso, necessaria a firmare gli ordini di rimborso. Vive qui
// e non nel plugin, per le ragioni discusse nel paragrafo 4.4 della tesi.
export const MERCHANT_SIGNER_KEY = process.env.MERCHANT_SIGNER_PRIVATE_KEY ?? '';
