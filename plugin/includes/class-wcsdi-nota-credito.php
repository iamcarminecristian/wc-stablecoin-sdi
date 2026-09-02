<?php
/**
 * Nota di credito a fronte di un rimborso disposto dall'esercente (RF-10).
 *
 * Una fattura trasmessa al SdI non si annulla e non si corregge: si rettifica
 * con un documento di segno opposto che rinvia a quello originario (art. 26,
 * c. 2 e 3, DPR 633/72). La nota segue perciò lo stesso percorso della
 * fattura, con gli stessi ritentativi, e viene emessa una sola volta per
 * ciascun rimborso.
 *
 * Il documento rettifica; la restituzione della somma al cliente è un atto
 * distinto, che questo componente non esegue: se l'esercente ne registra
 * l'hash sul rimborso, la nota lo riporta fra i riferimenti.
 */

defined( 'ABSPATH' ) || exit;

class WCSDI_Nota_Credito {

	const AZIONE = 'wcsdi_trasmetti_nota_credito';
	const GRUPPO = 'wc-stablecoin-sdi';

	/** Tipo documento per la nota di credito, come da §4.5 e RF-10. */
	const TIPO_DOCUMENTO = 'TD04';

	/** Oltre questo numero di tentativi il caso passa all'esercente. */
	const MAX_TENTATIVI = 6;

	/**
	 * Oltre un anno dall'effettuazione la variazione in diminuzione per
	 * sopravvenuto accordo fra le parti non è ammessa (art. 26, c. 3): il
	 * sistema non conosce la causa del rimborso e lascia la qualificazione
	 * all'esercente, ma lo avverte.
	 */
	const GIORNI_AVVISO = 365;

	public static function init() {
		add_action( self::AZIONE, array( __CLASS__, 'trasmetti' ), 10, 2 );

		// WooCommerce segnala il rimborso quando è già registrato: da qui si
		// conosce l'importo effettivamente restituito.
		add_action( 'woocommerce_order_refunded', array( __CLASS__, 'accoda' ), 10, 2 );
	}

	/**
	 * Mette in coda la nota per il rimborso indicato.
	 *
	 * La chiave del lavoro è l'identificativo del rimborso, non quello
	 * dell'ordine: un ordine può essere rimborsato più volte, e ogni rimborso
	 * richiede la propria nota.
	 */
	public static function accoda( $order_id, $refund_id ) {
		if ( ! function_exists( 'as_schedule_single_action' ) ) {
			return;
		}

		$order = wc_get_order( (int) $order_id );
		if ( ! $order || 'wcsdi_eure' !== $order->get_payment_method() ) {
			return;
		}

		// Senza una fattura trasmessa non c'è nulla da rettificare: il
		// rimborso di un ordine mai fatturato non genera alcun documento. Una
		// fattura scartata è, per il SdI, mai emessa: la nota resterebbe un
		// documento sospeso.
		$stato_fattura = (string) $order->get_meta( '_wcsdi_fattura_stato' );
		if ( '' === (string) $order->get_meta( '_wcsdi_fattura_uuid' ) || in_array( $stato_fattura, array( 'rejected', 'errore', 'da_ritrasmettere' ), true ) ) {
			$order->add_order_note( __( 'Nota di credito non emessa: la fattura originaria non risulta trasmessa e accettata.', 'wc-stablecoin-sdi' ) );
			$order->save();
			return;
		}

		$args = array( 'order_id' => (int) $order_id, 'refund_id' => (int) $refund_id );
		if ( as_has_scheduled_action( self::AZIONE, $args, self::GRUPPO ) ) {
			return;
		}

		as_schedule_single_action( time(), self::AZIONE, $args, self::GRUPPO );
	}

	/**
	 * Compone e trasmette la nota. Invocata da Action Scheduler.
	 */
	public static function trasmetti( $order_id, $refund_id ) {
		$order  = wc_get_order( (int) $order_id );
		$refund = wc_get_order( (int) $refund_id );
		if ( ! $order || ! $refund ) {
			return;
		}

		// Ogni nota emessa resta annotata sul proprio rimborso: è il modo per
		// non emetterne una seconda a fronte di un ritentativo o di un
		// riaccodamento (RNF-03).
		if ( '' !== (string) $refund->get_meta( '_wcsdi_nota_uuid' ) ) {
			return;
		}

		$tentativo = (int) $refund->get_meta( '_wcsdi_nota_tentativi' ) + 1;
		$refund->update_meta_data( '_wcsdi_nota_tentativi', $tentativo );
		$refund->save();

		$config = self::configurazione();
		if ( is_wp_error( $config ) ) {
			$order->add_order_note( sprintf(
				/* translators: %s: descrizione dell'errore */
				__( 'Nota di credito non emessa: %s', 'wc-stablecoin-sdi' ),
				$config->get_error_message()
			) );
			$order->save();
			return;
		}

		self::avvisa_termine( $order );

		$numero = (int) $refund->get_meta( '_wcsdi_nota_numero' );
		if ( ! $numero ) {
			$numero = WCSDI_Fattura::prossimo_numero( (int) wp_date( 'Y' ) );
			$refund->update_meta_data( '_wcsdi_nota_numero', $numero );
			$refund->save();
		}

		try {
			$xml    = self::componi( $order, $refund, $config, $numero );
			$client = new WCSDI_SdI_Client( $config['base_url'], $config['token'] );
			$esito  = $client->trasmetti( $xml );

			$refund->update_meta_data( '_wcsdi_nota_uuid', $esito['uuid'] );
			$refund->save();

			$order->add_order_note( sprintf(
				/* translators: 1: numero nota, 2: importo, 3: identificativo */
				__( 'Nota di credito %1$s per %2$s EUR trasmessa al SdI. Identificativo %3$s.', 'wc-stablecoin-sdi' ),
				$numero,
				wc_format_decimal( (string) abs( (float) $refund->get_total() ) ),
				$esito['uuid']
			) );
			$order->save();

		} catch ( WCSDI_SdI_Exception $e ) {
			$order->add_order_note( sprintf(
				/* translators: %s: descrizione dell'errore */
				__( 'Trasmissione della nota di credito non riuscita: %s', 'wc-stablecoin-sdi' ),
				$e->getMessage()
			) );
			$order->save();

			if ( $e->e_transitorio() && $tentativo < self::MAX_TENTATIVI ) {
				$attesa = WCSDI_Fatturazione::BACKOFF[ min( $tentativo - 1, count( WCSDI_Fatturazione::BACKOFF ) - 1 ) ];
				as_schedule_single_action(
					time() + $attesa,
					self::AZIONE,
					array( 'order_id' => $order->get_id(), 'refund_id' => $refund->get_id() ),
					self::GRUPPO
				);
				return;
			}
			$refund->update_meta_data( '_wcsdi_nota_errore', $e->getMessage() );
			$refund->save();
			do_action( 'wcsdi_nota_credito_fallita', $order, $refund, $e->getMessage() );
		}
	}

	/**
	 * Compone la nota di credito.
	 *
	 * Il documento ricalca la fattura, con due differenze: il tipo è quello
	 * della nota e il blocco DatiFattureCollegate rinvia al documento che
	 * viene rettificato. Gli importi restano positivi: è il tipo di documento
	 * a esprimere il segno, non il valore. Le righe seguono quelle del
	 * rimborso, ciascuna con la propria aliquota: un rimborso parziale su un
	 * ordine con più aliquote non può essere ridotto a un'aliquota media.
	 */
	private static function componi( WC_Order $order, $refund, array $config, $numero ) {
		$righe = self::righe( $refund, $config );
		if ( empty( $righe ) ) {
			throw new WCSDI_SdI_Exception( 'Rimborso privo di importi da rettificare', false );
		}
		$riepilogo = self::riepilogo( $righe );
		$totale    = abs( (float) $refund->get_total() );

		$w = new XMLWriter();
		$w->openMemory();
		$w->setIndent( true );
		$w->setIndentString( '  ' );
		$w->startDocument( '1.0', 'UTF-8' );

		$w->startElementNS( 'p', 'FatturaElettronica', WCSDI_Fattura::NS_FATTURA );
		$w->writeAttribute( 'versione', WCSDI_Fattura::FORMATO_TRASMISSIONE );

		WCSDI_Fattura::scrivi_header( $w, $order, $config, $numero );

		$w->startElement( 'FatturaElettronicaBody' );
		$w->startElement( 'DatiGenerali' );
		$w->startElement( 'DatiGeneraliDocumento' );
		$w->writeElement( 'TipoDocumento', self::TIPO_DOCUMENTO );
		$w->writeElement( 'Divisa', 'EUR' );
		$w->writeElement( 'Data', wp_date( 'Y-m-d' ) );
		$w->writeElement( 'Numero', (string) $numero );
		$w->writeElement( 'ImportoTotaleDocumento', WCSDI_Fattura::dec( $totale ) );
		$motivo = trim( (string) $refund->get_reason() );
		if ( '' !== $motivo ) {
			$w->writeElement( 'Causale', substr( $motivo, 0, WCSDI_Fattura::MAX_CAUSALE ) );
		}
		$w->endElement();

		// Rinvio alla fattura rettificata: senza, la nota resterebbe un
		// documento sospeso, non collegato ad alcuna operazione.
		$w->startElement( 'DatiFattureCollegate' );
		$w->writeElement( 'IdDocumento', (string) $order->get_meta( '_wcsdi_fattura_numero' ) );
		$w->writeElement( 'Data', WCSDI_Fattura::data_effettuazione( $order ) );
		$w->endElement();

		$w->endElement();

		$w->startElement( 'DatiBeniServizi' );
		$adg = self::riferimenti_restituzione( $refund );
		foreach ( $righe as $i => $riga ) {
			$w->startElement( 'DettaglioLinee' );
			$w->writeElement( 'NumeroLinea', (string) ( $i + 1 ) );
			$w->writeElement( 'Descrizione', $riga['descrizione'] );
			if ( null !== $riga['quantita'] ) {
				$w->writeElement( 'Quantita', WCSDI_Fattura::dec( $riga['quantita'] ) );
			}
			$w->writeElement( 'PrezzoUnitario', WCSDI_Fattura::dec8( $riga['prezzo_unitario'] ) );
			$w->writeElement( 'PrezzoTotale', WCSDI_Fattura::dec( $riga['imponibile'] ) );
			$w->writeElement( 'AliquotaIVA', WCSDI_Fattura::dec( $riga['aliquota'] ) );
			if ( null !== $riga['natura'] ) {
				$w->writeElement( 'Natura', $riga['natura'] );
			}
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
			$w->writeElement( 'AliquotaIVA', WCSDI_Fattura::dec( $voce['aliquota'] ) );
			if ( null !== $voce['natura'] ) {
				$w->writeElement( 'Natura', $voce['natura'] );
			}
			$w->writeElement( 'ImponibileImporto', WCSDI_Fattura::dec( $voce['imponibile'] ) );
			$w->writeElement( 'Imposta', WCSDI_Fattura::dec( $voce['imposta'] ) );
			$w->writeElement( 'EsigibilitaIVA', 'I' );
			$w->endElement();
		}
		$w->endElement();

		$w->endElement();
		$w->endElement();
		$w->endDocument();

		return $w->outputMemory();
	}

	/**
	 * Righe della nota, dalle righe del rimborso. Un rimborso registrato per
	 * solo importo, senza righe, produce una riga unica con l'aliquota
	 * ricavata dal rapporto e ricondotta a quella vigente più vicina.
	 */
	private static function righe( $refund, array $config ) {
		$righe = array();
		foreach ( $refund->get_items( array( 'line_item', 'fee', 'shipping' ) ) as $item ) {
			$imponibile = abs( (float) $item->get_total() );
			$imposta    = abs( (float) $item->get_total_tax() );
			if ( $imponibile <= 0 ) {
				continue;
			}
			$quantita = method_exists( $item, 'get_quantity' ) ? abs( (float) $item->get_quantity() ) : 0.0;
			if ( 'shipping' === $item->get_type() ) {
				$quantita = 0.0;
			}
			$aliquota = WCSDI_Fattura::aliquota_item( $item, $imponibile, $imposta );
			$natura   = null;
			if ( $aliquota <= 0.0 ) {
				$natura = ! empty( $config['natura_iva_zero'] ) ? $config['natura_iva_zero'] : null;
				if ( null === $natura ) {
					throw new WCSDI_SdI_Exception( 'Riga di rimborso a IVA zero senza Natura configurata.', false );
				}
			}
			$righe[] = array(
				'descrizione'     => WCSDI_Fattura::campo( $item->get_name(), WCSDI_Fattura::MAX_DESCRIZIONE, 'descrizione di riga' ),
				'quantita'        => $quantita > 0 ? $quantita : null,
				'prezzo_unitario' => $quantita > 0 ? $imponibile / $quantita : $imponibile,
				'imponibile'      => $imponibile,
				'imposta'         => $imposta,
				'aliquota'        => $aliquota,
				'natura'          => $natura,
			);
		}

		if ( empty( $righe ) ) {
			$totale     = abs( (float) $refund->get_total() );
			$imposta    = abs( (float) $refund->get_total_tax() );
			$imponibile = $totale - $imposta;
			if ( $imponibile <= 0 ) {
				return array();
			}
			$derivata = $imposta / $imponibile * 100;
			$aliquota = round( $derivata, 2 );
			foreach ( WCSDI_Fattura::ALIQUOTE_NOTE as $nota ) {
				if ( abs( $derivata - $nota ) < 0.5 ) {
					$aliquota = $nota;
				}
			}
			$motivo = trim( (string) $refund->get_reason() );
			$righe[] = array(
				'descrizione'     => '' !== $motivo ? substr( $motivo, 0, WCSDI_Fattura::MAX_DESCRIZIONE ) : __( 'Rimborso', 'wc-stablecoin-sdi' ),
				'quantita'        => null,
				'prezzo_unitario' => $imponibile,
				'imponibile'      => $imponibile,
				'imposta'         => $imposta,
				'aliquota'        => $aliquota,
				'natura'          => $aliquota <= 0.0 ? ( ! empty( $config['natura_iva_zero'] ) ? $config['natura_iva_zero'] : 'N2.2' ) : null,
			);
		}
		return $righe;
	}

	private static function riepilogo( array $righe ) {
		$per_aliquota = array();
		foreach ( $righe as $riga ) {
			$k = WCSDI_Fattura::dec( $riga['aliquota'] ) . '|' . (string) $riga['natura'];
			if ( ! isset( $per_aliquota[ $k ] ) ) {
				$per_aliquota[ $k ] = array( 'aliquota' => $riga['aliquota'], 'natura' => $riga['natura'], 'imponibile' => 0.0, 'imposta' => 0.0 );
			}
			$per_aliquota[ $k ]['imponibile'] += $riga['imponibile'];
			$per_aliquota[ $k ]['imposta']    += $riga['imposta'];
		}
		return array_values( $per_aliquota );
	}

	/**
	 * Se l'esercente ha registrato sul rimborso l'hash della transazione con
	 * cui ha restituito gli EURe al cliente, la nota lo riporta: è ciò che
	 * collega il documento di rettifica a una restituzione avvenuta.
	 */
	private static function riferimenti_restituzione( $refund ) {
		$hash = strtolower( trim( (string) $refund->get_meta( '_wcsdi_restituzione_tx' ) ) );
		if ( ! preg_match( '/^0x[0-9a-f]{64}$/', $hash ) ) {
			return array();
		}
		return array(
			array( 'tipo' => 'RESTIT-TX1', 'valore' => substr( $hash, 0, 33 ) ),
			array( 'tipo' => 'RESTIT-TX2', 'valore' => substr( $hash, 33 ) ),
		);
	}

	private static function avvisa_termine( WC_Order $order ) {
		$pagato = $order->get_date_paid();
		if ( ! $pagato ) {
			return;
		}
		$giorni = (int) floor( ( time() - $pagato->getTimestamp() ) / DAY_IN_SECONDS );
		if ( $giorni > self::GIORNI_AVVISO ) {
			$order->add_order_note( sprintf(
				/* translators: %d: giorni trascorsi */
				__( 'La nota di credito rettifica un\'operazione effettuata %d giorni fa: oltre l\'anno la variazione in diminuzione è ammessa solo per nullità, annullamento, revoca o risoluzione, non per sopravvenuto accordo (art. 26, c. 2 e 3, DPR 633/72). La qualificazione resta all\'esercente.', 'wc-stablecoin-sdi' ),
				$giorni
			) );
			$order->save();
		}
	}

	private static function configurazione() {
		return WCSDI_Fatturazione::configurazione_cedente();
	}
}
