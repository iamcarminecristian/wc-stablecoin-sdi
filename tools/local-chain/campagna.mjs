// Campagna sperimentale per il Capitolo 6.
//
// Genera gli ordini secondo il paniere di importi del protocollo, li paga
// tramite il contratto di inoltro e attende che il servizio di rilevamento li
// porti a conferma. L'esportazione del dataset resta un passo separato, cosi'
// da poterla ripetere senza rieseguire la campagna.
//
// La generazione e' automatica di proposito: il protocollo la indica come
// preferibile per la ripetibilita', e a mano il disegno sperimentale completo
// non sarebbe eseguibile in tempi ragionevoli.
//
// Uso:
//   node tools/local-chain/campagna.mjs --importi=10,25,50 --ripetizioni=5
//   node tools/local-chain/campagna.mjs --dry-run   (piano senza eseguire)
//
// Prerequisiti: ambiente avviato, contratto pubblicato, watcher in esecuzione
// con FORWARDER_ADDRESS coerente.
import { config } from 'dotenv';
config({ path: new URL('../../.env', import.meta.url) });

import { createWalletClient, createPublicClient, http, parseUnits, formatUnits, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// --- parametri -------------------------------------------------------------

const arg = (nome, predefinito) => {
  const v = process.argv.find((a) => a.startsWith(`--${nome}=`));
  return v ? v.split('=').slice(1).join('=') : predefinito;
};
const flag = (nome) => process.argv.includes(`--${nome}`);

// Paniere del protocollo: gli importi coprono due ordini di grandezza perche'
// le commissioni delle carte sono percentuali e quelle on-chain quasi piatte,
// ed e' li' che il punto di pareggio diventa visibile.
const IMPORTI = arg('importi', '10,25,50,100,250,500,1000,2500').split(',').map((s) => s.trim());
const RIPETIZIONI = Number(arg('ripetizioni', '30'));
const ALIQUOTA = Number(arg('aliquota', '22'));
const ATTESA_MS = Number(arg('attesa', '600000'));

// Identificativo della campagna, scritto su ogni ordine. Serve a separare
// misure prodotte da disegni sperimentali diversi: senza, una correzione al
// procedimento rende l'intero file un miscuglio di cui nessuno sa piu' dire
// quale riga sia stata prodotta come.
const CAMPAGNA = arg('campagna', new Date().toISOString().replace(/[:.]/g, '-'));

const RPC = process.env.RPC_URL;
const FORWARDER = arg('forwarder', process.env.FORWARDER_ADDRESS);
const TOKEN = arg('token', process.env.TOKEN_ADDRESS);
const CHAIN_ID = Number(arg('chain-id', process.env.CHAIN_ID ?? '31337'));
const DECIMALI = Number(process.env.TOKEN_DECIMALS ?? '18');

// Chiave del cliente che paga. Sulla chain di sviluppo e' un account di anvil,
// pubblico e privo di valore; su rete di prova va passata da shell.
const CHIAVE_CLIENTE = process.env.CAMPAGNA_PAYER_KEY
  ?? '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

const totale = IMPORTI.length * RIPETIZIONI;
console.log(`Campagna: ${IMPORTI.length} importi x ${RIPETIZIONI} ripetizioni = ${totale} ordini`);
console.log(`Rete ${RPC} (chain id ${CHAIN_ID}), contratto ${FORWARDER}`);
if (flag('dry-run')) {
  console.log('\nPiano:');
  for (const i of IMPORTI) console.log(`  ${RIPETIZIONI} ordini da ${i} EUR`);
  process.exit(0);
}

// Oltre il piano serve un ambiente pronto.
if (!FORWARDER || !TOKEN) {
  console.error('FORWARDER_ADDRESS e TOKEN_ADDRESS devono essere nel .env o passati come argomenti.');
  process.exit(1);
}

// --- creazione degli ordini ------------------------------------------------

const wp = (php) =>
  execFileSync('docker', ['compose', 'run', '--rm', '-T', 'wpcli', 'eval', php], {
    cwd: new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

// Gli ordini si creano in un'unica invocazione: ogni chiamata a wp-cli avvia
// un container, e farne una per ordine renderebbe la campagna piu' lenta
// dell'attesa delle conferme.
function creaOrdini() {
  const celle = [];
  for (const importo of IMPORTI) {
    for (let i = 0; i < RIPETIZIONI; i++) celle.push(importo);
  }

  const php = `
$g = WC()->payment_gateways()->payment_gateways()["wcsdi_eure"];
$importi = ${JSON.stringify(celle)};
foreach ( $importi as $lordo ) {
  $lordo = (float) $lordo;
  $imponibile = round( $lordo / ( 1 + ${ALIQUOTA} / 100 ), 2 );
  $imposta = round( $lordo - $imponibile, 2 );
  $o = wc_create_order();
  $o->set_currency("EUR");
  $o->set_payment_method($g);
  $o->set_address( array(
    "first_name" => "Cliente", "last_name" => "Prova",
    "address_1" => "Via del Cliente, 2", "postcode" => "00100",
    "city" => "Roma", "state" => "RM", "country" => "IT",
  ), "billing" );
  $o->update_meta_data("_wcsdi_codice_fiscale", "RSSMRA80A01H501U");
  $o->update_meta_data("_wcsdi_campagna", "${CAMPAGNA}");
  $item = new WC_Order_Item_Fee();
  $item->set_name("Transazione di campagna");
  $item->set_total($imponibile);
  $item->set_total_tax($imposta);
  $o->add_item($item);
  $o->set_total( number_format($lordo, 2, ".", "") );
  $o->save();
  $g->process_payment($o->get_id());
  $f = wc_get_order($o->get_id());
  echo $o->get_id() . " " . $f->get_meta("_wcsdi_order_ref") . " " . number_format($lordo, 2, ".", "") . "\\n";
}`;

  return wp(php)
    .split('\n')
    .map((r) => r.trim())
    .filter((r) => /^\d+ 0x[0-9a-f]{64} /i.test(r))
    .map((r) => {
      const [id, ref, importo] = r.split(/\s+/);
      return { id: Number(id), ref, importo };
    });
}

console.log('\nCreo gli ordini...');
const ordini = creaOrdini();
console.log(`  ${ordini.length} ordini creati su ${totale} attesi`);
if (ordini.length === 0) process.exit(1);

// --- pagamento -------------------------------------------------------------

const CHAIN = {
  id: CHAIN_ID,
  name: `chain-${CHAIN_ID}`,
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

const erc20 = JSON.parse(readFileSync(new URL('./erc20.json', import.meta.url)));
const fwd = JSON.parse(readFileSync(new URL('../../contracts/build/OrderForwarder.json', import.meta.url)));

const cliente = privateKeyToAccount(CHIAVE_CLIENTE);
const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const wallet = createWalletClient({ account: cliente, chain: CHAIN, transport: http(RPC) });

const somma = ordini.reduce((t, o) => t + parseUnits(o.importo, DECIMALI), 0n);

// I fondi ruotano: ogni pagamento li sposta dal cliente all'esercente, sicche'
// dopo qualche campagna il cliente resta senza. Prima di iniziare l'esercente
// gli rimette la dotazione necessaria. E' un artificio dell'ambiente di prova,
// dove le due parti sono simulate; in esercizio il cliente arriva con i propri.
const chiaveEsercente = 31337 === CHAIN_ID
  ? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
  : process.env.MERCHANT_SIGNER_PRIVATE_KEY;

if (chiaveEsercente) {
  const saldo = await pub.readContract({
    address: TOKEN, abi: erc20.abi, functionName: 'balanceOf', args: [cliente.address],
  });
  if (saldo < somma) {
    const esercente = privateKeyToAccount(chiaveEsercente);
    const w = createWalletClient({ account: esercente, chain: CHAIN, transport: http(RPC) });
    const disponibile = await pub.readContract({
      address: TOKEN, abi: erc20.abi, functionName: 'balanceOf', args: [esercente.address],
    });
    const serve = somma - saldo;
    if (disponibile < serve) {
      console.error(`
Fondi insufficienti: servono ${formatUnits(serve, DECIMALI)} EURe, l'esercente ne ha ${formatUnits(disponibile, DECIMALI)}.`);
      console.error('Ridurre il paniere o le ripetizioni.');
      process.exit(1);
    }
    console.log(`
Ricarico il cliente di ${formatUnits(serve, DECIMALI)} EURe...`);
    await pub.waitForTransactionReceipt({
      hash: await w.writeContract({
        address: TOKEN, abi: erc20.abi, functionName: 'transfer', args: [cliente.address, serve],
      }),
    });
  }
}
// L'autorizzazione e' concessa con un margine: su rete pubblica la lettura
// dello stato non e' immediatamente coerente fra i nodi dietro il medesimo
// endpoint, e un'autorizzazione esatta produce rifiuti sporadici verso la
// fine della campagna.
const autorizzato = somma * 2n;
console.log(`\nAutorizzo il contratto per ${ordini.length} pagamenti...`);
await pub.waitForTransactionReceipt({
  hash: await wallet.writeContract({
    address: TOKEN, abi: erc20.abi, functionName: 'approve', args: [FORWARDER, autorizzato],
  }),
});

// I pagamenti partono in ordine casuale, non nell'ordine in cui gli ordini
// sono stati creati. Le transazioni si inviano una dopo l'altra e ciascuna
// costa un secondo abbondante, mentre l'istante t0 e' fissato alla creazione:
// pagare il paniere in ordine crescente attribuirebbe agli importi maggiori
// una latenza sistematicamente piu' alta, che non e' una proprieta'
// dell'importo ma della sua posizione nella coda. Randomizzare converte quel
// termine sistematico in dispersione, che le ripetizioni mediano.
function mescola(v) {
  const a = v.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

console.log('Pago gli ordini in ordine casuale...');
let pagati = 0;
const falliti = [];
for (const o of mescola(ordini)) {
  // Due tentativi: il primo fallimento su rete pubblica e' quasi sempre
  // transitorio, il secondo indica una causa reale che va registrata come
  // dato, perche' il tasso di errore e' uno dei KPI da misurare.
  let ultimo = null;
  for (let tentativo = 1; tentativo <= 2; tentativo++) {
    try {
      const hash = await wallet.writeContract({
        address: FORWARDER, abi: fwd.abi, functionName: 'pay',
        args: [o.ref, parseUnits(o.importo, DECIMALI)],
      });
      await pub.waitForTransactionReceipt({ hash });
      pagati++;
      ultimo = null;
      break;
    } catch (err) {
      ultimo = (err.shortMessage ?? err.message ?? String(err)).replace(/\s+/g, ' ').slice(0, 120);
      if (tentativo < 2) await new Promise((r) => setTimeout(r, 4000));
    }
  }
  if (ultimo) falliti.push({ id: o.id, motivo: ultimo });
  process.stdout.write(`\r  ${pagati}/${ordini.length} pagati, ${falliti.length} falliti`);
}
console.log(`\n  pagati ${pagati}, falliti ${falliti.length}`);
for (const f of falliti.slice(0, 5)) console.log(`    ordine ${f.id}: ${f.motivo}`);

// --- attesa delle conferme -------------------------------------------------

// La chain di sviluppo produce blocchi solo quando riceve transazioni: gli
// ultimi pagamenti resterebbero senza la profondita' richiesta. Su una rete
// reale i blocchi arrivano comunque e il passo non serve.
if (31337 === CHAIN_ID) {
  for (let k = 0; k < 6; k++) {
    await fetch(RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'evm_mine', params: [], id: 1 }),
    });
    await new Promise((r) => setTimeout(r, 500));
  }
}

console.log('\nAttendo che il servizio confermi i pagamenti...');
const scadenza = Date.now() + ATTESA_MS;
let confermati = 0;

while (Date.now() < scadenza) {
  const out = wp(`
$ids = ${JSON.stringify(ordini.map((o) => o.id))};
$n = 0;
foreach ( $ids as $id ) {
  $o = wc_get_order($id);
  if ( $o && $o->has_status( array("processing","completed") ) ) { $n++; }
}
echo $n;`).trim();

  confermati = Number(out.match(/\d+/)?.[0] ?? 0);
  process.stdout.write(`\r  confermati ${confermati}/${pagati}`);
  if (confermati >= pagati) break;
  await new Promise((r) => setTimeout(r, 10000));
}

console.log(`\n\nCampagna conclusa: ${confermati} ordini confermati su ${ordini.length} creati.`);
console.log('Esportare il dataset con:');
console.log('  docker compose run --rm -T wpcli wcsdi export --format=csv > dataset.csv');
