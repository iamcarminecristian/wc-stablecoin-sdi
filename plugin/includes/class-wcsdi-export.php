<?php
/**
 * Esportazione del dataset sperimentale (Capitolo 6).
 *
 * Il protocollo chiede che i dati confluiscano in un file versionabile e
 * allegabile alla tesi come artefatto riproducibile. L'esportazione avviene
 * da riga di comando, non da interfaccia: la campagna di misura è un'attività
 * ripetibile e va poter essere rieseguita da uno script.
 *
 *   wp wcsdi export --file=dataset.csv
 *   wp wcsdi export --format=json --dopo=2026-09-01
 */

defined( 'ABSPATH' ) || exit;

class WCSDI_Export {

	public static function init() {
		if ( defined( 'WP_CLI' ) && WP_CLI ) {
			WP_CLI::add_command( 'wcsdi export', array( __CLASS__, 'comando' ) );
		}
	}

	/**
	 * Esporta il dataset delle transazioni.
	 *
	 * ## OPTIONS
	 *
	 * [--file=<percorso>]
	 * : File di destinazione. Senza, scrive sullo standard output.
	 *
	 * [--format=<formato>]
	 * : csv oppure json. Predefinito csv.
	 *
	 * [--dopo=<data>]
	 * : Considera i soli ordini creati da questa data, in formato Y-m-d.
	 *
	 * [--limite=<n>]
	 * : Numero massimo di ordini. Predefinito 5000.
	 */
	public static function comando( $args, $assoc ) {
		$formato = isset( $assoc['format'] ) ? strtolower( $assoc['format'] ) : 'csv';
		$limite  = isset( $assoc['limite'] ) ? (int) $assoc['limite'] : 5000;

		$query = array(
			'limit'          => $limite,
			'status'         => 'any',
			'payment_method' => 'wcsdi_eure',
			'orderby'        => 'date',
			'order'          => 'ASC',
		);
		if ( ! empty( $assoc['dopo'] ) ) {
			$query['date_created'] = '>=' . $assoc['dopo'];
		}

		$ordini = wc_get_orders( $query );
		$righe  = array();
		foreach ( $ordini as $ordine ) {
			// La query restituisce anche i rimborsi, che sono oggetti di un
			// altro tipo e non espongono il metodo di pagamento: interrogarli
			// come ordini produce un errore fatale.
			if ( ! $ordine instanceof WC_Order ) {
				continue;
			}
			// Il filtro per metodo di pagamento non è supportato da tutti i
			// data store: si riverifica, come per la ricerca per riferimento.
			if ( 'wcsdi_eure' !== $ordine->get_payment_method() ) {
				continue;
			}
			$righe[] = WCSDI_Misure::riga( $ordine );
		}

		if ( empty( $righe ) ) {
			WP_CLI::warning( 'Nessun ordine da esportare.' );
			return;
		}

		$contenuto = 'json' === $formato
			? wp_json_encode( $righe, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES )
			: self::csv( $righe );

		if ( empty( $assoc['file'] ) ) {
			WP_CLI::line( $contenuto );
			return;
		}

		if ( false === file_put_contents( $assoc['file'], $contenuto ) ) {
			WP_CLI::error( 'Scrittura non riuscita su ' . $assoc['file'] );
		}
		WP_CLI::success( sprintf( '%d transazioni esportate in %s', count( $righe ), $assoc['file'] ) );
	}

	private static function csv( array $righe ) {
		$out = fopen( 'php://temp', 'r+' );
		fputcsv( $out, array_keys( $righe[0] ) );
		foreach ( $righe as $riga ) {
			fputcsv( $out, $riga );
		}
		rewind( $out );
		$csv = stream_get_contents( $out );
		fclose( $out );
		return $csv;
	}
}
