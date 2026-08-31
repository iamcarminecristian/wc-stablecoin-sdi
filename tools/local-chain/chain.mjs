// Config condivisa per gli script della chain locale (anvil).
export const RPC = process.env.RPC_URL ?? 'http://localhost:8545';
export const CHAIN = {
  id: 31337,
  name: 'anvil',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};
// Chiavi di default di anvil: pubbliche e prive di qualunque valore reale.
export const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // account #0
export const DEFAULT_WATCH = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // account #1
