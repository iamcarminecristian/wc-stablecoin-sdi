// Deploya MockEURe sulla chain locale e salva l'indirizzo in deployment.json.
import { createWalletClient, createPublicClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, writeFileSync } from 'node:fs';
import { RPC, CHAIN, DEPLOYER_KEY } from './chain.mjs';

const { abi, bytecode } = JSON.parse(readFileSync(new URL('./erc20.json', import.meta.url)));
const account = privateKeyToAccount(DEPLOYER_KEY);
const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });
const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });

const hash = await wallet.deployContract({ abi, bytecode, args: [parseUnits('1000000', 18)] });
const rcpt = await pub.waitForTransactionReceipt({ hash });
writeFileSync(new URL('./deployment.json', import.meta.url),
  JSON.stringify({ token: rcpt.contractAddress, rpc: RPC }, null, 2));

console.log('[OK] MockEURe deployato:', rcpt.contractAddress);
console.log('Variabili per spikes/01-onchain-detection/.env:');
console.log(`  RPC_URL=${RPC}`);
console.log(`  TOKEN_ADDRESS=${rcpt.contractAddress}`);
console.log('  WATCH_ADDRESS=<indirizzo di incasso, es. account #1 di anvil>');
