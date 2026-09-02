# Analisi statica del contratto di inoltro

Strumento: Slither 0.11.6, compilatore solc 0.8.24, 102 detector attivi.
Esecuzione del 1 settembre 2026 su `contracts/src/OrderForwarder.sol`.

```bash
pip install slither-analyzer solc-select
solc-select install 0.8.24 && solc-select use 0.8.24
cd contracts && slither src/OrderForwarder.sol
```

**Nota sul compilatore (2 settembre 2026).** Il contratto pubblicato su Base
Sepolia è stato compilato con solc 0.8.36 (vedi `CLAUDE.md`, ambiente di
misura), non con la 0.8.24 usata per l'esecuzione sopra descritta. Una
rianalisi con Slither sul bytecode 0.8.36 non è stata eseguita in questa
sessione: né `slither` né `solc-select` risultano installati
nell'ambiente disponibile (`pip` stesso non è presente), e installarli non
rientrava nei tempi a disposizione. Non si dichiara quindi alcun esito per
la 0.8.36: l'esito riportato sotto resta quello ottenuto con la 0.8.24 e va
letto con questo scarto di versione. Le due segnalazioni a impatto basso
discusse più sotto riguardano un pattern (`reentrancy-events`) indipendente
dalla versione del compilatore, ma questo non è stato riverificato
empiricamente sulla 0.8.36.

## Esito

| Impatto | Segnalazioni |
|---|---|
| Alto | 0 |
| Medio | 0 |
| Basso | 2 |
| Informativo | 0 |

Le due segnalazioni appartengono entrambe al detector `reentrancy-events`,
impatto basso e confidenza media, e riguardano `_forward` e `payWithPermit`.

## Le due segnalazioni

Il detector rileva che l'evento `OrderPaid` viene emesso dopo la chiamata
esterna `token.transferFrom`, e che in caso di rientranza gli eventi
potrebbero essere emessi in un ordine diverso da quello atteso.

La segnalazione non descrive un rischio per questo contratto, e la ragione e'
strutturale anziche' argomentativa: **il contratto non ha stato persistente**.
Le uniche due variabili, `token` e `merchant`, sono `immutable`, quindi
risiedono nel bytecode e non in memoria persistente, e nessuna funzione scrive
alcuno slot. Una rientranza non puo' percio' corrompere alcuno stato, perche'
non ve n'e' alcuno da corrompere.

Quanto agli eventi, una chiamata rientrante produrrebbe un secondo `OrderPaid`
solo a fronte di un secondo `transferFrom` effettivamente eseguito, cioe' di un
pagamento realmente avvenuto. I due eventi avrebbero indici di log distinti, e
la chiave di idempotenza del servizio di rilevamento e' proprio la coppia
`txHash:logIndex`: due pagamenti distinti resterebbero distinti, un evento
ripetuto verrebbe riconosciuto. Perche' la condizione si presenti servirebbe
inoltre un token rientrante, mentre il token e' fissato alla costruzione ed e'
l'EURe dell'emittente.

## Perche' il contratto non e' stato modificato

Il rilievo si silenzierebbe emettendo l'evento prima della chiamata esterna. La
modifica non e' stata apportata per una ragione di integrita' sperimentale: il
contratto pubblicato su Base Sepolia all'indirizzo
`0x91f7B2252256a112Fe12Ee79BA58e1cb290D21C3` e' quello con cui sono state
eseguite tutte le misure del Capitolo 6, e sostituirne il bytecode dopo la
campagna spezzerebbe la corrispondenza fra i dati riportati e l'artefatto
pubblicato. Trattandosi di un rilievo di impatto basso e privo di conseguenze
dimostrabili su questo contratto, la scelta e' di documentarlo anziche' di
inseguire un esito privo di segnalazioni.

## Cosa l'analisi non copre

L'analisi statica esamina il contratto isolatamente e non sostituisce una
revisione indipendente. Restano fuori dal suo perimetro il comportamento in
composizione con il token reale, le proprieta' che richiederebbero verifica
formale e l'analisi economica degli incentivi.
