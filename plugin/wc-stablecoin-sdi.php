<?php
/**
 * Plugin Name:       WC Stablecoin SdI
 * Plugin URI:        https://github.com/iamcarminecristian/wc-stablecoin-sdi
 * Description:       Pagamenti in stablecoin EUR-pegged (EURe) per WooCommerce con conversione automatica in EUR e fatturazione elettronica via SdI. Prototipo di ricerca (tesi LM-32): non usare in produzione senza revisione.
 * Version:           0.2.0
 * Requires at least: 6.8
 * Tested up to:      7.1
 * Requires PHP:      8.1
 * Requires Plugins:  woocommerce
 * WC requires at least: 10.0
 * WC tested up to:   11.0
 * Author:            Carmine Cristian Cruoglio
 * License:           GPL-3.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-3.0.html
 * Text Domain:       wc-stablecoin-sdi
 * Domain Path:       /languages
 */

defined( 'ABSPATH' ) || exit;

define( 'WCSDI_VERSION', '0.2.0' );
define( 'WCSDI_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );

/**
 * Registrazione del gateway (cfr. tesi, §2.6 e §4.2).
 */
add_action( 'plugins_loaded', function () {
	if ( ! class_exists( 'WC_Payment_Gateway' ) ) {
		return; // WooCommerce non attivo.
	}
	load_plugin_textdomain( 'wc-stablecoin-sdi', false, dirname( plugin_basename( __FILE__ ) ) . '/languages' );

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
	require_once WCSDI_PLUGIN_DIR . 'includes/class-wcsdi-checkout.php';
	require_once WCSDI_PLUGIN_DIR . 'includes/class-wcsdi-copia-cliente.php';

	WCSDI_Fatturazione::init();
	WCSDI_Nota_Credito::init();
	WCSDI_Scadenza::init();
	WCSDI_Export::init();
	WCSDI_Checkout::init();
	WCSDI_Copia_Cliente::init();

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
		// Per un consumatore la fattura è dovuta solo su richiesta (art. 22,
		// c. 1, n. 1, DPR 633/72): la si emette per scelta di progetto, salvo
		// che il cliente l'abbia espressamente declinata al checkout.
		if ( 'no' === (string) $order->get_meta( '_wcsdi_richiedi_fattura' ) && 'azienda' !== (string) $order->get_meta( '_wcsdi_tipo_cliente' ) ) {
			$order->add_order_note( __( 'Fattura non emessa: il cliente consumatore non l\'ha richiesta. L\'operazione va annotata nel registro dei corrispettivi.', 'wc-stablecoin-sdi' ) );
			$order->save();
		} else {
			WCSDI_Fatturazione::accoda( $order_id );
		}

		// L'ordine è pagato: la verifica di scadenza non ha più senso e
		// lasciarla in coda produrrebbe solo lavoro inutile.
		WCSDI_Scadenza::annulla( $order_id );
	}, 10, 4 );

	add_filter( 'woocommerce_payment_gateways', function ( $gateways ) {
		$gateways[] = WCSDI_Gateway_EURe::class;
		return $gateways;
	} );

	// Istruzioni di pagamento sulla pagina di ringraziamento, nell'area
	// riservata e nelle email dell'ordine in attesa (RF-02): il cliente che
	// chiude la scheda o cambia dispositivo deve poterle ritrovare.
	$istruzioni = function ( $order ) {
		$order_id = $order instanceof WC_Order ? $order->get_id() : (int) $order;
		$gateways = WC()->payment_gateways()->payment_gateways();
		if ( isset( $gateways['wcsdi_eure'] ) ) {
			$gateways['wcsdi_eure']->thankyou_page( $order_id );
		}
	};
	add_action( 'woocommerce_thankyou_wcsdi_eure', $istruzioni );
	add_action( 'woocommerce_view_order', $istruzioni );
	add_action( 'woocommerce_email_before_order_table', function ( $order, $sent_to_admin ) use ( $istruzioni ) {
		if ( ! $sent_to_admin && $order instanceof WC_Order && 'wcsdi_eure' === $order->get_payment_method() ) {
			$istruzioni( $order );
		}
	}, 10, 2 );
} );

/**
 * Ritrova l'ordine dal riferimento comunicato alla catena.
 *
 * Il riferimento è un HMAC dell'identificativo dell'ordine, quindi non è
 * invertibile e la ricerca deve passare dal metadato.
 *
 * Due cautele. La prima: il risultato della query viene sempre riverificato
 * confrontando il metadato dell'ordine con il riferimento cercato. Entrambi i
 * data store di WooCommerce supportano il filtro sui metadati, ma la
 * riverifica è una difesa in profondità contro divergenze future, e il
 * confronto usa hash_equals perché il riferimento è derivato da un segreto.
 * La seconda: la ricerca non filtra per stato. Deve ritrovare anche gli
 * ordini già pagati, altrimenti una notifica ripetuta non riconoscerebbe il
 * duplicato e RNF-03 sarebbe violato proprio nel caso che l'idempotenza
 * esiste per gestire.
 */
function wcsdi_trova_ordine_da_riferimento( $ref ) {
	// Il data store classico (post) ignora del tutto la meta_query passata a
	// wc_get_orders: senza il filtro registrato qui sotto la query restituiva
	// i cinque ordini piu' recenti e la riverifica del metadato li scartava,
	// sicche' un pagamento veniva trovato solo se il suo ordine era fra gli
	// ultimi cinque creati. Scoperto il 2 settembre 2026 con tre ordini su
	// otto di un lotto finiti fra gli orfani. La variabile propria
	// wcsdi_order_ref e' tradotta in meta_query dal filtro per il data store
	// classico; il data store HPOS accetta la meta_query direttamente.
	$ordini = wc_get_orders( array(
		'limit'           => 5,
		'status'          => 'any',
		'orderby'         => 'date',
		'order'           => 'DESC',
		'wcsdi_order_ref' => $ref,
		'meta_query'      => array(
			array(
				'key'     => '_wcsdi_order_ref',
				'value'   => $ref,
				'compare' => '=',
			),
		),
	) );

	foreach ( $ordini as $ordine ) {
		if ( ! $ordine instanceof WC_Order ) {
			continue;
		}
		$meta = (string) $ordine->get_meta( '_wcsdi_order_ref' );
		if ( '' !== $meta && hash_equals( $meta, $ref ) ) {
			return $ordine;
		}
	}
	return null;
}

/**
 * Traduzione della variabile wcsdi_order_ref in meta_query per il data store
 * classico, che altrimenti non filtra per metadato (vedi la ricerca sopra).
 */
add_filter( 'woocommerce_order_data_store_cpt_get_orders_query', function ( $query, $query_vars ) {
	if ( ! empty( $query_vars['wcsdi_order_ref'] ) ) {
		$query['meta_query'][] = array(
			'key'     => '_wcsdi_order_ref',
			'value'   => (string) $query_vars['wcsdi_order_ref'],
			'compare' => '=',
		);
	}
	return $query;
}, 10, 2 );

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
 * Validazione della notifica di pagamento, eseguita dopo l'autenticazione.
 *
 * Il servizio non conosce l'identificativo dell'ordine: conosce solo il
 * riferimento letto dalla catena. L'importo arriva in unità di valuta come
 * stringa decimale positiva, senza segno né notazione esponenziale; gli
 * altri campi sono facoltativi ma, se presenti, devono avere la forma attesa.
 *
 * @return WP_Error|null Errore 400 se un campo non è accettabile.
 */
function wcsdi_valida_notifica_pagamento( WP_REST_Request $request ) {
	$errore = function ( $campo ) {
		return new WP_Error( 'rest_invalid_param', sprintf( 'Parametro non valido: %s', $campo ), array( 'status' => 400, 'params' => array( $campo ) ) );
	};

	if ( ! preg_match( '/^0x[0-9a-f]{64}$/i', (string) $request['order_ref'] ) ) {
		return $errore( 'order_ref' );
	}
	if ( ! preg_match( '/^0x[0-9a-f]{64}$/i', (string) $request['tx_hash'] ) ) {
		return $errore( 'tx_hash' );
	}
	if ( ! isset( $request['log_index'] ) || ! is_numeric( $request['log_index'] ) || (int) $request['log_index'] < 0 ) {
		return $errore( 'log_index' );
	}
	$amount = (string) $request['amount'];
	if ( ! preg_match( '/^\d{1,12}(\.\d{1,18})?$/', $amount ) || (float) $amount <= 0 ) {
		return $errore( 'amount' );
	}
	$payer = (string) $request['payer'];
	if ( '' !== $payer && ! preg_match( '/^0x[0-9a-f]{40}$/i', $payer ) ) {
		return $errore( 'payer' );
	}
	foreach ( array( 'block_number', 'tx_index', 'chain_id', 'conferme' ) as $intero ) {
		if ( isset( $request[ $intero ] ) && '' !== (string) $request[ $intero ] && ! preg_match( '/^\d{1,15}$/', (string) $request[ $intero ] ) ) {
			return $errore( $intero );
		}
	}
	foreach ( array( 't1', 't2' ) as $istante ) {
		if ( isset( $request[ $istante ] ) && '' !== (string) $request[ $istante ] && ! is_numeric( $request[ $istante ] ) ) {
			return $errore( $istante );
		}
	}
	$block_hash = (string) $request['block_hash'];
	if ( '' !== $block_hash && ! preg_match( '/^0x[0-9a-f]{64}$/i', $block_hash ) ) {
		return $errore( 'block_hash' );
	}
	return null;
}

/**
 * Autenticazione delle chiamate del servizio di rilevamento: segreto
 * condiviso nell'header X-WCSDI-Secret, confrontato a tempo costante.
 * Il canale deve essere cifrato quando plugin e servizio non condividono la
 * macchina: il segreto viaggia in chiaro nell'header.
 */
function wcsdi_permesso_watcher( WP_REST_Request $request ) {
	$secret = get_option( 'wcsdi_watcher_secret', '' );
	return is_string( $secret ) && '' !== $secret
		&& hash_equals( $secret, (string) $request->get_header( 'x-wcsdi-secret' ) );
}

/**
 * Serializza per ordine l'elaborazione di una notifica. Due notifiche dello
 * stesso evento che arrivino insieme, per esempio una ripetizione dopo un
 * timeout mentre la prima è ancora in corso, supererebbero entrambe il
 * controllo dei duplicati e accumulerebbero l'importo due volte: il blocco
 * sul database le mette in fila (RNF-03).
 *
 * @return bool True se il blocco è stato ottenuto.
 */
function wcsdi_blocca_ordine( $order_id ) {
	global $wpdb;
	return '1' === (string) $wpdb->get_var( $wpdb->prepare( 'SELECT GET_LOCK(%s, 5)', 'wcsdi_ordine_' . (int) $order_id ) );
}

function wcsdi_sblocca_ordine( $order_id ) {
	global $wpdb;
	$wpdb->query( $wpdb->prepare( 'SELECT RELEASE_LOCK(%s)', 'wcsdi_ordine_' . (int) $order_id ) );
}

/**
 * Endpoint REST per il servizio di rilevamento (§4.2, passo 3 del flusso):
 *   POST /wp-json/wcsdi/v1/payment-confirmed   pagamento confermato
 *   POST /wp-json/wcsdi/v1/redemption-update   esito del riscatto (t4, t5)
 *   POST /wp-json/wcsdi/v1/heartbeat           il servizio è vivo
 *   GET  /wp-json/wcsdi/v1/config              configurazione del gateway
 * Autenticazione: segreto condiviso nell'header X-WCSDI-Secret.
 * Idempotenza: chiave (tx_hash, log_index) registrata sull'ordine (RNF-03).
 */
add_action( 'rest_api_init', function () {

	register_rest_route( 'wcsdi/v1', '/config', array(
		'methods'             => 'GET',
		'permission_callback' => 'wcsdi_permesso_watcher',
		'callback'            => function () {
			$opzioni = (array) get_option( 'woocommerce_wcsdi_eure_settings', array() );
			$leggi   = function ( $k, $d = '' ) use ( $opzioni ) {
				return isset( $opzioni[ $k ] ) ? (string) $opzioni[ $k ] : $d;
			};
			$chain = $leggi( 'chain', 'gnosis' );
			return array(
				'plugin_version'  => WCSDI_VERSION,
				'chain'           => $chain,
				'chain_id'        => WCSDI_Gateway_EURe::chain_id( $chain ),
				'token_address'   => $leggi( 'token_address' ),
				'receive_address' => $leggi( 'receive_address' ),
				'forwarder'       => $leggi( 'forwarder_address' ),
				'finality_mode'   => $leggi( 'finality_mode', 'finalized' ),
				'confirmations'   => (int) $leggi( 'confirmations', '12' ),
				'payment_window'  => (int) $leggi( 'payment_window', '60' ),
			);
		},
	) );

	register_rest_route( 'wcsdi/v1', '/heartbeat', array(
		'methods'             => 'POST',
		'permission_callback' => 'wcsdi_permesso_watcher',
		'args'                => array(
			'testa'      => array( 'required' => false, 'type' => 'integer' ),
			'ultimo'     => array( 'required' => false, 'type' => 'integer' ),
			'in_attesa'  => array( 'required' => false, 'type' => 'integer' ),
			'criterio'   => array( 'required' => false, 'type' => 'string' ),
			'chain_id'   => array( 'required' => false, 'type' => 'integer' ),
		),
		'callback'            => function ( WP_REST_Request $request ) {
			// Il silenzio di un servizio fermo è indistinguibile dal
			// funzionamento: l'ultimo battito registrato è ciò che consente
			// all'esercente di accorgersene.
			update_option( 'wcsdi_watcher_heartbeat', array(
				'ora'       => time(),
				'testa'     => (int) $request['testa'],
				'ultimo'    => (int) $request['ultimo'],
				'in_attesa' => (int) $request['in_attesa'],
				'criterio'  => sanitize_key( (string) $request['criterio'] ),
				'chain_id'  => (int) $request['chain_id'],
			), false );
			return array( 'status' => 'accepted' );
		},
	) );

	/**
	 * Aggiornamenti sul riscatto presso l'emittente, dal servizio di
	 * rilevamento. Servono i marcatori t4 e t5 del protocollo KPI: il momento
	 * in cui il riscatto viene disposto e quello in cui l'emittente lo dichiara
	 * lavorato. Il plugin non parla con l'emittente, quindi non potrebbe
	 * osservarli.
	 */
	register_rest_route( 'wcsdi/v1', '/redemption-update', array(
		'methods'             => 'POST',
		'permission_callback' => 'wcsdi_permesso_watcher',
		'args'                => array(
			'order_ref' => array( 'required' => true, 'type' => 'string' ),
			'stato'     => array( 'required' => true, 'type' => 'string' ),
			'ordine_id' => array( 'required' => false, 'type' => 'string' ),
			'motivo'    => array( 'required' => false, 'type' => 'string' ),
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

			$stato  = sanitize_key( (string) $request['stato'] );
			$motivo = sanitize_text_field( (string) $request['motivo'] );
			$order->update_meta_data( '_wcsdi_riscatto_stato', $stato );
			if ( isset( $request['ordine_id'] ) ) {
				$order->update_meta_data( '_wcsdi_riscatto_id', sanitize_text_field( (string) $request['ordine_id'] ) );
			}
			if ( '' !== $motivo ) {
				$order->update_meta_data( '_wcsdi_riscatto_motivo', $motivo );
			}
			if ( isset( $request['t4'] ) ) {
				WCSDI_Misure::segna( $order, 't4', (float) $request['t4'] );
			}
			if ( isset( $request['t5'] ) ) {
				WCSDI_Misure::segna( $order, 't5', (float) $request['t5'] );
			}

			// Un riscatto rifiutato, sospeso o fallito lascia gli euro
			// tokenizzati sull'indirizzo di incasso: la fattura resta valida,
			// perché l'operazione si è effettuata con il pagamento, ma
			// l'esercente deve saperlo e trattarlo con l'emittente.
			$negativi = array( 'rejected', 'declined', 'failed', 'unknown' );
			if ( in_array( $stato, $negativi, true ) ) {
				$order->update_meta_data( '_wcsdi_riscatto_da_verificare', 'yes' );
				$order->add_order_note( sprintf(
					/* translators: 1: stato, 2: motivo */
					__( 'Riscatto presso l\'emittente non concluso (stato %1$s): gli EURe restano sull\'indirizzo di incasso. %2$s', 'wc-stablecoin-sdi' ),
					$stato,
					$motivo
				) );
				do_action( 'wcsdi_riscatto_fallito', $order, $stato, $motivo );
			} else {
				$order->delete_meta_data( '_wcsdi_riscatto_da_verificare' );
				$order->add_order_note( sprintf(
					/* translators: %s: stato del riscatto presso l'emittente */
					__( 'Riscatto presso l\'emittente: stato %s.', 'wc-stablecoin-sdi' ),
					$stato
				) );
			}
			$order->save();

			return array( 'status' => 'accepted', 'order_id' => $order->get_id() );
		},
	) );

	register_rest_route( 'wcsdi/v1', '/payment-confirmed', array(
		'methods'             => 'POST',
		'permission_callback' => 'wcsdi_permesso_watcher',
		// Nessuna validazione dichiarata negli args: WP_REST_Server la esegue
		// prima del permission_callback, e una richiesta senza segreto
		// riceverebbe 400 invece di 401, rivelando che cosa il gestore accetta.
		// La validazione sta in wcsdi_valida_notifica_pagamento(), dopo
		// l'autenticazione.
		'callback'            => function ( WP_REST_Request $request ) {
			$non_valido = wcsdi_valida_notifica_pagamento( $request );
			if ( $non_valido ) {
				return $non_valido;
			}
			$ref = sanitize_text_field( (string) $request['order_ref'] );

			$trovato = wcsdi_trova_ordine_da_riferimento( $ref );
			if ( ! $trovato ) {
				// Un pagamento senza ordine corrispondente non è un errore del
				// servizio: è denaro arrivato al contratto con un riferimento
				// che questo negozio non ha emesso. Non va riprovato.
				return new WP_Error( 'wcsdi_order_not_found', 'Nessun ordine per il riferimento indicato', array( 'status' => 404 ) );
			}

			$order_id = $trovato->get_id();
			if ( ! wcsdi_blocca_ordine( $order_id ) ) {
				// Un'altra notifica per lo stesso ordine è in lavorazione: il
				// servizio riproverà, e troverà l'evento già registrato.
				return new WP_Error( 'wcsdi_busy', 'Ordine in lavorazione, riprovare', array( 'status' => 503 ) );
			}

			try {
				// Riletto dopo il blocco: i metadati devono essere quelli
				// scritti da chi ha tenuto il blocco prima di noi. La ricerca
				// per riferimento ha già caricato l'ordine, e la cache degli
				// oggetti di questa richiesta lo restituirebbe com'era prima
				// del blocco: otto notifiche parallele dello stesso evento
				// risultavano tutte "accettate" pur incassando una volta sola.
				clean_post_cache( $order_id );
				if ( class_exists( '\Automattic\WooCommerce\Caches\OrderCache' ) ) {
					wc_get_container()->get( \Automattic\WooCommerce\Caches\OrderCache::class )->remove( $order_id );
				}
				$order = wc_get_order( $order_id );
				if ( $order ) {
					$order->read_meta_data( true );
				}
				if ( ! $order ) {
					return new WP_Error( 'wcsdi_order_not_found', 'Ordine non più disponibile', array( 'status' => 404 ) );
				}

				// La rete osservata deve essere quella per cui l'ordine è stato
				// emesso: un servizio puntato per errore sulla catena di sviluppo
				// marcherebbe pagati ordini reali con token di prova.
				$atteso = (int) $order->get_meta( '_wcsdi_chain_id_atteso' );
				if ( isset( $request['chain_id'] ) && $atteso > 0 && (int) $request['chain_id'] !== $atteso ) {
					return new WP_Error( 'wcsdi_chain_mismatch', sprintf( 'Pagamento osservato sulla rete %d, ordine emesso per la rete %d', (int) $request['chain_id'], $atteso ), array( 'status' => 409 ) );
				}

				// Idempotenza (RNF-03): la coppia hash della transazione e indice
				// di log identifica l'evento in modo stabile anche fra riavvii.
				$tx_hash = strtolower( sanitize_text_field( (string) $request['tx_hash'] ) );
				$key     = $tx_hash . ':' . (int) $request['log_index'];
				$seen    = $order->get_meta( '_wcsdi_confirmed_events', true );
				$seen    = is_array( $seen ) ? $seen : array();
				if ( in_array( $key, $seen, true ) ) {
					return array( 'status' => 'duplicate', 'key' => $key, 'order_id' => $order_id );
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

				if ( isset( $request['criterio'] ) ) {
					$order->update_meta_data( '_wcsdi_criterio', sanitize_key( (string) $request['criterio'] ) );
				}
				if ( isset( $request['conferme'] ) ) {
					$order->update_meta_data( '_wcsdi_conferme', (int) $request['conferme'] );
				}
				if ( isset( $request['chain_id'] ) ) {
					$order->update_meta_data( '_wcsdi_chain_id', (int) $request['chain_id'] );
				}
				if ( isset( $request['block_number'] ) ) {
					$order->update_meta_data( '_wcsdi_blocco', (int) $request['block_number'] );
				}
				if ( isset( $request['tx_index'] ) ) {
					$order->update_meta_data( '_wcsdi_tx_index', (int) $request['tx_index'] );
				}
				if ( isset( $request['block_hash'] ) && preg_match( '/^0x[0-9a-f]{64}$/i', (string) $request['block_hash'] ) ) {
					$order->update_meta_data( '_wcsdi_block_hash', strtolower( (string) $request['block_hash'] ) );
				}

				$campi_costo = array(
					'gas_usato'      => '_wcsdi_gas_usato',
					'gas_prezzo_wei' => '_wcsdi_gas_prezzo',
					'costo_gas'      => '_wcsdi_costo_gas',
					'l1_fee_wei'     => '_wcsdi_l1_fee',
					'costo_totale'   => '_wcsdi_costo_totale',
				);
				foreach ( $campi_costo as $campo => $meta ) {
					if ( isset( $request[ $campo ] ) && preg_match( '/^[0-9.]{0,40}$/', (string) $request[ $campo ] ) ) {
						$order->update_meta_data( $meta, (string) $request[ $campo ] );
					}
				}

				$importo = wc_format_decimal( (string) $request['amount'], 8 );
				$seen[]  = $key;
				$order->update_meta_data( '_wcsdi_confirmed_events', $seen );

				// I trasferimenti verso lo stesso ordine si accumulano: è il
				// totale a decidere, non il singolo evento (RF-04).
				$incassato = round( (float) $order->get_meta( '_wcsdi_paid_total' ) + (float) $importo, 8 );
				$order->update_meta_data( '_wcsdi_paid_total', wc_format_decimal( (string) $incassato, 8 ) );
				$order->update_meta_data( '_wcsdi_tx_hash', $tx_hash );
				$payer = isset( $request['payer'] ) ? strtolower( sanitize_text_field( (string) $request['payer'] ) ) : '';
				if ( '' !== $payer ) {
					$order->update_meta_data( '_wcsdi_payer', $payer );
				}

				$dovuto = (float) $order->get_meta( '_wcsdi_expected_amount' );
				$order->add_order_note( sprintf(
					/* translators: 1: chiave evento, 2: importo, 3: totale incassato, 4: dovuto */
					__( 'Pagamento on-chain confermato: %1$s. Importo %2$s EURe, incassato %3$s su %4$s dovuti.', 'wc-stablecoin-sdi' ),
					$key,
					wc_format_decimal( $importo, 2 ),
					wc_format_decimal( (string) $incassato, 2 ),
					wc_format_decimal( (string) $dovuto, 2 )
				) );

				$scaduto = 'yes' === (string) $order->get_meta( '_wcsdi_scaduto' );
				$esito   = 'partial';
				if ( $incassato + 0.00001 >= $dovuto ) {
					$eccedenza = round( $incassato - $dovuto, 8 );
					$esito     = $eccedenza > 0.00001 ? 'overpaid' : 'paid';
					if ( 'overpaid' === $esito ) {
						// L'eccedenza è un pagamento non dovuto: va restituita
						// (art. 2033 c.c.), non trattenuta in silenzio (RF-04).
						$order->update_meta_data( '_wcsdi_da_restituire', wc_format_decimal( (string) $eccedenza, 8 ) );
						$order->add_order_note( sprintf(
							/* translators: 1: eccedenza, 2: indirizzo del pagatore */
							__( 'Pagamento in eccesso di %1$s EURe: la somma va restituita all\'indirizzo di provenienza %2$s.', 'wc-stablecoin-sdi' ),
							wc_format_decimal( (string) $eccedenza, 2 ),
							'' !== $payer ? $payer : __( 'non registrato', 'wc-stablecoin-sdi' )
						) );
					} elseif ( $scaduto ) {
						// Un pagamento giunto dopo la scadenza ha comunque
						// raggiunto il dovuto: l'ordine si riapre e
						// l'indicazione di restituzione decade.
						$order->delete_meta_data( '_wcsdi_da_restituire' );
					}
					if ( $scaduto ) {
						$order->delete_meta_data( '_wcsdi_scaduto' );
						$order->add_order_note( __( 'Pagamento giunto oltre la finestra dichiarata ma completo: l\'ordine è riaperto e considerato pagato.', 'wc-stablecoin-sdi' ) );
					}
					$order->payment_complete( $tx_hash );
				} else {
					if ( $scaduto ) {
						// Pagamento parziale tardivo su ordine già chiuso: resta
						// chiuso, e la somma (ora maggiore) va restituita.
						$order->update_meta_data( '_wcsdi_da_restituire', wc_format_decimal( (string) $incassato, 8 ) );
						$order->add_order_note( __( 'Pagamento parziale giunto dopo la scadenza: l\'ordine resta chiuso e la somma ricevuta va restituita.', 'wc-stablecoin-sdi' ) );
					} else {
						$order->update_status( 'on-hold', __( 'Pagamento parziale in attesa del saldo.', 'wc-stablecoin-sdi' ) );
					}
				}

				$order->save();

				// La fatturazione parte dal cambio di stato dell'ordine, non da
				// qui: così copre anche gli ordini portati a pagato per altre
				// vie. Il riscatto è disposto dal servizio di rilevamento.

				return array(
					'status'   => 'accepted',
					'outcome'  => $esito,
					'key'      => $key,
					'order_id' => $order_id,
				);
			} finally {
				wcsdi_sblocca_ordine( $order_id );
			}
		},
	) );
} );

/**
 * Avviso in bacheca quando il servizio di rilevamento non dà segni di vita:
 * un servizio fermo non produce errori, produce silenzio, e il silenzio va
 * reso visibile (§6.5 della tesi).
 */
add_action( 'admin_notices', function () {
	if ( ! current_user_can( 'manage_woocommerce' ) ) {
		return;
	}
	$opzioni = (array) get_option( 'woocommerce_wcsdi_eure_settings', array() );
	if ( empty( $opzioni['enabled'] ) || 'yes' !== $opzioni['enabled'] ) {
		return;
	}
	$battito = get_option( 'wcsdi_watcher_heartbeat', array() );
	$ora     = is_array( $battito ) && isset( $battito['ora'] ) ? (int) $battito['ora'] : 0;
	if ( time() - $ora > 10 * MINUTE_IN_SECONDS ) {
		printf(
			'<div class="notice notice-error"><p>%s</p></div>',
			esc_html( 0 === $ora
				? __( 'WC Stablecoin SdI: il servizio di rilevamento non ha mai comunicato con il negozio. I pagamenti in EURe non verranno rilevati.', 'wc-stablecoin-sdi' )
				: sprintf(
					/* translators: %s: tempo trascorso */
					__( 'WC Stablecoin SdI: il servizio di rilevamento non comunica da %s. I pagamenti in EURe non vengono rilevati.', 'wc-stablecoin-sdi' ),
					human_time_diff( $ora )
				)
			)
		);
	}
	if ( ! is_ssl() && 'local' !== wp_get_environment_type() ) {
		printf(
			'<div class="notice notice-warning"><p>%s</p></div>',
			esc_html__( 'WC Stablecoin SdI: il sito non usa HTTPS. Il segreto condiviso con il servizio di rilevamento viaggerebbe in chiaro.', 'wc-stablecoin-sdi' )
		);
	}
} );
