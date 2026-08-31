<?php
/**
 * Plugin Name:       WC Stablecoin SdI
 * Description:       Pagamenti in stablecoin EUR-pegged (EURe) per WooCommerce con conversione automatica in EUR e fatturazione elettronica via SdI. Progetto di tesi, in sviluppo.
 * Version:           0.1.0
 * Requires PHP:      8.1
 * Author:            Carmine Cristian Cruoglio
 * License:           GPL-3.0-or-later
 * Text Domain:       wc-stablecoin-sdi
 */

defined( 'ABSPATH' ) || exit;

define( 'WCSDI_VERSION', '0.1.0' );
define( 'WCSDI_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );

/**
 * Registrazione del gateway (cfr. tesi, §2.6 e §4.2).
 */
add_action( 'plugins_loaded', function () {
	if ( ! class_exists( 'WC_Payment_Gateway' ) ) {
		return; // WooCommerce non attivo.
	}
	require_once WCSDI_PLUGIN_DIR . 'includes/class-wc-gateway-eure.php';

	add_filter( 'woocommerce_payment_gateways', function ( $gateways ) {
		$gateways[] = WCSDI_Gateway_EURe::class;
		return $gateways;
	} );
} );

/**
 * Compatibilità dichiarata con HPOS e checkout a blocchi (RNF-05).
 * L'integrazione del gateway nei blocchi (WC Blocks payment method) è
 * prevista in fase di sviluppo del Capitolo 5.
 */
add_action( 'before_woocommerce_init', function () {
	if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
		\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', __FILE__, true );
		\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'cart_checkout_blocks', __FILE__, true );
	}
} );

/**
 * Endpoint REST per le notifiche del watcher (§4.2, passo 3 del flusso):
 * POST /wp-json/wcsdi/v1/payment-confirmed
 * Autenticazione: segreto condiviso nell'header X-WCSDI-Secret.
 * Idempotenza: chiave (tx_hash, log_index) registrata sull'ordine (RNF-03).
 */
add_action( 'rest_api_init', function () {
	register_rest_route( 'wcsdi/v1', '/payment-confirmed', array(
		'methods'             => 'POST',
		'permission_callback' => function ( WP_REST_Request $request ) {
			$secret = get_option( 'wcsdi_watcher_secret', '' );
			return is_string( $secret ) && '' !== $secret
				&& hash_equals( $secret, (string) $request->get_header( 'x-wcsdi-secret' ) );
		},
		'args'                => array(
			'order_id'  => array( 'required' => true, 'type' => 'integer' ),
			'tx_hash'   => array( 'required' => true, 'type' => 'string' ),
			'log_index' => array( 'required' => true, 'type' => 'integer' ),
			'amount'    => array( 'required' => true, 'type' => 'string' ),
		),
		'callback'            => function ( WP_REST_Request $request ) {
			$order = wc_get_order( (int) $request['order_id'] );
			if ( ! $order ) {
				return new WP_Error( 'wcsdi_order_not_found', 'Ordine inesistente', array( 'status' => 404 ) );
			}

			$key  = sanitize_text_field( $request['tx_hash'] ) . ':' . (int) $request['log_index'];
			$seen = (array) $order->get_meta( '_wcsdi_confirmed_events', true );
			if ( in_array( $key, $seen, true ) ) {
				return array( 'status' => 'duplicate', 'key' => $key ); // idempotente
			}

			$seen[] = $key;
			$order->update_meta_data( '_wcsdi_confirmed_events', $seen );
			$order->add_order_note( sprintf( 'Pagamento on-chain confermato: %s (importo %s)', $key, sanitize_text_field( $request['amount'] ) ) );

			// TODO(cap.5): verifica importo cumulato vs dovuto (RF-04),
			// transizione pending -> processing (RF-03), accodamento della
			// redemption (RF-05) e della fatturazione (RF-06) via Action Scheduler.
			$order->save();

			return array( 'status' => 'accepted', 'key' => $key );
		},
	) );
} );
