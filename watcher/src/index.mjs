// Servizio di rilevamento on-chain (paragrafo 4.3 della tesi).
//
// Osserva gli eventi OrderPaid del contratto di inoltro, applica il criterio
// di finalita' configurato e notifica al plugin i pagamenti confermati, che
// resta l'unica autorita' sullo stato dell'ordine. Se abilitato, dispone il
// rimborso alla pari verso l'IBAN dell'esercente.
//
// Ogni OrderPaid emesso dal contratto e' per definizione un incasso
// dell'esercente, quindi il servizio non ha bisogno di conoscere in anticipo
// gli ordini in attesa: non esiste una registrazione preventiva da mantenere
// in sincronia, e il plugin ritrova l'ordine dal riferimento nell'evento.
import { createPublicClient, http, parseAbiItem, formatUnits } from 'viem';

import {
  RPC_URL, CHAIN_ID, FORWARDER, CONFIRMATIONS, FINALITY_MODE, POLL_MS, DECIMALS, MAX_BLOCK_SPAN,
  STATE_FILE, START_BLOCK, REDEEM_ENABLED,
} from './config.mjs';
import { caricaStato, salvaStato } from './state.mjs';
import { notificaPagamento, notificaRimborso } from './notify.mjs';
import { disponiRimborso, attendiRimborso, configurazioneRimborsoCompleta } from './redeem.mjs';

const orderPaid = parseAbiItem(
  'event OrderPaid(bytes32 indexed orderRef, address indexed payer, uint256 amount)'
);

const client = createPublicClient({ transport: http(RPC_URL) });

const stato = caricaStato(STATE_FILE);
const notificate = new Set(stato.notificate);

// Pagamenti visti ma non ancora confermati. Non persistiti di proposito: un
// evento provvisorio viene comunque riproposto dalla catena al riavvio,
// mentre uno decaduto per riorganizzazione non deve sopravvivere in memoria.
const inAttesa = new Map();

const chiave = (log) => `${log.transactionHash}:${log.logIndex}`;

// Cache dei tempi di blocco: nel giro di osservazione lo stesso blocco ricorre
// per piu' eventi, e interrogare il nodo ogni volta sarebbe uno spreco.
const oraBlocco = new Map();

async function istanteBlocco(numero) {
  const k = numero.toString();
  if (!oraBlocco.has(k)) {
    const blocco = await client.getBlock({ blockNumber: numero });
    oraBlocco.set(k, Number(blocco.timestamp));
  }
  return oraBlocco.get(k);
}

// Costo effettivo della transazione: gas consumato per prezzo pagato, come
// prescrive il protocollo. Non e' una stima ma il dato della ricevuta.
async function costoTransazione(txHash) {
  try {
    const r = await client.getTransactionReceipt({ hash: txHash });
    const usato = r.gasUsed;
    const prezzo = r.effectiveGasPrice ?? 0n;
    return {
      gasUsato: usato.toString(),
      gasPrezzo: prezzo.toString(),
      costoGas: formatUnits(usato * prezzo, 18),
    };
  } catch {
    // Il costo e' un dato di misura, non una condizione di funzionamento:
    // se manca si prosegue, il pagamento resta valido.
    return { gasUsato: '', gasPrezzo: '', costoGas: '' };
  }
}

async function osserva(daBlocco, aBlocco) {
  // I provider RPC pubblici limitano l'ampiezza dell'intervallo interrogabile,
  // quindi si procede a finestre anziche' in una sola richiesta.
  for (let inizio = daBlocco; inizio <= aBlocco; inizio += MAX_BLOCK_SPAN) {
    const fine = inizio + MAX_BLOCK_SPAN - 1n > aBlocco ? aBlocco : inizio + MAX_BLOCK_SPAN - 1n;
    const logs = await client.getLogs({ address: FORWARDER, event: orderPaid, fromBlock: inizio, toBlock: fine });

    for (const log of logs) {
      const k = chiave(log);
      if (notificate.has(k) || inAttesa.has(k)) continue;

      // t1 e' l'ora del blocco che contiene la transazione, non quella in cui
      // questo servizio l'ha vista: la seconda dipende dall'intervallo di
      // sondaggio e falserebbe la latenza misurata.
      const t1 = await istanteBlocco(log.blockNumber);
      const costo = await costoTransazione(log.transactionHash);

      inAttesa.set(k, {
        orderRef: log.args.orderRef,
        payer: log.args.payer,
        valore: log.args.amount,
        blocco: log.blockNumber,
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        t1,
        ...costo,
      });
      console.log(`[VISTO]      ordine ${log.args.orderRef.slice(0, 10)} | ${formatUnits(log.args.amount, DECIMALS)} EURe | blocco ${log.blockNumber}`);
    }
  }
}

/// Ultimo blocco che soddisfa il criterio di finalita' configurato, insieme
/// all'istante da attribuire al marcatore t2.
///
/// Con il conteggio delle conferme l'istante e' quello del blocco che porta la
/// transazione alla profondita' richiesta, ed e' un'ora di catena, indipendente
/// da quando il servizio se ne accorge. Con le etichette non esiste un blocco
/// equivalente, perche' l'avanzamento dipende da eventi del primo livello: si
/// adotta l'ora del blocco che in quel momento e' la testa sicura o
/// finalizzata, e la misura porta percio' una quantizzazione pari
/// all'intervallo di sondaggio, trascurabile rispetto ai minuti in gioco.
async function testaFinale(testa) {
  if ('confirmations' === FINALITY_MODE) {
    return { numero: testa - CONFIRMATIONS, perBlocco: (b) => b + CONFIRMATIONS };
  }
  const blocco = await client.getBlock({ blockTag: FINALITY_MODE });
  oraBlocco.set(blocco.number.toString(), Number(blocco.timestamp));
  return { numero: blocco.number, perBlocco: () => blocco.number };
}

async function confermaEnotifica(testa) {
  if (inAttesa.size === 0) return;

  const finale = await testaFinale(testa);

  for (const [k, p] of inAttesa) {
    if (p.blocco > finale.numero) continue;

    const importo = formatUnits(p.valore, DECIMALS);

    // t2 e' l'istante in cui l'incasso diventa certo per l'esercente secondo
    // il criterio scelto.
    const t2 = await istanteBlocco(finale.perBlocco(p.blocco));

    const esito = await notificaPagamento({
      chainId: CHAIN_ID,
      orderRef: p.orderRef,
      txHash: p.txHash,
      logIndex: p.logIndex,
      importo,
      payer: p.payer,
      blocco: p.blocco,
      conferme: 'confirmations' === FINALITY_MODE ? Number(CONFIRMATIONS) : 0,
      criterio: FINALITY_MODE,
      t1: p.t1,
      t2,
      gasUsato: p.gasUsato,
      gasPrezzo: p.gasPrezzo,
      costoGas: p.costoGas,
    });

    if (!esito.ok) {
      console.error(`[NOTIFICA]   fallita per ${p.orderRef.slice(0, 10)}: ${esito.dettaglio}`);
      // Un errore definitivo non migliora riprovando: si smette di insistere
      // e si lascia traccia, altrimenti il servizio resterebbe bloccato su un
      // evento che nessun tentativo puo' risolvere.
      if (esito.definitivo) {
        notificate.add(k);
        inAttesa.delete(k);
        stato.notificate = [...notificate];
        salvaStato(STATE_FILE, stato);
      }
      continue;
    }

    console.log(`[CONFERMATO] ordine ${p.orderRef.slice(0, 10)} | ${importo} EURe | ${'confirmations' === FINALITY_MODE ? `profondità ${testa - p.blocco} blocchi` : `criterio ${FINALITY_MODE}, ${testa - p.blocco} blocchi di ritardo`}`);
    notificate.add(k);
    inAttesa.delete(k);
    stato.notificate = [...notificate];
    salvaStato(STATE_FILE, stato);

    if (REDEEM_ENABLED) await rimborsa(p.orderRef, importo);
  }
}

async function rimborsa(orderRef, importo) {
  if (!configurazioneRimborsoCompleta()) {
    console.log(`[RIMBORSO]   saltato per ${orderRef.slice(0, 10)}: configurazione Monerium incompleta`);
    return;
  }
  try {
    // t4 del protocollo: l'istante in cui il rimborso viene disposto. Si
    // rileva prima della chiamata, cosi' la latenza di rete dell'emittente
    // ricade nel regolamento e non sparisce dalla misura.
    const t4 = Date.now() / 1000;
    const ordine = await disponiRimborso(importo, orderRef);
    console.log(`[RIMBORSO]   disposto per ${orderRef.slice(0, 10)}: ordine ${ordine.id}, stato ${ordine.state}`);

    await notificaRimborso({ orderRef, stato: ordine.state ?? 'placed', ordineId: ordine.id, t4 });

    // t5: gli euro sono usciti verso l'IBAN. Si attende in modo asincrono per
    // non trattenere il ciclo di osservazione, che deve restare reattivo.
    attendiRimborso(ordine.id)
      .then((esito) => {
        if (!esito) return;
        console.log(`[RIMBORSO]   ${orderRef.slice(0, 10)} concluso: ${esito.stato}`);
        return notificaRimborso({ orderRef, stato: esito.stato, ordineId: ordine.id, t5: esito.t5 });
      })
      .catch((err) => console.error(`[RIMBORSO]   esito non rilevato: ${err.message ?? err}`));
  } catch (err) {
    // Il rimborso fallito non blocca nulla: la fatturazione dipende
    // dall'effettuazione dell'operazione, non dall'esito del rimborso.
    console.error(`[RIMBORSO]   fallito per ${orderRef.slice(0, 10)}: ${err.message ?? err}`);
  }
}

async function main() {
  const testa = await client.getBlockNumber();
  let ultimo = stato.ultimoBlocco ?? START_BLOCK ?? testa;

  const criterio = 'confirmations' === FINALITY_MODE ? `${CONFIRMATIONS} conferme` : `etichetta ${FINALITY_MODE}`;
  console.log(`Watcher avviato. Contratto ${FORWARDER}, finalità per ${criterio}, sondaggio ogni ${POLL_MS} ms.`);
  console.log(`Ripartenza dal blocco ${ultimo} (testa ${testa}), ${notificate.size} eventi già notificati.`);
  if (REDEEM_ENABLED && !configurazioneRimborsoCompleta()) {
    console.log('Rimborso automatico abilitato ma non configurato: i pagamenti verranno solo notificati.');
  }

  for (;;) {
    try {
      const testa = await client.getBlockNumber();
      if (testa > ultimo) {
        await osserva(ultimo + 1n, testa);
        ultimo = testa;
        stato.ultimoBlocco = ultimo;
        salvaStato(STATE_FILE, stato);
      }
      await confermaEnotifica(testa);
    } catch (err) {
      // Un guasto transitorio della rete o del provider non deve terminare il
      // servizio: si registra e si riprova al giro successivo.
      console.error(`[ERRORE]     ${err.message ?? err}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main();
