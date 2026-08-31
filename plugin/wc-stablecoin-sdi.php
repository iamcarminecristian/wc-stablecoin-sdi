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
	// Il client definisce WCSDI_SdI_Exception, che la composizione solleva:
	// va caricato per primo.
	require_once WCSDI_PLUGIN_DIR . 'includes/class-wcsdi-sdi-client.php';
	require_once WCSDI_PLUGIN_DIR . 'includes/class-wcsdi-fattura.php';
	require_once WCSDI_PLUGIN_DIR . 'includes/class-wcsdi-fatturazione.php';
	require_once WCSDI_PLUGIN_DIR . 'includes/class-wcsdi-nota-credito.php';
	require_once WCSDI_PLUGIN_DIR . 'includes/class-wcsdi-scadenza.php';
	require_once WCSDI_PLUGIN_DIR . 'includes/class-wcsdi-misure.php';
	require_once WCSDI_PLUGIN_DIR . 'includes/class-wcsdi-export.php';

	WCSDI_Fatturazione::init();
	WCSDI_Nota_Credito::init();
	WCSDI_Scadenza::init();
	WCSDI_Export::init();

	// La fatturazione parte alla conferma del pagamento, non alla creazione
	// dell'ordine: l'operazione si considera effettuata quando il pagamento
	// on-chain si perfeziona (§4.5). L'aggancio passa da woocommerce_order_
	// status_changed anziché da payment_complete perché copre anche gli ordini
	// che WooCommerce porta direttamente a completed, come quelli senza righe
	// da spedire.
	add_action( 'woocommerce_order_status_changed', function ( $order_id, $vecchio, $nuovo, $order ) {
		if ( ! in_array( $nuovo, array( 'processing', 'completed' ), true ) ) {
			return;
		}
		if ( ! $order instanceof WC_Order || 'wcsdi_eure' !== $order->get_payment_method() ) {
			return;
		}
		WCSDI_Fatturazione::accoda( $order_id );

		// L'ordine è pagato: la verifica di scadenza non ha più senso e
		// lasciarla in coda produrrebbe solo lavoro inutile.
		WCSDI_Scadenza::annulla( $order_id );
	}, 10, 4 );

	add_filter( 'woocommerce_payment_gateways', function ( $gateways ) {
		$gateways[] = WCSDI_Gateway_EURe::class;
		return $gateways;
	} );

	// Istruzioni di pagamento sulla pagina di ringraziamento (RF-02).
	add_action( 'woocommerce_thankyou_wcsdi_eure', function ( $order_id ) {
		$gateways = WC()->payment_gateways()->payment_gateways();
		if ( isset( $gateways['wcsdi_eure'] ) ) {
			$gateways['wcsdi_eure']->thankyou_page( $order_id );
		}
	} );
} );

/**
 * Ritrova l'ordine dal riferimento comunicato alla catena.
 *
 * Il riferimento è un HMAC dell'identificativo dell'ordine, quindi non è
 * invertibile e la ricerca deve passare dal metadato.
 *
 * Due cautele, entrambe imparate a caro prezzo. La prima: il risultato della
 * query viene sempre riverificato confrontando il metadato dell'ordine con il
 * riferimento cercato. wc_get_orders delega a data store diversi a seconda che
 * l'archiviazione ad alte prestazioni sia attiva o meno, e un filtro non
 * compreso dal data store viene ignorato in silenzio anziché produrre un
 * errore: senza la riverifica, un pagamento finirebbe attribuito a un ordine
 * qualsiasi. Il confronto usa hash_equals perché il riferimento è derivato da
 * un segreto. La seconda: la ricerca non filtra per stato. Deve ritrovare
 * anche gli ordini già pagati, altrimenti una notifica ripetuta non
 * riconoscerebbe il duplicato e RNF-03 sarebbe violato proprio nel caso che
 * l'idempotenza esiste per gestire.
 */
function wcsdi_trova_ordine_da_riferimento( $ref ) {
	$ordini = wc_get_orders( array(
		'limit'      => 20,
		'status'     => 'any',
		'orderby'    => 'date',
		'order'      => 'DESC',
		'meta_query' => array(
			array(
				'key'     => '_wcsdi_order_ref',
				'value'   => $ref,
				'compare' => '=',
			),
		),
	) );

	foreach ( $ordini as $ordine ) {
		$meta = (string) $ordine->get_meta( '_wcsdi_order_ref' );
		if ( '' !== $meta && hash_equals( $meta, $ref ) ) {
			return $ordine;
		}
	}
	return null;
}

/**
 * Compatibilità dichiarata con HPOS e checkout a blocchi (RNF-05).
 */
add_action( 'before_woocommerce_init', function () {
	if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
		\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', __FILE__, true );
		\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'cart_checkout_blocks', __FILE__, true );
	}
} );

/**
 * Registrazione del metodo nel checkout a blocchi (RNF-05).
 *
 * Il checkout a blocchi si costruisce nel browser e ignora la definizione PHP
 * del gateway: conosce solo i metodi dichiarati per questa via. Senza, il
 * pagamento in EURe non compare fra le opzioni.
 */
add_action( 'woocommerce_blocks_loaded', function () {
	$tipo = 'Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType';
	if ( ! class_exists( $tipo ) ) {
		return;
	}
	require_once WCSDI_PLUGIN_DIR . 'includes/class-wcsdi-blocks.php';

	add_action( 'woocommerce_blocks_payment_method_type_registration', function ( $registry ) {
		$registry->register( new WCSDI_Blocks() );
	} );
} );

/**
 * Endpoint REST per le notifiche del watcher (§4.2, passo 3 del flusso):
 * POST /wp-json/wcsdi/v1/payment-confirmed
 * Autenticazione: segreto condiviso nell'header X-WCSDI-Secret.
 * Idempotenza: chiave (tx_hash, log_index) registrata sull'ordine (RNF-03).
 */
add_action( 'rest_api_init', function () {
	/**
	 * Aggiornamenti sul rimborso, dal servizio di rilevamento.
	 * Servono i marcatori t4 e t5 del protocollo KPI: il momento in cui il
	 * rimborso viene disposto e quello in cui gli euro risultano accreditati.
	 * Il plugin non parla con l'emittente, quindi non potrebbe osservarli.
	 */
	register_rest_route( 'wcsdi/v1', '/redemption-update', array(
		'methods'             => 'POST',
		'permission_callback' => function ( WP_REST_Request $request ) {
			$secret = get_option( 'wcsdi_watcher_secret', '' );
			return is_string( $secret ) && '' !== $secret
				&& hash_equals( $secret, (string) $request->get_header( 'x-wcsdi-secret' ) );
		},
		'args'                => array(
			'order_ref' => array( 'required' => true, 'type' => 'string' ),
			'stato'     => array( 'required' => true, 'type' => 'string' ),
			'ordine_id' => array( 'required' => false, 'type' => 'string' ),
			't4'        => array( 'required' => false, 'type' => 'number' ),
			't5'        => array( 'required' => false, 'type' => 'number' ),
		),
		'callback'            => function ( WP_REST_Request $request ) {
			$ref = sanitize_text_field( (string) $request['order_ref'] );
			if ( ! preg_match( '/^0x[0-9a-f]{64}$/i', $ref ) ) {
				return new WP_Error( 'wcsdi_bad_ref', 'Riferimento ordine malformato', array( 'status' => 400 ) );
			}
			$order = wcsdi_trova_ordine_da_riferimento( $ref );
			if ( ! $order ) {
				return new WP_Error( 'wcsdi_order_not_found', 'Nessun ordine per il riferimento indicato', array( 'status' => 404 ) );
			}

			$stato = sanitize_text_field( (string) $request['stato'] );
			$order->update_meta_data( '_wcsdi_rimborso_stato', $stato );
			if ( isset( $request['ordine_id'] ) ) {
				$order->update_meta_data( '_wcsdi_rimborso_id', sanitize_text_field( (string) $request['ordine_id'] ) );
			}
			if ( isset( $request['t4'] ) ) {
				WCSDI_Misure::segna( $order, 't4', (float) $request['t4'] );
			}
			if ( isset( $request['t5'] ) ) {
				WCSDI_Misure::segna( $order, 't5', (float) $request['t5'] );
			}
			$order->add_order_note( sprintf(
				/* translators: %s: stato del rimborso presso l'emittente */
				__( 'Rimborso in EUR: stato %s.', 'wc-stablecoin-sdi' ),
				$stato
			) );
			$order->save();

			return array( 'status' => 'accepted', 'order_id' => $order->get_id() );
		},
	) );

	register_rest_route( 'wcsdi/v1', '/payment-confirmed', array(
		'methods'             => 'POST',
		'permission_callback' => function ( WP_REST_Request $request ) {
			$secret = get_option( 'wcsdi_watcher_secret', '' );
			return is_string( $secret ) && '' !== $secret
				&& hash_equals( $secret, (string) $request->get_header( 'x-wcsdi-secret' ) );
		},
		'args'                => array(
			// Il servizio non conosce l'identificativo dell'ordine: conosce
			// solo il riferimento che ha letto dalla catena.
			'order_ref'    => array( 'required' => true, 'type' => 'string' ),
			'tx_hash'      => array( 'required' => true, 'type' => 'string' ),
			'log_index'    => array( 'required' => true, 'type' => 'integer' ),
			'amount'       => array( 'required' => true, 'type' => 'string' ),
			'payer'        => array( 'required' => false, 'type' => 'string' ),
			'block_number' => array( 'required' => false, 'type' => 'integer' ),
			'chain_id'     => array( 'required' => false, 'type' => 'integer' ),
			'conferme'     => array( 'required' => false, 'type' => 'integer' ),
			'criterio'     => array( 'required' => false, 'type' => 'string' ),
			// Marcatori e costo di rete: li conosce solo il servizio, che
			// legge il blocco e la ricevuta della transazione (Capitolo 6).
			't1'             => array( 'required' => false, 'type' => 'number' ),
			't2'             => array( 'required' => false, 'type' => 'number' ),
			'gas_usato'      => array( 'required' => false, 'type' => 'string' ),
			'gas_prezzo_wei' => array( 'required' => false, 'type' => 'string' ),
			'costo_gas'      => array( 'required' => false, 'type' => 'string' ),
		),
		'callback'            => function ( WP_REST_Request $request ) {
			$ref = sanitize_text_field( (string) $request['order_ref'] );
			if ( ! preg_match( '/^0x[0-9a-f]{64}$/i', $ref ) ) {
				return new WP_Error( 'wcsdi_bad_ref', 'Riferimento ordine malformato', array( 'status' => 400 ) );
			}

			$order = wcsdi_trova_ordine_da_riferimento( $ref );
			if ( ! $order ) {
				// Un pagamento senza ordine corrispondente non è un errore del
				// servizio: è denaro arrivato al contratto con un riferimento
				// che questo negozio non ha emesso. Non va riprovato.
				return new WP_Error( 'wcsdi_order_not_found', 'Nessun ordine per il riferimento indicato', array( 'status' => 404 ) );
			}

			// Idempotenza (RNF-03): la coppia hash della transazione e indice
			// di log identifica l'evento in modo stabile anche fra riavvii.
			$key  = sanitize_text_field( (string) $request['tx_hash'] ) . ':' . (int) $request['log_index'];
			$seen = (array) $order->get_meta( '_wcsdi_confirmed_events', true );
			if ( in_array( $key, $seen, true ) ) {
				return array( 'status' => 'duplicate', 'key' => $key, 'order_id' => $order->get_id() );
			}

			// I marcatori on-chain portano l'ora del blocco, non quella in cui
			// il servizio se ne è accorto: la seconda dipende dall'intervallo
			// di sondaggio e falserebbe la misura della latenza.
			if ( isset( $request['t1'] ) ) {
				WCSDI_Misure::segna( $order, 't1', (float) $request['t1'] );
			}
			if ( isset( $request['t2'] ) ) {
				WCSDI_Misure::segna( $order, 't2', (float) $request['t2'] );
			}
			WCSDI_Misure::segna( $order, 't3' );

			// La rete su cui il pagamento e' stato osservato: il gateway
			// dichiara una configurazione, ma la misura vale per la rete su
			// cui il servizio stava effettivamente ascoltando.
			if ( isset( $request['criterio'] ) ) {
				$order->update_meta_data( '_wcsdi_criterio', sanitize_key( (string) $request['criterio'] ) );
			}
			if ( isset( $request['conferme'] ) ) {
				$order->update_meta_data( '_wcsdi_conferme', (int) $request['conferme'] );
			}
			if ( isset( $request['chain_id'] ) ) {
				$order->update_meta_data( '_wcsdi_chain_id', (int) $request['chain_id'] );
			}

			foreach ( array( 'gas_usato' => '_wcsdi_gas_usato', 'gas_prezzo_wei' => '_wcsdi_gas_prezzo', 'costo_gas' => '_wcsdi_costo_gas' ) as $campo => $meta ) {
				if ( isset( $request[ $campo ] ) ) {
					$order->update_meta_data( $meta, sanitize_text_field( (string) $request[ $campo ] ) );
				}
			}

			$importo = wc_format_decimal( (string) $request['amount'] );
			$seen[]  = $key;
			$order->update_meta_data( '_wcsdi_confirmed_events', $seen );

			// I trasferimenti verso lo stesso ordine si accumulano: è il
			// totale a decidere, non il singolo evento (RF-04).
			$incassato = (float) $order->get_meta( '_wcsdi_paid_total' ) + (float) $importo;
			$order->update_meta_data( '_wcsdi_paid_total', wc_format_decimal( (string) $incassato ) );
			$order->update_meta_data( '_wcsdi_tx_hash', sanitize_text_field( (string) $request['tx_hash'] ) );
			if ( isset( $request['payer'] ) ) {
				$order->update_meta_data( '_wcsdi_payer', sanitize_text_field( (string) $request['payer'] ) );
			}

			$dovuto = (float) $order->get_meta( '_wcsdi_expected_amount' );
			$order->add_order_note( sprintf(
				/* translators: 1: chiave evento, 2: importo, 3: totale incassato, 4: dovuto */
				'Pagamento on-chain confermato: %1$s. Importo %2$s EURe, incassato %3$s su %4$s dovuti.',
				$key,
				$importo,
				wc_format_decimal( (string) $incassato ),
				wc_format_decimal( (string) $dovuto )
			) );

			$esito = 'partial';
			if ( $incassato + 0.00001 >= $dovuto ) {
				// Raggiunto il dovuto: l'ordine è pagato. L'eccedenza viene
				// segnalata all'esercente per la restituzione volontaria, non
				// trattenuta silenziosamente (RF-04).
				$esito = ( $incassato - $dovuto > 0.00001 ) ? 'overpaid' : 'paid';
				if ( 'overpaid' === $esito ) {
					$order->add_order_note( sprintf(
						'Pagamento in eccesso di %s EURe: valutare la restituzione al cliente.',
						wc_format_decimal( (string) ( $incassato - $dovuto ) )
					) );
				}
				$order->payment_complete( sanitize_text_field( (string) $request['tx_hash'] ) );
			} else {
				$order->update_status( 'on-hold', 'Pagamento parziale in attesa del saldo.' );
			}

			$order->save();

			// La fatturazione parte dal cambio di stato dell'ordine, non da
			// qui: cosi' copre anche gli ordini portati a pagato per altre
			// vie. Il rimborso e' disposto dal servizio di rilevamento.

			return array(
				'status'   => 'accepted',
				'outcome'  => $esito,
				'key'      => $key,
				'order_id' => $order->get_id(),
			);
		},
	) );
} );
