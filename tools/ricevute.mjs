// Rilegge dalla rete le ricevute delle transazioni del dataset e ne salva i
// campi di costo completi.
//
// Il servizio di rilevamento registra il solo prodotto gas per prezzo di
// esecuzione. Su una rete OP Stack la ricevuta porta anche la componente di
// pubblicazione dei dati sulla rete sottostante (l1Fee), che il cliente paga
// insieme alla prima: senza questo campo il costo di rete e' un limite
// inferiore. Lo strumento non modifica il dataset: scrive un file affiancato,
// legato alle righe dal tx_hash, che l'analisi puo' unire.
//
// Uso:
//   node tools/ricevute.mjs --dataset=docs/dataset/campagna.csv --chain-id=84532 \
//        --rpc=https://sepolia.base.org --out=docs/dataset/ricevute-2026-09-02.csv
import { readFileSync, writeFileSync } from 'node:fs';

const arg = (n, d) => {
  const v = process.argv.find((a) => a.startsWith(`--${n}=`));
  return v ? v.split('=').slice(1).join('=') : d;
};
const DATASET = arg('dataset', 'docs/dataset/campagna.csv');
const CHAIN_ID = arg('chain-id', '84532');
const RPC = arg('rpc', 'https://sepolia.base.org');
const OUT = arg('out', null);
const PAUSA_MS = Number(arg('pausa', '150'));

function leggiCsv(percorso) {
  const testo = readFileSync(percorso, 'utf8').replace(/^\uFEFF/, '');
  const righe = []; let campo = ''; let riga = []; let q = false;
  for (let i = 0; i < testo.length; i++) {
    const c = testo[i];
    if (q) { if (c === '"') { if (testo[i + 1] === '"') { campo += '"'; i++; } else q = false; } else campo += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { riga.push(campo); campo = ''; }
    else if (c === '\n') { riga.push(campo); righe.push(riga); riga = []; campo = ''; }
    else if (c !== '\r') campo += c;
  }
  if (campo !== '' || riga.length) { riga.push(campo); righe.push(riga); }
  const [testata, ...corpo] = righe;
  return corpo.filter((r) => r.length === testata.length).map((r) => Object.fromEntries(testata.map((k, i) => [k, r[i]])));
}

let id = 0;
async function rpc(method, params) {
  for (let tentativo = 1; tentativo <= 4; tentativo++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) {
      if (tentativo === 4) throw e;
      await new Promise((res) => setTimeout(res, 1000 * tentativo));
    }
  }
}
const num = (h) => (h === undefined || h === null ? '' : BigInt(h).toString());

const righe = leggiCsv(DATASET).filter((r) => r.chain_id === CHAIN_ID && r.tx_hash);
const viste = new Set();
const uscita = ['order_id,campagna,tx_hash,blocco,block_hash,tx_index,stato,gas_usato,effective_gas_price_wei,max_priority_fee_wei,l1_fee_wei,l1_gas_used,l1_gas_price_wei,l1_base_fee_scalar,l1_blob_base_fee_wei,l1_blob_base_fee_scalar,byte_input,costo_l2_wei,costo_totale_wei'];
let fatte = 0;
for (const r of righe) {
  if (viste.has(r.tx_hash)) continue;
  viste.add(r.tx_hash);
  try {
    const [ric, tx] = await Promise.all([
      rpc('eth_getTransactionReceipt', [r.tx_hash]),
      rpc('eth_getTransactionByHash', [r.tx_hash]),
    ]);
    if (!ric) { console.error(`ricevuta assente per ${r.tx_hash}`); continue; }
    const gas = BigInt(ric.gasUsed), prezzo = BigInt(ric.effectiveGasPrice ?? 0);
    const l1 = ric.l1Fee ? BigInt(ric.l1Fee) : 0n;
    uscita.push([
      r.order_id, r.campagna, r.tx_hash, num(ric.blockNumber), ric.blockHash, num(ric.transactionIndex),
      num(ric.status), gas.toString(), prezzo.toString(), num(tx?.maxPriorityFeePerGas),
      l1.toString(), num(ric.l1GasUsed), num(ric.l1GasPrice), num(ric.l1BaseFeeScalar),
      num(ric.l1BlobBaseFee), num(ric.l1BlobBaseFeeScalar),
      tx?.input ? (tx.input.length - 2) / 2 : '', (gas * prezzo).toString(), (gas * prezzo + l1).toString(),
    ].join(','));
    fatte++;
    if (fatte % 25 === 0) process.stdout.write(`\r  ${fatte} ricevute lette   `);
  } catch (e) {
    console.error(`\n${r.tx_hash}: ${e.message}`);
  }
  await new Promise((res) => setTimeout(res, PAUSA_MS));
}
console.log(`\n${fatte} ricevute su ${viste.size} transazioni distinte (chain ${CHAIN_ID})`);
if (OUT) { writeFileSync(OUT, uscita.join('\n') + '\n'); console.log(`Scritto ${OUT}`); }
else console.log(uscita.join('\n'));
