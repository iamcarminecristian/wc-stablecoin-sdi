# Il criterio di finalità su una rete di secondo livello

Il progetto adottava come criterio di finalità il conteggio delle conferme. È il
criterio giusto su una rete di primo livello, dove la profondità in blocchi
approssima il costo di riscrivere la storia. Su Base non lo è, e questa nota
spiega perché, che cosa lo sostituisce e quanto costa.

## Perché il conteggio non misura nulla, qui

Base è una rete di secondo livello costruita su OP Stack. I blocchi che il
sequencer produce non derivano dai dati pubblicati sulla rete sottostante:
restano revocabili finché il lotto che li contiene non vi è stato scritto, e
nessun numero di conferme accorcia quell'attesa, perché le conferme le produce
lo stesso sequencer che potrebbe riorganizzarle.

La specifica OP Stack nomina tre livelli e li definisce senza ambiguità.

Un blocco **unsafe** è «an L2 block that a rollup node knows about, but which was
not derived from the L1 chain». È il blocco appena prodotto. Dodici conferme su
questo livello sono dodici blocchi dello stesso sequencer: non spostano il
blocco a un livello diverso.

Un blocco **safe** è «an L2 block that can be derived entirely from L1 by a
rollup node». Il lotto è stato pubblicato. Può ancora decadere, ma solo se
decade il blocco di primo livello che lo contiene.

La testa **finalized** è «the highest L2 block that can be derived from finalized
L1 blocks, i.e. L1 blocks older than two L1 epochs». Revocarla richiederebbe una
violazione della finalità del consenso sottostante, con la penalizzazione degli
attori che vi concorrono.

## Perché qui pesa più che in un gateway ordinario

In un normale processore di pagamenti, accettare un incasso non ancora
irreversibile significa rischiare di spedire merce contro un pagamento che poi
svanisce. In questo sistema la conferma innesca due azioni irreversibili fuori
dalla catena: il servizio dispone il riscatto verso l'IBAN, che distrugge i
token e muove euro, e il plugin genera e trasmette la fattura al Sistema di
Interscambio. Un pagamento che decadesse dopo la conferma lascerebbe l'esercente
con euro accreditati a fronte di token mai ricevuti e con un documento fiscale
già trasmesso, correggibile solo con una nota di credito.

Il criterio di finalità non è quindi un parametro di comodità: è ciò che separa
il funzionamento nominale da un guasto che richiede rimedi contabili.

## Quanto costa ciascun livello

Arretrato delle due etichette rispetto alla testa della catena, campionato ogni
quindici secondi. L'avanzamento è a scatti, perché le etichette si muovono
quando un lotto viene pubblicato o finalizzato: per un esercente conta il valore
massimo, non la mediana, perché è quello che si presenta a chi paga subito dopo
uno scatto.

| Rete | Etichetta | n | min | mediana | p95 | max |
|---|---|---|---|---|---|---|
| Base mainnet | `safe` | 99 | 22 s | 56 s | 90 s | 96 s |
| Base mainnet | `finalized` | 99 | 830 s | 1 030 s | 1 197 s | 1 218 s |
| Base Sepolia | `safe` | 99 | 30 s | 230 s | 414 s | 444 s |
| Base Sepolia | `finalized` | 99 | 810 s | 1 010 s | 1 208 s | 1 256 s |
| Gnosis Chain | `safe` | 47 | 75 s | 120 s | 153 s | 155 s |
| Gnosis Chain | `finalized` | 47 | 155 s | 200 s | 233 s | 235 s |

I dati completi sono in `docs/dataset/finalita-*.csv`.

## Non dipende dal volume

La prima domanda che sorge è se questi tempi reggano sui grandi numeri. La
risposta è che non dipendono dal volume, e il confronto fra le prime due righe
lo dimostra senza bisogno di argomentazioni: Base mainnet è una delle reti di
secondo livello più trafficate, Base Sepolia è una rete di prova quasi deserta,
e l'arretrato di `finalized` è lo stesso a meno del rumore, 810-1 256 secondi
contro 830-1 218. Ciò che lo determina non è quante transazioni passino, ma la
cadenza con cui il lotto viene pubblicato e il tempo che la rete sottostante
impiega a finalizzare.

Su `safe` la differenza fra le due c'è, ed è nel verso opposto a quello che
l'intuizione suggerirebbe: la rete trafficata pubblica i lotti più spesso, ogni
minuto scarso, mentre quella deserta li pubblica ogni sette minuti circa, perché
un lotto quasi vuoto non vale il costo di pubblicarlo. Il volume, dove ha un
effetto, lo ha a favore.

C'è anzi un effetto di scala favorevole: le transazioni che cadono nella stessa
finestra finalizzano insieme, sicché l'attesa non si somma per transazione e la
coda dell'esercente non cresce con il traffico.

Non dipende nemmeno dall'importo. La sicurezza economica che sostiene la
finalità della rete sottostante è di ordini di grandezza superiore a qualunque
pagamento di commercio elettronico: per un negozio, `finalized` è più che
sufficiente a qualsiasi scontrino. La variabile che dipende dall'importo non è
la garanzia ma la sua necessità, ed è una scelta dell'esercente.

## Il limite è della rete sottostante, e si supera cambiando rete

I circa venti minuti non sono un difetto di Base. Sono la finalità di Ethereum:
gli slot durano dodici secondi, un'epoca ne conta trentadue e la finalità
richiede due epoche, cioè circa 12,8 minuti, ai quali il secondo livello aggiunge
il tempo di pubblicazione del lotto. **Nessuna rete di secondo livello costruita
su Ethereum può fare meglio**, perché eredita quel limite: cambiare criterio non
serve, va cambiata la rete.

La misura su Gnosis Chain mostra che l'alternativa esiste ed è praticabile.
Gnosis è una rete di primo livello che adotta la stessa architettura di consenso
di Ethereum ma con slot da cinque secondi ed epoche da circa ottanta, sicché la
finalità arriva in **155-235 secondi**, poco più di un quinto del tempo di Base.
L'emittente supporta EURe anche su Gnosis, il che rende la migrazione una
questione di configurazione e di collegamento dell'IBAN, non di riprogettazione.

Ne discende una conclusione di progetto che il \S4.3 non aveva colto: il valore
predefinito da tarare per rete non è un numero di conferme, è il tipo stesso di
criterio, e per un sistema in cui la conferma innesca azioni irreversibili fuori
dalla catena una rete di primo livello a finalità rapida vale più di una rete di
secondo livello a gas economico.

## Che cosa è cambiato nel codice

Il servizio di rilevamento accetta ora `FINALITY_MODE` con tre valori:
`confirmations`, che conserva il comportamento precedente, `safe` e `finalized`.
Il criterio adottato viaggia con ogni misura fino al dataset, accanto
all'eventuale numero di conferme: senza, misure prese sotto garanzie diverse
resterebbero indistinguibili.

Il valore predefinito resta `confirmations`, per non cambiare il comportamento
su una rete di primo livello dove quel criterio è corretto. Su una rete di
secondo livello va impostato `finalized`.

Una precisazione sulla misura, che è costata una prima serie di dati da buttare.
Con il conteggio delle conferme il marcatore t2 è l'ora del blocco che porta la
transazione alla profondità richiesta: è un'ora di catena, indipendente da
quando il servizio se ne accorge, ed è la misura preferibile.

Con le etichette non esiste un blocco equivalente, e prendere l'ora della testa
etichettata è un errore, che la prima esecuzione ha commesso. Quella testa porta
l'ora in cui fu prodotta, che è minuti nel passato, e le etichette avanzano a
scatti di centinaia di blocchi: l'ora della testa non dice nulla su quando il
pagamento sia diventato finale. L'errore era riconoscibile dall'incoerenza fra
le colonne, perché il riscatto parte subito dopo la conferma e la latenza di
regolamento risultava superiore a quella di conferma di oltre mille secondi
anziché di due.

Ciò che conta per l'esercente è l'istante in cui il criterio risulta
soddisfatto, perché è da lì che può agire: si adotta quello, con una
quantizzazione pari all'intervallo di sondaggio, cinque secondi, trascurabile
rispetto ai minuti in gioco.

## Una scelta che resta legittima

Attendere `finalized` costa fra i quindici e i venti minuti. Non è detto che
convenga sempre: per uno scontrino di venti euro un esercente può
ragionevolmente decidere di fidarsi del sequencer e accettare il pagamento
prima. Ciò che non è lecito è presentare quella scelta come una garanzia
crittografica: è fiducia in un operatore identificato, e va dichiarata per
quello che è. Il sistema la consente e la nomina, che è quanto serve perché la
decisione resti dell'esercente e sia consapevole.

## Fonti

- OP Stack Specification, *Glossary* — <https://specs.optimism.io/glossary.html>
- OP Stack Specification, *Derivation* —
  <https://specs.optimism.io/protocol/derivation.html>
- Optimism Docs, *Transaction Flow* —
  <https://docs.optimism.io/stack/protocol/transaction-flow>
- ethereum.org, *Proof-of-stake (PoS)* —
  <https://ethereum.org/developers/docs/consensus-mechanisms/pos/>
- Gnosis Chain Docs, *Consensus* — <https://docs.gnosischain.com/specs/consensus/>
