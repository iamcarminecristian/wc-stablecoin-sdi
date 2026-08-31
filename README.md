# WC Stablecoin SdI — monorepo di tesi

Plugin WooCommerce per pagamenti in stablecoin EUR-pegged (EURe) con conversione automatica in EUR e fatturazione elettronica via SdI, più servizio di rilevamento, chain locale di sviluppo e spike tecnici. Progetto di tesi LM-32, Università degli Studi Guglielmo Marconi.

## Struttura

```
plugin/             plugin WooCommerce (PHP): gateway, endpoint REST, configurazione
contracts/          contratto di inoltro dei pagamenti (Solidity) + compile, deploy, test
watcher/            servizio Node di rilevamento: osserva, conferma, notifica, rimborsa
spikes/             tre spike isolati, in ordine, ciascuno con criterio di uscita
tools/local-chain/  MockEURe + script di deploy e pagamento simulato su anvil
docker-compose.yml  WordPress+WooCommerce, chain EVM locale, watcher (profilo full)
docs/sessioni/      note delle sessioni di lavoro sui sandbox esterni
CLAUDE.md           istruzioni di progetto per sessioni Claude Code / Cowork
```

## Configurazione

Un solo file per tutto il monorepo, alla root: `cp .env.example .env` e compilare
i valori. Gli spike lo caricano per path relativo al proprio file, non dalla cwd,
quindi partono sia dalla loro directory sia dalla root del repo. `.env` e' escluso
da `.gitignore`: i segreti non vanno mai committati.

Le variabili gia' presenti nell'ambiente hanno la precedenza su quelle del file,
quindi il flusso offline su anvil convive con la configurazione di testnet:

```bash
RPC_URL=http://localhost:8545 TOKEN_ADDRESS=<stampato da make demo> npm start
```

`tools/local-chain/` non legge il `.env` di proposito: prenderebbe l'RPC di
Base Sepolia e `make demo` smetterebbe di funzionare sulla chain locale.

## Ambiente in pochi comandi

Prerequisiti: Docker (con Compose v2), Node 20+, make.

```bash
make init    # prima accensione: container + provisioning WordPress/WooCommerce
make demo    # deploya MockEURe sulla chain locale e simula un pagamento confermato
```

Fatto: negozio su http://localhost:8080/wp-admin (admin / admin), gateway da abilitare in WooCommerce → Impostazioni → Pagamenti, chain locale su http://localhost:8545. Poi `make up` / `make down` per accendere e spegnere, `make nuke` per ripartire da zero.

## Spike (ordine di esecuzione)

Lo spike 2 va eseguito per primo: il suo output fornisce il `TOKEN_ADDRESS` che serve allo spike 1 su testnet.

1. **01-onchain-detection**: su Base Sepolia con la configurazione del `.env` (`npm install && npm start`), oppure offline su anvil con l'override da shell descritto sopra, rilanciando `make demo` in un altro terminale. Uscita attesa: riga `[CONFERMATO]` con profondità 12.
2. **02-monerium-redemption**: richiede credenziali sandbox monerium.dev. Auth, `GET /tokens`, `GET /profiles` e `GET /ibans` implementati: l'output stampa l'indirizzo del contratto EURe sulla chain configurata, da incollare in `TOKEN_ADDRESS`. Redeem da completare. Uscita: ordine di redemption a stato finale in sandbox.
3. **03-fatturapa-sdi**: genera subito la fattura di esempio in `out/` (tracciato 1.9.1, mappatura §4.5: TD01, EUR, MP05, riferimenti on-chain in AltriDatiGestionali dentro DettaglioLinee); invio al SdI di test da completare dopo l'attivazione openapi.it. Uscita: ricevuta di consegna dal SdI di test.

**Gate fiscale**: le scelte MP05 / AltriDatiGestionali / momento di effettuazione sono in attesa di validazione del relatore; non consolidare lo spike 3 nel plugin prima dell'ok (vedi CLAUDE.md).

## Verifica end-to-end

```bash
make init     # WordPress + WooCommerce (una volta sola)
make e2e      # due ordini di pari importo, pagati on-chain, fino allo stato finale
```

Copre i passi da 1 a 3 del flusso nominale: creazione dell'ordine con il proprio riferimento, pagamento tramite il contratto di inoltro, rilevamento con criterio di finalita', verifica dell'importo e transizione di stato. Verifica anche che una notifica ripetuta sia riconosciuta come duplicata e che una priva del segreto condiviso sia respinta.

## Fatturazione elettronica

Alla conferma del pagamento il plugin accoda la fatturazione su Action Scheduler: compone il tracciato FatturaPA dall'ordine, lo trasmette al fornitore accreditato e ne segue lo stato fino a un esito definitivo. I ritentativi hanno attesa crescente e distinguono i guasti transitori, che si riprovano da soli, da quelli definitivi, che vengono portati all'attenzione dell'esercente sull'ordine.

I dati del cedente e le credenziali si impostano in WooCommerce, nelle opzioni del gateway. I riferimenti dell'incasso on-chain finiscono in `AltriDatiGestionali`, cosi' che dalla sola fattura si risalga alla transazione che l'ha originata.

## Contratto di inoltro

Il cliente non trasferisce EURe direttamente all'esercente: invoca `OrderForwarder`, che inoltra l'importo ed emette un evento con il riferimento dell'ordine. Serve perche' l'emittente lega l'IBAN a un solo indirizzo e un trasferimento ERC-20 non porta causale, quindi due ordini di pari importo nella stessa finestra sarebbero altrimenti indistinguibili. Il contratto non trattiene nulla e non ha poteri amministrativi.

```bash
cd contracts
npm install && npm run compile
npm test                              # verifiche su anvil (make up)
npm run deploy                        # chain locale
DEPLOY_TARGET=live DEPLOYER_PRIVATE_KEY=0x... npm run deploy   # rete di RPC_URL
```

Il deploy stampa l'indirizzo da mettere in `FORWARDER_ADDRESS` nel `.env`.

## Collegamento con la tesi

I requisiti citati nel codice (RF-xx, RNF-xx) e i riferimenti §4.x rimandano al Capitolo 4 della tesi (repository LaTeX separato). Le note in `docs/sessioni/` documentano i problemi incontrati sui sandbox esterni e sono materiale diretto per §5.3 e §5.4.
