// Misura quanto sono arretrate le etichette di finalità di una rete di secondo
// livello rispetto alla testa della catena.
//
// Contare le conferme è il criterio giusto su una rete di primo livello, dove
// la profondità approssima il costo di riscrivere la storia. Su una rete di
// secondo livello non lo è: i blocchi che il sequencer produce restano
// revocabili finché il lotto che li contiene non è stato pubblicato e
// finalizzato sulla rete sottostante, e nessun numero di conferme accorcia
// quell'attesa. Il protocollo espone due etichette che nominano i due
// passaggi, `safe` e `finalized`, ed è la loro distanza dalla testa a misurare
// l'irreversibilità reale.
//
// Uso:
//   node tools/finalita-l2.mjs --minuti=20
//   node tools/finalita-l2.mjs --rpc=https://mainnet.base.org --out=docs/dataset/finalita.csv
//   node tools/finalita-l2.mjs --minuti=2880 --grezzo=docs/dataset/finalita-campioni.csv
//
// Con --grezzo ogni campione viene scritto su file man mano (ogni dieci
// letture), cosi' un'osservazione di giorni sopravvive a un'interruzione e
// la distribuzione si puo' ricalcolare per ciclo di finalizzazione, non solo
// dai quantili del riassunto.
import { writeFileSync, appendFileSync, existsSync } from 'node:fs';

const arg = (n, d) => {
  const v = process.argv.find((a) => a.startsWith(`--${n}=`));
  return v ? v.split('=').slice(1).join('=') : d;
};

const RPC = arg('rpc', 'https://sepolia.base.org');
const MINUTI = Number(arg('minuti', '20'));
const PASSO_MS = Number(arg('passo', '15000'));
const OUT = arg('out', null);
const GREZZO = arg('grezzo', null);
if (GREZZO && !existsSync(GREZZO)) {
  writeFileSync(GREZZO, 'ora,testa,safe_blocchi,safe_secondi,finalized_blocchi,finalized_secondi,rete\n');
}
let daScrivere = [];
const scrivi = () => {
  if (!GREZZO || daScrivere.length === 0) return;
  appendFileSync(GREZZO, daScrivere.map((c) => [c.ora, c.testa, c.safeBlocchi, c.safeSecondi, c.finBlocchi, c.finSecondi, RPC].join(',')).join('\n') + '\n');
  daScrivere = [];
};

let id = 0;
async function rpc(method, params = []) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

function quantile(o, p) {
  const h = (o.length - 1) * p;
  const b = Math.floor(h);
  const a = Math.min(b + 1, o.length - 1);
  return o[b] + (h - b) * (o[a] - o[b]);
}

const riassumi = (v) => {
  const o = v.slice().sort((a, b) => a - b);
  return { n: o.length, min: o[0], mediana: quantile(o, 0.5), p95: quantile(o, 0.95), max: o[o.length - 1] };
};

console.log(`Rete ${RPC}, chain id ${Number(await rpc('eth_chainId'))}`);
console.log(`Campionamento ogni ${PASSO_MS / 1000} s per ${MINUTI} minuti\n`);

const campioni = [];
const scadenza = Date.now() + MINUTI * 60 * 1000;
while (Date.now() < scadenza) {
  try {
    const [l, s, f] = await Promise.all([
      rpc('eth_getBlockByNumber', ['latest', false]),
      rpc('eth_getBlockByNumber', ['safe', false]),
      rpc('eth_getBlockByNumber', ['finalized', false]),
    ]);
    const t = (b) => Number(BigInt(b.timestamp));
    const n = (b) => Number(BigInt(b.number));
    const campione = {
      ora: new Date(t(l) * 1000).toISOString(), testa: n(l),
      safeBlocchi: n(l) - n(s), safeSecondi: t(l) - t(s),
      finBlocchi: n(l) - n(f), finSecondi: t(l) - t(f),
    };
    campioni.push(campione);
    daScrivere.push(campione);
    if (daScrivere.length >= 10) scrivi();
    process.stdout.write(`\r  ${campioni.length} campioni | safe ${t(l) - t(s)} s | finalized ${t(l) - t(f)} s   `);
  } catch (e) {
    process.stdout.write(`\r  errore: ${e.message}   `);
  }
  await new Promise((r) => setTimeout(r, PASSO_MS));
}

scrivi();
const safe = riassumi(campioni.map((c) => c.safeSecondi));
const fin = riassumi(campioni.map((c) => c.finSecondi));
const f = (x) => x.toFixed(0).padStart(6);

console.log(`\n\nArretrato rispetto alla testa, in secondi:`);
console.log(`  etichetta      n     min  mediana     p95     max`);
console.log(`  safe       ${String(safe.n).padStart(5)}  ${f(safe.min)}  ${f(safe.mediana)}  ${f(safe.p95)}  ${f(safe.max)}`);
console.log(`  finalized  ${String(fin.n).padStart(5)}  ${f(fin.min)}  ${f(fin.mediana)}  ${f(fin.p95)}  ${f(fin.max)}`);

if (OUT) {
  const righe = ['etichetta,unita,n,min,mediana,p95,max,finestra_da,finestra_a,rete'];
  for (const [nome, r] of [['safe', safe], ['finalized', fin]]) {
    righe.push([nome, 'secondi', r.n, r.min, r.mediana, r.p95, r.max,
      campioni[0]?.ora, campioni[campioni.length - 1]?.ora, RPC].join(','));
  }
  writeFileSync(OUT, righe.join('\n') + '\n');
  console.log(`\nScritto ${OUT}`);
}
