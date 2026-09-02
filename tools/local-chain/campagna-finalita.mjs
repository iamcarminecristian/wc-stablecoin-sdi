// Determina sperimentalmente il compromesso fra latenza e irreversibilita'.
//
// Il paragrafo 4.3 della tesi impegna a stabilire i valori di default del
// criterio di conferma come compromesso misurato, non come scelta d'ufficio.
// Misurarlo richiede di ripetere la stessa campagna variando il solo
// criterio, che e' un parametro del servizio di rilevamento: per ciascun
// valore lo script riavvia il servizio, esegue un lotto breve e attende che
// le misure, riscatti compresi, siano complete.
//
// I criteri sono di due famiglie: la profondita' in blocchi (confirmations:N)
// e le etichette del protocollo (safe, finalized), che ancorano la conferma
// alla rete di primo livello. La numerosita' e' la stessa per ogni criterio,
// cosi' che i confronti fra righe della tabella abbiano lo stesso peso.
//
// Il paniere e' volutamente ridotto: qui la variabile in esame e' il
// criterio, non l'importo, e la campagna principale ha gia' stabilito che la
// latenza non dipende dall'importo.
//
// Uso:
//   node tools/local-chain/campagna-finalita.mjs
//   node tools/local-chain/campagna-finalita.mjs --criteri=confirmations:1,confirmations:12,safe,finalized --ripetizioni=5
import { config } from 'dotenv';
config({ path: new URL('../../.env', import.meta.url) });

import { spawn } from 'node:child_process';
import { criterio, avviaServizio, fermaServizio, radice } from './servizio.mjs';

const arg = (n, d) => {
  const v = process.argv.find((a) => a.startsWith(`--${n}=`));
  return v ? v.split('=').slice(1).join('=') : d;
};

const CRITERI = arg('criteri', 'confirmations:1,confirmations:3,confirmations:6,confirmations:12,confirmations:24,safe,finalized')
  .split(',').map((s) => criterio(s));
const IMPORTI = arg('importi', '25,100,500');
const RIPETIZIONI = Number(arg('ripetizioni', '5'));
const CHAIN_ID = Number(arg('chain-id', process.env.CHAIN_ID ?? '84532'));
const MODALITA = arg('modalita', 'allowance');
const DATA = arg('data', new Date().toISOString().slice(0, 10));

console.log(`Criteri da misurare: ${CRITERI.map((c) => c.etichetta).join(', ')}`);
console.log(`Paniere ${IMPORTI} x ${RIPETIZIONI} ripetizioni per criterio, modalita' ${MODALITA}\n`);

function eseguiCampagna(c, campagna) {
  return new Promise((risolvi) => {
    const p = spawn(process.execPath, [
      'tools/local-chain/campagna.mjs',
      `--importi=${IMPORTI}`,
      `--ripetizioni=${RIPETIZIONI}`,
      `--chain-id=${CHAIN_ID}`,
      `--campagna=${campagna}`,
      `--modalita=${MODALITA}`,
      `--attesa=${c.attesaMs}`,
    ], { cwd: radice });
    const scrivi = (d) => process.stdout.write(d.toString().replace(/^ Container.*\n/gm, ''));
    p.stdout.on('data', scrivi);
    p.stderr.on('data', scrivi);
    p.on('close', (codice) => risolvi(codice));
  });
}

const campagne = [];
for (const c of CRITERI) {
  console.log(`\n=== criterio: ${c.etichetta} ===`);
  const servizio = avviaServizio(c);
  await servizio.pronto;

  const campagna = `${DATA}-finalita-${c.etichetta}`;
  const codice = await eseguiCampagna(c, campagna);
  campagne.push(campagna);

  // La campagna attende conferme e riscatti prima di uscire; il servizio si
  // puo' fermare senza lasciare marcatori incompleti, e comunque riprende i
  // riscatti in corso alla prossima accensione.
  await fermaServizio(servizio);

  if (0 !== codice) {
    console.error(`Interrotta: la campagna con criterio ${c.etichetta} e' uscita con codice ${codice}.`);
    break;
  }
}

console.log('\nMisure concluse. Esportare il dataset e analizzare un criterio per volta:');
for (const c of campagne) {
  console.log(`  node tools/analisi.mjs --dataset=docs/dataset/campagna.csv --campagna=${c}`);
}
