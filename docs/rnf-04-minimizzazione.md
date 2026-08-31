# RNF-04: verifica della minimizzazione dei dati

Verifica condotta il 1 settembre 2026 sul codice del plugin e del servizio di
rilevamento. RNF-04 chiede che il trattamento dei dati personali segua il
principio di minimizzazione; questa nota accerta quali dati il sistema raccolga,
dove finiscano e se ciascuno abbia una finalità.

Il metodo è quello di seguire il dato, non la dichiarazione: per ogni
informazione riconducibile a una persona si è cercato dove viene scritta, chi la
legge e verso quali destinatari esce.

## Che cosa esce dal negozio, e verso chi

**Sulla rete pubblica** finiscono l'importo, l'indirizzo di incasso
dell'esercente e il riferimento dell'ordine. Il riferimento non è
l'identificativo dell'ordine ma il suo HMAC-SHA256 con un segreto che non lascia
il negozio: chi osserva la catena non può risalire al numero d'ordine né
collegare fra loro due pagamenti dello stesso cliente. È una scelta che RNF-04
richiedeva e che l'architettura rispetta per costruzione.

**Al servizio di rilevamento** arrivano il riferimento dell'ordine, l'hash della
transazione, l'importo e gli istanti. Nessun dato anagrafico. Il servizio non
conosce chi sia il cliente e non ha bisogno di saperlo.

**All'emittente dell'\ac{EMT}** vanno l'importo, l'\ac{IBAN} e il nome
dell'esercente, più il riferimento dell'ordine come promemoria. Sono dati
dell'esercente, non del cliente: la controparte del riscatto è l'esercente verso
se stesso.

**Al Sistema di Interscambio** vanno i dati anagrafici del cessionario, cioè
denominazione o nome e cognome, indirizzo, codice fiscale o partita \ac{IVA}.
Sono gli elementi che il tracciato FatturaPA impone e senza i quali la fattura
viene scartata: qui la minimizzazione non è una scelta del progetto ma un
vincolo di legge, e il sistema non trasmette nulla oltre il necessario.

## Il punto meno ovvio: l'indirizzo di provenienza

L'indirizzo del portafoglio da cui parte il pagamento è l'unico dato personale
che il sistema acquisisce senza che il cliente lo digiti, e merita attenzione
perché è pseudonimo ma non anonimo.

La verifica ha accertato tre cose. Primo: **non viene trasmesso al Sistema di
Interscambio.** Il campo `PAY-ADDR` del blocco `AltriDatiGestionali` riporta
l'indirizzo di *incasso dell'esercente*, non quello del pagatore. Secondo: **non
compare nel dataset esportato per il Capitolo 6**, che contiene identificativi
d'ordine, importi, istanti e hash, ma nessun elemento anagrafico. Terzo, ed è il
difetto emerso dalla verifica: **era conservato senza essere letto da alcuna
parte del sistema.**

Un dato raccolto e mai usato è esattamente ciò che la minimizzazione vieta. La
finalità però esiste, e stava altrove: quando la finestra di pagamento scade con
un incasso parziale, la somma va restituita, e l'indirizzo di provenienza è
l'unica informazione con cui l'esercente può restituirla. La nota che l'ordine
riportava in quel caso diceva «la somma va restituita al cliente» senza dire a
quale indirizzo.

La correzione ha reso la conservazione strumentale alla finalità: la nota riporta
ora l'indirizzo di provenienza, ed è l'unico punto del sistema in cui compare.

## Una limitazione che resta

L'hash della transazione viene trasmesso al Sistema di Interscambio, ed è
pubblico per natura: da esso chiunque consulti un esploratore di blocchi ricava
l'indirizzo del pagatore. La pseudonimizzazione dell'indirizzo di provenienza è
quindi efficace verso l'osservatore della sola catena, che non può risalire
all'ordine, ma non verso chi disponga già della fattura.

Questo è un effetto della scelta, oggi sotto la validazione del relatore, di
riportare i riferimenti on-chain in `AltriDatiGestionali`. La scelta ha una
ragione, cioè rendere l'operazione verificabile e chiudere il registro di audit
richiesto da RF-09, e ha questo costo. Va dichiarata insieme al suo costo, non
presentata come neutra.

## Esito

RNF-04 è soddisfatto: nessun dato personale del cliente è scritto sulla rete
pubblica, nessuno raggiunge il servizio di rilevamento o l'emittente, e verso il
Sistema di Interscambio va il solo insieme che il tracciato impone. Il difetto
trovato, cioè la conservazione senza finalità dell'indirizzo di provenienza, è
stato corretto rendendo la conservazione strumentale all'unico uso che la
giustifica. Resta dichiarata la limitazione sulla tracciabilità indiretta
attraverso l'hash della transazione.
