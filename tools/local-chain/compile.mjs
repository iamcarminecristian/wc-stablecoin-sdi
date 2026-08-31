// Rigenera erc20.json (abi + bytecode) da contracts/MockEURe.sol.
// L'artefatto è versionato nel repo: eseguire solo se si modifica il contratto.
import solc from 'solc';
import { readFileSync, writeFileSync } from 'node:fs';

const source = readFileSync(new URL('./contracts/MockEURe.sol', import.meta.url), 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'MockEURe.sol': { content: source } },
  settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
if (out.errors?.some((e) => e.severity === 'error')) {
  console.error(out.errors); process.exit(1);
}
const c = out.contracts['MockEURe.sol'].MockEURe;
writeFileSync(new URL('./erc20.json', import.meta.url),
  JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2));
console.log('[OK] erc20.json rigenerato');
