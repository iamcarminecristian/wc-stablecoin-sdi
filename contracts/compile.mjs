// Compila src/OrderForwarder.sol in build/OrderForwarder.json (abi + bytecode).
// L'artefatto e' versionato: eseguire solo dopo aver modificato il contratto.
import solc from 'solc';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const NOME = 'OrderForwarder';
const source = readFileSync(new URL(`./src/${NOME}.sol`, import.meta.url), 'utf8');

const input = {
  language: 'Solidity',
  sources: { [`${NOME}.sol`]: { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errori = out.errors?.filter((e) => e.severity === 'error') ?? [];
if (errori.length) {
  for (const e of errori) console.error(e.formattedMessage);
  process.exit(1);
}
for (const a of out.errors ?? []) console.warn(a.formattedMessage);

const c = out.contracts[`${NOME}.sol`][NOME];
mkdirSync(new URL('./build/', import.meta.url), { recursive: true });
writeFileSync(
  new URL(`./build/${NOME}.json`, import.meta.url),
  JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2)
);

const kb = (c.evm.bytecode.object.length / 2 / 1024).toFixed(2);
console.log(`[OK] build/${NOME}.json rigenerato (${kb} KB di bytecode)`);
