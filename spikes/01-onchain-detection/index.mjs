// ============================================================================
// SPIKE 1 — Rilevamento pagamento on-chain (ERC-20 Transfer verso indirizzo)
//
// Obiettivo dello spike: dimostrare in isolamento che un processo Node può
// (1) osservare gli eventi Transfer di un token ERC-20 verso un indirizzo
// di incasso, (2) applicare un criterio di finalità a N conferme,
// (3) produrre un evento "pagamento confermato" idempotente.
//
// Esecuzione:
//   cp ../../.env.example ../../.env   (compilare i valori, una volta sola)
//   npm install
//   npm start
//
// Rete di riferimento: Base Sepolia (chain id 84532, RPC https://sepolia.base.org),
// l'unica su cui il wallet Monerium ha un IBAN approvato. TOKEN_ADDRESS e'
// l'indirizzo del contratto EURe restituito da GET /tokens (spike 2).
// Per la demo offline su anvil, sovrascrivere da shell:
//   RPC_URL=http://localhost:8545 TOKEN_ADDRESS=0x... npm start
//
// Criterio di uscita dello spike: transazione di test su Base Sepolia rilevata
// e confermata con log coerente (txHash, logIndex, importo, blocco).
// ============================================================================

// Configurazione dal .env unico alla root del monorepo. Il path e' risolto
// rispetto a questo file, non alla cwd: lo spike parte sia da qui sia dalla root.
// Le variabili gia' presenti nell'ambiente hanno la precedenza (override da shell).
import { config } from 'dotenv';
config({ path: new URL('../../.env', import.meta.url) });
import { createPublicClient, http, parseAbiItem, formatUnits, getAddress } from 'viem';

const RPC_URL       = required('RPC_URL');
const TOKEN_ADDRESS = getAddress(required('TOKEN_ADDRESS'));
const WATCH_ADDRESS = getAddress(required('WATCH_ADDRESS'));
const CONFIRMATIONS = BigInt(process.env.CONFIRMATIONS ?? '12');
const POLL_MS       = Number(process.env.POLL_MS ?? '5000');
const DECIMALS      = Number(process.env.TOKEN_DECIMALS ?? '18');

// Con FORWARDER_ADDRESS il rilevamento osserva gli eventi del contratto di
// inoltro, che portano il riferimento dell'ordine: la correlazione e' esatta
// anche fra ordini di pari importo nella stessa finestra. Senza, si ripiega
// sugli eventi Transfer del token, che non trasportano alcuna causale: e' la
// modalita' di confronto, utile a mostrare il limite che il contratto risolve.
const FORWARDER = process.env.FORWARDER_ADDRESS
  ? getAddress(process.env.FORWARDER_ADDRESS)
  : null;

const transferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
);
const orderPaidEvent = parseAbiItem(
  'event OrderPaid(bytes32 indexed orderRef, address indexed payer, uint256 amount)'
);

const client = createPublicClient({ transport: http(RPC_URL) });

// Stato dello spike: pagamenti visti (provvisori) e confermati.
// Chiave idempotente: `${txHash}:${logIndex}` (cfr. RNF-03 della tesi).
const seen = new Map();      // key -> { blockNumber, value, from }
const confirmed = new Set(); // key già notificate

function required(name) {
  const v = process.env[name];
  if (!v) { console.error(`Variabile mancante: ${name} (vedi .env.example)`); process.exit(1); }
  return v;
}

async function scan(fromBlock, toBlock) {
  const logs = FORWARDER
    ? await client.getLogs({ address: FORWARDER, event: orderPaidEvent, fromBlock, toBlock })
    : await client.getLogs({
        address: TOKEN_ADDRESS,
        event: transferEvent,
        args: { to: WATCH_ADDRESS },
        fromBlock,
        toBlock,
      });

  for (const log of logs) {
    const key = `${log.transactionHash}:${log.logIndex}`;
    if (seen.has(key)) continue;

    const value = FORWARDER ? log.args.amount : log.args.value;
    const from  = FORWARDER ? log.args.payer  : log.args.from;
    const ordine = FORWARDER ? log.args.orderRef : null;

    seen.set(key, { blockNumber: log.blockNumber, value, from, ordine });
    console.log(
      `[VISTO]      ${key} | ${formatUnits(value, DECIMALS)} | blocco ${log.blockNumber}` +
      (ordine ? ` | ordine ${ordine.slice(0, 10)}` : '')
    );
  }
}

function checkConfirmations(head) {
  for (const [key, p] of seen) {
    if (confirmed.has(key)) continue;
    const depth = head - p.blockNumber;
    if (depth >= CONFIRMATIONS) {
      confirmed.add(key);
      // Nel sistema integrato questo è il punto in cui il watcher notifica il
      // plugin via REST (POST /wcsdi/v1/payment-confirmed, autenticato).
      console.log(
        `[CONFERMATO] ${key} | ${formatUnits(p.value, DECIMALS)} | profondità ${depth} blocchi` +
        (p.ordine ? ` | ordine ${p.ordine.slice(0, 10)}` : '')
      );
    }
  }
}

async function main() {
  console.log(
    FORWARDER
      ? `Spike 1 avviato in modalità inoltro. Contratto ${FORWARDER}, finalità ${CONFIRMATIONS} conferme.`
      : `Spike 1 avviato in modalità trasferimento diretto. Token ${TOKEN_ADDRESS}, incasso ${WATCH_ADDRESS}, finalità ${CONFIRMATIONS} conferme.`
  );
  let last = await client.getBlockNumber();
  console.log(`Blocco di partenza: ${last}`);

  // Nota riorganizzazioni: gli eventi restano "visti" finché non raggiungono
  // la profondità richiesta; un evento decaduto per riorg semplicemente non
  // verrà più restituito dai getLogs successivi né raggiungerà la conferma.
  // La gestione completa (invalidazione esplicita) è demandata al watcher.
  for (;;) {
    try {
      const head = await client.getBlockNumber();
      if (head > last) {
        await scan(last + 1n, head);
        last = head;
      }
      checkConfirmations(head);
    } catch (err) {
      console.error(`[ERRORE] ${err.message ?? err}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main();
