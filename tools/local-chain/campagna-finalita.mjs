// Determina sperimentalmente il compromesso fra latenza e irreversibilita'.
//
// Il paragrafo 4.3 della tesi impegna a stabilire i valori di default del
// criterio di finalita' come compromesso misurato, non come scelta d'ufficio.
// Misurarlo richiede di ripetere la stessa campagna variando il solo numero di
// conferme richieste, che e' un parametro del servizio di rilevamento: per
// ciascun valore lo script riavvia il servizio, esegue un lotto breve e attende
// che le misure siano complete.
//
// Il paniere e' volutamente ridotto: qui la variabile in esame e' il criterio,
// non l'importo, e la campagna principale ha gia' stabilito che la latenza non
// dipende dall'importo.
//
// Uso:
//   node tools/local-chain/campagna-finalita.mjs
//   node tools/local-chain/campagna-finalita.mjs --criteri=1,3,6,24 --ripetizioni=5
import { config } from 'dotenv';
config({ path: new URL('../../.env', import.meta.url) });

import { spawn } from 'node:child_process';

const arg = (n, d) => {
  const v = process.argv.find((a) => a.startsWith(`--${n}=`));
  return v ? v.split('=').slice(1).join('=') : d;
};

const CRITERI = arg('criteri', '1,3,6,24').split(',').map((s) => Number(s.trim()));
const IMPORTI = arg('importi', '25,100,500');
const RIPETIZIONI = Number(arg('ripetizioni', '5'));
const CHAIN_ID = Number(arg('chain-id', process.env.CHAIN_ID ?? '84532'));

const radice = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const attesa = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`Criteri da misurare: ${CRITERI.join(', ')} conferme`);
console.log(`Paniere ${IMPORTI} x ${RIPETIZIONI} ripetizioni per criterio\n`);

/// Avvia il servizio di rilevamento con il criterio richiesto e restituisce il
/// processo, insieme a una promessa che si risolve quando ha finito di
/// riavviarsi e sta osservando la rete.
function avviaServizio(conferme) {
  const p = spawn(process.execPath, ['src/index.mjs'], {
    cwd: `${radice}/watcher`,
    env: { ...process.env, CONFIRMATIONS: String(conferme) },
  });
  let pronto;
  const attesaPronto = new Promise((r) => { pronto = r; });
  const leggi = (d) => {
    const t = d.toString();
    process.stdout.write(t.replace(/^/gm, '    '));
    if (t.includes('Ripartenza dal blocco')) pronto();
  };
  p.stdout.on('data', leggi);
  p.stderr.on('data', leggi);
  return { processo: p, pronto: attesaPronto };
}

function eseguiCampagna(campagna) {
  return new Promise((risolvi) => {
    const p = spawn(process.execPath, [
      'tools/local-chain/campagna.mjs',
      `--importi=${IMPORTI}`,
      `--ripetizioni=${RIPETIZIONI}`,
      `--chain-id=${CHAIN_ID}`,
      `--campagna=${campagna}`,
    ], { cwd: radice });
    const scrivi = (d) => process.stdout.write(d.toString().replace(/^ Container.*\n/gm, ''));
    p.stdout.on('data', scrivi);
    p.stderr.on('data', scrivi);
    p.on('close', (codice) => risolvi(codice));
  });
}

for (const conferme of CRITERI) {
  console.log(`\n=== criterio: ${conferme} conferme ===`);
  const { processo, pronto } = avviaServizio(conferme);
  await pronto;

  const codice = await eseguiCampagna(`2026-09-01-finalita-${conferme}`);

  // Il riscatto dell'ultimo pagamento puo' essere ancora in volo: si concede
  // un margine prima di togliere di mezzo il servizio, altrimenti i marcatori
  // di regolamento resterebbero incompleti proprio sulle ultime righe.
  await attesa(30000);
  processo.kill();
  await attesa(2000);

  if (0 !== codice) {
    console.error(`Interrotta: la campagna a ${conferme} conferme e' uscita con codice ${codice}.`);
    break;
  }
}

console.log('\nMisure concluse. Analizzare un criterio per volta:');
for (const c of CRITERI) {
  console.log(`  node tools/analisi.mjs --dataset=docs/dataset/campagna.csv --campagna=2026-09-01-finalita-${c}`);
}
