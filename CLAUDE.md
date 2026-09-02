# CLAUDE.md — wc-stablecoin-sdi (monorepo di tesi)

## Cos'è
Plugin WooCommerce per pagamenti in stablecoin EUR-pegged (EURe) con conversione automatica in EUR (rimborso alla pari via Monerium) e fatturazione elettronica automatica via SdI (openapi.it). Progetto di tesi LM-32 Unimarconi di Carmine Cristian Cruoglio; relatore Prof. Comandini. Il repo LaTeX della tesi è separato: i riferimenti RF-xx/RNF-xx e §4.x nel codice rimandano al Capitolo 4 della tesi.

## Comandi
- `make init` — prima accensione: WordPress+WooCommerce provisionati su http://localhost:8080 (admin/admin) e chain locale anvil su :8545
- `make up` / `make down` / `make nuke` — gestione ambiente
- `make demo` — deploya MockEURe sulla chain locale, simula un pagamento e mina 12 blocchi (input per lo spike 1)
- `make contracts` — compila il contratto di inoltro e ne esegue le verifiche
- `make e2e` — verifica end-to-end su anvil: ordini di pari importo, pagamento on-chain, transizione di stato, idempotenza, autenticazione, validazione degli input, numeratore concorrente, notifiche parallele, riavvio del watcher con eventi in attesa, fatturazione e nota di credito se il sandbox e' configurato
- Campagne (Cap. 6): `node tools/local-chain/campagna-lotti.mjs --ripetizioni=10 --campagna=<id> --criterio=confirmations:12` (avvia da se' il watcher); scansione dei criteri con `campagna-finalita.mjs`; misure con `node tools/analisi.mjs`
- Spike: `cp .env.example .env` alla root (una volta sola), poi in `spikes/*/` `npm install && npm start`

## Stato e ordine di lavoro
1. Spike 1 e 2 consolidati in `watcher/`: rilevamento, criterio di conferma, notifica idempotente e riscatto. Verificato end-to-end con `make e2e`
2. Plugin completo: gateway, riferimento dell'ordine, endpoint REST, fatturazione via Action Scheduler (RF-06, RF-07), nota di credito (RF-10), scadenza (RF-04), checkout a blocchi (RNF-05), campi fiscali al checkout, strumentazione di misura
3. Revisione del 2 settembre 2026 (v0.2.0), dopo l'audit della campagna v1: numeratore delle fatture atomico, aliquota per riga da `WC_Tax`, natura per le operazioni a IVA zero, cessionario estero, ritrasmissione dopo scarto, lock per ordine sulla notifica, validazione degli input, criterio di conferma e segreto nel pannello (`GET /config` per il watcher), heartbeat, informativa al checkout; watcher con stato persistito (eventi in attesa, riscatti, orfani), verifica di canonicita', riscatti ritentati, componente L1 nel costo
4. Campagna v1 (31/08-01/09) conservata in `docs/dataset/` con i suoi difetti dichiarati (`docs/dataset/README.md`); campagna v2 dal 3 settembre con il codice corretto
5. Restano aperti: RNF-04 verificato solo per argomento (`docs/rnf-04-minimizzazione.md`), RF-09 senza anello del riscatto nel registro di audit, nessun esercizio su rete principale

Lo spike 2 resta utile per interrogare il sandbox: fornisce il `TOKEN_ADDRESS` del contratto EURe sulla chain in uso.

## Ambienti esterni (sandbox verificati il 31/08/2026)

Nota completa in `docs/sessioni/2026-08-31.md`.

**Monerium** — sandbox `api.monerium.dev`; la produzione e' `.app`, non usarla. Applicazione su piano Private, autenticazione OAuth2 `client_credentials` su `POST /auth/token`.
- Tutti gli endpoint autenticati (profili, indirizzi, IBAN, ordini, firme) richiedono l'header `Accept: application/vnd.monerium.api-v2+json`. Senza, l'API risponde 404 invece di un errore di validazione, il che rende la diagnosi fuorviante. Gli endpoint `/auth/token` e `/auth/context` non lo richiedono.
- **Il timestamp del messaggio di rimborso vuole i secondi, e vuole quelli veri.** La documentazione parla di precisione al minuto: questo induce sia a ometterli, e l'API rifiuta il valore troncato con `invalid timestamp format`, sia ad azzerarli, e allora due rimborsi di pari importo maturati nello stesso minuto producono lo stesso messaggio firmato e il secondo viene respinto con `Duplicate order`. In campagna succede a ogni coppia di ripetizioni.
- **`counterpart.details` e' obbligatorio** negli ordini di riscatto: senza, 400 «Details attribute is missing from JSON»; con il solo `name`, «field is required» su `firstName` e `lastName`. Il `country` e' facoltativo.
- Il campo `memo` e' accettato sugli ordini di riscatto e restituito invariato: ci viaggia il riferimento dell'ordine, cosi' il rimborso e' riconducibile alla transazione senza accoppiarlo per importo e istante.
- **Nessuna commissione.** Il listino dichiara «Currently, Monerium is not charging any fees» su emissione, riscatto, bonifici SEPA, IBAN e accesso API; l'oggetto ordine non espone alcun campo di costo. Fonte: <https://monerium.com/fee-schedule/>, consultata il 31/08/2026.
- **Lo stato dell'ordine sta in `state`, non in `meta.state`**: dentro `meta` ci sono solo gli istanti e gli hash. Stati terminali: `processed`, `rejected`, `declined`.
- Il bonifico simulato segue l'IBAN, non l'indirizzo selezionato nel pannello: per instradarlo altrove si sposta l'IBAN con `PATCH /ibans/{iban}`.
- Chain in uso: **Base Sepolia** (`basesepolia`, chain id 84532), l'unica con IBAN approvato sul wallet. Il piano di luglio ipotizzava Ethereum Sepolia: non e' la chain reale. Gnosis Chiado e' abilitato ma senza IBAN, quindi inutilizzabile per i test.
- Il profilo resta `kind: "unknown"` e `state: "created"`: normale in sandbox, che non richiede KYC. Non e' un errore da correggere.
- Gli elenchi (`/profiles`, `/ibans`) arrivano incapsulati in un oggetto, mentre `/tokens` restituisce un array nudo.

**Openapi (SdI / FatturaPA)** — sandbox `test.sdi.openapi.it`; la produzione e' `sdi.openapi.it`.
- Autenticazione con il Bearer token della sezione Autenticazione della dashboard, tipo Sandbox. **Non** e' la "API Key" mostrata piu' in alto nella stessa pagina: sono due credenziali distinte.
- Prerequisito a qualsiasi chiamata: impostare il credito sandbox da dashboard, anche se le richieste di test sono gratuite.
- `fiscal_id` in `BusinessRegistryConfiguration` accetta sia partita IVA sia codice fiscale personale, senza prefisso IT.
- **Le notifiche del SdI si leggono in due modi**, alternativi: callback registrate con `POST /api_configurations` (evento `customer-notification`), impraticabili per un'installazione locale non raggiungibile dall'esterno, oppure interrogazione di `GET /invoices_notifications/{uuid}` — l'identificativo va nel percorso, come parametro di query risponde `400 uuid is required`.
- **I valori di `marking` usano il trattino**: `sent`, `delivered`, `delivered-pa`, `not-delivered`, `rejected`. Scriverli con il carattere di sottolineatura produce un confronto sempre falso.
- Il silenzio sulle ricevute non e' di per se' un'anomalia: l'Agenzia delle Entrate dichiara tempi «da pochi minuti ad un massimo di 5 giorni». L'osservazione va condotta su giorni, e la riverifica del plugin copre ora poco piu' di nove giorni. Analisi in `docs/sdi-notifiche.md`.
- L'XML richiede la dichiarazione esplicita del namespace sul tag radice, che l'esempio ufficiale della documentazione Openapi omette: `xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2"`.
- L'attributo `versione` sul tag radice deve coincidere esattamente con `<FormatoTrasmissione>`, altrimenti il SdI scarta la fattura con errore 00428.
- Il Codice Destinatario da registrare sull'Agenzia delle Entrate serve solo al ciclo passivo: per il nostro caso, solo ciclo attivo, non serve.
- **Aperto**: non e' confermato se il sandbox raggiunga il vero canale di test SdI dell'Agenzia delle Entrate o simuli internamente le ricevute. La risposta condiziona il protocollo KPI del Capitolo 6.

## Come dialogano watcher e plugin

Non esiste registrazione preventiva degli ordini: ogni `OrderPaid` emesso dal contratto e' per definizione un incasso dell'esercente, e il riferimento viaggia dentro l'evento. Il watcher osserva, applica la finalita' e notifica; il plugin resta l'unica autorita' sullo stato dell'ordine e decide se l'importo basta.

- `order_ref` = HMAC-SHA256 di `wcsdi-order:<id>` con una chiave derivata dal segreto condiviso (`hash_hmac('sha256', 'wcsdi-order-ref-key', $secret, true)`): deterministico, non invertibile da fuori, 32 byte, e il segreto delle notifiche non e' mai usato direttamente come chiave. Il segreto si imposta nel pannello del gateway (campo che sincronizza l'opzione `wcsdi_watcher_secret` e poi si svuota) ed e' lo stesso di `WCSDI_SHARED_SECRET` nel `.env`: se divergono, le notifiche vengono respinte con 401.
- Il watcher legge all'avvio `GET /wcsdi/v1/config` (rete, contratto, criterio di conferma, conferme) e si ferma se rete o contratto non coincidono con i suoi; le variabili d'ambiente `FINALITY_MODE`/`CONFIRMATIONS`, se presenti, hanno la precedenza. Invia `POST /heartbeat` ogni minuto: il pannello avvisa se manca da piu' di dieci minuti.
- `POST /payment-confirmed` valida gli input (hash 0x + 64 esadecimali, importo decimale positivo, indirizzo), prende un lock MySQL per ordine (`GET_LOCK`) e rilegge l'ordine sotto lock; una `chain_id` diversa da quella attesa dall'ordine risponde 409 `wcsdi_chain_mismatch`. Il watcher considera definitivi solo 400, 409 e il 404 con codice `wcsdi_order_not_found`: gli altri errori si ritentano, e i definitivi finiscono fra gli orfani nel file di stato.
- Il watcher persiste in `state.json` (scrittura con fsync e rename atomica) gli eventi in attesa con l'hash del blocco, i riscatti da disporre o in corso e gli orfani: un riavvio riprende da prima del piu' antico evento in attesa. Prima di notificare rilegge la ricevuta e confronta l'hash del blocco: evento decaduto se la transazione e' sparita, riposizionato se inclusa altrove.
- La ricerca dell'ordine per riferimento **riverifica sempre** il metadato con `hash_equals`. `wc_get_orders` delega a data store diversi secondo che HPOS sia attivo, e un filtro non compreso viene ignorato in silenzio: senza riverifica un pagamento puo' essere attribuito all'ordine sbagliato. **Il data store classico ignora proprio la `meta_query`**: fino al 2 settembre 2026 la query restituiva i cinque ordini piu' recenti e la riverifica scartava gli altri, sicche' un pagamento era trovato solo se il suo ordine era fra gli ultimi cinque creati (tre orfani su otto in un lotto della campagna v2, e casi analoghi nella v1). La variabile propria `wcsdi_order_ref` viene tradotta in `meta_query` dal filtro `woocommerce_order_data_store_cpt_get_orders_query`; con HPOS la `meta_query` e' accettata direttamente. Il passo 7b di `make e2e` lo verifica notificando il sesto ordine piu' recente.
- La ricerca non filtra per stato, altrimenti una notifica ripetuta su un ordine gia' pagato non riconoscerebbe il duplicato e RNF-03 cadrebbe proprio nel caso che l'idempotenza esiste per coprire.
- L'immagine di WordPress non riscrive `/wp-json/`: la REST API si raggiunge come `?rest_route=/wcsdi/v1/...`, forma gia' impostata nel `.env.example`.

## Fatturazione elettronica

- **Il documento si invia come XML grezzo con `Content-Type: application/xml`.** Il fornitore restituisce poi la fattura come struttura JSON in snake_case, ma non la accetta in quella forma: inviarla come JSON risponde 422 con `Parsing error: malformed XML` (codice 802). La forma di lettura non e' la forma di scrittura.
- L'endpoint e' `POST /invoices`. Lo stato si rilegge da `GET /invoices/{uuid}`, che porta `marking` e `notifications`.
- La composizione passa da `XMLWriter`, non da concatenazione: i valori arrivano dall'ordine e quindi dal cliente, e l'escaping non puo' essere lasciato a chi scrive il template. L'ordine degli elementi segue le sequenze del tracciato: un elemento fuori posto fa scartare la fattura.
- `get_items()` senza argomenti restituisce le sole righe prodotto. Le commissioni vanno chieste esplicitamente con `array( 'line_item', 'fee' )`, altrimenti il documento nasce senza corpo e il fornitore lo rifiuta con un messaggio poco chiaro.
- Gli argomenti delle azioni di Action Scheduler contengono il solo `order_id`. Contatori di tentativi e di verifiche vivono nei metadati dell'ordine, perche' `as_has_scheduled_action` riconosce un'azione gia' in coda solo se gli argomenti coincidono esattamente: con il contatore fra gli argomenti il controllo anti-duplicato non individuerebbe mai il lavoro gia' accodato.
- Il numero progressivo si assegna una volta sola e resta nei metadati: un ritentativo non deve consumarne un altro e lasciare un buco nella serie. L'assegnazione e' atomica (`UPDATE ... SET option_value = LAST_INSERT_ID(option_value + 1)` sull'opzione `wcsdi_numeratore_<anno>`): la versione precedente leggeva e riscriveva l'opzione in due passi e con due runner concorrenti ha prodotto 30 numeri duplicati su 400 nella campagna v1, che il sandbox ha accettato. Non tornare a `get_option`/`update_option`.
- L'anno della serie e' quello della data del documento (momento di effettuazione, t3), non quello della trasmissione; una fattura scartata si ritrasmette con `wp wcsdi ritrasmetti <id>` o dall'azione dell'ordine, con lo stesso numero.
- L'aliquota di ogni riga viene da `WC_Tax` (rate dell'item), non dal rapporto imposta/imponibile arrotondato; una riga a IVA zero senza `Natura` configurata nel pannello e' un errore non transitorio, non un documento da trasmettere. Un cessionario senza codice fiscale ne' partita IVA (privato italiano) blocca la composizione prima dell'invio, perche' il SdI la scarterebbe con 00417; il cliente estero riceve `XXXXXXX` come codice destinatario, `IdPaese` proprio e CAP `00000`.
- Dopo la trasmissione il tracciato viene conservato in `wp-content/uploads/wcsdi-fatture/` (cartella con `.htaccess` di diniego) e una copia va al cliente per e-mail (`WCSDI_Copia_Cliente`), allegata anche alle e-mail di ordine completato e di fattura: e' l'adempimento dell'art. 1, c. 3, D.Lgs. 127/2015, che la messa a disposizione nell'area riservata non esaurisce. Nell'ambiente Docker le e-mail non partono: la nota sull'ordine lo dice.
- I dati fiscali del cessionario si raccolgono al checkout (`WCSDI_Checkout`: tipo cliente, codice fiscale con carattere di controllo, partita IVA, codice destinatario, PEC, richiesta di fattura) e finiscono nei metadati `_wcsdi_codice_fiscale`, `_wcsdi_piva`, `_wcsdi_codice_destinatario`, `_wcsdi_pec`, `_wcsdi_richiedi_fattura`, `_wcsdi_tipo_cliente`. Un privato che non richiede la fattura non la riceve (art. 22 DPR 633/72); lo script di campagna imposta la richiesta a `yes`.

## Nota di credito, scadenza, checkout a blocchi

- **Nota di credito**: la chiave del lavoro e' l'identificativo del rimborso, non quello dell'ordine, perche' un ordine puo' essere rimborsato piu' volte e ogni rimborso vuole la propria nota. L'uuid emesso resta annotato sul rimborso: e' cosi' che un riaccodamento non ne produce una seconda. Gli importi restano positivi, e' `TD04` a esprimere il segno. `DatiFattureCollegate` rinvia alla fattura rettificata: senza, la nota resterebbe un documento sospeso.
- **Scadenza**: l'azione e' pianificata con un margine oltre la finestra dichiarata, altrimenti un pagamento partito all'ultimo minuto non farebbe in tempo a maturare le conferme e si chiuderebbe un ordine di fatto pagato. Quando l'ordine viene pagato l'azione viene annullata. Un ordine scaduto con un incasso parziale conserva `_wcsdi_da_restituire`: la somma va restituita, non trattenuta in silenzio.
- **Checkout a blocchi**: il metodo va dichiarato una seconda volta in JavaScript, perche' il checkout a blocchi si costruisce nel browser e ignora la definizione PHP del gateway. `plugin/assets/js/blocks.js` usa i globali che WooCommerce espone e non richiede un passo di compilazione: il plugin non ha una toolchain di build e introdurla per poche righe non si giustifica. Allo script arrivano solo titolo e descrizione, mai credenziali o indirizzi.

## Ambiente di misura su Base Sepolia

- Contratto di inoltro pubblicato: `0x91f7B2252256a112Fe12Ee79BA58e1cb290D21C3`, compilato con solc 0.8.36 (ottimizzatore, 200 run) e verificato su Blockscout il 2 settembre 2026 (corrispondenza del bytecode, impronta dei metadati diversa: "partially verified"). L'artefatto tracciato in `contracts/build/` e' quello pubblicato: non ricompilare per committare
- Token EURe: `0x29F37F6adCa168B79B8d9567eab9BE3fBF21db85`
- Indirizzo di incasso: quello di `MERCHANT_SIGNER_PRIVATE_KEY`, con l'IBAN collegato
- `CAMPAGNA_PAYER_KEY` e' il cliente simulato: identita' distinta dall'esercente, perche' un pagamento verso se stessi non riproduce il flusso
- I fondi ruotano fra i due: la campagna ricarica il cliente prima di partire e si ferma se non bastano
- Dataset in `docs/dataset/`, esportato con `wp wcsdi export`

## Strumentazione per il Capitolo 6

Il protocollo KPI (documento su Drive) chiede che i marcatori t0-t5 siano registrati dal codice, non ricostruiti a posteriori dai log. `WCSDI_Misure` li tiene sull'ordine, `wp wcsdi export` produce il dataset.

- **I marcatori on-chain portano l'ora del blocco, non quella in cui il servizio se ne accorge.** La seconda dipende dall'intervallo di sondaggio e falserebbe la latenza. t1 e t2 arrivano quindi dal servizio, che legge il blocco; il plugin non parla con la catena e non potrebbe osservarli.
- **Il primo valore di un marcatore vince.** Una notifica ripetuta non deve spostare in avanti un istante gia' osservato, altrimenti le latenze risulterebbero piu' brevi del vero.
- **Le due latenze vanno tenute distinte**: conferma dell'incasso (t2-t0), che si confronta con l'autorizzazione di una carta, e regolamento (t5-t0), che si confronta con l'accredito. Confonderle rende il raffronto attaccabile, ed e' il punto su cui il protocollo insiste di piu'.
- Il costo di rete e' letto dalla ricevuta della transazione, non stimato.
- `wc_get_orders` restituisce anche i rimborsi, che non espongono `get_payment_method()`: interrogarli come ordini produce un errore fatale. Verificare sempre `instanceof WC_Order`.
- **Filtrare sempre per `chain_id`.** Il campo `chain` riporta il nome configurato nel gateway, che puo' non coincidere con la rete realmente osservata: senza il filtro numerico le misure locali si mescolano a quelle di rete.
- **Le latenze misurate sulla chain di sviluppo non sono significative.** Anvil genera i blocchi su richiesta e il loro orario non concorda con quello del server: si ottengono anche latenze negative. Il dataset le marca con `anomalia_orologio` e vanno scartate dall'analisi. Le misure buone si fanno su rete di prova con NTP attivo, come prescrive il protocollo.
- La campagna si lancia con `tools/local-chain/campagna-lotti.mjs` (una tranche, un lotto per ripetizione, watcher avviato dallo script con `--criterio`) o con `campagna.mjs` per un singolo lotto. `--dry-run` mostra il piano senza toccare nulla. `--modalita=allowance|approve|permit` sceglie come il cliente autorizza il contratto; il gas delle autorizzazioni e l'istante di invio di ogni transazione finiscono in `docs/dataset/gas-<campagna>.csv`.
- **Il marcatore `ti` (istante di invio) separa la coda dello script dalla latenza di inclusione.** Nella campagna v1 t1-t0 conteneva una mediana di dieci secondi di coda, perche' lo script paga in sequenza e t0 e' la creazione dell'ordine: senza `ti` la latenza di conferma non era scomponibile.
- **Il costo di rete comprende la componente L1.** Su Base la ricevuta porta `l1Fee`, che viem non espone senza i formattatori della catena: il watcher legge la ricevuta grezza con `eth_getTransactionReceipt`. Nel dataset v1 la colonna e' stata integrata a posteriori da `tools/ricevute.mjs`.
- Per i criteri a etichetta t2 e' l'istante di osservazione, quantizzato all'intervallo di sondaggio (10 s nelle campagne): non esiste un blocco che porti la transazione a `finalized`. Dettagli in `docs/finalita-l2.md`.

## Correlazione pagamento-ordine

L'emittente lega l'IBAN di accredito a un solo indirizzo, quindi non si puo' assegnare un indirizzo distinto a ogni ordine, e un trasferimento ERC-20 non porta causale. Il pagamento passa percio' dal contratto in `contracts/src/OrderForwarder.sol`, che sposta i token dal cliente all'esercente ed emette `OrderPaid(orderRef, payer, amount)`.

- Il contratto non custodisce: `transferFrom` va direttamente da cliente a esercente. Non ha proprietario, non espone prelievi, token e indirizzo di incasso sono immutabili. Non aggiungere funzioni amministrative: e' proprio la loro assenza a soddisfare RNF-02.
- `payWithPermit` tiene il permit in try/catch di proposito: una firma EIP-2612 in mempool puo' essere anticipata da chiunque, e il permit fallito non deve trascinare il pagamento. Non "sistemare" rimuovendo il catch.
- Il rilevamento osserva `OrderPaid` se `FORWARDER_ADDRESS` e' valorizzato, altrimenti ripiega su `Transfer`. La modalita' di ripiego serve al confronto in tesi, non e' codice morto.
- `orderRef` e' un valore derivato senza contenuto informativo sul cliente (RNF-04). Non passare l'id ordine in chiaro.
- Test: `cd contracts && npm test` con anvil attivo (`make up`).

## Vincoli non negoziabili
- **Scelte fiscali** (sciolte il 01/09/2026): TD01, TP02, MP05 accompagnato da una voce `PAY-MODE` in AltriDatiGestionali che ne dichiara la portata, hash della transazione in `Causale` e non in `RiferimentoTesto` (66 caratteri contro 60), momento di effettuazione al perfezionamento del pagamento on-chain. Restano raccolte nelle costanti in testa a `WCSDI_Fattura`, sotto un'intestazione esplicita: una revisione futura deve restare una modifica di poche righe in un punto solo. Non spargerle nel resto della composizione.
- **Non-custodial (RNF-02)**: mai chiavi private nel codice o nella configurazione del plugin; l'unica chiave presente nel repo è quella pubblica di default di anvil in `tools/local-chain/chain.mjs`, priva di valore.
- **Capacità di firma**: il redemption Monerium richiede una firma EIP-191 del wallet che detiene gli EURe, quindi il redemption automatico impone che il merchant deleghi al proprio sistema una capacità di firma. La chiave vive nel servizio `watcher/`, processo separato senza superficie HTTP pubblica; il plugin PHP non la vede mai e comunica col watcher solo via REST autenticata. RNF-02 resta pienamente rispettato: riguarda i fondi e le chiavi del cliente, che il sistema non tocca in nessun momento. Il perimetro di rischio residuo è il saldo in transito sull'indirizzo di incasso, contenuto strutturalmente dal fatto che il riscatto parte subito dopo la conferma. Non spostare la chiave nel plugin, in `wp-config.php` o nelle opzioni WordPress per nessun motivo.
- **Idempotenza (RNF-03)**: ogni operazione con effetti esterni deve avere chiave idempotente; per gli eventi on-chain è `txHash:logIndex`.
- **Segreti** solo nel `.env` unico alla root, mai committato; `.env.example` ne documenta i nomi. Gli spike lo caricano per path relativo al proprio file, non dalla cwd. Le variabili gia' in ambiente hanno la precedenza: e' cosi' che la demo offline su anvil convive con la configurazione di testnet. `tools/local-chain/` non legge il `.env` di proposito.

## Convenzioni
- Commenti e messaggi in italiano, tono asciutto; niente em dash.
- PHP: standard WordPress (escaping, sanitizzazione input REST, `hash_equals` per i segreti); compatibilità HPOS e checkout blocks già dichiarata nel bootstrap.
- JS: ESM (`.mjs`), viem per la chain, nessuna dipendenza superflua.
- Prima di ogni commit: `php -l` sui file PHP toccati e `node --check` sugli script toccati.
