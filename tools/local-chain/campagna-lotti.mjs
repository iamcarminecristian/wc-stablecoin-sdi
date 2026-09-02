// Esegue la campagna del protocollo a lotti, un lotto per ripetizione.
//
// Il vincolo che impone i lotti e' finanziario, non tecnico: la campagna
// finanzia il pagatore in anticipo per l'intera somma degli ordini, e il
// paniere completo per trenta ripetizioni vale piu' di centomila euro, mentre
// l'ambiente di prova ne mette a disposizione qualche migliaio. Una ripetizione
// intera del paniere sta invece dentro la dotazione, e i fondi rientrano
// all'esercente a ogni pagamento, per cui i lotti si possono ripetere.
//
// Fra un lotto e l'altro si attende che l'esercente torni capiente: con il
// riscatto attivo gli euro escono verso l'IBAN e l'emittente li riemette, ma
// non istantaneamente.
//
// Lo script avvia anche il servizio di rilevamento con il criterio indicato,
// cosi' che una tranche sia riproducibile con un comando solo e il criterio
// resti registrato sulle righe che ha prodotto.
//
// Uso:
//   node tools/local-chain/campagna-lotti.mjs --ripetizioni=10 --campagna=2026-09-03-v2-t1
//   node tools/local-chain/campagna-lotti.mjs --ripetizioni=2 --criterio=confirmations:12 --dry-run
import { config } from 'dotenv';
config({ path: new URL('../../.env', import.meta.url) });

import { createPublicClient, http, parseUnits, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { criterio, avviaServizio, fermaServizio, radice } from './servizio.mjs';

const arg = (nome, predefinito) => {
  const v = process.argv.find((a) => a.startsWith(`--${nome}=`));
  return v ? v.split('=').slice(1).join('=') : predefinito;
};
const flag = (nome) => process.argv.includes(`--${nome}`);

const IMPORTI = arg('importi', '10,25,50,100,250,500,1000,2500').split(',').map((s) => s.trim());
const RIPETIZIONI = Number(arg('ripetizioni', '30'));
const CHAIN_ID = Number(arg('chain-id', process.env.CHAIN_ID ?? '84532'));
const DECIMALI = Number(process.env.TOKEN_DECIMALS ?? '18');
const MODALITA = arg('modalita', 'allowance');
const CRITERIO = criterio(arg('criterio', 'confirmations:12'));

// Quanto si e' disposti ad attendere che l'emittente riemetta gli euro usciti
// verso l'IBAN, prima di dichiarare la campagna interrotta per fondi.
const ATTESA_FONDI_MS = Number(arg('attesa-fondi', String(15 * 60 * 1000)));

// Tutti i lotti appartengono alla stessa campagna e ne portano l'identificativo.
const CAMPAGNA = arg('campagna', new Date().toISOString().replace(/[:.]/g, '-'));
const SONDAGGIO_MS = 15000;

const erc20 = JSON.parse(readFileSync(new URL('./erc20.json', import.meta.url)));

const pub = createPublicClient({ transport: http(process.env.RPC_URL) });
const esercente = privateKeyToAccount(process.env.MERCHANT_SIGNER_PRIVATE_KEY);

const perLotto = IMPORTI.reduce((t, i) => t + parseUnits(i, DECIMALI), 0n);

console.log(`Campagna a lotti: ${RIPETIZIONI} lotti da ${IMPORTI.length} ordini, criterio ${CRITERIO.etichetta}, modalita' ${MODALITA}`);
console.log(`Paniere: ${IMPORTI.join(', ')} EUR, ${formatUnits(perLotto, DECIMALI)} EURe per lotto`);
console.log(`Campagna: ${CAMPAGNA}`);
console.log(`Totale: ${IMPORTI.length * RIPETIZIONI} ordini, ${formatUnits(perLotto * BigInt(RIPETIZIONI), DECIMALI)} EURe movimentati\n`);

if (flag('dry-run')) process.exit(0);

async function saldoEsercente() {
  return pub.readContract({
    address: process.env.TOKEN_ADDRESS,
    abi: erc20.abi,
    functionName: 'balanceOf',
    args: [esercente.address],
  });
}

// Soglia di ripartenza. Il saldo osservato in un singolo istante non dice se i
// fondi siano fermi: durante e subito dopo un lotto ci sono riscatti in volo,
// gli euro sono gia' usciti e l'emittente non li ha ancora riemessi, e il
// saldo attraversa un minimo transitorio. Ripartire su quel minimo fa fallire
// il lotto successivo per fondi. Si richiede percio' un margine oltre il
// fabbisogno e, soprattutto, che il saldo sia stabile su due letture
// consecutive: e' la stabilita', non il valore, a dire che il transitorio e'
// finito.
const MARGINE = perLotto / 5n;

/// Attende che l'esercente possa finanziare un altro lotto. Restituisce false
/// se la dotazione non si ricostituisce entro il tempo concesso: e' un esito
/// legittimo dell'ambiente di prova, non un errore da nascondere.
async function attendiCapienza() {
  const soglia = perLotto + MARGINE;
  const scadenza = Date.now() + ATTESA_FONDI_MS;
  let precedente = null;
  let annunciato = -1n;

  while (Date.now() < scadenza) {
    const s = await saldoEsercente();
    if (s >= soglia && precedente !== null && s === precedente) return true;
    if (s !== annunciato) {
      const stato = s >= soglia ? 'in assestamento' : 'in attesa di fondi';
      console.log(`  ${stato}: ${formatUnits(s, DECIMALI)} di ${formatUnits(soglia, DECIMALI)} EURe`);
      annunciato = s;
    }
    precedente = s;
    await new Promise((r) => setTimeout(r, SONDAGGIO_MS));
  }
  return false;
}

function eseguiLotto() {
  return new Promise((risolvi) => {
    const p = spawn(process.execPath, [
      'tools/local-chain/campagna.mjs',
      `--importi=${IMPORTI.join(',')}`,
      '--ripetizioni=1',
      `--chain-id=${CHAIN_ID}`,
      `--campagna=${CAMPAGNA}`,
      `--modalita=${MODALITA}`,
      `--attesa=${CRITERIO.attesaMs}`,
    ], { cwd: radice });

    let coda = '';
    const raccogli = (d) => {
      coda = (coda + d.toString()).slice(-4000);
      process.stdout.write(d.toString().replace(/^ Container.*\n/gm, ''));
    };
    p.stdout.on('data', raccogli);
    p.stderr.on('data', raccogli);
    p.on('close', (codice) => risolvi({ codice, coda }));
  });
}

const servizio = avviaServizio(CRITERIO, { silenzioso: flag('servizio-silenzioso') });
await servizio.pronto;
process.on('SIGINT', async () => { await fermaServizio(servizio); process.exit(130); });

let completati = 0;
for (let i = 1; i <= RIPETIZIONI; i++) {
  console.log(`\n=== lotto ${i}/${RIPETIZIONI} ===`);

  if (!(await attendiCapienza())) {
    console.error(`\nInterrotta al lotto ${i}: l'esercente non e' tornato capiente entro il tempo concesso.`);
    console.error(`Servono ${formatUnits(perLotto + MARGINE, DECIMALI)} EURe stabili, disponibili ${formatUnits(await saldoEsercente(), DECIMALI)}.`);
    break;
  }

  const { codice } = await eseguiLotto();
  if (0 !== codice) {
    console.error(`\nInterrotta al lotto ${i}: la campagna e' uscita con codice ${codice}.`);
    break;
  }
  completati++;
}

await fermaServizio(servizio);

console.log(`\nLotti completati: ${completati}/${RIPETIZIONI}, ${completati * IMPORTI.length} ordini.`);
console.log('Esportare il dataset con:');
console.log('  docker compose run --rm -T wpcli wcsdi export --format=csv > docs/dataset/campagna.csv');
