<?php
/**
 * Nota di credito a fronte di un rimborso disposto dall'esercente (RF-10).
 *
 * Una fattura trasmessa al SdI non si annulla e non si corregge: si rettifica
 * con un documento di segno opposto che rinvia a quello originario. La nota
 * segue perciò lo stesso percorso della fattura, con gli stessi ritentativi,
 * e viene emessa una sola volta per ciascun rimborso.
 */

defined( 'ABSPATH' ) || exit;

class WCSDI_Nota_Credito {

	const AZIONE = 'wcsdi_trasmetti_nota_credito';
	const GRUPPO = 'wc-stablecoin-sdi';

	/** Tipo documento per la nota di credito, come da §4.5 e RF-10. */
	const TIPO_DOCUMENTO = 'TD04';

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
		// rimborso di un ordine mai fatturato non genera alcun documento.
		if ( '' === (string) $order->get_meta( '_wcsdi_fattura_uuid' ) ) {
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

		$numero = (int) $refund->get_meta( '_wcsdi_nota_numero' );
		if ( ! $numero ) {
			$numero = WCSDI_Fattura::prossimo_numero( (int) gmdate( 'Y' ) );
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

			if ( $e->e_transitorio() ) {
				as_schedule_single_action(
					time() + HOUR_IN_SECONDS,
					self::AZIONE,
					array( 'order_id' => $order->get_id(), 'refund_id' => $refund->get_id() ),
					self::GRUPPO
				);
			}
		}
	}

	/**
	 * Compone la nota di credito.
	 *
	 * Il documento ricalca la fattura, con due differenze: il tipo è quello
	 * della nota e il blocco DatiFatture Collegate rinvia al documento che
	 * viene rettificato. Gli importi restano positivi: è il tipo di documento
	 * a esprimere il segno, non il valore.
	 */
	private static function componi( WC_Order $order, $refund, array $config, $numero ) {
		$totale = abs( (float) $refund->get_total() );
		$imposta = abs( (float) $refund->get_total_tax() );
		$imponibile = $totale - $imposta;
		$aliquota = $imponibile > 0 ? round( $imposta / $imponibile * 100, 2 ) : 0.0;

		$motivo = trim( (string) $refund->get_reason() );
		if ( '' === $motivo ) {
			$motivo = __( 'Rimborso', 'wc-stablecoin-sdi' );
		}

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
		$w->writeElement( 'Data', gmdate( 'Y-m-d' ) );
		$w->writeElement( 'Numero', (string) $numero );
		$w->writeElement( 'ImportoTotaleDocumento', number_format( $totale, 2, '.', '' ) );
		$w->endElement();

		// Rinvio alla fattura rettificata: senza, la nota resterebbe un
		// documento sospeso, non collegato ad alcuna operazione.
		$w->startElement( 'DatiFattureCollegate' );
		$w->writeElement( 'IdDocumento', (string) $order->get_meta( '_wcsdi_fattura_numero' ) );
		$data_fattura = $order->get_date_paid();
		$w->writeElement( 'Data', $data_fattura ? $data_fattura->date( 'Y-m-d' ) : gmdate( 'Y-m-d' ) );
		$w->endElement();

		$w->endElement();

		$w->startElement( 'DatiBeniServizi' );
		$w->startElement( 'DettaglioLinee' );
		$w->writeElement( 'NumeroLinea', '1' );
		$w->writeElement( 'Descrizione', $motivo );
		$w->writeElement( 'PrezzoUnitario', number_format( $imponibile, 2, '.', '' ) );
		$w->writeElement( 'PrezzoTotale', number_format( $imponibile, 2, '.', '' ) );
		$w->writeElement( 'AliquotaIVA', number_format( $aliquota, 2, '.', '' ) );
		$w->endElement();

		$w->startElement( 'DatiRiepilogo' );
		$w->writeElement( 'AliquotaIVA', number_format( $aliquota, 2, '.', '' ) );
		$w->writeElement( 'ImponibileImporto', number_format( $imponibile, 2, '.', '' ) );
		$w->writeElement( 'Imposta', number_format( $imposta, 2, '.', '' ) );
		$w->writeElement( 'EsigibilitaIVA', 'I' );
		$w->endElement();
		$w->endElement();

		$w->endElement();
		$w->endElement();
		$w->endDocument();

		return $w->outputMemory();
	}

	private static function configurazione() {
		return WCSDI_Fatturazione::configurazione_cedente();
	}
}
