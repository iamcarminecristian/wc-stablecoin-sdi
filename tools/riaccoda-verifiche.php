<?php
/**
 * Riaccoda la verifica delle ricevute SdI per ogni ordine fatturato che non
 * abbia ancora uno stato definitivo e non abbia una verifica in attesa.
 *
 * Serve dopo la correzione 377db64: le fatture trasmesse prima di allora
 * hanno ricevuto una sola verifica e nessun riaccodamento, quindi lo stato
 * registrato sull'ordine non riflette quello presso il fornitore.
 *
 *   docker compose run --rm -v "$PWD/tools:/tools" wpcli eval-file /tools/riaccoda-verifiche.php
 *   WCSDI_DRY=1 ... per la sola conta, senza accodare.
 *
 * Le verifiche sono distribuite nel tempo (cinque ordini al minuto) per non
 * saturare i limiti di lettura del fornitore.
 */
$dry    = (bool) getenv( 'WCSDI_DRY' );
$ordini = wc_get_orders( array(
	'limit'          => -1,
	'status'         => 'any',
	'payment_method' => 'wcsdi_eure',
	'orderby'        => 'ID',
	'order'          => 'ASC',
) );
$def = WCSDI_Misure::MARKING_DEFINITIVI;
$tot = 0; $con_uuid = 0; $definitive = 0; $in_coda = 0; $accodate = 0; $i = 0;
$per_stato = array();
foreach ( $ordini as $o ) {
	if ( ! $o instanceof WC_Order || 'wcsdi_eure' !== $o->get_payment_method() ) {
		continue;
	}
	$tot++;
	$uuid = (string) $o->get_meta( '_wcsdi_fattura_uuid' );
	if ( '' === $uuid ) {
		continue;
	}
	$con_uuid++;
	$stato = (string) $o->get_meta( '_wcsdi_fattura_stato' );
	$per_stato[ $stato ] = ( $per_stato[ $stato ] ?? 0 ) + 1;
	if ( in_array( $stato, $def, true ) ) {
		$definitive++;
		continue;
	}
	$pend = as_get_scheduled_actions( array(
		'hook'     => 'wcsdi_verifica_ricevute',
		'args'     => array( 'order_id' => $o->get_id() ),
		'group'    => 'wc-stablecoin-sdi',
		'status'   => ActionScheduler_Store::STATUS_PENDING,
		'per_page' => 1,
	), 'ids' );
	if ( ! empty( $pend ) ) {
		$in_coda++;
		continue;
	}
	if ( ! $dry ) {
		$ritardo = intdiv( $i, 5 ) * 60;
		as_schedule_single_action( time() + $ritardo, 'wcsdi_verifica_ricevute', array( 'order_id' => $o->get_id() ), 'wc-stablecoin-sdi' );
	}
	$accodate++;
	$i++;
}
WP_CLI::log( sprintf(
	'ordini EURe: %d; con fattura: %d; per stato: %s; stato definitivo: %d; verifica gia in coda: %d; %s: %d (ultima fra %d min)',
	$tot, $con_uuid, wp_json_encode( $per_stato ), $definitive, $in_coda,
	$dry ? 'da accodare' : 'accodate ora', $accodate, intdiv( max( $i - 1, 0 ), 5 )
) );
