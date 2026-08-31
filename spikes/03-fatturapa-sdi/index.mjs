// ============================================================================
// SPIKE 3 — Generazione FatturaPA e trasmissione SdI via openapi.it (sandbox)
//
// Obiettivo dello spike: dimostrare in isolamento (1) la generazione di un
// file XML conforme al tracciato FatturaPA 1.9.1 a partire da un ordine di
// esempio, applicando la mappatura del §4.5 della tesi (TD01, valuta EUR,
// MP05, riferimenti on-chain in AltriDatiGestionali), (2) la trasmissione
// al SdI di test tramite openapi.it e la lettura delle ricevute.
//
// Esecuzione:
//   cp .env.example .env   (compilare i valori)
//   npm start              (nessuna dipendenza esterna)
//
// Output: fattura di esempio in ./out/IT01234567890_00001.xml
//
// Criterio di uscita dello spike: fattura accettata dal SdI di test con
// ricevuta di consegna o messa a disposizione.
//
// NOTA: il passo (1) è implementato; il passo (2) è predisposto ma endpoint
// e formato di invio vanno allineati alla documentazione openapi.it dopo
// l'attivazione del servizio in sandbox.
// ATTENZIONE (gate fiscale): la scelta di MP05 e la codifica dei riferimenti
// on-chain in AltriDatiGestionali sono in attesa di validazione del relatore.
// ============================================================================

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';

// --- Ordine di esempio (nel sistema integrato arriva da WooCommerce) -------
const ordine = {
  numero: '2026-0001',
  data: '2026-07-27',
  cedente: {
    denominazione: 'Esempio SRL',
    partitaIva: '01234567890',
    codiceFiscale: '01234567890',
    regimeFiscale: 'RF01',
    indirizzo: { via: 'Via Roma 1', cap: '00100', comune: 'Roma', provincia: 'RM', nazione: 'IT' },
  },
  cessionario: {
    denominazione: 'Cliente di Prova SRL',
    partitaIva: '09876543210',
    codiceDestinatario: '0000000', // consumatore/PEC: gestito nel plugin
    indirizzo: { via: 'Via Milano 2', cap: '20100', comune: 'Milano', provincia: 'MI', nazione: 'IT' },
  },
  righe: [
    { descrizione: 'Prodotto di esempio', quantita: 1, prezzoUnitario: 100.0, aliquotaIVA: 22.0 },
  ],
  pagamento: {
    modalita: 'MP05', // bonifico: accredito SEPA generato dal rimborso EURe (§4.5)
    txHash: '0x' + 'ab'.repeat(32),
    rete: 'gnosis-chiado',
    indirizzoIncasso: '0x' + 'cd'.repeat(20),
  },
};

// --- Generazione XML (tracciato FPR12, v. specifiche 1.9.1) ----------------
const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const dec = (n) => n.toFixed(2);

function generaFattura(o) {
  const imponibile = o.righe.reduce((t, r) => t + r.quantita * r.prezzoUnitario, 0);
  const aliquota = o.righe[0].aliquotaIVA; // spike: aliquota unica; il plugin gestirà il riepilogo per aliquota
  const imposta = imponibile * (aliquota / 100);
  const totale = imponibile + imposta;
  const progressivo = '00001';

  // Riferimenti on-chain: AltriDatiGestionali, figlio di DettaglioLinee
  // (blocco 2.2.1.16 del tracciato) — mappatura §4.5, RF-09. GATE FISCALE.
  const adg = [
    ['TX-HASH', o.pagamento.txHash],
    ['CHAIN', o.pagamento.rete],
    ['PAY-ADDR', o.pagamento.indirizzoIncasso],
  ].map(([tipo, val]) => `
        <AltriDatiGestionali>
          <TipoDato>${tipo}</TipoDato>
          <RiferimentoTesto>${xmlEscape(val)}</RiferimentoTesto>
        </AltriDatiGestionali>`).join('');

  const righeXml = o.righe.map((r, i) => `
      <DettaglioLinee>
        <NumeroLinea>${i + 1}</NumeroLinea>
        <Descrizione>${xmlEscape(r.descrizione)}</Descrizione>
        <Quantita>${dec(r.quantita)}</Quantita>
        <PrezzoUnitario>${dec(r.prezzoUnitario)}</PrezzoUnitario>
        <PrezzoTotale>${dec(r.quantita * r.prezzoUnitario)}</PrezzoTotale>
        <AliquotaIVA>${dec(r.aliquotaIVA)}</AliquotaIVA>${i === 0 ? adg : ''}
      </DettaglioLinee>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="FPR12"
  xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <FatturaElettronicaHeader>
    <DatiTrasmissione>
      <IdTrasmittente>
        <IdPaese>IT</IdPaese>
        <IdCodice>${o.cedente.partitaIva}</IdCodice>
      </IdTrasmittente>
      <ProgressivoInvio>${progressivo}</ProgressivoInvio>
      <FormatoTrasmissione>FPR12</FormatoTrasmissione>
      <CodiceDestinatario>${o.cessionario.codiceDestinatario}</CodiceDestinatario>
    </DatiTrasmissione>
    <CedentePrestatore>
      <DatiAnagrafici>
        <IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${o.cedente.partitaIva}</IdCodice></IdFiscaleIVA>
        <CodiceFiscale>${o.cedente.codiceFiscale}</CodiceFiscale>
        <Anagrafica><Denominazione>${xmlEscape(o.cedente.denominazione)}</Denominazione></Anagrafica>
        <RegimeFiscale>${o.cedente.regimeFiscale}</RegimeFiscale>
      </DatiAnagrafici>
      <Sede>
        <Indirizzo>${xmlEscape(o.cedente.indirizzo.via)}</Indirizzo>
        <CAP>${o.cedente.indirizzo.cap}</CAP>
        <Comune>${xmlEscape(o.cedente.indirizzo.comune)}</Comune>
        <Provincia>${o.cedente.indirizzo.provincia}</Provincia>
        <Nazione>${o.cedente.indirizzo.nazione}</Nazione>
      </Sede>
    </CedentePrestatore>
    <CessionarioCommittente>
      <DatiAnagrafici>
        <IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${o.cessionario.partitaIva}</IdCodice></IdFiscaleIVA>
        <Anagrafica><Denominazione>${xmlEscape(o.cessionario.denominazione)}</Denominazione></Anagrafica>
      </DatiAnagrafici>
      <Sede>
        <Indirizzo>${xmlEscape(o.cessionario.indirizzo.via)}</Indirizzo>
        <CAP>${o.cessionario.indirizzo.cap}</CAP>
        <Comune>${xmlEscape(o.cessionario.indirizzo.comune)}</Comune>
        <Provincia>${o.cessionario.indirizzo.provincia}</Provincia>
        <Nazione>${o.cessionario.indirizzo.nazione}</Nazione>
      </Sede>
    </CessionarioCommittente>
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody>
    <DatiGenerali>
      <DatiGeneraliDocumento>
        <TipoDocumento>TD01</TipoDocumento>
        <Divisa>EUR</Divisa>
        <Data>${o.data}</Data>
        <Numero>${o.numero}</Numero>
        <ImportoTotaleDocumento>${dec(totale)}</ImportoTotaleDocumento>
      </DatiGeneraliDocumento>
    </DatiGenerali>
    <DatiBeniServizi>${righeXml}
      <DatiRiepilogo>
        <AliquotaIVA>${dec(aliquota)}</AliquotaIVA>
        <ImponibileImporto>${dec(imponibile)}</ImponibileImporto>
        <Imposta>${dec(imposta)}</Imposta>
        <EsigibilitaIVA>I</EsigibilitaIVA>
      </DatiRiepilogo>
    </DatiBeniServizi>
    <DatiPagamento>
      <CondizioniPagamento>TP02</CondizioniPagamento>
      <DettaglioPagamento>
        <ModalitaPagamento>${o.pagamento.modalita}</ModalitaPagamento>
        <ImportoPagamento>${dec(totale)}</ImportoPagamento>
      </DettaglioPagamento>
    </DatiPagamento>
  </FatturaElettronicaBody>
</p:FatturaElettronica>
`;
}

// --- Trasmissione a openapi.it (sandbox) ------------------------------------
// TODO(spike): allineare endpoint, autenticazione e formato di invio alla
// documentazione del servizio dopo l'attivazione in sandbox; implementare
// poi il polling/webhook delle ricevute SdI (consegna, scarto, MC).
async function trasmetti(_xml) {
  console.log('[SDI] stub: implementare invio dopo attivazione sandbox openapi.it');
}

function main() {
  const xml = generaFattura(ordine);
  mkdirSync('out', { recursive: true });
  const nomeFile = `IT${ordine.cedente.partitaIva}_00001.xml`;
  writeFileSync(`out/${nomeFile}`, xml, 'utf8');
  console.log(`[OK] generato out/${nomeFile} (${xml.length} byte)`);
  return trasmetti(xml);
}

main();
