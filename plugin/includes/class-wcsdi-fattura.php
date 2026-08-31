<?php
/**
 * Composizione della fattura elettronica dai dati dell'ordine (RF-06, §4.5).
 *
 * Produce il tracciato FatturaPA come XML. La serializzazione passa da
 * XMLWriter anziché da concatenazione di stringhe: l'escaping dei valori è
 * garantito dalla libreria, e i dati che finiscono nel documento provengono
 * dall'ordine, quindi in ultima analisi dal cliente.
 *
 * L'ordine degli elementi non è opzionale: le specifiche definiscono sequenze,
 * e un elemento fuori posto fa scartare la fattura. La struttura di questo file
 * segue perciò l'ordine del tracciato, non una comodità di scrittura.
 */

defined( 'ABSPATH' ) || exit;

class WCSDI_Fattura {

	/**
	 * ============================================================
	 * SCELTE FISCALI IN ATTESA DI VALIDAZIONE DEL RELATORE
	 * ============================================================
	 * Sono le scelte del §4.5 adottate in via preliminare. Vivono qui, tutte
	 * insieme e isolate dal resto della composizione, proprio perché il gate
	 * non è ancora sciolto: cambiarle deve restare una modifica di poche righe
	 * in un solo punto, non una revisione sparsa nel codice.
	 *
	 * TIPO_DOCUMENTO       TD01, cessione di beni o prestazione di servizi.
	 * MODALITA_PAGAMENTO   MP05 (bonifico): rappresenta la sostanza dell'incasso
	 *                      a regime, in cui le disponibilità affluiscono come
	 *                      accredito SEPA generato dal rimborso.
	 * CONDIZIONI_PAGAMENTO TP02, pagamento completo in una soluzione.
	 * ADG_*                Riferimenti on-chain in AltriDatiGestionali, blocco
	 *                      destinato dalle specifiche alle informazioni
	 *                      concordate fra le parti (RF-09).
	 */
	const TIPO_DOCUMENTO       = 'TD01';
	const MODALITA_PAGAMENTO   = 'MP05';
	const CONDIZIONI_PAGAMENTO = 'TP02';
	const ADG_TX_HASH          = 'TX-HASH';
	const ADG_CHAIN            = 'CHAIN';
	const ADG_PAY_ADDR         = 'PAY-ADDR';
	/** Fine delle scelte sotto gate fiscale. */

	/**
	 * Formato di trasmissione. L'attributo `versione` sull'elemento radice deve
	 * riportare lo stesso valore di FormatoTrasmissione: se divergono il SdI
	 * scarta la fattura con il codice 00428.
	 */
	const FORMATO_TRASMISSIONE = 'FPR12';

	/** Codice convenzionale per destinatari senza canale telematico. */
	const DESTINATARIO_DEFAULT = '0000000';

	const NS_FATTURA = 'http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2';

	/** Lunghezza massima di RiferimentoTesto secondo le specifiche. */
	const MAX_RIFERIMENTO_TESTO = 60;

	/**
	 * Numero progressivo della fattura, univoco nell'anno.
	 *
	 * Il contatore è per anno perché la numerazione riparte da uno a ogni
	 * esercizio. L'incremento avviene dentro l'azione asincrona, che Action
	 * Scheduler esegue una alla volta: è la stessa serializzazione su cui il
	 * plugin conta per non trasmettere due volte lo stesso documento.
	 */
	public static function prossimo_numero( $anno ) {
		$chiave = 'wcsdi_numeratore_' . (int) $anno;
		$n      = (int) get_option( $chiave, 0 ) + 1;
		update_option( $chiave, $n, false );
		return $n;
	}

	/**
	 * Compone la fattura per l'ordine indicato.
	 *
	 * @param WC_Order $order  Ordine già pagato.
	 * @param array    $config Dati del cedente dalla configurazione del gateway.
	 * @param int      $numero Numero progressivo assegnato.
	 * @return string Documento XML pronto per la trasmissione.
	 */
	public static function componi( WC_Order $order, array $config, $numero ) {
		$righe = self::righe( $order );
		if ( empty( $righe ) ) {
			// Meglio fermarsi qui che trasmettere un documento che il
			// fornitore rifiuterebbe con un messaggio meno comprensibile.
			throw new WCSDI_SdI_Exception(
				sprintf( 'Ordine %d privo di righe fatturabili', $order->get_id() ),
				false
			);
		}

		$riepilogo = self::riepilogo( $righe );
		$totale    = (float) $order->get_total();

		$w = new XMLWriter();
		$w->openMemory();
		$w->setIndent( true );
		$w->setIndentString( '  ' );
		$w->startDocument( '1.0', 'UTF-8' );

		$w->startElementNS( 'p', 'FatturaElettronica', self::NS_FATTURA );
		$w->writeAttribute( 'versione', self::FORMATO_TRASMISSIONE );

		self::scrivi_header( $w, $order, $config, $numero );
		self::body( $w, $order, $numero, $righe, $riepilogo, $totale );

		$w->endElement();
		$w->endDocument();

		return $w->outputMemory();
	}

	/**
	 * Intestazione del documento: trasmittente, cedente e cessionario.
	 * È pubblica perché identica per la fattura e per la nota di credito, e
	 * duplicarla significherebbe lasciarle divergere alla prima modifica.
	 */
	public static function scrivi_header( XMLWriter $w, WC_Order $order, array $config, $numero ) {
		$w->startElement( 'FatturaElettronicaHeader' );

		$w->startElement( 'DatiTrasmissione' );
		$w->startElement( 'IdTrasmittente' );
		$w->writeElement( 'IdPaese', 'IT' );
		$w->writeElement( 'IdCodice', $config['fiscal_id'] );
		$w->endElement();
		$w->writeElement( 'ProgressivoInvio', str_pad( (string) $numero, 5, '0', STR_PAD_LEFT ) );
		$w->writeElement( 'FormatoTrasmissione', self::FORMATO_TRASMISSIONE );
		$w->writeElement( 'CodiceDestinatario', self::codice_destinatario( $order ) );
		$pec = self::pec_destinatario( $order );
		if ( null !== $pec ) {
			$w->writeElement( 'PECDestinatario', $pec );
		}
		$w->endElement();

		$w->startElement( 'CedentePrestatore' );
		$w->startElement( 'DatiAnagrafici' );
		$w->startElement( 'IdFiscaleIVA' );
		$w->writeElement( 'IdPaese', 'IT' );
		$w->writeElement( 'IdCodice', $config['fiscal_id'] );
		$w->endElement();
		$w->startElement( 'Anagrafica' );
		$w->writeElement( 'Denominazione', $config['denominazione'] );
		$w->endElement();
		$w->writeElement( 'RegimeFiscale', $config['regime'] );
		$w->endElement();
		self::sede( $w, $config['sede'] );
		$w->endElement();

		$w->startElement( 'CessionarioCommittente' );
		self::anagrafica_cessionario( $w, $order );
		self::sede( $w, self::sede_cessionario( $order ) );
		$w->endElement();

		$w->endElement();
	}

	private static function body( XMLWriter $w, WC_Order $order, $numero, array $righe, array $riepilogo, $totale ) {
		$w->startElement( 'FatturaElettronicaBody' );

		$w->startElement( 'DatiGenerali' );
		$w->startElement( 'DatiGeneraliDocumento' );
		$w->writeElement( 'TipoDocumento', self::TIPO_DOCUMENTO );
		$w->writeElement( 'Divisa', 'EUR' );
		// Momento di effettuazione: la data in cui il pagamento on-chain si è
		// perfezionato, non quella della trasmissione, che può cadere più
		// tardi per effetto dei ritentativi (§4.5).
		$w->writeElement( 'Data', self::data_effettuazione( $order ) );
		$w->writeElement( 'Numero', (string) $numero );
		$w->writeElement( 'ImportoTotaleDocumento', self::dec( $totale ) );
		$w->endElement();
		$w->endElement();

		$w->startElement( 'DatiBeniServizi' );
		$adg = self::riferimenti_onchain( $order );
		foreach ( $righe as $i => $riga ) {
			$w->startElement( 'DettaglioLinee' );
			$w->writeElement( 'NumeroLinea', (string) ( $i + 1 ) );
			$w->writeElement( 'Descrizione', $riga['descrizione'] );
			if ( null !== $riga['quantita'] ) {
				$w->writeElement( 'Quantita', self::dec( $riga['quantita'] ) );
			}
			$w->writeElement( 'PrezzoUnitario', self::dec( $riga['prezzo_unitario'] ) );
			$w->writeElement( 'PrezzoTotale', self::dec( $riga['imponibile'] ) );
			$w->writeElement( 'AliquotaIVA', self::dec( $riga['aliquota'] ) );
			// I riferimenti on-chain descrivono l'incasso nel suo insieme, non
			// la singola riga: si riportano una volta sola, sulla prima.
			if ( 0 === $i ) {
				foreach ( $adg as $dato ) {
					$w->startElement( 'AltriDatiGestionali' );
					$w->writeElement( 'TipoDato', $dato['tipo'] );
					$w->writeElement( 'RiferimentoTesto', $dato['valore'] );
					$w->endElement();
				}
			}
			$w->endElement();
		}

		foreach ( $riepilogo as $voce ) {
			$w->startElement( 'DatiRiepilogo' );
			$w->writeElement( 'AliquotaIVA', self::dec( $voce['aliquota'] ) );
			$w->writeElement( 'ImponibileImporto', self::dec( $voce['imponibile'] ) );
			$w->writeElement( 'Imposta', self::dec( $voce['imposta'] ) );
			$w->writeElement( 'EsigibilitaIVA', 'I' );
			$w->endElement();
		}
		$w->endElement();

		$w->startElement( 'DatiPagamento' );
		$w->writeElement( 'CondizioniPagamento', self::CONDIZIONI_PAGAMENTO );
		$w->startElement( 'DettaglioPagamento' );
		$w->writeElement( 'ModalitaPagamento', self::MODALITA_PAGAMENTO );
		$w->writeElement( 'ImportoPagamento', self::dec( $totale ) );
		$w->endElement();
		$w->endElement();

		$w->endElement();
	}

	/**
	 * Righe del documento: articoli dell'ordine più le spese di spedizione,
	 * che il tracciato tratta come una riga a sé con la propria aliquota.
	 */
	private static function righe( WC_Order $order ) {
		$righe = array();

		// get_items() senza argomenti restituisce le sole righe prodotto: le
		// commissioni sono righe fatturabili a tutti gli effetti e vanno
		// chieste esplicitamente, altrimenti il documento nasce senza corpo.
		foreach ( $order->get_items( array( 'line_item', 'fee' ) ) as $item ) {
			$imponibile = (float) $item->get_total();
			$imposta    = (float) $item->get_total_tax();
			$quantita   = (float) $item->get_quantity();

			$righe[] = array(
				'descrizione'     => $item->get_name(),
				'quantita'        => $quantita > 0 ? $quantita : null,
				'prezzo_unitario' => $quantita > 0 ? $imponibile / $quantita : $imponibile,
				'imponibile'      => $imponibile,
				'imposta'         => $imposta,
				'aliquota'        => self::aliquota( $imponibile, $imposta ),
			);
		}

		$spedizione = (float) $order->get_shipping_total();
		if ( $spedizione > 0 ) {
			$imposta = (float) $order->get_shipping_tax();
			$righe[] = array(
				'descrizione'     => __( 'Spese di spedizione', 'wc-stablecoin-sdi' ),
				'quantita'        => null,
				'prezzo_unitario' => $spedizione,
				'imponibile'      => $spedizione,
				'imposta'         => $imposta,
				'aliquota'        => self::aliquota( $spedizione, $imposta ),
			);
		}

		return $righe;
	}

	/** Riepilogo per aliquota: il tracciato ne vuole uno per ciascuna. */
	private static function riepilogo( array $righe ) {
		$per_aliquota = array();
		foreach ( $righe as $riga ) {
			$k = self::dec( $riga['aliquota'] );
			if ( ! isset( $per_aliquota[ $k ] ) ) {
				$per_aliquota[ $k ] = array( 'aliquota' => $riga['aliquota'], 'imponibile' => 0.0, 'imposta' => 0.0 );
			}
			$per_aliquota[ $k ]['imponibile'] += $riga['imponibile'];
			$per_aliquota[ $k ]['imposta']    += $riga['imposta'];
		}
		return array_values( $per_aliquota );
	}

	private static function aliquota( $imponibile, $imposta ) {
		return $imponibile > 0 ? round( $imposta / $imponibile * 100, 2 ) : 0.0;
	}

	/**
	 * Riferimenti dell'incasso on-chain (RF-09).
	 * Rendono la fattura autoportante ai fini di riconciliazione e controllo:
	 * dal solo documento si risale alla transazione che lo ha originato.
	 */
	private static function riferimenti_onchain( WC_Order $order ) {
		$valori = array(
			self::ADG_TX_HASH  => (string) $order->get_meta( '_wcsdi_tx_hash' ),
			self::ADG_CHAIN    => (string) $order->get_meta( '_wcsdi_chain' ),
			self::ADG_PAY_ADDR => (string) $order->get_meta( '_wcsdi_receive_address' ),
		);

		$out = array();
		foreach ( $valori as $tipo => $valore ) {
			if ( '' === $valore ) {
				continue;
			}
			// Il campo è limitato a 60 caratteri e un hash di transazione ne
			// occupa 66: eccede e va troncato. La perdita è accettabile perché
			// il prefisso resta sufficiente a individuare la transazione.
			$out[] = array( 'tipo' => $tipo, 'valore' => substr( $valore, 0, self::MAX_RIFERIMENTO_TESTO ) );
		}
		return $out;
	}

	private static function anagrafica_cessionario( XMLWriter $w, WC_Order $order ) {
		$piva = trim( (string) $order->get_meta( '_wcsdi_piva' ) );
		$cf   = trim( (string) $order->get_meta( '_wcsdi_codice_fiscale' ) );

		$denominazione = trim( $order->get_billing_company() );
		if ( '' === $denominazione ) {
			$denominazione = trim( $order->get_billing_first_name() . ' ' . $order->get_billing_last_name() );
		}
		if ( '' === $denominazione ) {
			$denominazione = __( 'Cliente', 'wc-stablecoin-sdi' );
		}

		$w->startElement( 'DatiAnagrafici' );
		if ( '' !== $piva ) {
			$w->startElement( 'IdFiscaleIVA' );
			$w->writeElement( 'IdPaese', 'IT' );
			$w->writeElement( 'IdCodice', $piva );
			$w->endElement();
		}
		if ( '' !== $cf ) {
			$w->writeElement( 'CodiceFiscale', $cf );
		}
		$w->startElement( 'Anagrafica' );
		$w->writeElement( 'Denominazione', $denominazione );
		$w->endElement();
		$w->endElement();
	}

	private static function sede_cessionario( WC_Order $order ) {
		return array(
			'indirizzo' => $order->get_billing_address_1(),
			'cap'       => $order->get_billing_postcode(),
			'comune'    => $order->get_billing_city(),
			'provincia' => $order->get_billing_state(),
			'nazione'   => $order->get_billing_country() ? $order->get_billing_country() : 'IT',
		);
	}

	private static function sede( XMLWriter $w, array $sede ) {
		$w->startElement( 'Sede' );
		$w->writeElement( 'Indirizzo', $sede['indirizzo'] );
		$w->writeElement( 'CAP', $sede['cap'] );
		$w->writeElement( 'Comune', $sede['comune'] );
		// La provincia è facoltativa e vuole la sigla di due lettere: un
		// valore più lungo, come il nome esteso, farebbe scartare la fattura.
		if ( ! empty( $sede['provincia'] ) && 2 === strlen( $sede['provincia'] ) ) {
			$w->writeElement( 'Provincia', strtoupper( $sede['provincia'] ) );
		}
		$w->writeElement( 'Nazione', $sede['nazione'] );
		$w->endElement();
	}

	private static function codice_destinatario( WC_Order $order ) {
		$codice = trim( (string) $order->get_meta( '_wcsdi_codice_destinatario' ) );
		return '' !== $codice ? strtoupper( $codice ) : self::DESTINATARIO_DEFAULT;
	}

	private static function pec_destinatario( WC_Order $order ) {
		$pec = trim( (string) $order->get_meta( '_wcsdi_pec' ) );
		return '' !== $pec ? $pec : null;
	}

	private static function data_effettuazione( WC_Order $order ) {
		$pagato = $order->get_date_paid();
		return $pagato ? $pagato->date( 'Y-m-d' ) : gmdate( 'Y-m-d' );
	}

	private static function dec( $n ) {
		return number_format( (float) $n, 2, '.', '' );
	}
}
