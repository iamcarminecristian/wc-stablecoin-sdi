<?php
/**
 * Copia della fattura al cliente (art. 1, c. 3, D.Lgs. 127/2015).
 *
 * Con il codice destinatario convenzionale la fattura al consumatore è messa
 * a disposizione nell'area riservata dell'Agenzia delle Entrate, ma
 * l'emittente deve comunque consegnarne una copia al cliente, salvo rinuncia.
 * La messa a disposizione non esaurisce l'adempimento: senza questa consegna
 * il flusso «senza intervento manuale» resterebbe incompleto sul lato del
 * consumatore.
 *
 * Il documento trasmesso viene conservato in una cartella privata degli
 * upload e allegato a una comunicazione al cliente; resta allegato anche alle
 * e-mail di ordine completato e di fattura che WooCommerce invia o reinvia,
 * così un secondo invio dall'amministrazione porta con sé il documento.
 */

defined( 'ABSPATH' ) || exit;

final class WCSDI_Copia_Cliente {

	const CARTELLA = 'wcsdi-fatture';

	public static function init() {
		add_filter( 'woocommerce_email_attachments', array( __CLASS__, 'allega' ), 10, 3 );
	}

	/**
	 * Conserva il documento trasmesso e ne consegna una copia al cliente.
	 *
	 * @param WC_Order $order  Ordine fatturato.
	 * @param string   $xml    Tracciato FatturaPA trasmesso.
	 * @param string   $numero Numero del documento.
	 * @param string   $uuid   Identificativo assegnato dal fornitore.
	 */
	public static function conserva_e_consegna( WC_Order $order, $xml, $numero, $uuid ) {
		$percorso = self::conserva( $order, $xml, $numero, $uuid );
		if ( '' === $percorso ) {
			$order->add_order_note( __( 'Copia della fattura non conservata: cartella degli upload non scrivibile. Consegnarla al cliente a mano.', 'wc-stablecoin-sdi' ) );
			return;
		}
		$order->update_meta_data( '_wcsdi_fattura_file', $percorso );

		// Il cliente puo' rinunciare alla copia (l'articolo lo consente): la
		// rinuncia e' un metadato che il checkout puo' impostare.
		if ( 'yes' === (string) $order->get_meta( '_wcsdi_copia_rinuncia' ) ) {
			$order->add_order_note( __( 'Copia della fattura conservata; il cliente ha rinunciato alla consegna.', 'wc-stablecoin-sdi' ) );
			return;
		}

		$destinatario = $order->get_billing_email();
		if ( '' === (string) $destinatario ) {
			$order->add_order_note( __( 'Copia della fattura conservata ma non consegnata: l\'ordine non ha un indirizzo e-mail.', 'wc-stablecoin-sdi' ) );
			return;
		}

		$oggetto = sprintf(
			/* translators: 1: numero fattura, 2: nome del negozio */
			__( 'Fattura %1$s di %2$s', 'wc-stablecoin-sdi' ),
			$numero,
			wp_specialchars_decode( get_bloginfo( 'name' ), ENT_QUOTES )
		);
		$corpo = sprintf(
			/* translators: 1: numero ordine, 2: numero fattura */
			__( "In allegato la copia della fattura elettronica relativa all'ordine %1\$s (documento n. %2\$s), trasmessa al Sistema di Interscambio dell'Agenzia delle Entrate. L'originale è disponibile nella sua area riservata sul sito dell'Agenzia.", 'wc-stablecoin-sdi' ),
			$order->get_order_number(),
			$numero
		);

		$inviata = wp_mail( $destinatario, $oggetto, $corpo, array(), array( $percorso ) );
		if ( $inviata ) {
			$order->update_meta_data( '_wcsdi_copia_inviata_il', gmdate( 'c' ) );
			$order->add_order_note( sprintf(
				/* translators: %s: indirizzo e-mail */
				__( 'Copia della fattura inviata al cliente (%s).', 'wc-stablecoin-sdi' ),
				$destinatario
			) );
		} else {
			// L'esito negativo va detto: e' un adempimento, non una cortesia.
			$order->add_order_note( __( 'Copia della fattura non inviata: il sito non riesce a spedire e-mail. Il documento resta allegato alle e-mail dell\'ordine e va consegnato al cliente.', 'wc-stablecoin-sdi' ) );
		}
	}

	/**
	 * Allega il documento alle e-mail di ordine completato e di fattura.
	 *
	 * @param array    $allegati Percorsi già presenti.
	 * @param string   $tipo     Identificativo dell'e-mail WooCommerce.
	 * @param mixed    $oggetto  Ordine, se l'e-mail lo riguarda.
	 * @return array
	 */
	public static function allega( $allegati, $tipo, $oggetto = null ) {
		if ( ! in_array( $tipo, array( 'customer_completed_order', 'customer_invoice' ), true ) ) {
			return $allegati;
		}
		if ( ! $oggetto instanceof WC_Order ) {
			return $allegati;
		}
		$file = (string) $oggetto->get_meta( '_wcsdi_fattura_file' );
		if ( '' !== $file && file_exists( $file ) && ! in_array( $file, (array) $allegati, true ) ) {
			$allegati[] = $file;
		}
		return $allegati;
	}

	/**
	 * Scrive il tracciato in una cartella privata degli upload.
	 *
	 * @return string Percorso del file, o stringa vuota se non scrivibile.
	 */
	private static function conserva( WC_Order $order, $xml, $numero, $uuid ) {
		$upload = wp_upload_dir();
		if ( ! empty( $upload['error'] ) ) {
			return '';
		}
		$cartella = trailingslashit( $upload['basedir'] ) . self::CARTELLA;
		if ( ! wp_mkdir_p( $cartella ) ) {
			return '';
		}
		// La cartella non deve essere esplorabile ne' servita dal web: le
		// fatture contengono i dati fiscali del cliente.
		if ( ! file_exists( $cartella . '/index.html' ) ) {
			file_put_contents( $cartella . '/index.html', '' ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
		}
		if ( ! file_exists( $cartella . '/.htaccess' ) ) {
			file_put_contents( $cartella . '/.htaccess', "Require all denied\n" ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
		}

		$nome = sprintf(
			'fattura-%s-%s-%s.xml',
			sanitize_file_name( (string) $numero ),
			$order->get_id(),
			substr( preg_replace( '/[^a-z0-9]/i', '', (string) $uuid ), 0, 12 )
		);
		$percorso = $cartella . '/' . $nome;
		$scritto  = file_put_contents( $percorso, $xml ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
		return false === $scritto ? '' : $percorso;
	}
}
