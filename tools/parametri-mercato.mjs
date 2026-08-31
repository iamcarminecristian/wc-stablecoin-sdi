// Rileva i due parametri di mercato che servono a convertire in euro il costo
// di rete di una transazione: il prezzo del gas sulla rete principale e il
// tasso di cambio ETH/EUR.
//
// Nessuno dei due e' misurabile in laboratorio, e nessuno dei due e' una
// costante. Prenderne un solo valore, per giunta dell'istante in cui si scrive,
// darebbe al risultato una precisione che non ha: il cambio di una
// cripto-attivita' varia di un fattore due nell'arco di un anno, e il prezzo
// del gas di una rete di secondo livello varia con la congestione. Entrambi
// vanno percio' osservati su una finestra dichiarata e riportati come
// intervallo, non come punto.
//
// Uso:
//   node tools/parametri-mercato.mjs
//   node tools/parametri-mercato.mjs --mesi=24 --giorni-gas=7 --out=docs/dataset/parametri.csv
import { writeFileSync } from 'node:fs';

const arg = (n, d) => {
  const v = process.argv.find((a) => a.startsWith(`--${n}=`));
  return v ? v.split('=').slice(1).join('=') : d;
};

const MESI = Number(arg('mesi', '24'));
const GIORNI_GAS = Number(arg('giorni-gas', '7'));
const CAMPIONI_GAS = Number(arg('campioni-gas', '168'));
const OUT = arg('out', null);

const RPC_BASE = arg('rpc', 'https://mainnet.base.org');
const PAUSA_MS = Number(arg('pausa', '120'));

const attesa = (ms) => new Promise((r) => setTimeout(r, ms));

// --- statistica ------------------------------------------------------------

function quantile(ordinati, p) {
  const h = (ordinati.length - 1) * p;
  const b = Math.floor(h);
  const a = Math.min(b + 1, ordinati.length - 1);
  return ordinati[b] + (h - b) * (ordinati[a] - ordinati[b]);
}

function riassumi(v) {
  const o = v.slice().sort((a, b) => a - b);
  return {
    n: o.length,
    min: o[0],
    p05: quantile(o, 0.05),
    mediana: quantile(o, 0.5),
    p95: quantile(o, 0.95),
    max: o[o.length - 1],
  };
}

// --- tasso di cambio -------------------------------------------------------

// Fonte pubblica e interrogabile per data, quindi verificabile da un terzo
// senza dover disporre di un abbonamento a un servizio dati.
const FONTE_CAMBIO = 'https://api.coinbase.com/v2/prices/ETH-EUR/spot';

async function cambioAllaData(iso) {
  const r = await fetch(`${FONTE_CAMBIO}?date=${iso}`);
  if (!r.ok) return null;
  const j = await r.json();
  const v = Number(j?.data?.amount);
  return Number.isFinite(v) ? v : null;
}

console.log(`Tasso di cambio ETH/EUR: campionamento settimanale su ${MESI} mesi`);
const oggi = new Date();
const serie = [];
const SETTIMANE = Math.round((MESI * 365.25 / 12) / 7);
for (let k = SETTIMANE; k >= 0; k--) {
  const d = new Date(oggi.getTime() - k * 7 * 24 * 3600 * 1000);
  const iso = d.toISOString().slice(0, 10);
  const v = await cambioAllaData(iso);
  if (v !== null) serie.push({ data: iso, eur: v });
  await attesa(PAUSA_MS);
  if (serie.length % 20 === 0) process.stdout.write(`\r  ${serie.length}/${SETTIMANE + 1} rilevazioni`);
}
const corrente = await cambioAllaData(oggi.toISOString().slice(0, 10));
const cambio = riassumi(serie.map((x) => x.eur));
console.log(`\r  ${serie.length} rilevazioni da ${serie[0]?.data} a ${serie[serie.length - 1]?.data}`);
console.log(`  min ${cambio.min.toFixed(2)}  p05 ${cambio.p05.toFixed(2)}  mediana ${cambio.mediana.toFixed(2)}  p95 ${cambio.p95.toFixed(2)}  max ${cambio.max.toFixed(2)}`);
console.log(`  ultima rilevazione: ${corrente?.toFixed(3)} EUR`);

// --- prezzo del gas --------------------------------------------------------

console.log(`\nPrezzo del gas su ${RPC_BASE}: ${CAMPIONI_GAS} campioni su ${GIORNI_GAS} giorni`);
// JSON-RPC diretto: due sole chiamate, e cosi' lo strumento non dipende da
// alcun pacchetto e gira da qualunque directory del monorepo.
let idChiamata = 0;
async function rpc(method, params = []) {
  const r = await fetch(RPC_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++idChiamata, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

const chainId = Number(await rpc('eth_chainId'));
const testaGrezza = await rpc('eth_getBlockByNumber', ['latest', false]);
const testa = { number: BigInt(testaGrezza.number) };
const secondiPerBlocco = 2;
const passo = BigInt(Math.max(1, Math.floor((GIORNI_GAS * 86400 / secondiPerBlocco) / CAMPIONI_GAS)));

const gas = [];
for (let k = 0; k < CAMPIONI_GAS; k++) {
  const n = testa.number - BigInt(k) * passo;
  if (n <= 0n) break;
  try {
    const b = await rpc('eth_getBlockByNumber', ['0x' + n.toString(16), false]);
    gas.push({
      blocco: Number(BigInt(b.number)),
      ora: new Date(Number(BigInt(b.timestamp)) * 1000).toISOString(),
      gwei: Number(BigInt(b.baseFeePerGas)) / 1e9,
    });
  } catch {
    // Un nodo pubblico puo' rifiutare una richiesta: si prosegue, il campione
    // manca ma la finestra resta quella dichiarata.
  }
  await attesa(PAUSA_MS);
  if (gas.length % 20 === 0) process.stdout.write(`\r  ${gas.length}/${CAMPIONI_GAS} blocchi`);
}
const prezzo = riassumi(gas.map((x) => x.gwei));
console.log(`\r  ${gas.length} blocchi, chain id ${chainId}, da ${gas[gas.length - 1]?.ora} a ${gas[0]?.ora}`);
console.log(`  min ${prezzo.min.toFixed(6)}  p05 ${prezzo.p05.toFixed(6)}  mediana ${prezzo.mediana.toFixed(6)}  p95 ${prezzo.p95.toFixed(6)}  max ${prezzo.max.toFixed(6)} gwei`);

// --- costo risultante ------------------------------------------------------

const GAS_INOLTRO = 65388;
const euro = (gwei, eur) => GAS_INOLTRO * gwei * 1e-9 * eur;

console.log(`\nCosto di un pagamento (${GAS_INOLTRO} gas) in euro:`);
console.log(`  caso favorevole  (gas p05, cambio p05):  ${euro(prezzo.p05, cambio.p05).toFixed(6)}`);
console.log(`  caso centrale    (mediane):              ${euro(prezzo.mediana, cambio.mediana).toFixed(6)}`);
console.log(`  caso sfavorevole (gas p95, cambio p95):  ${euro(prezzo.p95, cambio.p95).toFixed(6)}`);
console.log(`  estremo osservato (max, max):            ${euro(prezzo.max, cambio.max).toFixed(6)}`);

if (OUT) {
  const righe = ['grandezza,unita,n,min,p05,mediana,p95,max,finestra_da,finestra_a,fonte'];
  righe.push([
    'cambio_eth_eur', 'EUR', cambio.n, cambio.min, cambio.p05, cambio.mediana, cambio.p95, cambio.max,
    serie[0]?.data, serie[serie.length - 1]?.data, FONTE_CAMBIO,
  ].join(','));
  righe.push([
    'prezzo_gas_base', 'gwei', prezzo.n, prezzo.min, prezzo.p05, prezzo.mediana, prezzo.p95, prezzo.max,
    gas[gas.length - 1]?.ora, gas[0]?.ora, RPC_BASE,
  ].join(','));
  writeFileSync(OUT, righe.join('\n') + '\n');
  console.log(`\nScritto ${OUT}`);
}
