// Simula il pagamento di uno o più ordini tramite il contratto di inoltro.
// Usato da tools/e2e.sh; vive qui perche' e' dove risiedono viem e gli
// artefatti della chain locale.
import { createWalletClient, createPublicClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';

const [token, forwarder, chiaveCliente, ...riferimenti] = process.argv.slice(2);
if (!token || !forwarder || !chiaveCliente || riferimenti.length === 0) {
  console.error('Uso: e2e-pay.mjs <token> <forwarder> <chiave cliente> <ref...>');
  process.exit(1);
}

const RPC = process.env.RPC_URL ?? 'http://localhost:8545';
const CHAIN = {
  id: 31337, name: 'anvil',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

const erc20 = JSON.parse(readFileSync(new URL('./erc20.json', import.meta.url)));
const fwd = JSON.parse(readFileSync(new URL('../../contracts/build/OrderForwarder.json', import.meta.url)));

const importo = parseUnits('49.90', 18);
const merchant = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const cliente = privateKeyToAccount(chiaveCliente);

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const wM = createWalletClient({ account: merchant, chain: CHAIN, transport: http(RPC) });
const wC = createWalletClient({ account: cliente, chain: CHAIN, transport: http(RPC) });
const attesa = (hash) => pub.waitForTransactionReceipt({ hash });

// Il cliente deve avere di che pagare: sulla chain locale glielo fornisce
// l'esercente, che detiene l'intera fornitura del token di prova.
const serve = importo * BigInt(riferimenti.length);
const saldo = await pub.readContract({
  address: token, abi: erc20.abi, functionName: 'balanceOf', args: [cliente.address],
});
if (saldo < serve) {
  await attesa(await wM.writeContract({
    address: token, abi: erc20.abi, functionName: 'transfer', args: [cliente.address, serve - saldo],
  }));
}

await attesa(await wC.writeContract({
  address: token, abi: erc20.abi, functionName: 'approve', args: [forwarder, serve],
}));

for (const ref of riferimenti) {
  const hash = await wC.writeContract({
    address: forwarder, abi: fwd.abi, functionName: 'pay', args: [ref, importo],
  });
  await attesa(hash);
  console.log(`   pagato ${ref.slice(0, 12)} -> ${hash.slice(0, 12)}`);
}
