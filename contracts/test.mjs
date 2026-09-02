// Verifica del contratto di inoltro sulla chain locale (anvil).
// Prerequisito: `make up` (o `docker compose up -d anvil`).
//
// Copre il caso nominale e le tre invarianti che rendono il contratto
// utilizzabile in produzione: correlazione esatta, assenza di custodia,
// rifiuto degli input degeneri.
import { createWalletClient, createPublicClient, http, parseUnits, parseEventLogs, keccak256, toHex, parseSignature } from 'viem';
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
const deveFallire = async (args, descrizione, functionName = 'pay') => {
  try {
    await pub.simulateContract({ address: fwdAddr, abi: forwarder.abi, functionName, args, account: cliente });
    check(false, descrizione);
  } catch { check(true, descrizione); }
};
await deveFallire([refA, 0n], 'importo nullo rifiutato');
await deveFallire([`0x${'00'.repeat(32)}`, importo], 'riferimento ordine nullo rifiutato');
await deveFallire([keccak256(toHex('wc-order-9999')), parseUnits('999999', 18)],
  'importo oltre il saldo del cliente rifiutato');

// --- payWithPermit -----------------------------------------------------------
// MockEURe implementa EIP-2612: qui si esercita davvero la funzione, mai
// toccata finche' il token di prova non firmava permit.
console.log('\npayWithPermit');

// Il dominio si legge dal token (ERC-5267), come fa lo script di campagna:
// non si hardcodano nome e versione nel test.
const dominioGrezzo = await pub.readContract({ address: tokenAddr, abi: erc20.abi, functionName: 'eip712Domain' });
const dominioPermit = {
  name: dominioGrezzo[1],
  version: dominioGrezzo[2],
  chainId: Number(dominioGrezzo[3]),
  verifyingContract: dominioGrezzo[4],
};
const tipiPermit = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};
const scadenzaPermit = BigInt(Math.floor(Date.now() / 1000) + 3600);
const nonceOf = (indirizzo) =>
  pub.readContract({ address: tokenAddr, abi: erc20.abi, functionName: 'nonces', args: [indirizzo] });
// Firma corrotta di proposito: r ed s nulli fanno restituire l'indirizzo
// zero a ecrecover, che non coincide mai con il firmatario atteso.
const firmaFinta = { v: 27, r: `0x${'00'.repeat(32)}`, s: `0x${'00'.repeat(32)}` };

// (a) firma valida, senza approve preventiva: il permit deve bastare da solo.
const importoPermitOk = parseUnits('5', 18);
const refPermitOk = keccak256(toHex('wc-order-permit-ok'));
const nonceIniziale = await nonceOf(cliente.address);

const firmaValida = await cliente.signTypedData({
  domain: dominioPermit, types: tipiPermit, primaryType: 'Permit',
  message: { owner: cliente.address, spender: fwdAddr, value: importoPermitOk, nonce: nonceIniziale, deadline: scadenzaPermit },
});
const componentiFirma = parseSignature(firmaValida);
const permitV = Number(componentiFirma.v ?? (27n + BigInt(componentiFirma.yParity ?? 0)));

const rPermitOk = await attesa(await wC.writeContract({
  address: fwdAddr, abi: forwarder.abi, functionName: 'payWithPermit',
  args: [refPermitOk, importoPermitOk, scadenzaPermit, permitV, componentiFirma.r, componentiFirma.s],
}));
const evPermitOk = parseEventLogs({ abi: forwarder.abi, eventName: 'OrderPaid', logs: rPermitOk.logs })[0];
check(rPermitOk.status === 'success', 'payWithPermit con firma valida e senza approve preventiva riesce');
check(!!evPermitOk && evPermitOk.args.orderRef === refPermitOk && evPermitOk.args.amount === importoPermitOk,
  "l'evento OrderPaid viene emesso con riferimento e importo corretti");
check((await nonceOf(cliente.address)) === nonceIniziale + 1n,
  'il nonce del cliente sale di uno dopo un permit riuscito');

// (b) firma non valida ma con allowance gia' concessa: il permit fallisce in
// silenzio (try/catch voluto) e il pagamento riesce comunque sull'allowance.
const importoFallback = parseUnits('5', 18);
const refFallback = keccak256(toHex('wc-order-permit-fallback'));
const nonceAncoraFermo = await nonceOf(cliente.address);

await attesa(await wC.writeContract({
  address: tokenAddr, abi: erc20.abi, functionName: 'approve', args: [fwdAddr, importoFallback],
}));
const rFallback = await attesa(await wC.writeContract({
  address: fwdAddr, abi: forwarder.abi, functionName: 'payWithPermit',
  args: [refFallback, importoFallback, scadenzaPermit, firmaFinta.v, firmaFinta.r, firmaFinta.s],
}));
const evFallback = parseEventLogs({ abi: forwarder.abi, eventName: 'OrderPaid', logs: rFallback.logs })[0];
check(rFallback.status === 'success',
  "payWithPermit con firma non valida ma allowance gia' concessa riesce comunque");
check(!!evFallback && evFallback.args.orderRef === refFallback,
  "l'evento OrderPaid viene emesso anche quando il permit fallisce in silenzio");
check((await nonceOf(cliente.address)) === nonceAncoraFermo,
  'il nonce non sale: il permit fallito non produce effetti');

// (c) firma non valida e nessuna allowance: qui il permit fallito non ha
// nulla da cui ripiegare, e la transazione fallisce per intero.
const importoSenzaAllowance = parseUnits('5', 18);
const refSenzaAllowance = keccak256(toHex('wc-order-permit-fallisce'));
await deveFallire(
  [refSenzaAllowance, importoSenzaAllowance, scadenzaPermit, firmaFinta.v, firmaFinta.r, firmaFinta.s],
  'payWithPermit con firma non valida e senza allowance fallisce',
  'payWithPermit'
);

console.log(`\n${falliti === 0 ? 'Tutte le verifiche superate.' : `${falliti} verifiche fallite.`}`);
process.exit(falliti === 0 ? 0 : 1);
