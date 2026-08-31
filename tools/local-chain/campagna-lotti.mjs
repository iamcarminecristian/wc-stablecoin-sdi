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
// rimborso attivo gli euro escono verso l'IBAN e l'emittente li riemette, ma
// non istantaneamente.
//
// Uso:
//   node tools/local-chain/campagna-lotti.mjs --ripetizioni=30
//   node tools/local-chain/campagna-lotti.mjs --ripetizioni=2 --dry-run
import { config } from 'dotenv';
config({ path: new URL('../../.env', import.meta.url) });

import { createPublicClient, http, parseUnits, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const arg = (nome, predefinito) => {
  const v = process.argv.find((a) => a.startsWith(`--${nome}=`));
  return v ? v.split('=').slice(1).join('=') : predefinito;
};
const flag = (nome) => process.argv.includes(`--${nome}`);

const IMPORTI = arg('importi', '10,25,50,100,250,500,1000,2500').split(',').map((s) => s.trim());
const RIPETIZIONI = Number(arg('ripetizioni', '30'));
const CHAIN_ID = Number(arg('chain-id', process.env.CHAIN_ID ?? '84532'));
const DECIMALI = Number(process.env.TOKEN_DECIMALS ?? '18');

// Quanto si e' disposti ad attendere che l'emittente riemetta gli euro usciti
// verso l'IBAN, prima di dichiarare la campagna interrotta per fondi.
const ATTESA_FONDI_MS = Number(arg('attesa-fondi', String(15 * 60 * 1000)));
const SONDAGGIO_MS = 15000;

const radice = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const erc20 = JSON.parse(readFileSync(new URL('./erc20.json', import.meta.url)));

const pub = createPublicClient({ transport: http(process.env.RPC_URL) });
const esercente = privateKeyToAccount(process.env.MERCHANT_SIGNER_PRIVATE_KEY);

const perLotto = IMPORTI.reduce((t, i) => t + parseUnits(i, DECIMALI), 0n);

console.log(`Campagna a lotti: ${RIPETIZIONI} lotti da ${IMPORTI.length} ordini`);
console.log(`Paniere: ${IMPORTI.join(', ')} EUR — ${formatUnits(perLotto, DECIMALI)} EURe per lotto`);
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

/// Attende che l'esercente possa finanziare un altro lotto. Restituisce false
/// se la dotazione non si ricostituisce entro il tempo concesso: e' un esito
/// legittimo dell'ambiente di prova, non un errore da nascondere.
async function attendiCapienza() {
  const scadenza = Date.now() + ATTESA_FONDI_MS;
  let ultimo = -1n;
  while (Date.now() < scadenza) {
    const s = await saldoEsercente();
    if (s >= perLotto) return true;
    if (s !== ultimo) {
      console.log(`  in attesa di fondi: ${formatUnits(s, DECIMALI)} di ${formatUnits(perLotto, DECIMALI)} EURe`);
      ultimo = s;
    }
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

let completati = 0;
for (let i = 1; i <= RIPETIZIONI; i++) {
  console.log(`\n=== lotto ${i}/${RIPETIZIONI} ===`);

  if (!(await attendiCapienza())) {
    console.error(`\nInterrotta al lotto ${i}: l'esercente non e' tornato capiente entro il tempo concesso.`);
    console.error(`Servono ${formatUnits(perLotto, DECIMALI)} EURe, disponibili ${formatUnits(await saldoEsercente(), DECIMALI)}.`);
    break;
  }

  const { codice } = await eseguiLotto();
  if (0 !== codice) {
    console.error(`\nInterrotta al lotto ${i}: la campagna e' uscita con codice ${codice}.`);
    break;
  }
  completati++;
}

console.log(`\nLotti completati: ${completati}/${RIPETIZIONI} — ${completati * IMPORTI.length} ordini.`);
console.log('Esportare il dataset con:');
console.log('  docker compose run --rm -T wpcli wcsdi export --format=csv > docs/dataset/campagna.csv');
