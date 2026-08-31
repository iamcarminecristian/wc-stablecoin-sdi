// Simula un pagamento: transfer di PAY_AMOUNT EURe verso WATCH_ADDRESS,
// poi mina CONFIRMATIONS blocchi per far scattare la finalità nello spike 1.
import { createWalletClient, createPublicClient, createTestClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { RPC, CHAIN, DEPLOYER_KEY, DEFAULT_WATCH } from './chain.mjs';

const WATCH = process.env.WATCH_ADDRESS ?? DEFAULT_WATCH;
const AMOUNT = process.env.PAY_AMOUNT ?? '100';
const CONF = Number(process.env.CONFIRMATIONS ?? '12');

const { abi } = JSON.parse(readFileSync(new URL('./erc20.json', import.meta.url)));
const { token } = JSON.parse(readFileSync(new URL('./deployment.json', import.meta.url)));

const account = privateKeyToAccount(DEPLOYER_KEY);
const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });
const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });

const hash = await wallet.writeContract({
  address: token, abi, functionName: 'transfer', args: [WATCH, parseUnits(AMOUNT, 18)],
});
const rcpt = await pub.waitForTransactionReceipt({ hash });
console.log(`[OK] pagati ${AMOUNT} EURe a ${WATCH} (tx ${hash}, blocco ${rcpt.blockNumber})`);

const test = createTestClient({ mode: 'anvil', chain: CHAIN, transport: http(RPC) });
await test.mine({ blocks: CONF });
console.log(`[OK] minati ${CONF} blocchi: la finalità dello spike 1 può scattare`);
