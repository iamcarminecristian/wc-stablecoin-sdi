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
  RPC_URL, FORWARDER, CONFIRMATIONS, POLL_MS, DECIMALS, MAX_BLOCK_SPAN,
  STATE_FILE, START_BLOCK, REDEEM_ENABLED,
} from './config.mjs';
import { caricaStato, salvaStato } from './state.mjs';
import { notificaPagamento } from './notify.mjs';
import { disponiRimborso, configurazioneRimborsoCompleta } from './redeem.mjs';

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

async function osserva(daBlocco, aBlocco) {
  // I provider RPC pubblici limitano l'ampiezza dell'intervallo interrogabile,
  // quindi si procede a finestre anziche' in una sola richiesta.
  for (let inizio = daBlocco; inizio <= aBlocco; inizio += MAX_BLOCK_SPAN) {
    const fine = inizio + MAX_BLOCK_SPAN - 1n > aBlocco ? aBlocco : inizio + MAX_BLOCK_SPAN - 1n;
    const logs = await client.getLogs({ address: FORWARDER, event: orderPaid, fromBlock: inizio, toBlock: fine });

    for (const log of logs) {
      const k = chiave(log);
      if (notificate.has(k) || inAttesa.has(k)) continue;
      inAttesa.set(k, {
        orderRef: log.args.orderRef,
        payer: log.args.payer,
        valore: log.args.amount,
        blocco: log.blockNumber,
        txHash: log.transactionHash,
        logIndex: log.logIndex,
      });
      console.log(`[VISTO]      ordine ${log.args.orderRef.slice(0, 10)} | ${formatUnits(log.args.amount, DECIMALS)} EURe | blocco ${log.blockNumber}`);
    }
  }
}

async function confermaEnotifica(testa) {
  for (const [k, p] of inAttesa) {
    const profondita = testa - p.blocco;
    if (profondita < CONFIRMATIONS) continue;

    const importo = formatUnits(p.valore, DECIMALS);
    const esito = await notificaPagamento({
      orderRef: p.orderRef,
      txHash: p.txHash,
      logIndex: p.logIndex,
      importo,
      payer: p.payer,
      blocco: p.blocco,
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

    console.log(`[CONFERMATO] ordine ${p.orderRef.slice(0, 10)} | ${importo} EURe | profondità ${profondita} blocchi`);
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
    const ordine = await disponiRimborso(importo);
    console.log(`[RIMBORSO]   disposto per ${orderRef.slice(0, 10)}: ordine ${ordine.id}, stato ${ordine.meta?.state}`);
  } catch (err) {
    // Il rimborso fallito non blocca nulla: la fatturazione dipende
    // dall'effettuazione dell'operazione, non dall'esito del rimborso.
    console.error(`[RIMBORSO]   fallito per ${orderRef.slice(0, 10)}: ${err.message ?? err}`);
  }
}

async function main() {
  const testa = await client.getBlockNumber();
  let ultimo = stato.ultimoBlocco ?? START_BLOCK ?? testa;

  console.log(`Watcher avviato. Contratto ${FORWARDER}, finalità ${CONFIRMATIONS} conferme, sondaggio ogni ${POLL_MS} ms.`);
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
