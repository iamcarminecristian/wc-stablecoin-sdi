// Watcher: da implementare consolidando lo spike 1 (vedi spikes/01-onchain-detection).
// Responsabilità: registro ordini in attesa, osservazione eventi Transfer,
// criterio di finalità per rete, notifica idempotente al plugin via REST.
//
// Consolidando anche lo spike 2, questo processo diventa l'unico punto del
// sistema che detiene la capacità di firma del merchant per il redemption
// Monerium. E' una scelta deliberata: sta fuori dal container WordPress e non
// espone porte pubbliche, mentre il plugin PHP resta senza chiavi. Vedi
// "Capacità di firma" in CLAUDE.md e docs/sessioni/2026-08-31.md.
console.log('wcsdi-watcher: consolidare dallo spike 1.');
