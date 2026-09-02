// Campagna sperimentale per il Capitolo 6.
//
// Genera gli ordini secondo il paniere di importi del protocollo, li paga
// tramite il contratto di inoltro e attende che il servizio di rilevamento li
// porti a conferma e, se attivo, che il riscatto si concluda. L'esportazione
// del dataset resta un passo separato, cosi' da poterla ripetere senza
// rieseguire la campagna.
//
// La generazione e' automatica di proposito: il protocollo la indica come
// preferibile per la ripetibilita', e a mano il disegno sperimentale completo
// non sarebbe eseguibile in tempi ragionevoli.
//
// Tre modalita' di pagamento, perche' il costo per il cliente dipende da come
// concede l'autorizzazione al contratto:
//   allowance  una sola approve per l'intero lotto, poi pay per ordine.
//              E' il caso del cliente abituale. Predefinita.
//   approve    approve e pay per ogni ordine: il cliente occasionale, due
//              transazioni per acquisto.
//   permit     payWithPermit con firma EIP-2612: una sola transazione per
//              acquisto, preceduta da una firma fuori catena.
//
// Uso:
//   node tools/local-chain/campagna.mjs --importi=10,25,50 --ripetizioni=5
//   node tools/local-chain/campagna.mjs --modalita=permit --ripetizioni=2
//   node tools/local-chain/campagna.mjs --dry-run   (piano senza eseguire)
//
// Prerequisiti: ambiente avviato, contratto pubblicato, watcher in esecuzione
// con FORWARDER_ADDRESS coerente.
import { config } from 'dotenv';
config({ path: new URL('../../.env', import.meta.url) });

import { createWalletClient, createPublicClient, http, parseUnits, formatUnits, parseAbi, parseSignature } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';

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
const ATTESA_MS = Number(arg('attesa', '900000'));
const ATTESA_RISCATTI_MS = Number(arg('attesa-riscatti', '900000'));
const MODALITA = arg('modalita', 'allowance');
if (!['allowance', 'approve', 'permit'].includes(MODALITA)) {
  console.error(`Modalita' non riconosciuta: ${MODALITA} (attese allowance, approve, permit)`);
  process.exit(1);
}

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
// pubblico e privo di valore; su qualsiasi altra rete va fornita, perche' un
// ripiego silenzioso su una chiave nota manderebbe fondi veri a un indirizzo
// che chiunque puo' svuotare.
const CHIAVE_CLIENTE = process.env.CAMPAGNA_PAYER_KEY
  ?? (31337 === CHAIN_ID ? '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' : null);

const radice = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const totale = IMPORTI.length * RIPETIZIONI;
console.log(`Campagna ${CAMPAGNA}: ${IMPORTI.length} importi x ${RIPETIZIONI} ripetizioni = ${totale} ordini, modalita' ${MODALITA}`);
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
if (!CHIAVE_CLIENTE) {
  console.error('CAMPAGNA_PAYER_KEY manca: su una rete diversa da anvil la chiave del cliente va fornita.');
  process.exit(1);
}

// --- creazione degli ordini ------------------------------------------------

const wp = (php) =>
  execFileSync('docker', ['compose', 'run', '--rm', '-T', 'wpcli', 'eval', php], {
    cwd: radice,
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

  // L'imposta di una riga vive nell'array delle tasse per aliquota, non nel
  // solo totale: set_total_tax da solo non sopravvive al salvataggio, e una
  // riga senza aliquota e' una riga a IVA zero, che il composer rifiuta in
  // assenza di Natura. L'aliquota di campagna e' registrata una volta nel
  // negozio e riusata.
  const php = `
$g = WC()->payment_gateways()->payment_gateways()["wcsdi_eure"];
$importi = ${JSON.stringify(celle)};
$rate_id = (int) get_option("wcsdi_campagna_rate_${ALIQUOTA}", 0);
if ( ! $rate_id || ! WC_Tax::_get_tax_rate( $rate_id ) ) {
  $rate_id = (int) WC_Tax::_insert_tax_rate( array(
    "tax_rate_country" => "IT", "tax_rate_state" => "", "tax_rate" => "${ALIQUOTA.toFixed(4)}",
    "tax_rate_name" => "IVA", "tax_rate_priority" => 1, "tax_rate_compound" => 0,
    "tax_rate_shipping" => 1, "tax_rate_order" => 0, "tax_rate_class" => "",
  ) );
  update_option("wcsdi_campagna_rate_${ALIQUOTA}", $rate_id, false);
}
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
  $o->update_meta_data("_wcsdi_tipo_cliente", "privato");
  $o->update_meta_data("_wcsdi_richiedi_fattura", "yes");
  $o->update_meta_data("_wcsdi_campagna", "${CAMPAGNA}");
  $o->update_meta_data("_wcsdi_modalita_pagamento", "${MODALITA}");
  $item = new WC_Order_Item_Fee();
  $item->set_name("Transazione di campagna");
  $item->set_total($imponibile);
  $item->set_taxes( array( "total" => array( $rate_id => $imposta ) ) );
  $o->add_item($item);
  $o->set_cart_tax( number_format($imposta, 2, ".", "") );
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
const permitAbi = parseAbi([
  'function nonces(address owner) view returns (uint256)',
  'function name() view returns (string)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
]);

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
      console.error(`\nFondi insufficienti: servono ${formatUnits(serve, DECIMALI)} EURe, l'esercente ne ha ${formatUnits(disponibile, DECIMALI)}.`);
      console.error('Ridurre il paniere o le ripetizioni.');
      process.exit(1);
    }
    console.log(`\nRicarico il cliente di ${formatUnits(serve, DECIMALI)} EURe...`);
    await pub.waitForTransactionReceipt({
      hash: await w.writeContract({
        address: TOKEN, abi: erc20.abi, functionName: 'transfer', args: [cliente.address, serve],
      }),
    });
  }
}

// --- misure laterali: gas per transazione e istante di invio ---------------

// Il dataset principale porta il costo della sola transazione di pagamento,
// letto dal servizio. Il costo dell'autorizzazione, che il cliente paga a
// parte, e l'istante in cui la transazione e' stata inviata vivono in un file
// affiancato, chiave l'ordine.
const FILE_GAS = `${radice}/docs/dataset/gas-${CAMPAGNA}.csv`;
const COLONNE_GAS = 'campagna,order_id,order_ref,modalita,t_invio,tx_approve,gas_approve,prezzo_approve_wei,l1_fee_approve_wei,tx_pay,gas_pay,prezzo_pay_wei,l1_fee_pay_wei,esito';
mkdirSync(`${radice}/docs/dataset`, { recursive: true });
if (!existsSync(FILE_GAS)) appendFileSync(FILE_GAS, COLONNE_GAS + '\n');

async function ricevutaGrezza(hash) {
  // La ricevuta grezza porta anche l1Fee sulle reti OP Stack, che viem non
  // espone senza i formattatori della catena.
  const r = await pub.request({ method: 'eth_getTransactionReceipt', params: [hash] });
  return {
    ok: r && BigInt(r.status) === 1n,
    gas: r ? BigInt(r.gasUsed).toString() : '',
    prezzo: r?.effectiveGasPrice ? BigInt(r.effectiveGasPrice).toString() : '',
    l1: r?.l1Fee ? BigInt(r.l1Fee).toString() : '',
  };
}

function registraGas(o, r) {
  const riga = [CAMPAGNA, o.id, o.ref, MODALITA, r.tInvio ?? '',
    r.txApprove ?? '', r.gasApprove ?? '', r.prezzoApprove ?? '', r.l1Approve ?? '',
    r.txPay ?? '', r.gasPay ?? '', r.prezzoPay ?? '', r.l1Pay ?? '', r.esito ?? ''];
  appendFileSync(FILE_GAS, riga.join(',') + '\n');
}

// L'istante di invio (ti) si scrive sull'ordine a lotti: una chiamata a
// wp-cli per pagamento costerebbe piu' del pagamento stesso. Il marcatore
// e' comunque preso prima dell'invio, non al momento della scrittura.
const tiDaScrivere = new Map();
function scriviTi(forza = false) {
  if (tiDaScrivere.size === 0 || (!forza && tiDaScrivere.size < 8)) return;
  // Il JSON passa per json_decode: un oggetto JSON non e' un letterale PHP.
  const php = `
$m = json_decode( '${JSON.stringify(Object.fromEntries(tiDaScrivere))}', true );
foreach ( $m as $id => $ts ) {
  $o = wc_get_order( (int) $id );
  if ( $o ) { WCSDI_Misure::segna( $o, 'ti', (float) $ts ); $o->save(); }
}
echo count($m);`;
  try {
    wp(php);
    tiDaScrivere.clear();
  } catch (err) {
    console.error(`\n  scrittura di ti rinviata: ${(err.message ?? String(err)).slice(0, 120)}`);
  }
}

// --- autorizzazione --------------------------------------------------------

let dominioPermit = null;
async function dominio() {
  if (dominioPermit) return dominioPermit;
  try {
    const d = await pub.readContract({ address: TOKEN, abi: permitAbi, functionName: 'eip712Domain' });
    dominioPermit = { name: d[1], version: d[2], chainId: Number(d[3]), verifyingContract: d[4] };
  } catch {
    // Token senza ERC-5267: si assume la versione 1, che e' quella di EURe.
    const name = await pub.readContract({ address: TOKEN, abi: permitAbi, functionName: 'name' });
    dominioPermit = { name, version: '1', chainId: CHAIN_ID, verifyingContract: TOKEN };
  }
  return dominioPermit;
}

async function firmaPermit(valore, deadline) {
  const nonce = await pub.readContract({ address: TOKEN, abi: permitAbi, functionName: 'nonces', args: [cliente.address] });
  const firma = await cliente.signTypedData({
    domain: await dominio(),
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    message: { owner: cliente.address, spender: FORWARDER, value: valore, nonce, deadline },
  });
  const s = parseSignature(firma);
  return { v: Number(s.v ?? (27n + BigInt(s.yParity ?? 0))), r: s.r, s: s.s };
}

if ('allowance' === MODALITA) {
  // L'autorizzazione e' concessa con un margine: su rete pubblica la lettura
  // dello stato non e' immediatamente coerente fra i nodi dietro il medesimo
  // endpoint, e un'autorizzazione esatta produce rifiuti sporadici verso la
  // fine della campagna.
  const autorizzato = somma * 2n;
  console.log(`\nAutorizzo il contratto per ${ordini.length} pagamenti...`);
  const hash = await wallet.writeContract({
    address: TOKEN, abi: erc20.abi, functionName: 'approve', args: [FORWARDER, autorizzato],
  });
  await pub.waitForTransactionReceipt({ hash });
  const r = await ricevutaGrezza(hash);
  registraGas({ id: '', ref: '' }, { txApprove: hash, gasApprove: r.gas, prezzoApprove: r.prezzo, l1Approve: r.l1, esito: 'approve-lotto' });
}

// --- pagamento -------------------------------------------------------------

// I pagamenti partono in ordine casuale, non nell'ordine in cui gli ordini
// sono stati creati. Le transazioni si inviano una dopo l'altra e ciascuna
// costa un secondo abbondante, mentre l'istante t0 e' fissato alla creazione:
// pagare il paniere in ordine crescente attribuirebbe agli importi maggiori
// una latenza sistematicamente piu' alta, che non e' una proprieta'
// dell'importo ma della sua posizione nella coda. Randomizzare converte quel
// termine sistematico in dispersione, che le ripetizioni mediano; il
// marcatore ti, preso all'invio, permette comunque di separare la coda dello
// script dalla latenza di inclusione.
function mescola(v) {
  const a = v.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function paga(o) {
  const valore = parseUnits(o.importo, DECIMALI);
  const misura = { tInvio: null };

  if ('approve' === MODALITA) {
    misura.tInvio = Date.now() / 1000;
    const hashA = await wallet.writeContract({
      address: TOKEN, abi: erc20.abi, functionName: 'approve', args: [FORWARDER, valore],
    });
    await pub.waitForTransactionReceipt({ hash: hashA });
    const ra = await ricevutaGrezza(hashA);
    Object.assign(misura, { txApprove: hashA, gasApprove: ra.gas, prezzoApprove: ra.prezzo, l1Approve: ra.l1 });
  }

  let hash;
  if ('permit' === MODALITA) {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const { v, r, s } = await firmaPermit(valore, deadline);
    misura.tInvio = Date.now() / 1000;
    hash = await wallet.writeContract({
      address: FORWARDER, abi: fwd.abi, functionName: 'payWithPermit',
      args: [o.ref, valore, deadline, v, r, s],
    });
  } else {
    misura.tInvio = misura.tInvio ?? Date.now() / 1000;
    hash = await wallet.writeContract({
      address: FORWARDER, abi: fwd.abi, functionName: 'pay', args: [o.ref, valore],
    });
  }
  await pub.waitForTransactionReceipt({ hash });
  const rp = await ricevutaGrezza(hash);
  Object.assign(misura, { txPay: hash, gasPay: rp.gas, prezzoPay: rp.prezzo, l1Pay: rp.l1, esito: rp.ok ? 'ok' : 'revert' });
  if (!rp.ok) throw new Error('transazione di pagamento respinta dalla rete');
  return misura;
}

console.log(`Pago gli ordini in ordine casuale (modalita' ${MODALITA})...`);
let pagati = 0;
const falliti = [];
for (const o of mescola(ordini)) {
  // Due tentativi: il primo fallimento su rete pubblica e' quasi sempre
  // transitorio, il secondo indica una causa reale che va registrata come
  // dato, perche' il tasso di errore e' uno dei KPI da misurare.
  let ultimo = null;
  let primoInvio = null;
  for (let tentativo = 1; tentativo <= 2; tentativo++) {
    try {
      const m = await paga(o);
      // Il primo invio vince: un secondo tentativo non deve accorciare la
      // latenza misurata.
      primoInvio = primoInvio ?? m.tInvio;
      m.tInvio = primoInvio;
      registraGas(o, m);
      tiDaScrivere.set(String(o.id), primoInvio);
      pagati++;
      ultimo = null;
      break;
    } catch (err) {
      ultimo = (err.shortMessage ?? err.message ?? String(err)).replace(/\s+/g, ' ').slice(0, 120);
      primoInvio = primoInvio ?? Date.now() / 1000;
      if (tentativo < 2) await new Promise((r) => setTimeout(r, 4000));
    }
  }
  if (ultimo) {
    falliti.push({ id: o.id, motivo: ultimo });
    registraGas(o, { tInvio: primoInvio, esito: `fallito: ${ultimo.replace(/,/g, ';')}` });
  }
  scriviTi();
  process.stdout.write(`\r  ${pagati}/${ordini.length} pagati, ${falliti.length} falliti`);
}
scriviTi(true);
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

const ids = ordini.map((o) => o.id);
const conta = (condizione) => {
  const out = wp(`
$ids = ${JSON.stringify(ids)};
$n = 0;
foreach ( $ids as $id ) {
  $o = wc_get_order($id);
  if ( $o && ( ${condizione} ) ) { $n++; }
}
echo $n;`).trim();
  return Number(out.match(/\d+$/)?.[0] ?? 0);
};

console.log('\nAttendo che il servizio confermi i pagamenti...');
let scadenza = Date.now() + ATTESA_MS;
let confermati = 0;
while (Date.now() < scadenza) {
  confermati = conta('$o->has_status( array("processing","completed") )');
  process.stdout.write(`\r  confermati ${confermati}/${pagati}`);
  if (confermati >= pagati) break;
  await new Promise((r) => setTimeout(r, 10000));
}

// Il riscatto segue la conferma e il suo esito e' il marcatore t5: senza
// attenderlo le ultime righe della campagna resterebbero senza regolamento.
const RISCATTO_ATTIVO = (process.env.AUTO_REDEEM ?? 'true') !== 'false' && !flag('senza-riscatti');
let riscattati = 0;
if (RISCATTO_ATTIVO && confermati > 0) {
  console.log('\nAttendo la conclusione dei riscatti...');
  scadenza = Date.now() + ATTESA_RISCATTI_MS;
  while (Date.now() < scadenza) {
    riscattati = conta('in_array( $o->get_meta("_wcsdi_riscatto_stato"), array("processed","rejected","declined","failed"), true )');
    process.stdout.write(`\r  riscatti conclusi ${riscattati}/${confermati}`);
    if (riscattati >= confermati) break;
    await new Promise((r) => setTimeout(r, 10000));
  }
}

console.log(`\n\nCampagna conclusa: ${confermati} ordini confermati su ${ordini.length} creati${RISCATTO_ATTIVO ? `, ${riscattati} riscatti conclusi` : ''}.`);
console.log(`Misure di gas e istanti di invio in ${FILE_GAS}`);
console.log('Esportare il dataset con:');
console.log('  docker compose run --rm -T wpcli wcsdi export --format=csv > dataset.csv');
