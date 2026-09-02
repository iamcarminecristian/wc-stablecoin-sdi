<?php
/**
 * Scadenza della finestra di pagamento (RF-04).
 *
 * Un ordine in attesa non può restarci per sempre: oltre la finestra
 * configurata il riferimento non è più valido e l'ordine va chiuso. La
 * chiusura non cancella però quanto eventualmente ricevuto, che resta
 * registrato sull'ordine perché l'esercente possa restituirlo.
 */

defined( 'ABSPATH' ) || exit;

class WCSDI_Scadenza {

	const AZIONE = 'wcsdi_scadenza_pagamento';
	const GRUPPO = 'wc-stablecoin-sdi';

	/**
	 * Margine oltre la finestra, per criterio di conferma, in secondi.
	 *
	 * Un pagamento partito all'ultimo minuto deve avere il tempo di
	 * soddisfare il criterio, altrimenti si chiuderebbe un ordine di fatto
	 * pagato. Con il conteggio delle conferme bastano pochi minuti; con
	 * l'etichetta «finalized» l'attesa misurata su Base arriva a ventuno
	 * minuti (Capitolo 6, tab. dell'arretrato delle etichette), e il margine
	 * deve superarla.
	 */
	const MARGINE = array(
		'confirmations' => 600,
		'safe'          => 900,
		'finalized'     => 1800,
	);

	public static function init() {
		add_action( self::AZIONE, array( __CLASS__, 'verifica' ), 10, 1 );
	}

	/**
	 * Pianifica la verifica alla scadenza della finestra dell'ordine.
	 */
	public static function pianifica( WC_Order $order ) {
		if ( ! function_exists( 'as_schedule_single_action' ) ) {
			return;
		}

		$scadenza = (int) $order->get_meta( '_wcsdi_expires_at' );
		if ( $scadenza <= 0 ) {
			return;
		}

		$args = array( 'order_id' => $order->get_id() );
		if ( as_has_scheduled_action( self::AZIONE, $args, self::GRUPPO ) ) {
			return;
		}

		$opzioni  = (array) get_option( 'woocommerce_wcsdi_eure_settings', array() );
		$criterio = isset( $opzioni['finality_mode'] ) ? (string) $opzioni['finality_mode'] : 'finalized';
		$base     = isset( self::MARGINE[ $criterio ] ) ? self::MARGINE[ $criterio ] : self::MARGINE['finalized'];
		$margine  = (int) apply_filters( 'wcsdi_margine_scadenza', $base, $order );

		as_schedule_single_action( $scadenza + $margine, self::AZIONE, $args, self::GRUPPO );
	}

	/**
	 * Chiude l'ordine se la finestra è passata senza che il dovuto sia stato
	 * raggiunto. Invocata da Action Scheduler.
	 */
	public static function verifica( $order_id ) {
		$order = wc_get_order( (int) $order_id );
		if ( ! $order ) {
			return;
		}

		// Solo gli ordini ancora in attesa interessano: se il pagamento è
		// arrivato l'ordine è già passato oltre, e un pagamento parziale è
		// stato messo in sospeso, stato che l'esercente deve poter valutare.
		if ( ! $order->has_status( array( 'pending', 'on-hold' ) ) ) {
			return;
		}

		$incassato = (float) $order->get_meta( '_wcsdi_paid_total' );
		$dovuto    = (float) $order->get_meta( '_wcsdi_expected_amount' );

		if ( $incassato > 0 ) {
			// Ha pagato, ma non abbastanza. L'ordine si chiude comunque,
			// perché il riferimento non è più valido, ma la somma ricevuta
			// resta evidenziata: è un pagamento non dovuto, che va restituito
			// (art. 2033 c.c.), non trattenuto in silenzio.
			// L'indirizzo di provenienza compare qui e nella nota di eccedenza:
			// è l'unica informazione con cui l'esercente può restituire la
			// somma, ed è la ragione per cui viene conservato (RNF-04).
			$mittente = (string) $order->get_meta( '_wcsdi_payer' );

			$order->update_status( 'failed', sprintf(
				/* translators: 1: importo incassato, 2: importo dovuto, 3: indirizzo di provenienza */
				__( 'Finestra di pagamento scaduta con un pagamento parziale: ricevuti %1$s EURe su %2$s dovuti. La somma va restituita all\'indirizzo di provenienza %3$s.', 'wc-stablecoin-sdi' ),
				wc_format_decimal( (string) $incassato ),
				wc_format_decimal( (string) $dovuto ),
				'' !== $mittente ? $mittente : __( 'non registrato', 'wc-stablecoin-sdi' )
			) );
			$order->update_meta_data( '_wcsdi_da_restituire', wc_format_decimal( (string) $incassato ) );
		} else {
			$order->update_status( 'failed', __( 'Finestra di pagamento scaduta senza alcun incasso.', 'wc-stablecoin-sdi' ) );
		}

		$order->update_meta_data( '_wcsdi_scaduto', 'yes' );
		$order->save();

		/**
		 * Consente all'esercente di essere avvisato di un ordine scaduto,
		 * in particolare quando resta una somma da restituire.
		 *
		 * @param WC_Order $order     Ordine scaduto.
		 * @param float    $incassato Somma ricevuta, zero se nessuna.
		 */
		do_action( 'wcsdi_pagamento_scaduto', $order, $incassato );
	}

	/**
	 * Annulla la verifica pianificata: l'ordine è stato pagato o chiuso
	 * altrimenti, e lasciare l'azione in coda produrrebbe solo lavoro inutile.
	 */
	public static function annulla( $order_id ) {
		if ( ! function_exists( 'as_unschedule_all_actions' ) ) {
			return;
		}
		as_unschedule_all_actions( self::AZIONE, array( 'order_id' => (int) $order_id ), self::GRUPPO );
	}
}
