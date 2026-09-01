// Riduce il dataset sperimentale alle tabelle del Capitolo 6.
//
// L'analisi vive qui e non in un foglio di calcolo perche' deve essere
// rieseguibile: cambiare il dataset e rilanciare deve bastare a rifare tutte
// le tabelle, senza passaggi manuali che nessuno puo' ripercorrere.
//
// Uso:
//   node tools/analisi.mjs --dataset=docs/dataset/campagna.csv
//   node tools/analisi.mjs --dataset=... --latex   (tabelle pronte da includere)
//
// Il costo in euro NON viene ricavato dal prezzo del gas della rete di prova,
// che non ha domanda di blocco: si usano i parametri osservati sulla rete
// principale, dichiarati qui sotto e documentati in docs/costo-in-euro.md.
import { readFileSync } from 'node:fs';

const arg = (n, d) => {
  const v = process.argv.find((a) => a.startsWith(`--${n}=`));
  return v ? v.split('=').slice(1).join('=') : d;
};
const flag = (n) => process.argv.includes(`--${n}`);

const DATASET = arg('dataset', 'docs/dataset/campagna.csv');
const BASELINE = arg('baseline', 'docs/dataset/baseline-psp-2026-08-31.csv');

// Parametri di conversione, con la loro provenienza. Non sono costanti ma
// distribuzioni osservate su finestre dichiarate, rilevate da
// tools/parametri-mercato.mjs e riportate in docs/dataset/. Il costo in euro
// esce percio' come intervallo: un solo valore attribuirebbe al risultato una
// precisione che non ha, dato che il cambio varia di un fattore tre in due anni.
//
// Cambio ETH/EUR: 105 rilevazioni settimanali, 02/09/2024 - 31/08/2026.
// Prezzo del gas su Base mainnet: 168 blocchi orari, 24/08/2026 - 31/08/2026.
const GAS_P05 = Number(arg('gas-p05', '0.005'));
const GAS_MED = Number(arg('gas-mediana', '0.005'));
const GAS_P95 = Number(arg('gas-p95', '0.005015'));
const ETH_P05 = Number(arg('eth-p05', '1486.54'));
const ETH_MED = Number(arg('eth-mediana', '2244.07'));
const ETH_P95 = Number(arg('eth-p95', '3784.77'));

// --- lettura ---------------------------------------------------------------

function leggiCsv(percorso) {
  const testo = readFileSync(percorso, 'utf8').replace(/^\uFEFF/, '');
  const righe = [];
  let campo = '';
  let riga = [];
  let virgolette = false;
  for (let i = 0; i < testo.length; i++) {
    const c = testo[i];
    if (virgolette) {
      if (c === '"') {
        if (testo[i + 1] === '"') { campo += '"'; i++; } else virgolette = false;
      } else campo += c;
      continue;
    }
    if (c === '"') virgolette = true;
    else if (c === ',') { riga.push(campo); campo = ''; }
    else if (c === '\n') { riga.push(campo); righe.push(riga); riga = []; campo = ''; }
    else if (c !== '\r') campo += c;
  }
  if (campo !== '' || riga.length) { riga.push(campo); righe.push(riga); }
  const intestazione = righe.shift();
  return righe
    .filter((r) => r.length === intestazione.length)
    .map((r) => Object.fromEntries(intestazione.map((k, i) => [k, r[i]])));
}

// --- statistica ------------------------------------------------------------

const num = (v) => (v === '' || v === undefined || v === null ? null : Number(v));

function quantile(ordinati, p) {
  if (!ordinati.length) return null;
  // Interpolazione lineare fra i ranghi, come nel metodo predefinito di R e
  // numpy: su campioni piccoli la scelta del metodo sposta il p95 in modo
  // visibile, quindi va dichiarata.
  const h = (ordinati.length - 1) * p;
  const b = Math.floor(h);
  const a = Math.min(b + 1, ordinati.length - 1);
  return ordinati[b] + (h - b) * (ordinati[a] - ordinati[b]);
}

function riassumi(valori) {
  const v = valori.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const media = v.reduce((t, x) => t + x, 0) / v.length;
  return {
    n: v.length,
    media,
    mediana: quantile(v, 0.5),
    p95: quantile(v, 0.95),
    min: v[0],
    max: v[v.length - 1],
  };
}

const f = (x, d = 2) => (x === null || x === undefined ? '—' : x.toFixed(d));

// --- dati ------------------------------------------------------------------

const tutte = leggiCsv(DATASET);

// Si tengono solo le misure prese sulla rete di prova pubblica, con orologi
// coerenti e con il criterio di finalita' registrato: senza quest'ultimo la
// latenza di conferma non e' interpretabile.
// Con --conferme=N si isola un singolo criterio di finalita', che e' il modo
// corretto di analizzare un file che ne contiene piu' d'uno.
const SOLO_CONFERME = arg('conferme', null);
// Con --campagna=ID si isolano le misure di una campagna; piu' identificativi
// separati da virgola aggregano campagne dello stesso disegno (le tranche).
const SOLO_CAMPAGNA = arg('campagna', null);
const CAMPAGNE_SCELTE = SOLO_CAMPAGNA === null ? null : SOLO_CAMPAGNA.split(',');

const righe = tutte.filter((r) =>
  r.chain_id === '84532' && r.anomalia_orologio === '0' && r.conferme !== '' &&
  (SOLO_CONFERME === null || r.conferme === SOLO_CONFERME) &&
  (CAMPAGNE_SCELTE === null || CAMPAGNE_SCELTE.includes(r.campagna)));

const scartate = tutte.length - righe.length;

console.log(`Dataset: ${DATASET}`);
console.log(`Righe totali ${tutte.length}, utilizzabili ${righe.length}, scartate ${scartate}`);

const campagne = [...new Set(righe.map((r) => r.campagna || '(senza identificativo)'))];
if (CAMPAGNE_SCELTE !== null && CAMPAGNE_SCELTE.length > 1) {
  console.log(`Campagne aggregate su richiesta: ${campagne.join(', ')}`);
} else if (campagne.length > 1) {
  console.log(`\nATTENZIONE: piu' campagne nello stesso insieme (${campagne.join(', ')}).`);
  console.log('Isolarne una con --campagna=ID: disegni diversi non sono confrontabili.');
} else {
  console.log(`Campagna: ${campagne[0] ?? '(nessuna)'}`);
}

const criteri = [...new Set(righe.map((r) => r.conferme))];
if (criteri.length > 1) {
  console.log(`\nATTENZIONE: criteri di finalita' diversi nello stesso insieme (${criteri.join(', ')}).`);
  console.log("Le latenze di conferma non sono aggregabili: separare l'analisi per criterio.");
} else if (criteri.length === 1) {
  console.log(`Criterio di finalita': ${criteri[0]} conferme`);
}

const perImporto = new Map();
for (const r of righe) {
  const k = Number(r.importo);
  if (!perImporto.has(k)) perImporto.set(k, []);
  perImporto.get(k).push(r);
}
const importi = [...perImporto.keys()].sort((a, b) => a - b);

// --- 6.1 latenze -----------------------------------------------------------

console.log('\n=== 6.1 Latenze (secondi) ===');
console.log('importo    n   conferma t0->t2          riconcil. t0->t3        regolamento t0->t5');
console.log('                med    p95    max      med    p95    max      n   med    p95    max');
const latenze = [];
for (const i of importi) {
  const g = perImporto.get(i);
  const c = riassumi(g.map((r) => num(r.latenza_conferma)));
  const ri = riassumi(g.map((r) => num(r.latenza_riconcil)));
  const re = riassumi(g.map((r) => num(r.latenza_regolam)));
  latenze.push({ importo: i, c, ri, re });
  console.log(
    String(i.toFixed(2)).padStart(8),
    String(c?.n ?? 0).padStart(4),
    f(c?.mediana).padStart(7), f(c?.p95).padStart(6), f(c?.max).padStart(6), '  ',
    f(ri?.mediana).padStart(6), f(ri?.p95).padStart(6), f(ri?.max).padStart(6), '  ',
    String(re?.n ?? 0).padStart(3), f(re?.mediana).padStart(6), f(re?.p95).padStart(6), f(re?.max).padStart(6)
  );
}
const compl = { c: riassumi(righe.map((r) => num(r.latenza_conferma))), re: riassumi(righe.map((r) => num(r.latenza_regolam))) };
console.log(`\ncomplessivo  conferma: n=${compl.c?.n} med ${f(compl.c?.mediana)} p95 ${f(compl.c?.p95)}`);
console.log(`             regolam.: n=${compl.re?.n} med ${f(compl.re?.mediana)} p95 ${f(compl.re?.p95)}`);

// --- 6.2 affidabilita' -----------------------------------------------------

console.log('\n=== 6.2 Affidabilita\' ===');
const esiti = {};
for (const r of righe) esiti[r.esito] = (esiti[r.esito] ?? 0) + 1;
const successi = esiti.successo ?? 0;
console.log(`esiti: ${Object.entries(esiti).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`tasso di successo: ${(100 * successi / righe.length).toFixed(2)} % su ${righe.length} transazioni`);
const errori = {};
for (const r of righe) if (r.categoria_errore) errori[r.categoria_errore] = (errori[r.categoria_errore] ?? 0) + 1;
console.log(`categorie di errore: ${Object.keys(errori).length ? Object.entries(errori).map(([k, v]) => `${k} ${v}`).join(', ') : 'nessuna'}`);

const rimborsi = {};
for (const r of righe) if (r.stato_rimborso) rimborsi[r.stato_rimborso] = (rimborsi[r.stato_rimborso] ?? 0) + 1;
const conRimborso = Object.values(rimborsi).reduce((t, x) => t + x, 0);
console.log(`rimborsi: ${conRimborso}/${righe.length} disposti — ${Object.entries(rimborsi).map(([k, v]) => `${k} ${v}`).join(', ') || 'nessuno'}`);

// --- 6.3 costi -------------------------------------------------------------

const listino = leggiCsv(BASELINE).filter((r) => r.voce === 'commissione di transazione');
const tariffa = (fornitore, ambito) => {
  const v = listino.find((r) => r.fornitore === fornitore && r.ambito === ambito);
  return v ? { pct: Number(v.percentuale), fisso: Number(v.fisso_eur) } : null;
};
const stripe = tariffa('Stripe', 'carta standard SEE');
const paypal = tariffa('PayPal', 'PayPal e Paga a rate nazionale');
const paypalCarta = tariffa('PayPal', 'elaborazione delle carte');

console.log('\n=== 6.3 Costo per transazione (EUR) ===');
console.log(`gas su Base: p05 ${GAS_P05} | mediana ${GAS_MED} | p95 ${GAS_P95} gwei`);
console.log(`cambio ETH/EUR: p05 ${ETH_P05} | mediana ${ETH_MED} | p95 ${ETH_P95}`);
console.log('stablecoin: il costo di rete lo sostiene il cliente; l\'emittente non applica commissioni all\'esercente');
console.log('\nimporto   gas(u)   rete favor.  rete centr.  rete sfav.   Stripe   PayPal   PayPal carta');
const costi = [];
const inEuro = (gas, gwei, eur) => (gas === null ? null : gas * gwei * 1e-9 * eur);
for (const i of importi) {
  const g = perImporto.get(i);
  const gasMed = riassumi(g.map((r) => num(r.gas_usato)))?.mediana ?? null;
  const favorevole = inEuro(gasMed, GAS_P05, ETH_P05);
  const centrale = inEuro(gasMed, GAS_MED, ETH_MED);
  const sfavorevole = inEuro(gasMed, GAS_P95, ETH_P95);
  const s = stripe ? i * stripe.pct / 100 + stripe.fisso : null;
  const p = paypal ? i * paypal.pct / 100 + paypal.fisso : null;
  const pc = paypalCarta ? i * paypalCarta.pct / 100 + paypalCarta.fisso : null;
  costi.push({ importo: i, gas: gasMed, favorevole, centrale, sfavorevole, stripe: s, paypal: p, paypalCarta: pc });
  console.log(
    String(i.toFixed(2)).padStart(7),
    String(gasMed ?? '—').padStart(7),
    f(favorevole, 6).padStart(12), f(centrale, 6).padStart(12), f(sfavorevole, 6).padStart(12),
    f(s).padStart(8), f(p).padStart(8), f(pc).padStart(14)
  );
}
// Il rapporto piu' istruttivo non e' quello con la tariffa complessiva ma con
// la sola componente fissa, che il costo di rete deve battere anche
// sull'importo piu' piccolo perche' il confronto regga a ogni scala.
if (stripe && costi.length) {
  const peggiore = Math.max(...costi.map((c) => c.sfavorevole ?? 0));
  console.log(`\ncaso di rete piu' oneroso osservato: ${peggiore.toFixed(6)} EUR, pari a ${(peggiore / stripe.fisso * 100).toFixed(3)} % della sola componente fissa di Stripe (${stripe.fisso.toFixed(2)} EUR)`);
}

// --- 6.4 integrita' fiscale ------------------------------------------------

console.log('\n=== 6.4 Integrita\' fiscale ===');
const conFattura = righe.filter((r) => r.fattura_uuid);
const accettate = righe.filter((r) => r.fattura_accettata === '1');
const statiFattura = {};
for (const r of righe) if (r.fattura_stato) statiFattura[r.fattura_stato] = (statiFattura[r.fattura_stato] ?? 0) + 1;
console.log(`fatture trasmesse: ${conFattura.length}/${righe.length}`);
console.log(`stati: ${Object.entries(statiFattura).map(([k, v]) => `${k} ${v}`).join(', ') || 'nessuno'}`);
console.log(`consegnate o messe a disposizione: ${accettate.length}`);
if (conFattura.length && !accettate.length) {
  console.log("Nessuna ricevuta: il Sistema di Interscambio dichiara tempi fino a cinque giorni.");
  console.log('Rieseguire l\'esportazione a distanza — vedi docs/sdi-notifiche.md.');
}

// --- tabelle LaTeX ---------------------------------------------------------

if (flag('latex')) {
  console.log('\n%%% --- 6.1 latenze ---');
  console.log('\\begin{tabular}{rrrrrrr}\n\\toprule');
  console.log('Importo & $n$ & \\multicolumn{2}{c}{Conferma} & \\multicolumn{2}{c}{Regolamento} \\\\');
  console.log('(EUR) & & mediana & p95 & mediana & p95 \\\\\n\\midrule');
  for (const l of latenze) {
    console.log(`${l.importo.toFixed(2)} & ${l.c?.n ?? 0} & ${f(l.c?.mediana)} & ${f(l.c?.p95)} & ${f(l.re?.mediana)} & ${f(l.re?.p95)} \\\\`);
  }
  console.log('\\bottomrule\n\\end{tabular}');

  console.log('\n%%% --- 6.3 costi ---');
  console.log('\\begin{tabular}{rrrrrr}\n\\toprule');
  console.log('Importo & \\multicolumn{3}{c}{Costo di rete} & Stripe & PayPal \\\\');
  console.log(' & favorevole & centrale & sfavorevole & & \\\\\n\\midrule');
  for (const c of costi) {
    console.log(`${c.importo.toFixed(2)} & ${f(c.favorevole, 6)} & ${f(c.centrale, 6)} & ${f(c.sfavorevole, 6)} & ${f(c.stripe)} & ${f(c.paypal)} \\\\`);
  }
  console.log('\\bottomrule\n\\end{tabular}');
}
