# WC Stablecoin SdI — monorepo di tesi

Plugin WooCommerce per pagamenti in stablecoin EUR-pegged (EURe) con conversione automatica in EUR e fatturazione elettronica via SdI, più servizio di rilevamento, chain locale di sviluppo e spike tecnici. Progetto di tesi LM-32, Università degli Studi Guglielmo Marconi.

## Struttura

```
plugin/             plugin WooCommerce (PHP): gateway, endpoint REST, configurazione
watcher/            servizio Node di rilevamento (nasce dal consolidamento dello spike 1)
spikes/             tre spike isolati, in ordine, ciascuno con criterio di uscita
tools/local-chain/  MockEURe + script di deploy e pagamento simulato su anvil
docker-compose.yml  WordPress+WooCommerce, chain EVM locale, watcher (profilo full)
CLAUDE.md           istruzioni di progetto per sessioni Claude Code / Cowork
```

## Ambiente in pochi comandi

Prerequisiti: Docker (con Compose v2), Node 20+, make.

```bash
make init    # prima accensione: container + provisioning WordPress/WooCommerce
make demo    # deploya MockEURe sulla chain locale e simula un pagamento confermato
```

Fatto: negozio su http://localhost:8080/wp-admin (admin / admin), gateway da abilitare in WooCommerce → Impostazioni → Pagamenti, chain locale su http://localhost:8545. Poi `make up` / `make down` per accendere e spegnere, `make nuke` per ripartire da zero.

## Spike (ordine di esecuzione)

1. **01-onchain-detection**: eseguibile subito, anche offline. `make demo` stampa `TOKEN_ADDRESS`; in `spikes/01-onchain-detection`: `cp .env.example .env` (RPC http://localhost:8545, WATCH_ADDRESS = account #1 di anvil), `npm install && npm start`, poi rilanciare `make demo` in un altro terminale. Uscita attesa: riga `[CONFERMATO]` con profondità 12.
2. **02-monerium-redemption**: richiede credenziali sandbox monerium.dev. Auth e `GET /tokens` già implementati (l'output fornisce gli indirizzi EURe reali per testare lo spike 1 su testnet); redeem da completare sulla documentazione corrente. Uscita: ordine di redemption a stato finale in sandbox.
3. **03-fatturapa-sdi**: genera subito la fattura di esempio in `out/` (tracciato 1.9.1, mappatura §4.5: TD01, EUR, MP05, riferimenti on-chain in AltriDatiGestionali dentro DettaglioLinee); invio al SdI di test da completare dopo l'attivazione openapi.it. Uscita: ricevuta di consegna dal SdI di test.

**Gate fiscale**: le scelte MP05 / AltriDatiGestionali / momento di effettuazione sono in attesa di validazione del relatore; non consolidare lo spike 3 nel plugin prima dell'ok (vedi CLAUDE.md).

## Collegamento con la tesi

I requisiti citati nel codice (RF-xx, RNF-xx) e i riferimenti §4.x rimandano al Capitolo 4 della tesi (repository LaTeX separato).
