# CLAUDE.md — wc-stablecoin-sdi (monorepo di tesi)

## Cos'è
Plugin WooCommerce per pagamenti in stablecoin EUR-pegged (EURe) con conversione automatica in EUR (rimborso alla pari via Monerium) e fatturazione elettronica automatica via SdI (openapi.it). Progetto di tesi LM-32 Unimarconi di Carmine Cristian Cruoglio; relatore Prof. Comandini. Il repo LaTeX della tesi è separato: i riferimenti RF-xx/RNF-xx e §4.x nel codice rimandano al Capitolo 4 della tesi.

## Comandi
- `make init` — prima accensione: WordPress+WooCommerce provisionati su http://localhost:8080 (admin/admin) e chain locale anvil su :8545
- `make up` / `make down` / `make nuke` — gestione ambiente
- `make demo` — deploya MockEURe sulla chain locale, simula un pagamento e mina 12 blocchi (input per lo spike 1)
- `make contracts` — compila il contratto di inoltro e ne esegue le verifiche
- `make e2e` — verifica end-to-end: due ordini WooCommerce di pari importo, pagamento on-chain, transizione di stato, idempotenza, autenticazione
- Spike: `cp .env.example .env` alla root (una volta sola), poi in `spikes/*/` `npm install && npm start`

## Stato e ordine di lavoro
1. Spike 1 e 2 consolidati in `watcher/`: rilevamento, finalita', notifica idempotente e rimborso. Verificato end-to-end con `make e2e`
2. Plugin: gateway, riferimento dell'ordine, endpoint REST con verifica dell'importo e transizione di stato (RF-02, RF-03, RF-04, RNF-03). Restano la fatturazione via Action Scheduler (RF-06, RF-07), la nota di credito (RF-10) e l'integrazione nei checkout blocks
3. Fatturazione consolidata nel plugin: composizione del tracciato, trasmissione al fornitore e ciclo delle ricevute, orchestrati da Action Scheduler (RF-06, RF-07). Verificata contro il sandbox reale da `make e2e`
4. Nota di credito (RF-10), scadenza della finestra (RF-04) e checkout a blocchi (RNF-05) completati e verificati
5. Il rimborso e' scritto ma non ancora eseguito end-to-end: manca `MERCHANT_SIGNER_PRIVATE_KEY` nel `.env`
6. Restano aperti: repository pubblico (RNF-01), verifica della minimizzazione dei dati (RNF-04) e l'anello del rimborso nel registro di audit (RF-09)

Lo spike 2 resta utile per interrogare il sandbox: fornisce il `TOKEN_ADDRESS` del contratto EURe sulla chain in uso.

## Ambienti esterni (sandbox verificati il 31/08/2026)

Nota completa in `docs/sessioni/2026-08-31.md`.

**Monerium** — sandbox `api.monerium.dev`; la produzione e' `.app`, non usarla. Applicazione su piano Private, autenticazione OAuth2 `client_credentials` su `POST /auth/token`.
- Tutti gli endpoint autenticati (profili, indirizzi, IBAN, ordini, firme) richiedono l'header `Accept: application/vnd.monerium.api-v2+json`. Senza, l'API risponde 404 invece di un errore di validazione, il che rende la diagnosi fuorviante. Gli endpoint `/auth/token` e `/auth/context` non lo richiedono.
- Chain in uso: **Base Sepolia** (`basesepolia`, chain id 84532), l'unica con IBAN approvato sul wallet. Il piano di luglio ipotizzava Ethereum Sepolia: non e' la chain reale. Gnosis Chiado e' abilitato ma senza IBAN, quindi inutilizzabile per i test.
- Il profilo resta `kind: "unknown"` e `state: "created"`: normale in sandbox, che non richiede KYC. Non e' un errore da correggere.
- Gli elenchi (`/profiles`, `/ibans`) arrivano incapsulati in un oggetto, mentre `/tokens` restituisce un array nudo.

**Openapi (SdI / FatturaPA)** — sandbox `test.sdi.openapi.it`; la produzione e' `sdi.openapi.it`.
- Autenticazione con il Bearer token della sezione Autenticazione della dashboard, tipo Sandbox. **Non** e' la "API Key" mostrata piu' in alto nella stessa pagina: sono due credenziali distinte.
- Prerequisito a qualsiasi chiamata: impostare il credito sandbox da dashboard, anche se le richieste di test sono gratuite.
- `fiscal_id` in `BusinessRegistryConfiguration` accetta sia partita IVA sia codice fiscale personale, senza prefisso IT.
- L'XML richiede la dichiarazione esplicita del namespace sul tag radice, che l'esempio ufficiale della documentazione Openapi omette: `xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2"`.
- L'attributo `versione` sul tag radice deve coincidere esattamente con `<FormatoTrasmissione>`, altrimenti il SdI scarta la fattura con errore 00428.
- Il Codice Destinatario da registrare sull'Agenzia delle Entrate serve solo al ciclo passivo: per il nostro caso, solo ciclo attivo, non serve.
- **Aperto**: non e' confermato se il sandbox raggiunga il vero canale di test SdI dell'Agenzia delle Entrate o simuli internamente le ricevute. La risposta condiziona il protocollo KPI del Capitolo 6.

## Come dialogano watcher e plugin

Non esiste registrazione preventiva degli ordini: ogni `OrderPaid` emesso dal contratto e' per definizione un incasso dell'esercente, e il riferimento viaggia dentro l'evento. Il watcher osserva, applica la finalita' e notifica; il plugin resta l'unica autorita' sullo stato dell'ordine e decide se l'importo basta.

- `order_ref` = `hash_hmac('sha256', 'wcsdi-order:'.$id, wcsdi_watcher_secret)`. Deterministico, non invertibile da fuori, 32 byte. Il segreto e' lo stesso di `WCSDI_SHARED_SECRET` nel `.env`: se divergono, le notifiche vengono respinte con 401.
- La ricerca dell'ordine per riferimento **riverifica sempre** il metadato con `hash_equals`. `wc_get_orders` delega a data store diversi secondo che HPOS sia attivo, e un filtro non compreso viene ignorato in silenzio: senza riverifica un pagamento finisce sull'ordine sbagliato. E' un bug gia' occorso, non un'ipotesi.
- La ricerca non filtra per stato, altrimenti una notifica ripetuta su un ordine gia' pagato non riconoscerebbe il duplicato e RNF-03 cadrebbe proprio nel caso che l'idempotenza esiste per coprire.
- L'immagine di WordPress non riscrive `/wp-json/`: la REST API si raggiunge come `?rest_route=/wcsdi/v1/...`, forma gia' impostata nel `.env.example`.

## Fatturazione elettronica

- **Il documento si invia come XML grezzo con `Content-Type: application/xml`.** Il fornitore restituisce poi la fattura come struttura JSON in snake_case, ma non la accetta in quella forma: inviarla come JSON risponde 422 con `Parsing error: malformed XML` (codice 802). La forma di lettura non e' la forma di scrittura.
- L'endpoint e' `POST /invoices`, non `/IT/invoices`, che risponde 401 da uno storage estraneo e trae in inganno. Lo stato si rilegge da `GET /invoices/{uuid}`, che porta `marking` e `notifications`.
- La composizione passa da `XMLWriter`, non da concatenazione: i valori arrivano dall'ordine e quindi dal cliente, e l'escaping non puo' essere lasciato a chi scrive il template. L'ordine degli elementi segue le sequenze del tracciato: un elemento fuori posto fa scartare la fattura.
- `get_items()` senza argomenti restituisce le sole righe prodotto. Le commissioni vanno chieste esplicitamente con `array( 'line_item', 'fee' )`, altrimenti il documento nasce senza corpo e il fornitore lo rifiuta con un messaggio poco chiaro.
- Gli argomenti delle azioni di Action Scheduler contengono il solo `order_id`. Contatori di tentativi e di verifiche vivono nei metadati dell'ordine, perche' `as_has_scheduled_action` riconosce un'azione gia' in coda solo se gli argomenti coincidono esattamente: con il contatore fra gli argomenti il controllo anti-duplicato non troverebbe mai nulla e ogni conferma accoderebbe una copia. E' un bug gia' occorso.
- Il numero progressivo si assegna una volta sola e resta nei metadati: un ritentativo non deve consumarne un altro e lasciare un buco nella serie.

## Nota di credito, scadenza, checkout a blocchi

- **Nota di credito**: la chiave del lavoro e' l'identificativo del rimborso, non quello dell'ordine, perche' un ordine puo' essere rimborsato piu' volte e ogni rimborso vuole la propria nota. L'uuid emesso resta annotato sul rimborso: e' cosi' che un riaccodamento non ne produce una seconda. Gli importi restano positivi, e' `TD04` a esprimere il segno. `DatiFattureCollegate` rinvia alla fattura rettificata: senza, la nota resterebbe un documento sospeso.
- **Scadenza**: l'azione e' pianificata con un margine oltre la finestra dichiarata, altrimenti un pagamento partito all'ultimo minuto non farebbe in tempo a maturare le conferme e si chiuderebbe un ordine di fatto pagato. Quando l'ordine viene pagato l'azione viene annullata. Un ordine scaduto con un incasso parziale conserva `_wcsdi_da_restituire`: la somma va restituita, non trattenuta in silenzio.
- **Checkout a blocchi**: il metodo va dichiarato una seconda volta in JavaScript, perche' il checkout a blocchi si costruisce nel browser e ignora la definizione PHP del gateway. `plugin/assets/js/blocks.js` usa i globali che WooCommerce espone e non richiede un passo di compilazione: il plugin non ha una toolchain di build e introdurla per poche righe non si giustifica. Allo script arrivano solo titolo e descrizione, mai credenziali o indirizzi.

## Correlazione pagamento-ordine

L'emittente lega l'IBAN di accredito a un solo indirizzo, quindi non si puo' assegnare un indirizzo distinto a ogni ordine, e un trasferimento ERC-20 non porta causale. Il pagamento passa percio' dal contratto in `contracts/src/OrderForwarder.sol`, che sposta i token dal cliente all'esercente ed emette `OrderPaid(orderRef, payer, amount)`.

- Il contratto non custodisce: `transferFrom` va direttamente da cliente a esercente. Non ha proprietario, non espone prelievi, token e indirizzo di incasso sono immutabili. Non aggiungere funzioni amministrative: e' proprio la loro assenza a soddisfare RNF-02.
- `payWithPermit` tiene il permit in try/catch di proposito: una firma EIP-2612 in mempool puo' essere anticipata da chiunque, e il permit fallito non deve trascinare il pagamento. Non "sistemare" rimuovendo il catch.
- Il rilevamento osserva `OrderPaid` se `FORWARDER_ADDRESS` e' valorizzato, altrimenti ripiega su `Transfer`. La modalita' di ripiego serve al confronto in tesi, non e' codice morto.
- `orderRef` e' un valore derivato senza contenuto informativo sul cliente (RNF-04). Non passare l'id ordine in chiaro.
- Test: `cd contracts && npm test` con anvil attivo (`make up`).

## Vincoli non negoziabili
- **Gate fiscale**: MP05, AltriDatiGestionali (TX-HASH/CHAIN/PAY-ADDR), TD01, TP02 e il momento di effettuazione restano scelte in attesa di validazione del relatore. Lo spike 3 e' stato consolidato nel plugin su indicazione di Carmine, ma le scelte sono raccolte nelle costanti in testa a `WCSDI_Fattura`, sotto un'intestazione esplicita: cambiarle quando il gate si sciogliera' deve restare una modifica di poche righe in un punto solo. Non spargerle nel resto della composizione.
- **Non-custodial (RNF-02)**: mai chiavi private nel codice o nella configurazione del plugin; l'unica chiave presente nel repo è quella pubblica di default di anvil in `tools/local-chain/chain.mjs`, priva di valore.
- **Capacità di firma**: il redemption Monerium richiede una firma EIP-191 del wallet che detiene gli EURe, quindi il redemption automatico impone che il merchant deleghi al proprio sistema una capacità di firma. La chiave vive nel servizio `watcher/`, processo separato senza superficie HTTP pubblica; il plugin PHP non la vede mai e comunica col watcher solo via REST autenticata. RNF-02 resta pienamente rispettato: riguarda i fondi e le chiavi del cliente, che il sistema non tocca in nessun momento. Il perimetro di rischio residuo è il saldo in transito sull'indirizzo di incasso, contenuto strutturalmente dal fatto che il riscatto parte subito dopo la conferma. Non spostare la chiave nel plugin, in `wp-config.php` o nelle opzioni WordPress per nessun motivo.
- **Idempotenza (RNF-03)**: ogni operazione con effetti esterni deve avere chiave idempotente; per gli eventi on-chain è `txHash:logIndex`.
- **Segreti** solo nel `.env` unico alla root, mai committato; `.env.example` ne documenta i nomi. Gli spike lo caricano per path relativo al proprio file, non dalla cwd. Le variabili gia' in ambiente hanno la precedenza: e' cosi' che la demo offline su anvil convive con la configurazione di testnet. `tools/local-chain/` non legge il `.env` di proposito.

## Convenzioni
- Commenti e messaggi in italiano, tono asciutto; niente em dash.
- PHP: standard WordPress (escaping, sanitizzazione input REST, `hash_equals` per i segreti); compatibilità HPOS e checkout blocks già dichiarata nel bootstrap.
- JS: ESM (`.mjs`), viem per la chain, nessuna dipendenza superflua.
- Prima di ogni commit: `php -l` sui file PHP toccati e `node --check` sugli script toccati.
