// Funzioni statistiche per tools/analisi.mjs: Mann-Whitney U, Kruskal-Wallis,
// bootstrap percentile della mediana. Nessuna dipendenza esterna di proposito,
// perche' il modulo deve restare verificabile con un self-test isolato
// (node tools/statistica.mjs --test) senza toccare la rete o pacchetti npm.
//
// Le implementazioni seguono i metodi standard (approssimazione normale con
// correzione di continuita' e correzione per i pari merito, chi-quadro dalla
// funzione gamma incompleta regolarizzata secondo Numerical Recipes). I casi
// del self-test sono costruiti a mano, non presi da un manuale a memoria,
// cosi' il valore atteso e' verificabile con carta e penna e non soggetto a
// un ricordo impreciso della fonte.
import { fileURLToPath } from 'node:url';

// --- funzione gamma e gamma incompleta regolarizzata -----------------------

function logGamma(x) {
  // Approssimazione di Lanczos, g=7, coefficienti a 9 termini.
  const G = 7;
  const C = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // riflessione per argomenti piccoli
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = C[0];
  const t = x + G + 0.5;
  for (let i = 1; i < G + 2; i++) a += C[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function gammaIncompletaInferiore(a, x) {
  // P(a,x) regolarizzata, via serie (x piccolo) o frazione continua (x grande).
  if (x < 0 || a <= 0) return null;
  if (x === 0) return 0;
  if (x < a + 1) {
    let somma = 1 / a;
    let termine = somma;
    let n = a;
    for (let i = 0; i < 500; i++) {
      n += 1;
      termine *= x / n;
      somma += termine;
      if (Math.abs(termine) < Math.abs(somma) * 1e-15) break;
    }
    return somma * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }
  return 1 - gammaIncompletaSuperioreCF(a, x);
}

function gammaIncompletaSuperioreCF(a, x) {
  // Q(a,x) via l'algoritmo di Lentz per la frazione continua.
  const FPMIN = 1e-300;
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

// P(X^2_df > chi2), coda superiore della distribuzione chi-quadro.
export function chiQuadratoPValore(chi2, df) {
  if (chi2 <= 0 || df <= 0) return 1;
  const a = df / 2;
  const x = chi2 / 2;
  const p = 1 - gammaIncompletaInferiore(a, x);
  return Math.min(1, Math.max(0, p));
}

// --- normale standard --------------------------------------------------

function erf(x) {
  // Abramowitz-Stegun 7.1.26, errore massimo 1.5e-7: sufficiente per un
  // p-value a 3 decimali.
  const segno = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return segno * y;
}

function normaleCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// --- ranghi con pari merito --------------------------------------------

// Attende un array gia' ordinato per v di oggetti con almeno il campo v.
// Ritorna i ranghi (medi sui pari merito, 1-based) nello stesso ordine e le
// dimensioni dei gruppi di pari merito, usate dalla correzione per i ties.
function assegnaRanghi(ordinati) {
  const ranghi = new Array(ordinati.length);
  const gruppiPariMerito = [];
  let i = 0;
  while (i < ordinati.length) {
    let j = i;
    while (j + 1 < ordinati.length && ordinati[j + 1].v === ordinati[i].v) j++;
    const rangoMedio = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k++) ranghi[k] = rangoMedio;
    gruppiPariMerito.push(j - i + 1);
    i = j + 1;
  }
  return { ranghi, gruppiPariMerito };
}

// --- Mann-Whitney U ------------------------------------------------------

// Test U a due code con approssimazione normale, correzione di continuita' e
// correzione per i pari merito nella varianza. a e b sono array di numeri.
export function mannWhitneyU(a, b) {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 === 0 || n2 === 0) return null;
  const combinati = [...a.map((v) => ({ v, gruppo: 0 })), ...b.map((v) => ({ v, gruppo: 1 }))];
  combinati.sort((x, y) => x.v - y.v);
  const { ranghi, gruppiPariMerito } = assegnaRanghi(combinati);
  let sommaRanghi1 = 0;
  for (let k = 0; k < combinati.length; k++) if (combinati[k].gruppo === 0) sommaRanghi1 += ranghi[k];
  const U1 = sommaRanghi1 - (n1 * (n1 + 1)) / 2;
  const U2 = n1 * n2 - U1;
  const U = Math.min(U1, U2);
  const N = n1 + n2;
  const sommaCorrezione = gruppiPariMerito.reduce((s, t) => s + (t ** 3 - t), 0);
  const varianza = (n1 * n2 / 12) * ((N + 1) - sommaCorrezione / (N * (N - 1)));
  const sigma = Math.sqrt(Math.max(varianza, 0));
  const media = (n1 * n2) / 2;
  let z = 0;
  if (sigma > 0) {
    const scarto = U1 - media;
    const correzioneContinuita = scarto > 0 ? -0.5 : scarto < 0 ? 0.5 : 0;
    z = (scarto + correzioneContinuita) / sigma;
  }
  const p = sigma > 0 ? Math.min(1, 2 * (1 - normaleCdf(Math.abs(z)))) : 1;
  return { U, U1, U2, n1, n2, z, p };
}

// --- Kruskal-Wallis --------------------------------------------------------

// gruppi: array di array di numeri. Correzione per i pari merito sull'
// intero campione combinato; p-value dalla coda superiore del chi-quadro con
// df = numero di gruppi non vuoti - 1.
export function kruskalWallis(gruppi) {
  const attivi = gruppi.filter((g) => g.length > 0);
  if (attivi.length < 2) return null;
  const combinati = [];
  attivi.forEach((g, gi) => g.forEach((v) => combinati.push({ v, gi })));
  combinati.sort((x, y) => x.v - y.v);
  const { ranghi, gruppiPariMerito } = assegnaRanghi(combinati);
  const N = combinati.length;
  const sommeRanghi = attivi.map(() => 0);
  for (let k = 0; k < combinati.length; k++) sommeRanghi[combinati[k].gi] += ranghi[k];
  let H = 0;
  for (let gi = 0; gi < attivi.length; gi++) H += (sommeRanghi[gi] ** 2) / attivi[gi].length;
  H = (12 / (N * (N + 1))) * H - 3 * (N + 1);
  const sommaCorrezione = gruppiPariMerito.reduce((s, t) => s + (t ** 3 - t), 0);
  const correzione = 1 - sommaCorrezione / (N ** 3 - N);
  const Hc = correzione !== 0 ? H / correzione : H;
  const df = attivi.length - 1;
  const p = chiQuadratoPValore(Hc, df);
  return { H: Hc, df, p, n: N, gruppi: attivi.length };
}

// --- bootstrap percentile della mediana ------------------------------------

// Generatore pseudo-casuale deterministico (mulberry32): a parita' di seme
// produce sempre la stessa sequenza, condizione necessaria perche' l'
// intervallo di confidenza sia riproducibile da chi rilancia lo script.
export function mulberry32(seme) {
  let a = seme >>> 0;
  return function generatore() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(ordinati, p) {
  if (!ordinati.length) return null;
  const h = (ordinati.length - 1) * p;
  const b = Math.floor(h);
  const a = Math.min(b + 1, ordinati.length - 1);
  return ordinati[b] + (h - b) * (ordinati[a] - ordinati[b]);
}

// Intervallo di confidenza al 95% (percentile) della mediana, per
// ricampionamento con reinserimento. ricampionamenti di default 2000, seme
// di default 42: entrambi dichiarati nel risultato perche' compaiano nelle
// tabelle senza doverli ricordare a parte.
export function bootstrapMedianaIC(valori, opzioni = {}) {
  const { ricampionamenti = 2000, seme = 42, alfa = 0.05 } = opzioni;
  const v = valori.filter((x) => x !== null && x !== undefined && Number.isFinite(x));
  const n = v.length;
  if (n === 0) return null;
  const casuale = mulberry32(seme);
  const mediane = new Array(ricampionamenti);
  for (let r = 0; r < ricampionamenti; r++) {
    const campione = new Array(n);
    for (let i = 0; i < n; i++) campione[i] = v[Math.floor(casuale() * n)];
    campione.sort((a, b) => a - b);
    mediane[r] = quantile(campione, 0.5);
  }
  mediane.sort((a, b) => a - b);
  const ordinatiOriginali = [...v].sort((a, b) => a - b);
  return {
    n,
    mediana: quantile(ordinatiOriginali, 0.5),
    ic95Basso: quantile(mediane, alfa / 2),
    ic95Alto: quantile(mediane, 1 - alfa / 2),
    ricampionamenti,
    seme,
  };
}

// --- self-test ---------------------------------------------------------

function autotest() {
  let tutteOk = true;
  const verifica = (nome, atteso, ottenuto, tolleranza = 1e-6) => {
    const numerico = typeof atteso === 'number';
    const passa = numerico ? Math.abs(atteso - ottenuto) <= tolleranza : atteso === ottenuto;
    console.log(`${passa ? 'OK     ' : 'FALLITO'} ${nome}: atteso=${atteso} ottenuto=${ottenuto}`);
    if (!passa) tutteOk = false;
  };

  console.log('--- Mann-Whitney U ---');
  // A e B completamente separati, senza pari merito: U esatto e' 0. Il
  // p-value esatto (permutazione completa) e' 0,0079; l'approssimazione
  // normale con correzione di continuita' cade nella fascia 0,009-0,012
  // dichiarata nel task, perche' n=5 e' piccolo per la normale.
  const mw = mannWhitneyU([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]);
  verifica('MW U (A separato da B)', 0, mw.U, 1e-9);
  const mwPArrotondato = Math.round(mw.p * 1000) / 1000;
  const mwOk = mwPArrotondato >= 0.009 && mwPArrotondato <= 0.012;
  console.log(`${mwOk ? 'OK     ' : 'FALLITO'} MW p (approssimazione normale, atteso 0,009-0,012, esatto 0,0079): ottenuto=${mw.p.toFixed(4)}`);
  if (!mwOk) tutteOk = false;

  console.log('--- Kruskal-Wallis ---');
  // Caso senza pari merito, verificabile a mano: tre gruppi disgiunti e
  // ordinati, H = 12/(N(N+1)) * sum(R_i^2/n_i) - 3(N+1) = 7,2 esatto, df=2.
  const kw1 = kruskalWallis([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
  verifica('KW H (3 gruppi disgiunti, senza pari merito)', 7.2, kw1.H, 1e-9);
  verifica('KW df (3 gruppi)', 2, kw1.df, 0);
  // Caso con pari merito, verificato a mano in frazione: H grezzo = 7/3,
  // correzione = 1 - 24/210 = 31/35, Hc = (7/3)/(31/35) = 245/93.
  const kw2 = kruskalWallis([[1, 2, 2], [2, 3, 4]]);
  verifica('KW H con correzione pari merito (245/93)', 245 / 93, kw2.H, 1e-9);
  verifica('KW df (2 gruppi)', 1, kw2.df, 0);

  console.log('--- Chi-quadro (coda superiore) ---');
  verifica('P(X^2_2 > 5,991) = 0,05', 0.05, chiQuadratoPValore(5.991, 2), 0.001);
  verifica('P(X^2_1 > 3,841) = 0,05', 0.05, chiQuadratoPValore(3.841, 1), 0.001);

  console.log('--- Bootstrap percentile della mediana ---');
  const dati = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const b1 = bootstrapMedianaIC(dati, { seme: 42, ricampionamenti: 500 });
  const b2 = bootstrapMedianaIC(dati, { seme: 42, ricampionamenti: 500 });
  const riproducibile = b1.ic95Basso === b2.ic95Basso && b1.ic95Alto === b2.ic95Alto;
  console.log(`${riproducibile ? 'OK     ' : 'FALLITO'} bootstrap riproducibile a parita' di seme: [${b1.ic95Basso}, ${b1.ic95Alto}] vs [${b2.ic95Basso}, ${b2.ic95Alto}]`);
  if (!riproducibile) tutteOk = false;
  verifica('bootstrap mediana campione 1..10', 5.5, b1.mediana, 1e-9);

  console.log(tutteOk ? '\nSelf-test superato.' : '\nSelf-test FALLITO.');
  return tutteOk;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--test')) {
    const ok = autotest();
    process.exit(ok ? 0 : 1);
  } else {
    console.log('Uso: node tools/statistica.mjs --test');
  }
}
