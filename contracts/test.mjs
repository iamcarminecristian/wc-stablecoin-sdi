// Verifica del contratto di inoltro sulla chain locale (anvil).
// Prerequisito: `make up` (o `docker compose up -d anvil`).
//
// Copre il caso nominale e le tre invarianti che rendono il contratto
// utilizzabile in produzione: correlazione esatta, assenza di custodia,
// rifiuto degli input degeneri.
import { createWalletClient, createPublicClient, http, parseUnits, parseEventLogs, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';

const RPC = process.env.RPC_URL ?? 'http://localhost:8545';
const CHAIN = {
  id: 31337, name: 'anvil',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};
// Chiavi di default di anvil: pubbliche e prive di qualunque valore.
const KEY_MERCHANT = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const KEY_CLIENTE  = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

const forwarder = JSON.parse(readFileSync(new URL('./build/OrderForwarder.json', import.meta.url)));
const erc20 = JSON.parse(readFileSync(new URL('../tools/local-chain/erc20.json', import.meta.url)));

const merchant = privateKeyToAccount(KEY_MERCHANT);
const cliente  = privateKeyToAccount(KEY_CLIENTE);
const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const wM = createWalletClient({ account: merchant, chain: CHAIN, transport: http(RPC) });
const wC = createWalletClient({ account: cliente,  chain: CHAIN, transport: http(RPC) });

let falliti = 0;
const check = (esito, descrizione) => {
  console.log(`  ${esito ? 'OK  ' : 'FAIL'} ${descrizione}`);
  if (!esito) falliti++;
};
const attesa = (hash) => pub.waitForTransactionReceipt({ hash });

// --- allestimento -----------------------------------------------------------
const tokenAddr = await attesa(await wM.deployContract({
  abi: erc20.abi, bytecode: erc20.bytecode, args: [parseUnits('1000000', 18)],
})).then((r) => r.contractAddress);

const fwdAddr = await attesa(await wM.deployContract({
  abi: forwarder.abi, bytecode: forwarder.bytecode, args: [tokenAddr, merchant.address],
})).then((r) => r.contractAddress);

console.log(`Token   ${tokenAddr}`);
console.log(`Inoltro ${fwdAddr}`);
console.log(`Esercente ${merchant.address}`);
console.log(`Cliente   ${cliente.address}\n`);

// Il cliente riceve fondi dall'esercente per poter pagare.
const dotazione = parseUnits('1000', 18);
await attesa(await wM.writeContract({
  address: tokenAddr, abi: erc20.abi, functionName: 'transfer', args: [cliente.address, dotazione],
}));

const saldo = (a) => pub.readContract({ address: tokenAddr, abi: erc20.abi, functionName: 'balanceOf', args: [a] });
const saldoMerchantIniziale = await saldo(merchant.address);

// --- caso nominale ----------------------------------------------------------
console.log('Caso nominale: due ordini di pari importo nella stessa finestra');

const importo = parseUnits('49.90', 18);
const refA = keccak256(toHex('wc-order-1001'));
const refB = keccak256(toHex('wc-order-1002'));

await attesa(await wC.writeContract({
  address: tokenAddr, abi: erc20.abi, functionName: 'approve', args: [fwdAddr, importo * 2n],
}));

const rA = await attesa(await wC.writeContract({
  address: fwdAddr, abi: forwarder.abi, functionName: 'pay', args: [refA, importo],
}));
const rB = await attesa(await wC.writeContract({
  address: fwdAddr, abi: forwarder.abi, functionName: 'pay', args: [refB, importo],
}));

const evA = parseEventLogs({ abi: forwarder.abi, eventName: 'OrderPaid', logs: rA.logs })[0];
const evB = parseEventLogs({ abi: forwarder.abi, eventName: 'OrderPaid', logs: rB.logs })[0];

check(evA.args.orderRef === refA, 'il primo pagamento porta il riferimento del proprio ordine');
check(evB.args.orderRef === refB, 'il secondo pagamento porta un riferimento distinto');
check(evA.args.amount === importo && evB.args.amount === importo,
  'i due ordini hanno importo identico e restano comunque distinguibili');
check(evA.args.payer === cliente.address, "l'evento registra chi ha pagato");

// La correlazione deve reggere anche interrogando la catena a posteriori,
// che e' come lavora il servizio di rilevamento.
const logsB = await pub.getLogs({
  address: fwdAddr,
  event: forwarder.abi.find((x) => x.type === 'event' && x.name === 'OrderPaid'),
  args: { orderRef: refB },
  fromBlock: 0n,
});
check(logsB.length === 1 && logsB[0].transactionHash === rB.transactionHash,
  'il filtro per singolo ordine restituisce esattamente il suo pagamento');

// --- assenza di custodia ----------------------------------------------------
console.log('\nInvariante non-custodial');
check((await saldo(fwdAddr)) === 0n, 'il contratto di inoltro non trattiene alcun token');
check((await saldo(merchant.address)) - saldoMerchantIniziale === importo * 2n,
  "l'intero importo e' arrivato all'esercente");

// --- input degeneri ---------------------------------------------------------
console.log('\nRifiuto degli input non validi');
const deveFallire = async (args, descrizione) => {
  try {
    await pub.simulateContract({ address: fwdAddr, abi: forwarder.abi, functionName: 'pay', args, account: cliente });
    check(false, descrizione);
  } catch { check(true, descrizione); }
};
await deveFallire([refA, 0n], 'importo nullo rifiutato');
await deveFallire([`0x${'00'.repeat(32)}`, importo], 'riferimento ordine nullo rifiutato');
await deveFallire([keccak256(toHex('wc-order-9999')), parseUnits('999999', 18)],
  'importo oltre il saldo del cliente rifiutato');

console.log(`\n${falliti === 0 ? 'Tutte le verifiche superate.' : `${falliti} verifiche fallite.`}`);
process.exit(falliti === 0 ? 0 : 1);
