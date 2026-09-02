// Avvio del servizio di rilevamento da parte degli strumenti di campagna.
//
// Le campagne variano il criterio di conferma, che e' un parametro del
// servizio: per ogni valore lo avviano con l'ambiente adatto e lo fermano a
// misure concluse. La logica sta qui, in un punto solo, perche' la campagna
// a lotti e la scansione dei criteri la usano entrambe e due copie
// divergerebbero.
import { spawn } from 'node:child_process';

export const radice = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
export const attesa = (ms) => new Promise((r) => setTimeout(r, ms));

/// Interpreta un criterio scritto come `confirmations:12`, `safe` o
/// `finalized` e restituisce l'ambiente da passare al servizio, insieme a
/// un'etichetta breve per l'identificativo della campagna.
export function criterio(testo) {
  const [modo, n] = String(testo).trim().split(':');
  if ('confirmations' === modo) {
    const conferme = Number(n ?? '12');
    if (!Number.isInteger(conferme) || conferme < 0) throw new Error(`Criterio non valido: ${testo}`);
    return {
      modo, conferme, etichetta: `c${conferme}`,
      // Con le conferme la profondita' cresce a ogni blocco e vale la pena
      // guardare spesso; con le etichette l'attesa e' di minuti e il
      // sondaggio serve solo a quantizzare t2: dieci secondi bastano.
      env: { FINALITY_MODE: 'confirmations', CONFIRMATIONS: String(conferme), POLL_MS: '5000' },
      attesaMs: 15 * 60 * 1000,
    };
  }
  if ('safe' === modo || 'finalized' === modo) {
    return {
      modo, conferme: 0, etichetta: modo,
      env: { FINALITY_MODE: modo, POLL_MS: '10000' },
      attesaMs: 60 * 60 * 1000,
    };
  }
  throw new Error(`Criterio non riconosciuto: ${testo} (attesi confirmations:N, safe, finalized)`);
}

/// Avvia il servizio con il criterio richiesto. Restituisce il processo e una
/// promessa che si risolve quando sta osservando la rete.
export function avviaServizio(c, { silenzioso = false } = {}) {
  const p = spawn(process.execPath, ['src/index.mjs'], {
    cwd: `${radice}/watcher`,
    env: { ...process.env, ...c.env },
  });
  let pronto;
  const attesaPronto = new Promise((r) => { pronto = r; });
  const leggi = (d) => {
    const t = d.toString();
    if (!silenzioso) process.stdout.write(t.replace(/^/gm, '    '));
    if (t.includes('Ripartenza dal blocco')) pronto();
  };
  p.stdout.on('data', leggi);
  p.stderr.on('data', leggi);
  p.on('exit', (codice) => {
    if (null !== codice && 0 !== codice) console.error(`    [servizio uscito con codice ${codice}]`);
    pronto();
  });
  return { processo: p, pronto: attesaPronto };
}

export async function fermaServizio(servizio) {
  if (!servizio?.processo || servizio.processo.exitCode !== null) return;
  servizio.processo.kill();
  await attesa(2000);
}
