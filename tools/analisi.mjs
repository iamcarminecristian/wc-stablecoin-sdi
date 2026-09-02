// Riduce il dataset sperimentale alle tabelle del Capitolo 6.
//
// L'analisi vive qui e non in un foglio di calcolo perche' deve essere
// rieseguibile: cambiare il dataset e rilanciare deve bastare a rifare tutte
// le tabelle, senza passaggi manuali che nessuno puo' ripercorrere.
//
// Uso:
//   node tools/analisi.mjs --dataset=docs/dataset/campagna.csv
//   node tools/analisi.mjs --dataset=... --latex   (tabelle pronte da includere, a schermo)
//   node tools/analisi.mjs --dataset=... --ricevute=docs/dataset/ricevute-2026-09-02.csv
//   node tools/analisi.mjs --dataset=... --latex=/tmp/tab --json=/tmp/analisi.json
//
// Il costo in euro NON viene ricavato dal prezzo del gas della rete di prova,
// che non ha domanda di blocco: si usano i parametri osservati sulla rete
// principale, dichiarati qui sotto e documentati in docs/costo-in-euro.md.
//
// Il dataset v2 aggiunge colonne rispetto a v1 (t_invio, blocco, l1_fee_wei,
// stato_riscatto al posto di stato_rimborso, le latenze scomposte lat_*...):
// lo script tratta le colonne mancanti come vuote e accetta i sinonimi, cosi'
// funziona senza modifiche sui due dataset. Le funzioni statistiche (Mann-
// Whitney, Kruskal-Wallis, bootstrap) vivono in tools/statistica.mjs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { mannWhitneyU, kruskalWallis, bootstrapMedianaIC } from './statistica.mjs';

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

// Opzioni aggiuntive: ricevute di rete, sezione 6.4 (costi propri e soglia
// di convenienza), gas per modalita' e uscite (LaTeX su file, JSON).
const RICEVUTE = arg('ricevute', null);
const FLUSSO_LATEX = flag('flusso-latex');
const SDI_PER_FATTURA = Number(arg('sdi-per-fattura', '0.07'));
const FISSI_MESE = Number(arg('fissi-mese', '4.5'));
const RPC_MESE = Number(arg('rpc-mese', '0'));
const SCONTRINI = arg('scontrini', '37,114,130,210').split(',').map(Number);
const PAYPAL_CARTE = arg('paypal-carte', null);
const GAS_FILES = arg('gas', null);
const LATEX_DIR = arg('latex', null);
const JSON_OUT = arg('json', null);

// --- lettura ---------------------------------------------------------------

function leggiCsv(percorso) {
  const testo = readFileSync(percorso, 'utf8').replace(/^﻿/, '');
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

// --- statistica descrittiva --------------------------------------------

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

const f = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d));

// Formattazione italiana (virgola decimale) per la sezione dei test
// statistici, dove il task la richiede esplicitamente (es. «< 0,001»).
const fVirgola = (x, d = 3) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d).replace('.', ','));
const fPValore = (p) => {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—';
  if (p < 0.001) return '< 0,001';
  return fVirgola(p, 3);
};

// Formattazione LaTeX: virgola decimale e \, come separatore delle migliaia.
function fLatex(x, d = 2) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '---';
  const negativo = x < 0;
  const fisso = Math.abs(x).toFixed(d);
  const [intero, decimale] = fisso.split('.');
  const interoSeparato = intero.replace(/\B(?=(\d{3})+(?!\d))/g, '\\,');
  const risultato = decimale ? `${interoSeparato},${decimale}` : interoSeparato;
  return negativo ? `-${risultato}` : risultato;
}
function fLatexP(p) {
  if (p === null || p === undefined || !Number.isFinite(p)) return '---';
  if (p < 0.001) return '$<$ 0,001';
  return fVirgola(p, 3);
}
// Escaping minimo per testo libero (nomi di campagna, stati, modalita') che
// finisce dentro una tabella LaTeX: senza, un underscore nei dati spacca la
// compilazione.
function escLatex(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/([_%&#{}])/g, '\\$1');
}

// --- latenze: colonne dirette con ricalcolo dai marcatori t* ---------------

// Se la colonna derivata e' vuota (dataset v1, o riga v2 non popolata), si
// ricalcola dalla differenza dei marcatori t0-t5: e' quanto chiede il punto
// 3 del task ("calcola le differenze dai marcatori t* quando le colonne
// derivate sono vuote").
function diffT(r, campoA, campoB) {
  const a = num(r[campoA]);
  const b = num(r[campoB]);
  return a === null || b === null ? null : b - a;
}
function derivaLatenza(r, campoDerivato, campoA, campoB) {
  const diretto = num(r[campoDerivato]);
  return diretto !== null ? diretto : diffT(r, campoA, campoB);
}
const latenzaConferma = (r) => derivaLatenza(r, 'latenza_conferma', 't0', 't2');
const latenzaRiconcil = (r) => derivaLatenza(r, 'latenza_riconcil', 't0', 't3');
const latenzaRegolam = (r) => derivaLatenza(r, 'latenza_regolam', 't0', 't5');

// --- costo di rete: esecuzione L2 e pubblicazione L1 -----------------------

// L2 = gas_usato * prezzo del gas pagato (dalla colonna del dataset, con
// ripiego sul prezzo effettivo di ricevuta se quella manca). L1 = tariffa di
// pubblicazione dati sul livello sottostante, gia' un importo assoluto in
// wei (non un prezzo da moltiplicare), letta dalla ricevuta.
function costoL2Wei(r) {
  const gas = num(r.gas_usato);
  const prezzo = num(r.gas_prezzo_wei) ?? num(r.effective_gas_price_wei);
  return gas === null || prezzo === null ? null : gas * prezzo;
}
function costoL1Wei(r) {
  return num(r.l1_fee_wei);
}
function rapportoL1L2(r) {
  const l2 = costoL2Wei(r);
  const l1 = costoL1Wei(r);
  return l2 === null || l1 === null || l2 === 0 ? null : l1 / l2;
}
function quotaPriorityFee(r) {
  const eff = num(r.effective_gas_price_wei);
  const pri = num(r.max_priority_fee_wei);
  return eff === null || pri === null || eff === 0 ? null : pri / eff;
}
// Conversione in euro: L2 si scala per i tre scenari di prezzo del gas
// (favorevole/centrale/sfavorevole, osservati su mainnet perche' la rete di
// prova non ha domanda di blocco). L1 e' gia' un importo assoluto osservato:
// si converte solo con il tasso di cambio, senza un'ulteriore ipotesi di
// prezzo. La sensibilita' alla congestione (L1 x10, x100) e' un secondo
// scenario esplicito, dichiarato separatamente, non una previsione.
const inEuro = (gasUnita, gwei, eur) => (gasUnita === null ? null : gasUnita * gwei * 1e-9 * eur);
const inEuroDiretta = (wei, eur) => (wei === null ? null : wei * 1e-18 * eur);
function costoEuroCentrale(r) {
  const l2 = inEuro(num(r.gas_usato), GAS_MED, ETH_MED);
  const l1wei = costoL1Wei(r);
  const l1 = l1wei !== null ? inEuroDiretta(l1wei, ETH_MED) : null;
  if (l2 === null && l1 === null) return null;
  return (l2 ?? 0) + (l1 ?? 0);
}

// --- conteggi generici e integrita' fiscale ---------------------------

function conteggiaOccorrenze(elenco, campo) {
  const m = {};
  for (const r of elenco) if (r[campo]) m[r[campo]] = (m[r[campo]] ?? 0) + 1;
  return m;
}
function trovaDuplicatiFattura(elenco) {
  const perNumero = new Map();
  for (const r of elenco) {
    if (!r.fattura_numero) continue;
    if (!perNumero.has(r.fattura_numero)) perNumero.set(r.fattura_numero, []);
    perNumero.get(r.fattura_numero).push(r.order_id);
  }
  return [...perNumero.entries()].filter(([, ordini]) => ordini.length > 1);
}
function buchiNumerazione(elenco) {
  const numeri = elenco.map((r) => Number(r.fattura_numero)).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!numeri.length) return { min: null, max: null, attesi: 0, presenti: 0, buchi: [] };
  const presenti = new Set(numeri);
  const min = numeri[0];
  const max = numeri[numeri.length - 1];
  const buchi = [];
  for (let n = min; n <= max; n++) if (!presenti.has(n)) buchi.push(n);
  return { min, max, attesi: max - min + 1, presenti: presenti.size, buchi };
}

// --- ricevute: unione per tx_hash -------------------------------------

// Riempie solo le colonne che mancano (le righe che le hanno gia', v2, non
// vengono toccate). Il confronto e' case-insensitive perche' un tx_hash puo'
// arrivare in maiuscolo da un'origine e in minuscolo da un'altra.
function fondiRicevute(elenco, percorso) {
  const ricevute = leggiCsv(percorso);
  const mappa = new Map();
  for (const r of ricevute) if (r.tx_hash) mappa.set(r.tx_hash.toLowerCase(), r);
  let integrate = 0;
  const risultato = elenco.map((r) => {
    if (!r.tx_hash) return r;
    const rc = mappa.get(r.tx_hash.toLowerCase());
    if (!rc) return r;
    const aggiornato = { ...r };
    let cambiato = false;
    for (const campo of ['l1_fee_wei', 'effective_gas_price_wei', 'max_priority_fee_wei', 'blocco']) {
      const attuale = aggiornato[campo];
      const nuovo = rc[campo];
      if ((attuale === undefined || attuale === '') && nuovo !== undefined && nuovo !== '') {
        aggiornato[campo] = nuovo;
        cambiato = true;
      }
    }
    if (cambiato) integrate++;
    return aggiornato;
  });
  return { righe: risultato, integrate, totaliRicevute: ricevute.length };
}

// --- dati ------------------------------------------------------------------

const grezzo = leggiCsv(DATASET);
const fusioneRicevute = RICEVUTE ? fondiRicevute(grezzo, RICEVUTE) : null;
const tutte = fusioneRicevute ? fusioneRicevute.righe : grezzo;

console.log(`Dataset: ${DATASET}`);
if (fusioneRicevute) {
  console.log(`Ricevute unite da ${RICEVUTE}: ${fusioneRicevute.integrate} righe integrate su ${fusioneRicevute.totaliRicevute} ricevute lette`);
}

// Con --conferme=N si isola un singolo criterio di finalita', che e' il modo
// corretto di analizzare un file che ne contiene piu' d'uno.
const SOLO_CONFERME = arg('conferme', null);
// Con --campagna=ID si isolano le misure di una campagna; piu' identificativi
// separati da virgola aggregano campagne dello stesso disegno (le tranche).
const SOLO_CAMPAGNA = arg('campagna', null);
const CAMPAGNE_SCELTE = SOLO_CAMPAGNA === null ? null : SOLO_CAMPAGNA.split(',');

// --- flusso di esclusione ---------------------------------------------

// Si tengono solo le misure prese sulla rete di prova pubblica (chain_id
// 84532), con orologi coerenti e con il criterio di finalita' registrato
// (criterio o conferme: la v2 usa criterio='safe'/'finalized' con conferme
// eventualmente vuoto, la v1 usa solo conferme). La catena di filtri va
// sempre stampata, coi conteggi ad ogni passo: e' il primo requisito del
// task e la base della riproducibilita' dei numeri a valle.
const stepTotale = tutte.length;
const stepChain = tutte.filter((r) => r.chain_id === '84532');
const scartatiChainRighe = tutte.filter((r) => r.chain_id !== '84532');
const scartatiAnvil = scartatiChainRighe.filter((r) => r.chain_id === '31337').length;
const scartatiVuoto = scartatiChainRighe.filter((r) => r.chain_id === '').length;
const scartatiAltre = scartatiChainRighe.length - scartatiAnvil - scartatiVuoto;

const stepAnomalia = stepChain.filter((r) => r.anomalia_orologio !== '1');
const scartatiAnomalia = stepChain.length - stepAnomalia.length;

const stepCriterio = stepAnomalia.filter((r) => r.conferme !== '' || r.criterio !== '');
const scartatiCriterio = stepAnomalia.length - stepCriterio.length;

const stepCampagna = stepCriterio.filter((r) => CAMPAGNE_SCELTE === null || CAMPAGNE_SCELTE.includes(r.campagna));
const scartatiCampagna = stepCriterio.length - stepCampagna.length;

let righe = stepCampagna;
let scartatiSoloConferme = 0;
if (SOLO_CONFERME !== null) {
  const prima = righe.length;
  righe = righe.filter((r) => r.conferme === SOLO_CONFERME);
  scartatiSoloConferme = prima - righe.length;
}

const flussoRisultato = {
  totale: stepTotale,
  dettaglioChain: { anvil: scartatiAnvil, altre: scartatiAltre, vuoto: scartatiVuoto },
  passi: [
    { nome: 'Righe totali', scartate: null, rimanenti: stepTotale },
    { nome: 'chain_id = 84532', scartate: scartatiChainRighe.length, rimanenti: stepChain.length },
    { nome: "anomalia_orologio != 1", scartate: scartatiAnomalia, rimanenti: stepAnomalia.length },
    { nome: 'con criterio o conferme', scartate: scartatiCriterio, rimanenti: stepCriterio.length },
    {
      nome: CAMPAGNE_SCELTE ? `nelle campagne scelte (${CAMPAGNE_SCELTE.join(', ')})` : 'nessun filtro di campagna',
      scartate: scartatiCampagna,
      rimanenti: stepCampagna.length,
    },
  ],
  utilizzabili: righe.length,
};
if (SOLO_CONFERME !== null) {
  flussoRisultato.passi.push({ nome: `criterio isolato --conferme=${SOLO_CONFERME}`, scartate: scartatiSoloConferme, rimanenti: righe.length });
}

console.log('\n=== Flusso di esclusione ===');
console.log(`Righe totali: ${stepTotale}`);
console.log(`  - senza chain_id 84532: ${scartatiChainRighe.length}  (anvil 31337: ${scartatiAnvil}, altre: ${scartatiAltre}, vuoto: ${scartatiVuoto})  -> rimangono ${stepChain.length}`);
console.log(`  - con anomalia_orologio = 1: ${scartatiAnomalia}  -> rimangono ${stepAnomalia.length}`);
console.log(`  - senza criterio/conferme: ${scartatiCriterio}  -> rimangono ${stepCriterio.length}`);
console.log(`  - non nelle campagne scelte: ${scartatiCampagna}  -> rimangono ${stepCampagna.length}`);
if (SOLO_CONFERME !== null) {
  console.log(`  - criterio diverso da --conferme=${SOLO_CONFERME}: ${scartatiSoloConferme}  -> rimangono ${righe.length}`);
}
console.log(`Utilizzabili: ${righe.length}`);

if (FLUSSO_LATEX) {
  console.log('\n%%% --- flusso di esclusione ---');
  console.log(testoLatexFlusso());
}

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
  const c = riassumi(g.map(latenzaConferma));
  const ri = riassumi(g.map(latenzaRiconcil));
  const re = riassumi(g.map(latenzaRegolam));
  latenze.push({ importo: i, c, ri, re });
  console.log(
    String(i.toFixed(2)).padStart(8),
    String(c?.n ?? 0).padStart(4),
    f(c?.mediana).padStart(7), f(c?.p95).padStart(6), f(c?.max).padStart(6), '  ',
    f(ri?.mediana).padStart(6), f(ri?.p95).padStart(6), f(ri?.max).padStart(6), '  ',
    String(re?.n ?? 0).padStart(3), f(re?.mediana).padStart(6), f(re?.p95).padStart(6), f(re?.max).padStart(6)
  );
}
const compl = { c: riassumi(righe.map(latenzaConferma)), re: riassumi(righe.map(latenzaRegolam)) };
console.log(`\ncomplessivo  conferma: n=${compl.c?.n} med ${f(compl.c?.mediana)} p95 ${f(compl.c?.p95)}`);
console.log(`             regolam.: n=${compl.re?.n} med ${f(compl.re?.mediana)} p95 ${f(compl.re?.p95)}`);

// --- 6.1b scomposizione delle latenze --------------------------------------

console.log('\n=== 6.1b Scomposizione delle latenze (secondi) ===');
const presenzaTInvio = righe.some((r) => r.t_invio !== undefined && r.t_invio !== '');
const scomposizioneRighe = [];
if (presenzaTInvio) {
  scomposizioneRighe.push({ nome: 'attesa invio (t_invio - t0)', dati: righe.map((r) => derivaLatenza(r, 'lat_attesa_invio', 't0', 't_invio')) });
  scomposizioneRighe.push({ nome: 'inclusione (t1 - t_invio)', dati: righe.map((r) => derivaLatenza(r, 'lat_inclusione', 't_invio', 't1')) });
} else {
  console.log("t_invio assente in questo dataset (v1): si mostra t1 - t0 come 'coda + inclusione', dichiarato.");
  scomposizioneRighe.push({ nome: 'coda + inclusione (t1 - t0)', dati: righe.map((r) => diffT(r, 't0', 't1')) });
}
scomposizioneRighe.push({ nome: 'profondita (t2 - t1)', dati: righe.map((r) => derivaLatenza(r, 'lat_profondita', 't1', 't2')) });
scomposizioneRighe.push({ nome: 'notifica (t3 - t2)', dati: righe.map((r) => derivaLatenza(r, 'lat_notifica', 't2', 't3')) });
scomposizioneRighe.push({ nome: 'riscatto (t5 - t4)', dati: righe.map((r) => derivaLatenza(r, 'lat_riscatto', 't4', 't5')) });
scomposizioneRighe.push({ nome: 'totale conferma (t2 - t0)', dati: righe.map(latenzaConferma) });
scomposizioneRighe.push({ nome: 'totale riconciliazione (t3 - t0)', dati: righe.map(latenzaRiconcil) });
scomposizioneRighe.push({ nome: 'totale regolamento (t5 - t0)', dati: righe.map(latenzaRegolam) });

console.log('componente                                  n     mediana     p95      min      max');
for (const riga of scomposizioneRighe) {
  const r = riassumi(riga.dati);
  console.log(
    riga.nome.padEnd(42),
    String(r?.n ?? 0).padStart(5),
    f(r?.mediana).padStart(11), f(r?.p95).padStart(8), f(r?.min).padStart(8), f(r?.max).padStart(8)
  );
}

// --- 6.2 affidabilita' -----------------------------------------------------

console.log('\n=== 6.2 Affidabilita\' ===');
const esiti = {};
for (const r of righe) esiti[r.esito] = (esiti[r.esito] ?? 0) + 1;
const successi = esiti.successo ?? 0;
console.log(`esiti: ${Object.entries(esiti).map(([k, v]) => `${k} ${v}`).join(', ')}`);
const tassoSuccesso = (100 * successi) / righe.length;
console.log(`tasso di successo: ${tassoSuccesso.toFixed(2)} % su ${righe.length} transazioni`);
const errori = conteggiaOccorrenze(righe, 'categoria_errore');
console.log(`categorie di errore: ${Object.keys(errori).length ? Object.entries(errori).map(([k, v]) => `${k} ${v}`).join(', ') : 'nessuna'}`);

// stato_riscatto (v2) e stato_rimborso (v1) sono lo stesso concetto: l'esito
// del redeem verso EUR via Monerium, non il rimborso WooCommerce dell'ordine.
const statoRiscatto = (r) => r.stato_riscatto || r.stato_rimborso || '';
const riscatti = {};
for (const r of righe) {
  const s = statoRiscatto(r);
  if (s) riscatti[s] = (riscatti[s] ?? 0) + 1;
}
const conRiscatto = Object.values(riscatti).reduce((t, x) => t + x, 0);
console.log(`riscatti (redeem verso EUR): ${conRiscatto}/${righe.length} disposti — ${Object.entries(riscatti).map(([k, v]) => `${k} ${v}`).join(', ') || 'nessuno'}`);

const affidabilitaRisultato = { esiti, tassoSuccesso, errori, riscatti };

// --- 6.3 costi ---------------------------------------------------------

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
console.log('la conversione in euro e\' ora applicata al costo totale nativo (esecuzione L2 + pubblicazione L1)');

const rapportiL1L2 = righe.map(rapportoL1L2).filter((x) => x !== null);
const quotePriority = righe.map(quotaPriorityFee).filter((x) => x !== null);
const riassuntoRapportoL1L2 = riassumi(rapportiL1L2);
const riassuntoQuotaPriority = riassumi(quotePriority);
if (riassuntoRapportoL1L2) {
  console.log(`\nrapporto L1/L2 del costo (n=${riassuntoRapportoL1L2.n}): mediana ${f(riassuntoRapportoL1L2.mediana, 4)}  p95 ${f(riassuntoRapportoL1L2.p95, 4)}`);
} else {
  console.log('\nrapporto L1/L2: non disponibile (nessuna ricevuta unita con --ricevute=)');
}
if (riassuntoQuotaPriority) {
  console.log(`quota della priority fee sul prezzo effettivo (n=${riassuntoQuotaPriority.n}): mediana ${(riassuntoQuotaPriority.mediana * 100).toFixed(2)} %  p95 ${(riassuntoQuotaPriority.p95 * 100).toFixed(2)} %`);
} else {
  console.log('quota della priority fee: non disponibile (nessuna ricevuta unita con --ricevute=)');
}

console.log('\nimporto   gas(u)   L2(EUR,c)   L1(EUR,c)   rete favor.  rete centr.  rete sfav.   Stripe   PayPal   PayPal carta');
const costi = [];
const inEuroSensibilita = inEuro; // alias esplicito: qui GAS_* varia, ETH_* varia
for (const i of importi) {
  const g = perImporto.get(i);
  const gasMed = riassumi(g.map((r) => num(r.gas_usato)))?.mediana ?? null;
  const l1MedWei = riassumi(g.map(costoL1Wei).filter((x) => x !== null))?.mediana ?? null;

  const l2Favorevole = inEuroSensibilita(gasMed, GAS_P05, ETH_P05);
  const l2Centrale = inEuroSensibilita(gasMed, GAS_MED, ETH_MED);
  const l2Sfavorevole = inEuroSensibilita(gasMed, GAS_P95, ETH_P95);
  const l1Favorevole = l1MedWei !== null ? inEuroDiretta(l1MedWei, ETH_P05) : null;
  const l1Centrale = l1MedWei !== null ? inEuroDiretta(l1MedWei, ETH_MED) : null;
  const l1Sfavorevole = l1MedWei !== null ? inEuroDiretta(l1MedWei, ETH_P95) : null;

  const favorevole = l2Favorevole !== null ? l2Favorevole + (l1Favorevole ?? 0) : null;
  const centrale = l2Centrale !== null ? l2Centrale + (l1Centrale ?? 0) : null;
  const sfavorevole = l2Sfavorevole !== null ? l2Sfavorevole + (l1Sfavorevole ?? 0) : null;

  const s = stripe ? (i * stripe.pct) / 100 + stripe.fisso : null;
  const p = paypal ? (i * paypal.pct) / 100 + paypal.fisso : null;
  const pc = paypalCarta ? (i * paypalCarta.pct) / 100 + paypalCarta.fisso : null;

  const congestioneX10 = l1MedWei !== null ? l2Centrale + inEuroDiretta(l1MedWei * 10, ETH_MED) : null;
  const congestioneX100 = l1MedWei !== null ? l2Centrale + inEuroDiretta(l1MedWei * 100, ETH_MED) : null;

  costi.push({
    importo: i, gas: gasMed, gasUsatoMediana: gasMed, l1MedWei,
    l2Favorevole, l2Centrale, l2Sfavorevole, l1Favorevole, l1Centrale, l1Sfavorevole,
    favorevole, centrale, sfavorevole, stripe: s, paypal: p, paypalCarta: pc,
    congestioneX10, congestioneX100,
  });
  console.log(
    String(i.toFixed(2)).padStart(7),
    String(gasMed ?? '—').padStart(7),
    f(l2Centrale, 6).padStart(11),
    (l1Centrale === null ? '—' : f(l1Centrale, 6)).padStart(11),
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

console.log("\nsensibilita': costo totale (EUR, scenario centrale) se la componente L1 fosse moltiplicata per 10 o per 100");
console.log("(congestione della rete sottostante: scenario dichiarato, non una previsione)");
console.log('importo   totale centrale   L1 x10          L1 x100');
for (const c of costi) {
  console.log(
    String(c.importo.toFixed(2)).padStart(7),
    f(c.centrale, 6).padStart(16),
    (c.congestioneX10 === null ? '—' : f(c.congestioneX10, 6)).padStart(16),
    (c.congestioneX100 === null ? '—' : f(c.congestioneX100, 6)).padStart(16)
  );
}

// --- 6.3b test statistici ---------------------------------------------

console.log('\n=== 6.3b Test statistici ===');
const testRisultati = {};

const gruppiPerImporto = importi.map((i) => perImporto.get(i).map(latenzaConferma).filter((x) => x !== null));
testRisultati.kwImporti = kruskalWallis(gruppiPerImporto);
if (testRisultati.kwImporti) {
  console.log(`Kruskal-Wallis, latenza di conferma fra importi: H=${fVirgola(testRisultati.kwImporti.H)} df=${testRisultati.kwImporti.df} p=${fPValore(testRisultati.kwImporti.p)}`);
} else {
  console.log('Kruskal-Wallis fra importi: non calcolabile (meno di due gruppi con dati)');
}

if (CAMPAGNE_SCELTE && CAMPAGNE_SCELTE.length > 1) {
  const gruppiCampagne = CAMPAGNE_SCELTE.map((c) => righe.filter((r) => r.campagna === c).map(latenzaConferma).filter((x) => x !== null));
  testRisultati.kwCampagne = kruskalWallis(gruppiCampagne);
  if (testRisultati.kwCampagne) {
    console.log(`Kruskal-Wallis, latenza di conferma fra campagne (${CAMPAGNE_SCELTE.join(', ')}): H=${fVirgola(testRisultati.kwCampagne.H)} df=${testRisultati.kwCampagne.df} p=${fPValore(testRisultati.kwCampagne.p)}`);
  } else {
    console.log('Kruskal-Wallis fra campagne: non calcolabile (meno di due gruppi con dati)');
  }
} else {
  testRisultati.kwCampagne = null;
  console.log('Kruskal-Wallis fra campagne: non richiesto (serve --campagna=a,b,c con almeno due campagne)');
}

const fasciaBassa = righe.filter((r) => Number(r.importo) <= 100).map(latenzaConferma).filter((x) => x !== null);
const fasciaAlta = righe.filter((r) => Number(r.importo) > 100).map(latenzaConferma).filter((x) => x !== null);
testRisultati.mwFasce = mannWhitneyU(fasciaBassa, fasciaAlta);
if (testRisultati.mwFasce) {
  console.log(`Mann-Whitney, latenza di conferma, importo <=100 EUR (n=${fasciaBassa.length}) vs >100 EUR (n=${fasciaAlta.length}): U=${fVirgola(testRisultati.mwFasce.U, 1)} z=${fVirgola(testRisultati.mwFasce.z)} p=${fPValore(testRisultati.mwFasce.p)}`);
} else {
  console.log("Mann-Whitney fra fasce di importo: non calcolabile (una fascia e' vuota)");
}

const bootstrapConferma = bootstrapMedianaIC(righe.map(latenzaConferma).filter((x) => x !== null));
testRisultati.bootstrapConferma = bootstrapConferma;
if (bootstrapConferma) {
  console.log(`IC bootstrap 95% mediana latenza di conferma: ${fVirgola(bootstrapConferma.mediana)} s [${fVirgola(bootstrapConferma.ic95Basso)}, ${fVirgola(bootstrapConferma.ic95Alto)}]  (n=${bootstrapConferma.n}, ${bootstrapConferma.ricampionamenti} ricampionamenti, seme ${bootstrapConferma.seme})`);
}

const costiPerRiga = righe.map(costoEuroCentrale).filter((x) => x !== null && Number.isFinite(x));
const bootstrapCosto = bootstrapMedianaIC(costiPerRiga);
testRisultati.bootstrapCosto = bootstrapCosto;
if (bootstrapCosto) {
  console.log(`IC bootstrap 95% mediana costo di rete (scenario centrale, EUR): ${fVirgola(bootstrapCosto.mediana, 6)} [${fVirgola(bootstrapCosto.ic95Basso, 6)}, ${fVirgola(bootstrapCosto.ic95Alto, 6)}]  (n=${bootstrapCosto.n})`);
}

// --- 6.4 costi propri e soglia di convenienza -------------------------

console.log('\n=== 6.4 Costi propri e soglia di convenienza ===');
const gasMedGlobale = riassumi(righe.map((r) => num(r.gas_usato)))?.mediana ?? null;
const l1MedGlobaleWei = riassumi(righe.map(costoL1Wei).filter((x) => x !== null))?.mediana ?? null;
const costoReteEuroCentrale = (inEuro(gasMedGlobale, GAS_MED, ETH_MED) ?? 0) + (l1MedGlobaleWei !== null ? inEuroDiretta(l1MedGlobaleWei, ETH_MED) : 0);
const costoVariabileBinario = costoReteEuroCentrale + SDI_PER_FATTURA;
const costiFissiMensili = FISSI_MESE + RPC_MESE;
console.log(`costo di rete (mediana, scenario centrale): ${f(costoReteEuroCentrale, 6)} EUR${l1MedGlobaleWei === null ? ' (nessuna ricevuta L1 unita: solo componente L2)' : ''}`);
console.log(`c = costo variabile per transazione del binario (rete + SdI): ${f(costoVariabileBinario, 6)} EUR  (SdI/fattura ${f(SDI_PER_FATTURA, 2)} EUR)`);
console.log(`F = costi fissi mensili (server + RPC): ${f(costiFissiMensili, 2)} EUR  (server ${f(FISSI_MESE, 2)}, RPC ${f(RPC_MESE, 2)})`);

let paypalCarteFallback = false;
let paypalCarteEffettivo = paypalCarta;
if (!paypalCarteEffettivo && PAYPAL_CARTE) {
  const [pct, fisso] = PAYPAL_CARTE.split(',').map(Number);
  paypalCarteEffettivo = { pct, fisso };
  paypalCarteFallback = true;
  console.log(`PayPal carte: assente nel csv baseline, uso il parametro --paypal-carte=${PAYPAL_CARTE} (${pct}% + ${fisso} EUR), dichiarato`);
}

const baselinesSoglia = [
  stripe ? { nome: 'Stripe', tariffa: stripe } : null,
  paypal ? { nome: 'PayPal', tariffa: paypal } : null,
  paypalCarteEffettivo ? { nome: 'PayPal carte', tariffa: paypalCarteEffettivo } : null,
].filter(Boolean);

const sogliaRisultati = { F: costiFissiMensili, c: costoVariabileBinario, paypalCarteFallback, righe: [] };
console.log('\nbaseline          scontrino(EUR)   s(EUR)     c(EUR)     N*(transazioni/mese)');
for (const b of baselinesSoglia) {
  for (const scontrino of SCONTRINI) {
    const s = (scontrino * b.tariffa.pct) / 100 + b.tariffa.fisso;
    const differenza = s - costoVariabileBinario;
    const nStar = differenza > 0 ? costiFissiMensili / differenza : null;
    sogliaRisultati.righe.push({ baseline: b.nome, scontrino, s, c: costoVariabileBinario, nStar });
    console.log(
      b.nome.padEnd(16),
      String(scontrino.toFixed(2)).padStart(10),
      f(s, 4).padStart(10),
      f(costoVariabileBinario, 4).padStart(10),
      (nStar === null ? 'non conveniente' : f(nStar, 1)).padStart(20)
    );
  }
}

// --- 6.5 integrita' fiscale ---------------------------------------------

console.log('\n=== 6.5 Integrita\' fiscale ===');
const conFattura = righe.filter((r) => r.fattura_uuid);
const accettate = righe.filter((r) => r.fattura_accettata === '1');
const statiFattura = conteggiaOccorrenze(righe, 'fattura_stato');
console.log(`fatture trasmesse: ${conFattura.length}/${righe.length}`);
console.log(`stati: ${Object.entries(statiFattura).map(([k, v]) => `${k} ${v}`).join(', ') || 'nessuno'}`);
console.log(`consegnate o messe a disposizione: ${accettate.length}`);
if (conFattura.length && !accettate.length) {
  console.log("Nessuna ricevuta: il Sistema di Interscambio dichiara tempi fino a cinque giorni.");
  console.log('Rieseguire l\'esportazione a distanza — vedi docs/sdi-notifiche.md.');
}

const duplicatiAnalizzati = trovaDuplicatiFattura(righe);
const duplicatiFile = trovaDuplicatiFattura(tutte);
console.log(`\nnumeri di fattura duplicati nell'insieme analizzato: ${duplicatiAnalizzati.length}`);
for (const [numero, ordini] of duplicatiAnalizzati) console.log(`  ${numero}: ordini ${ordini.join(', ')}`);
console.log(`numeri di fattura duplicati nell'intero file: ${duplicatiFile.length}`);

const buchi = buchiNumerazione(tutte);
console.log(`\nserie di numerazione (intero file): da ${buchi.min ?? '—'} a ${buchi.max ?? '—'}, attesi ${buchi.attesi}, presenti ${buchi.presenti}, buchi ${buchi.buchi.length}`);
if (buchi.buchi.length) {
  const elenco = buchi.buchi.slice(0, 30).join(', ');
  console.log(`  numeri mancanti: ${elenco}${buchi.buchi.length > 30 ? ', ...' : ''}`);
}

const tentativi = conteggiaOccorrenze(righe, 'fattura_tentativi');
const verifiche = conteggiaOccorrenze(righe, 'sdi_verifiche');
console.log(`\nfattura_tentativi: ${Object.entries(tentativi).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `${k}:${v}`).join(', ') || 'nessuno'}`);
console.log(`sdi_verifiche: ${Object.entries(verifiche).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `${k}:${v}`).join(', ') || 'nessuno'}`);

const nonPiuSent = righe.filter((r) => r.fattura_stato && r.fattura_stato !== 'sent');
const distribNonSent = conteggiaOccorrenze(nonPiuSent, 'fattura_stato');
console.log(`\nfatture il cui stato e' mutato da 'sent': ${nonPiuSent.length}/${conFattura.length}`);
if (nonPiuSent.length) console.log(`  distribuzione: ${Object.entries(distribNonSent).map(([k, v]) => `${k} ${v}`).join(', ')}`);

const fiscaleRisultati = {
  conFattura: conFattura.length,
  accettate: accettate.length,
  statiFattura,
  duplicatiAnalizzati: duplicatiAnalizzati.length,
  duplicatiFile: duplicatiFile.length,
  buchi,
  tentativi,
  verifiche,
  mutateDaSent: nonPiuSent.length,
  distribuzioneMutateDaSent: distribNonSent,
};

// --- 6.6 gas per modalita' (facoltativo, richiede --gas=<csv,csv,...>) -----

let gasModalitaRisultati = null;
if (GAS_FILES) {
  const percorsiGas = GAS_FILES.split(',').map((s) => s.trim()).filter(Boolean);
  let righeGas = [];
  for (const p of percorsiGas) righeGas = righeGas.concat(leggiCsv(p));
  console.log('\n=== 6.6 Gas per modalita\' ===');
  if (!righeGas.length) {
    console.log('nessuna riga letta dai file indicati con --gas=');
  } else {
    const perModalita = new Map();
    for (const r of righeGas) {
      const m = r.modalita || '(vuoto)';
      if (!perModalita.has(m)) perModalita.set(m, []);
      perModalita.get(m).push(r);
    }
    gasModalitaRisultati = [];
    for (const [modalita, righeModalita] of perModalita) {
      // riga di approve condivisa per lotto: order_id vuoto ed esito 'approve-lotto'
      const righeLotto = righeModalita.filter((r) => r.order_id === '' && r.esito === 'approve-lotto');
      const righePagamento = righeModalita.filter((r) => !(r.order_id === '' && r.esito === 'approve-lotto'));
      const gasPay = riassumi(righePagamento.map((r) => num(r.gas_pay)));
      const gasApproveProprio = riassumi(righePagamento.map((r) => num(r.gas_approve)));
      const costi = [];
      if (modalita === 'allowance' && righeLotto.length) {
        // l'approve condivisa del lotto va ripartita sul numero di
        // pagamenti della stessa campagna: dichiarato a schermo.
        const perCampagna = new Map();
        for (const r of righePagamento) {
          if (!perCampagna.has(r.campagna)) perCampagna.set(r.campagna, []);
          perCampagna.get(r.campagna).push(r);
        }
        for (const lotto of righeLotto) {
          const pagamentiLotto = perCampagna.get(lotto.campagna) || [];
          const nPagamenti = pagamentiLotto.length || 1;
          const costoApproveLotto = (num(lotto.gas_approve) ?? 0) * (num(lotto.prezzo_approve_wei) ?? 0) + (num(lotto.l1_fee_approve_wei) ?? 0);
          const quotaApprove = costoApproveLotto / nPagamenti;
          for (const r of pagamentiLotto) {
            const costoPay = (num(r.gas_pay) ?? 0) * (num(r.prezzo_pay_wei) ?? 0) + (num(r.l1_fee_pay_wei) ?? 0);
            costi.push(costoPay + quotaApprove);
          }
        }
        console.log(`  ${modalita}: approve condivisa ripartita su ${righePagamento.length} pagamenti (dichiarato)`);
      } else {
        for (const r of righePagamento) {
          const costoPay = (num(r.gas_pay) ?? 0) * (num(r.prezzo_pay_wei) ?? 0) + (num(r.l1_fee_pay_wei) ?? 0);
          const costoApprove = num(r.gas_approve) !== null ? (num(r.gas_approve) ?? 0) * (num(r.prezzo_approve_wei) ?? 0) + (num(r.l1_fee_approve_wei) ?? 0) : 0;
          costi.push(costoPay + costoApprove);
        }
      }
      const costoRiassunto = riassumi(costi);
      const esitiModalita = conteggiaOccorrenze(righePagamento, 'esito');
      gasModalitaRisultati.push({ modalita, n: righePagamento.length, gasPay, gasApproveProprio, costoRiassunto, esiti: esitiModalita });
      console.log(
        `${modalita}: n=${righePagamento.length}  gas_pay med ${f(gasPay?.mediana, 0)} [${f(gasPay?.min, 0)}-${f(gasPay?.max, 0)}]  gas_approve med ${f(gasApproveProprio?.mediana, 0)}  costo tot (wei) med ${f(costoRiassunto?.mediana, 0)}  esiti: ${Object.entries(esitiModalita).map(([k, v]) => `${k} ${v}`).join(', ') || 'nessuno'}`
      );
    }
  }
}

// --- tabelle LaTeX a schermo (comportamento invariato di --latex) ----------

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

// --- generatori delle tabelle LaTeX per --latex=<dir> e --flusso-latex -----
//
// Dichiarazioni con "function" (issate in cima allo scope del modulo) cosi'
// si possono richiamare anche da punti del file precedenti alla loro
// posizione testuale, come il blocco --flusso-latex subito dopo il flusso di
// esclusione: al momento della chiamata i dati referenziati sono gia' pronti.

function testoLatexFlusso() {
  const righeTex = flussoRisultato.passi
    .map((p) => `${escLatex(p.nome)} & ${p.scartate === null ? '---' : fLatex(p.scartate, 0)} & ${fLatex(p.rimanenti, 0)} \\\\`)
    .join('\n');
  return `\\begin{tabular}{lrr}\n\\toprule\nFase & Scartate & Rimanenti \\\\\n\\midrule\n${righeTex}\n\\midrule\nUtilizzabili & & ${fLatex(flussoRisultato.utilizzabili, 0)} \\\\\n\\bottomrule\n\\end{tabular}\n`;
}

function testoLatexLatenze() {
  const righeTex = latenze
    .map((l) => `${fLatex(l.importo, 2)} & ${l.c?.n ?? 0} & ${fLatex(l.c?.mediana)} & ${fLatex(l.c?.p95)} & ${fLatex(l.ri?.mediana)} & ${fLatex(l.ri?.p95)} & ${fLatex(l.re?.mediana)} & ${fLatex(l.re?.p95)} \\\\`)
    .join('\n');
  return `\\begin{tabular}{rrrrrrrr}\n\\toprule\nImporto & $n$ & \\multicolumn{2}{c}{Conferma} & \\multicolumn{2}{c}{Riconciliazione} & \\multicolumn{2}{c}{Regolamento} \\\\\n & & mediana & p95 & mediana & p95 & mediana & p95 \\\\\n\\midrule\n${righeTex}\n\\bottomrule\n\\end{tabular}\n`;
}

function testoLatexScomposizione() {
  const righeTex = scomposizioneRighe
    .map((r) => {
      const riass = riassumi(r.dati);
      return `${escLatex(r.nome)} & ${riass?.n ?? 0} & ${fLatex(riass?.mediana)} & ${fLatex(riass?.p95)} & ${fLatex(riass?.min)} & ${fLatex(riass?.max)} \\\\`;
    })
    .join('\n');
  return `\\begin{tabular}{lrrrrr}\n\\toprule\nComponente & $n$ & mediana & p95 & min & max \\\\\n\\midrule\n${righeTex}\n\\bottomrule\n\\end{tabular}\n`;
}

function testoLatexCosti() {
  const righeTex = costi
    .map((c) => `${fLatex(c.importo, 2)} & ${fLatex(c.gasUsatoMediana, 0)} & ${fLatex(c.l2Centrale, 6)} & ${c.l1Centrale === null ? '---' : fLatex(c.l1Centrale, 6)} & ${fLatex(c.centrale, 6)} \\\\`)
    .join('\n');
  return `\\begin{tabular}{rrrrr}\n\\toprule\nImporto & gas (u) & L2 (EUR) & L1 (EUR) & Totale (EUR) \\\\\n\\midrule\n${righeTex}\n\\bottomrule\n\\end{tabular}\n`;
}

function testoLatexCostiEuro() {
  const righeTex = costi
    .map((c) => `${fLatex(c.importo, 2)} & ${fLatex(c.favorevole, 6)} & ${fLatex(c.centrale, 6)} & ${fLatex(c.sfavorevole, 6)} & ${fLatex(c.stripe)} & ${fLatex(c.paypal)} & ${c.paypalCarta === null ? '---' : fLatex(c.paypalCarta)} \\\\`)
    .join('\n');
  return `\\begin{tabular}{rrrrrrr}\n\\toprule\nImporto & \\multicolumn{3}{c}{Costo di rete totale (L2+L1)} & Stripe & PayPal & PayPal carta \\\\\n & favorevole & centrale & sfavorevole & & & \\\\\n\\midrule\n${righeTex}\n\\bottomrule\n\\end{tabular}\n`;
}

function testoLatexAffidabilita() {
  const righeEsiti = Object.entries(affidabilitaRisultato.esiti).map(([k, v]) => `${escLatex(k)} & ${fLatex(v, 0)} \\\\`).join('\n');
  return `\\begin{tabular}{lr}\n\\toprule\nEsito & $n$ \\\\\n\\midrule\n${righeEsiti}\n\\midrule\nTasso di successo & ${fLatex(affidabilitaRisultato.tassoSuccesso, 2)}\\% \\\\\n\\bottomrule\n\\end{tabular}\n`;
}

function testoLatexFiscale() {
  const righeStati = Object.entries(fiscaleRisultati.statiFattura).map(([k, v]) => `${escLatex(k)} & ${fLatex(v, 0)} \\\\`).join('\n');
  return `\\begin{tabular}{lr}\n\\toprule\nStato fattura & $n$ \\\\\n\\midrule\n${righeStati}\n\\midrule\nFatture trasmesse & ${fLatex(fiscaleRisultati.conFattura, 0)} \\\\\nAccettate & ${fLatex(fiscaleRisultati.accettate, 0)} \\\\\nDuplicati (insieme analizzato) & ${fLatex(fiscaleRisultati.duplicatiAnalizzati, 0)} \\\\\nDuplicati (intero file) & ${fLatex(fiscaleRisultati.duplicatiFile, 0)} \\\\\nBuchi nella serie & ${fLatex(fiscaleRisultati.buchi.buchi.length, 0)} \\\\\nMutate da 'sent' & ${fLatex(fiscaleRisultati.mutateDaSent, 0)} \\\\\n\\bottomrule\n\\end{tabular}\n`;
}

function testoLatexTest() {
  const righeTex = [];
  if (testRisultati.kwImporti) righeTex.push(`KW latenza conferma fra importi & ${fLatex(testRisultati.kwImporti.H, 3)} & ${testRisultati.kwImporti.df} & ${fLatexP(testRisultati.kwImporti.p)} \\\\`);
  if (testRisultati.kwCampagne) righeTex.push(`KW latenza conferma fra campagne & ${fLatex(testRisultati.kwCampagne.H, 3)} & ${testRisultati.kwCampagne.df} & ${fLatexP(testRisultati.kwCampagne.p)} \\\\`);
  if (testRisultati.mwFasce) righeTex.push(`MW latenza conferma, importo $\\leq$100 vs $>$100 & U=${fLatex(testRisultati.mwFasce.U, 1)} & --- & ${fLatexP(testRisultati.mwFasce.p)} \\\\`);
  if (testRisultati.bootstrapConferma) righeTex.push(`IC 95\\% bootstrap mediana latenza conferma & ${fLatex(testRisultati.bootstrapConferma.mediana)} [${fLatex(testRisultati.bootstrapConferma.ic95Basso)}, ${fLatex(testRisultati.bootstrapConferma.ic95Alto)}] & --- & --- \\\\`);
  if (testRisultati.bootstrapCosto) righeTex.push(`IC 95\\% bootstrap mediana costo (EUR) & ${fLatex(testRisultati.bootstrapCosto.mediana, 6)} [${fLatex(testRisultati.bootstrapCosto.ic95Basso, 6)}, ${fLatex(testRisultati.bootstrapCosto.ic95Alto, 6)}] & --- & --- \\\\`);
  return `\\begin{tabular}{lrrr}\n\\toprule\nTest & Statistica & df & p \\\\\n\\midrule\n${righeTex.join('\n')}\n\\bottomrule\n\\end{tabular}\n`;
}

function testoLatexSoglia() {
  const righeTex = sogliaRisultati.righe
    .map((r) => `${escLatex(r.baseline)} & ${fLatex(r.scontrino, 2)} & ${fLatex(r.s, 4)} & ${fLatex(r.c, 4)} & ${r.nStar === null ? 'non conveniente' : fLatex(r.nStar, 1)} \\\\`)
    .join('\n');
  return `\\begin{tabular}{lrrrr}\n\\toprule\nBaseline & Scontrino (EUR) & s (EUR) & c (EUR) & $N^*$ \\\\\n\\midrule\n${righeTex}\n\\bottomrule\n\\end{tabular}\n`;
}

function testoLatexGasModalita() {
  if (!gasModalitaRisultati || !gasModalitaRisultati.length) return null;
  const righeTex = gasModalitaRisultati
    .map((g) => `${escLatex(g.modalita)} & ${g.n} & ${fLatex(g.gasPay?.mediana, 0)} & ${fLatex(g.gasApproveProprio?.mediana, 0)} & ${fLatex(g.costoRiassunto?.mediana, 0)} \\\\`)
    .join('\n');
  return `\\begin{tabular}{lrrrr}\n\\toprule\nModalita & $n$ & gas\\_pay mediana & gas\\_approve mediana & costo totale mediana (wei) \\\\\n\\midrule\n${righeTex}\n\\bottomrule\n\\end{tabular}\n`;
}

// --- scrittura su file: --latex=<dir> e --json=<file> ----------------------

function scriviFileLatex(dir, nome, contenuto) {
  mkdirSync(dir, { recursive: true });
  const percorso = `${dir.replace(/[\\/]+$/, '')}/${nome}`;
  writeFileSync(percorso, contenuto, 'utf8');
  return percorso;
}

if (LATEX_DIR) {
  const scritti = [
    scriviFileLatex(LATEX_DIR, 'tab-flusso.tex', testoLatexFlusso()),
    scriviFileLatex(LATEX_DIR, 'tab-latenze.tex', testoLatexLatenze()),
    scriviFileLatex(LATEX_DIR, 'tab-scomposizione.tex', testoLatexScomposizione()),
    scriviFileLatex(LATEX_DIR, 'tab-costi.tex', testoLatexCosti()),
    scriviFileLatex(LATEX_DIR, 'tab-costi-euro.tex', testoLatexCostiEuro()),
    scriviFileLatex(LATEX_DIR, 'tab-affidabilita.tex', testoLatexAffidabilita()),
    scriviFileLatex(LATEX_DIR, 'tab-fiscale.tex', testoLatexFiscale()),
    scriviFileLatex(LATEX_DIR, 'tab-test.tex', testoLatexTest()),
    scriviFileLatex(LATEX_DIR, 'tab-soglia.tex', testoLatexSoglia()),
  ];
  const testoGas = testoLatexGasModalita();
  if (testoGas) scritti.push(scriviFileLatex(LATEX_DIR, 'tab-gas-modalita.tex', testoGas));
  console.log(`\nTabelle LaTeX scritte in ${LATEX_DIR}:`);
  for (const p of scritti) console.log(`  ${p}`);
}

if (JSON_OUT) {
  const risultatoJson = {
    dataset: DATASET,
    generatoIl: new Date().toISOString(),
    flusso: flussoRisultato,
    latenze,
    scomposizione: scomposizioneRighe.map((r) => ({ nome: r.nome, riassunto: riassumi(r.dati) })),
    affidabilita: affidabilitaRisultato,
    costi,
    rapportoL1L2: riassuntoRapportoL1L2,
    quotaPriorityFee: riassuntoQuotaPriority,
    testStatistici: testRisultati,
    soglia: sogliaRisultati,
    fiscale: fiscaleRisultati,
    gasModalita: gasModalitaRisultati,
  };
  writeFileSync(JSON_OUT, JSON.stringify(risultatoJson, null, 2), 'utf8');
  console.log(`\nJSON scritto in ${JSON_OUT}`);
}
