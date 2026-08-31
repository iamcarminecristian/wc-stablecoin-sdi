# CLAUDE.md — wc-stablecoin-sdi (monorepo di tesi)

## Cos'è
Plugin WooCommerce per pagamenti in stablecoin EUR-pegged (EURe) con conversione automatica in EUR (rimborso alla pari via Monerium) e fatturazione elettronica automatica via SdI (openapi.it). Progetto di tesi LM-32 Unimarconi di Carmine Cristian Cruoglio; relatore Prof. Comandini. Il repo LaTeX della tesi è separato: i riferimenti RF-xx/RNF-xx e §4.x nel codice rimandano al Capitolo 4 della tesi.

## Comandi
- `make init` — prima accensione: WordPress+WooCommerce provisionati su http://localhost:8080 (admin/admin) e chain locale anvil su :8545
- `make up` / `make down` / `make nuke` — gestione ambiente
- `make demo` — deploya MockEURe sulla chain locale, simula un pagamento e mina 12 blocchi (input per lo spike 1)
- Spike: in `spikes/*/`, `cp .env.example .env` poi `npm install && npm start`

## Stato e ordine di lavoro
1. Spike 1 (rilevamento on-chain): completo, criterio di uscita verificabile con `make demo`
2. Spike 2 (redemption Monerium): auth + GET /tokens implementati; il redeem va completato sulla documentazione monerium.dev con le credenziali sandbox
3. Spike 3 (FatturaPA/SdI): generazione XML 1.9.1 completa; invio a openapi.it da completare con il token sandbox
4. Consolidamento: spike 1 → `watcher/`, spike 2-3 → `plugin/` (con Action Scheduler), poi Capitolo 5 della tesi

## Vincoli non negoziabili
- **Gate fiscale**: MP05, AltriDatiGestionali (TX-HASH/CHAIN/PAY-ADDR) e momento di effettuazione sono scelte in attesa di validazione del relatore. Non modificarle né consolidare lo spike 3 nel plugin senza indicazione esplicita di Carmine.
- **Non-custodial (RNF-02)**: mai chiavi private nel codice o nella configurazione del plugin; l'unica chiave presente nel repo è quella pubblica di default di anvil in `tools/local-chain/chain.mjs`, priva di valore.
- **Idempotenza (RNF-03)**: ogni operazione con effetti esterni deve avere chiave idempotente; per gli eventi on-chain è `txHash:logIndex`.
- **Segreti** solo in `.env` (mai committati); i `.env.example` documentano le variabili.

## Convenzioni
- Commenti e messaggi in italiano, tono asciutto; niente em dash.
- PHP: standard WordPress (escaping, sanitizzazione input REST, `hash_equals` per i segreti); compatibilità HPOS e checkout blocks già dichiarata nel bootstrap.
- JS: ESM (`.mjs`), viem per la chain, nessuna dipendenza superflua.
- Prima di ogni commit: `php -l` sui file PHP toccati e `node --check` sugli script toccati.
