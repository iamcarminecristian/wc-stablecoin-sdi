// Deploy del contratto di inoltro.
//
//   npm run deploy                       -> chain locale anvil (chiave di test)
//   DEPLOY_TARGET=live npm run deploy    -> rete configurata in RPC_URL
//
// Sulla rete reale serve una chiave con fondi per il gas, passata da shell in
// DEPLOYER_PRIVATE_KEY. Non va nel .env del repo: e' un'operazione una tantum
// dell'esercente, non una credenziale di esercizio del sistema.
import { config } from 'dotenv';
config({ path: new URL('../.env', import.meta.url) });

import { createWalletClient, createPublicClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, writeFileSync } from 'node:fs';

const LIVE = process.env.DEPLOY_TARGET === 'live';

const RPC = LIVE
  ? (process.env.RPC_URL ?? (() => { throw new Error('RPC_URL mancante'); })())
  : 'http://localhost:8545';

const CHAIN_ID = LIVE ? Number(process.env.CHAIN_ID ?? 0) : 31337;

// Chiave di default di anvil: pubblica e priva di qualunque valore.
const KEY_LOCALE = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const chiave = LIVE
  ? (process.env.DEPLOYER_PRIVATE_KEY ?? (() => {
      throw new Error('DEPLOYER_PRIVATE_KEY mancante: passarla da shell, non dal .env');
    })())
  : KEY_LOCALE;

const token = process.env.TOKEN_ADDRESS;
const merchant = process.env.WATCH_ADDRESS;
if (!token || !merchant) throw new Error('TOKEN_ADDRESS e WATCH_ADDRESS devono essere nel .env');

const CHAIN = {
  id: CHAIN_ID,
  name: LIVE ? `chain-${CHAIN_ID}` : 'anvil',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

const account = privateKeyToAccount(chiave.startsWith('0x') ? chiave : `0x${chiave}`);
const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });

// Il token e' fissato per sempre nel contratto: se l'indirizzo fosse sbagliato
// il contratto nascerebbe inservibile. Meglio accorgersene prima di spendere gas.
const simbolo = await pub.readContract({
  address: token, abi: parseAbi(['function symbol() view returns (string)']), functionName: 'symbol',
});
console.log(`Token   ${token} (${simbolo})`);
console.log(`Incasso ${merchant}`);
console.log(`Rete    ${RPC} (chain id ${CHAIN_ID})`);
console.log(`Deploy da ${account.address}\n`);

const { abi, bytecode } = JSON.parse(readFileSync(new URL('./build/OrderForwarder.json', import.meta.url)));
const hash = await wallet.deployContract({ abi, bytecode, args: [token, merchant] });
console.log(`Transazione ${hash}, attendo la conferma...`);
const rcpt = await pub.waitForTransactionReceipt({ hash });

writeFileSync(
  new URL('./build/deployment.json', import.meta.url),
  JSON.stringify({ forwarder: rcpt.contractAddress, token, merchant, chainId: CHAIN_ID, rpc: RPC }, null, 2)
);

console.log(`\n[OK] OrderForwarder deployato: ${rcpt.contractAddress}`);
console.log(`     gas usato: ${rcpt.gasUsed}`);
console.log('\nAggiungere al .env della root:');
console.log(`  FORWARDER_ADDRESS=${rcpt.contractAddress}`);
