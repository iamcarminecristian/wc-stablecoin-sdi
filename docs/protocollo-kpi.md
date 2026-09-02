# Protocollo KPI del Capitolo 6

Trascrizione del documento «Cap. 6 — Protocollo KPI e test (Validazione sperimentale)», redatto il 7 luglio 2026 prima dello sviluppo e conservato su Google Drive nella cartella della tesi. Il testo e' riportato integralmente, con le sole aggiunte marcate «Attuazione», che dicono come ciascuna voce e' stata realizzata nel monorepo e dove il dato si legge nel dataset (`docs/dataset/`). Le voci che il documento marcava «da confermare» sono state sciolte come indicato.

Il protocollo e' pubblicato qui perche' il Capitolo 6 della tesi dichiara che ogni numero e' riproducibile a partire da esso: un lettore deve poterlo leggere senza accedere al Drive.

## 1. Domande di ricerca e ipotesi

Ogni domanda e' formulata in modo da poter essere confermata o smentita dai dati misurati.

- RQ1, costo. A parita' di importo, qual e' il costo totale per transazione del gateway stablecoin rispetto a Stripe e PayPal, e a partire da quale fascia di importo diventa piu' conveniente? (individuazione del punto di pareggio).
- RQ2, finalita'. Quanto tempo intercorre tra il pagamento del cliente e (a) la conferma dell'incasso lato merchant e (b) la disponibilita' degli EUR sul conto, rispetto ad autorizzazione e accredito di Stripe/PayPal?
- RQ3, affidabilita'. Qual e' il tasso di errore delle transazioni sui tre binari e di che natura sono gli errori?
- RQ4, integrita' fiscale. Per ogni incasso in stablecoin la FatturaPA viene generata e accettata correttamente? E' il contributo originale della tesi, quindi va misurato e non solo descritto.

Ipotesi di lavoro (falsificabili). H1: esiste un importo di pareggio oltre il quale il costo percentuale del binario stablecoin e' inferiore a quello delle carte. H2: la conferma on-chain e' comparabile all'autorizzazione, mentre la disponibilita' degli EUR via SEPA e' comparabile o piu' lenta dell'accredito delle carte a seconda dell'orario di redeem. H3: il tasso di errore e' confrontabile tra i binari, con categorie di errore diverse per natura. H4: la generazione FatturaPA raggiunge un tasso di validita'/accettazione prossimo al 100% sul sandbox SdI.

Attuazione: le quattro domande sono riprese nel paragrafo 6.1 della tesi e le risposte, graduate secondo cio' che l'ambiente di prova permette di osservare, nel paragrafo 6.5. H1 e' risultata falsa nella forma attesa (nessun pareggio per la forma delle funzioni di costo ai parametri osservati, ma con una soglia di convenienza sui costi fissi propri del binario); H2 confermata sulla conferma e non misurabile sul regolamento bancario, simulato in sandbox; H3 misurata solo sul binario stablecoin; H4 confermata al livello dell'accettazione da parte del fornitore, non della consegna da parte del SdI.

## 2. KPI: definizioni operative (paragrafo 6.2)

### 2.1 Costo per transazione

Nota di rigore da esplicitare: con le carte e' il merchant a sostenere la commissione percentuale; nel binario stablecoin il cliente paga il gas on-chain e il merchant sostiene il costo di off-ramp/redeem. Vanno quindi riportate due viste, altrimenti il confronto e' attaccabile:

- costo lato merchant (confronto omogeneo con le fee di carta): per stablecoin = fee di redeem Monerium + eventuale spread; per Stripe/PayPal = commissione da listino;
- costo totale di sistema (cliente + merchant): aggiunge il gas on-chain.

Formula binario stablecoin: C = gas_fee + fee_redeem + spread. Espresso sia in EUR assoluti sia in percentuale dell'importo. Fonti di misura: fee di redeem dalla risposta API Monerium (sandbox); gas effettivo = gas usato x prezzo del gas dalla ricevuta on-chain; commissioni Stripe/PayPal dai listini di produzione documentati (tier, regione, data, URL fonte), perche' il sandbox non addebita fee reali.

Attuazione: `gas_usato`, `gas_prezzo_wei`, `l1_fee_wei` e `costo_totale_nativo` nel dataset, letti dalla ricevuta grezza della transazione (su Base la ricevuta porta anche la componente di pubblicazione dei dati sul primo livello, `l1Fee`, che va sommata all'esecuzione). Fee di redeem: nulla per listino dell'emittente (`docs/sessioni/2026-08-31.md`). Conversione in euro con i parametri di mercato di `docs/dataset/parametri-mercato-*.csv` (`tools/parametri-mercato.mjs`), riportata come intervallo p05/mediana/p95 e non come valore unico. Listini Stripe e PayPal in `docs/dataset/baseline-psp-*.csv` con data e fonte. Costi fissi propri del binario (fornitore SdI per fattura, server, provider RPC) aggiunti nel paragrafo 6.4 con la soglia di convenienza.

### 2.2 Tempo di finalita'

E' il KPI piu' delicato e va definito su piu' checkpoint espliciti, perche' «finalita'» cripto e «regolamento» carte non sono la stessa cosa. Marcatori temporali:

| Marcatore | Evento |
|---|---|
| t0 | Il cliente firma/trasmette la transazione (checkout completato) |
| t1 | Transazione inclusa in un blocco (prima conferma) |
| t2 | Finalita' raggiunta secondo criterio definito (N conferme, o finalita' deterministica se la rete la offre): incasso considerato certo dal merchant |
| t3 | Il plugin rileva e riconcilia il pagamento con l'ordine WooCommerce (ordine pagato, fattura innescata) |
| t4 | Redeem verso SEPA avviato (auto-conversione EUR, paragrafo 4.4 dell'indice) |
| t5 | EUR accreditati sul conto (SEPA credited) |

KPI derivati e confronti corretti:

- latenza di conferma incasso (lato merchant) = t2 - t0 (o t3 - t0 includendo la riconciliazione). Si confronta con l'autorizzazione di carta (circa istantanea);
- latenza di regolamento (EUR disponibili in banca) = t5 - t0. Si confronta con il payout/accredito di Stripe/PayPal (T+n secondo policy).

Regola di comparabilita': confrontare conferma con autorizzazione e regolamento con accredito, mai mescolando i due livelli. Questa distinzione e' cio' che protegge il capitolo in discussione. Unita': secondi per la conferma, ore/giorni per il regolamento. Riportare la distribuzione (mediana, media, min, max, p95) e non la sola media, vista la variabilita' on-chain e delle finestre bancarie. Tutti i timestamp da orologio sincronizzato via NTP, log lato server in UTC.

Attuazione: i marcatori sono registrati dal codice, non ricostruiti dai log (`plugin/includes/class-wcsdi-misure.php`, `WCSDI_Misure::segna`), e il primo valore osservato vince. t0 e' la creazione dell'ordine nel negozio; t1 e t2 portano l'ora del blocco (t1) e l'ora del blocco che porta la transazione alla profondita' richiesta (t2 con il conteggio delle conferme) oppure l'istante in cui il servizio osserva soddisfatto il criterio a etichetta, quantizzato all'intervallo di sondaggio; t3 e' la ricezione della notifica dal plugin; t4 e t5 sono comunicati dal servizio di rilevamento, che e' il solo a dialogare con l'emittente, e t5 e' l'istante di lavorazione dichiarato dall'emittente. Dalla campagna v2 il dataset porta anche `t_invio` (istante in cui lo script trasmette la transazione) che separa la coda dello script (`lat_attesa_invio` = t_invio - t0) dalla latenza di inclusione (`lat_inclusione` = t1 - t_invio), e le componenti `lat_profondita` (t2 - t1), `lat_notifica` (t3 - t2) e `lat_riscatto` (t5 - t4). Il tratto bancario non e' misurabile in sandbox, dove il bonifico e' simulato: t5 e' latenza dell'emittente, e la tesi lo dichiara.

### 2.3 Tasso di errore

error_rate = transazioni_fallite / transazioni_tentate, su un campione N definito. Tassonomia degli errori per binario, da riportare per categoria e non solo in aggregato:

- stablecoin: transazione rifiutata/underfunded, sottopagamento o sovrapagamento, transazione bloccata/non confermata entro timeout, fallimento del redeem, mismatch di riconciliazione, fallimento generazione o trasmissione FatturaPA;
- Stripe/PayPal: pagamento rifiutato (declined), timeout, errore/mancata ricezione webhook, fallimento riconciliazione, fallimento fattura.

Attuazione: colonne `esito` e `categoria_errore` del dataset; i tentativi di trasmissione della fattura in `fattura_tentativi` e le verifiche delle ricevute in `sdi_verifiche`; gli esiti negativi del riscatto in `stato_riscatto` e `riscatto_motivo`. I fallimenti di invio della transazione, che avvengono prima che l'ordine abbia un hash, sono registrati dallo script di campagna nel file laterale `docs/dataset/gas-<campagna>.csv` (colonna `esito`). Il binario Stripe/PayPal non e' stato esercitato: il confronto sul tasso di errore e' dichiarato non misurato.

### 2.4 Integrita' fiscale pagamento-fattura (KPI del contributo originale)

Percentuale di incassi per cui la FatturaPA prodotta e': (a) sintatticamente valida rispetto allo schema XML SdI; (b) semanticamente corretta (importi, aliquota/esposizione IVA, rappresentazione corretta dell'incasso in stablecoin); (c) accettata dal SdI sandbox. Misura direttamente il gap che la tesi colma: merita un KPI dedicato, i cui risultati confluiscono in 6.2/6.5.

Attuazione: `fattura_stato` e `fattura_accettata` nel dataset; (a) e (c) al livello dell'accettazione da parte del fornitore accreditato (`marking = sent`), poiche' non e' confermato che il sandbox del fornitore inoltri al canale di test dell'Agenzia delle Entrate (`docs/sdi-notifiche.md`); (b) verificata dal composer (aliquote per riga, natura per le operazioni a IVA zero, dati del cessionario) e dalla numerazione, la cui unicita' e' essa stessa un dato: la campagna v1 ha prodotto numeri duplicati per un difetto del numeratore, che il sandbox ha accettato, e il fatto e' riportato come risultato.

## 3. Ambiente di test e condizioni (paragrafo 6.1)

Tutto va fissato e versionato: e' la parte su cui il relatore ha insistito («condizioni documentate con precisione»).

- Blockchain (da confermare). Rete su cui gira EURe nel sandbox Monerium. Candidati e motivazione: Gnosis Chain (rete storica di EURe, commissioni sub-centesimo, blocchi rapidi, orientata all'euro) o Polygon (commissioni basse, ecosistema ampio). Da evitare Ethereum mainnet, con costo e volatilita' del gas incompatibili con l'argomento PMI. Verificare quali reti espone concretamente il sandbox. Documentare: rete, RPC provider, block time, criterio di finalita' adottato (numero di conferme o finalita' deterministica).
- Off-ramp. Monerium sandbox (EURe, redeem SEPA): versione/endpoint API, data di accesso.
- SdI (da confermare). Provider sandbox FatturaPA: endpoint, versione del tracciato, ambiente di test.
- Stripe/PayPal. Modalita' sandbox per il flusso funzionale; per le commissioni si usano i listini di produzione documentati (tier, regione, data, URL), dichiarando l'assunzione perche' il sandbox non addebita fee reali.
- Piattaforma. Versione del plugin (commit/tag git), WooCommerce, WordPress, PHP, database, specifiche server/hosting, condizioni di rete.
- Generazione delle transazioni. Script automatizzato (preferibile, per ripetibilita') oppure manuale, da specificare, con N ripetizioni.
- Periodo e fuso orario della campagna di test.

Attuazione: Base Sepolia (chain id 84532), l'unica rete sulla quale il sandbox dell'emittente collega un IBAN; RPC pubblico `sepolia.base.org`; blocchi ogni 2 secondi; criterio di conferma variato per campagna (12 conferme nella campagna principale, scansione dei criteri in `campagna-finalita`). Fornitore SdI: Openapi, sandbox `test.sdi.openapi.it`, tracciato FatturaPA 1.9.1. Versioni della piattaforma dichiarate in `docker-compose.yml` e nel README. Generazione automatica con `tools/local-chain/campagna-lotti.mjs` e `campagna-finalita.mjs`; identificativi delle campagne nella colonna `campagna` del dataset e nel README della cartella `docs/dataset/`. Fuso orario del negozio Europe/Rome, marcatori in secondi Unix.

## 4. Disegno sperimentale (paragrafi 6.2 e 6.3)

- Paniere di importi (per far emergere la curva di costo e il punto di pareggio), proposta: 10, 25, 50, 100, 250, 500, 1.000, 2.500 euro. Motivazione: le fee di carta sono circa percentuali, quelle stablecoin circa piatte, quindi il crossover diventa visibile.
- Ripetizioni, proposta: N = 30 per ciascun importo e per ciascun binario (sufficiente per mediana/p95 e minima significativita'). Totale ordini = 8 x 30 x 3 = 720, scalabile.
- Fattori controllati: stessi importi e, per quanto possibile, stesse finestre temporali sui tre binari; stessa configurazione merchant.
- Cosa non e' confrontabile e va dichiarato: il calendario di payout delle carte e' una policy commerciale, non una latenza tecnica; va confrontato al livello corretto (regolamento con accredito) ed esplicitato.

Attuazione: paniere adottato integralmente; N = 30 per importo sul solo binario stablecoin nella campagna v1 (400 ordini validi) e tranche in giorni distinti nella campagna v2; i binari Stripe e PayPal non sono stati esercitati e il confronto si fonda sui listini. Le campagne brevi della scansione dei criteri usano un paniere ridotto (25, 100, 500 euro) a numerosita' uguale per criterio.

## 5. Strumentazione e raccolta dati (paragrafo 6.1)

Questo e' il motivo per cui definiamo il protocollo prima di scrivere codice: il logging va progettato dentro il plugin fin dalle prime fasi, non aggiunto alla fine. Il plugin (e il servizio companion di rilevamento on-chain) devono emettere, per ogni transazione, un record strutturato con i timestamp t0-t5 e l'esito.

Schema minimo del record: order_id, binario, importo, chain e txhash (se stablecoin), t0-t5, esito, categoria_errore, esito_fattura, importi/IVA. Export verso un dataset CSV/JSON versionato, allegabile alla tesi come artefatto riproducibile. Sincronizzazione NTP e timestamp in UTC.

Attuazione: `wp wcsdi export --format=csv` (`plugin/includes/class-wcsdi-export.php`), una riga per ordine con lo schema esteso descritto nel README della cartella `docs/dataset/`; file laterali per le ricevute rilette dalla rete (`ricevute-*.csv`), per il gas delle autorizzazioni e gli istanti di invio (`gas-*.csv`) e per il campionamento della finalita' delle reti (`finalita-*.csv`).

## 6. Analisi dei risultati (paragrafo 6.5)

- Statistiche descrittive per KPI e per binario: mediana, media, min/max, p95, deviazione standard.
- Figura chiave: curva del costo percentuale in funzione dell'importo, con le tre linee (stablecoin, Stripe, PayPal) e individuazione del punto di pareggio. E' l'artefatto piu' persuasivo per l'argomento PMI.
- Tabella riepilogativa dei KPI misurati con numeri reali (non descrizioni).
- Tasso di errore per categoria.
- Integrita' fiscale: percentuale di fatture valide/accettate.
- Discussione: quando e perche' il binario stablecoin conviene, e con quali limiti.

Attuazione: `tools/analisi.mjs` produce tutte le tabelle del capitolo, anche in forma LaTeX (`--latex`), a partire dai file di `docs/dataset/`; `tools/genera-grafici.mjs` le figure. I test di confronto fra gruppi (Kruskal-Wallis, Mann-Whitney) e gli intervalli di confidenza bootstrap sono calcolati dallo stesso script.

## 7. Minacce alla validita' e limiti (paragrafi 6.5 e 7.2)

Dichiararle apertamente e' precisamente cio' che rende il capitolo solido in commissione.

- Divergenza sandbox vs produzione (fee reali, comportamento degli errori, congestione di rete).
- Tempi SEPA dipendenti da orari e banca; dichiarare le assunzioni (SCT ordinario vs SCT Inst).
- Volatilita' del gas su reti pubbliche.
- Numerosita' campionaria limitata.
- Caso PMI reale (6.4) «ove possibile»: se fattibile, un pilota su un cliente reale con NDA/anonimizzazione documentata; altrimenti simulazione dichiarata come tale.

Attuazione: minacce riprese e ampliate nel paragrafo 6.5 della tesi (validita' interna, esterna, di costrutto e conclusiva); il caso PMI e' uno scenario su dati di comparto, dichiarato come tale.

## 8. Checklist: decisioni da confermare per bloccare il protocollo

1. Rete blockchain esposta dal sandbox (Gnosis / Polygon / altro) e criterio di finalita'. Sciolta: Base Sepolia; conteggio delle conferme nel piano, esteso alle etichette `safe` e `finalized` dopo la misura.
2. Paniere di importi definitivo. Sciolta: quello proposto.
3. Numero di ripetizioni N per cella. Sciolta: 30 nella campagna principale.
4. Conferma di misurare entrambi i livelli: conferma incasso e regolamento EUR. Sciolta: entrambi, con il regolamento limitato alla lavorazione dell'emittente.
5. Listino Stripe/PayPal di riferimento (tier, regione, data, fonte). Sciolta: `docs/dataset/baseline-psp-2026-08-31.csv`.
6. Provider SdI sandbox. Sciolta: Openapi.
7. Generazione transazioni automatica vs manuale. Sciolta: automatica.
