/**
 * Registrazione del metodo di pagamento nel checkout a blocchi (RNF-05).
 *
 * Il checkout classico compone il modulo lato server, quello a blocchi lo
 * costruisce nel browser e ignora quindi la definizione PHP del gateway: il
 * metodo va dichiarato una seconda volta qui, altrimenti non compare.
 *
 * Il file usa i moduli che WooCommerce espone come variabili globali, senza
 * passare da un passo di compilazione: il plugin non ha una toolchain di
 * build, e introdurla per una manciata di righe non si giustifica.
 */
( function ( registry, element, htmlEntities ) {
	'use strict';

	if ( ! registry || ! element ) {
		return;
	}

	var createElement = element.createElement;
	var settings = ( window.wc && window.wc.wcSettings )
		? window.wc.wcSettings.getSetting( 'wcsdi_eure_data', {} )
		: {};

	var decodifica = htmlEntities && htmlEntities.decodeEntities
		? htmlEntities.decodeEntities
		: function ( s ) { return s; };

	var titolo = decodifica( settings.title || 'Paga in EURe' );

	function Descrizione() {
		var figli = [ createElement( 'p', { key: 'd' }, decodifica( settings.description || '' ) ) ];
		// L'informativa precontrattuale si mostra insieme alla descrizione:
		// e' il momento in cui il cliente sceglie il mezzo di pagamento, e
		// cio' che deve sapere va detto prima dell'ordine, non dopo.
		if ( settings.informativa ) {
			figli.push( createElement(
				'p',
				{ key: 'i', className: 'wcsdi-informativa', style: { fontSize: '0.9em' } },
				decodifica( settings.informativa )
			) );
		}
		return createElement( 'div', null, figli );
	}

	function Etichetta( props ) {
		// PaymentMethodLabel rispetta lo stile del tema; una stringa nuda no.
		var Label = props.components && props.components.PaymentMethodLabel;
		return Label ? createElement( Label, { text: titolo } ) : titolo;
	}

	registry.registerPaymentMethod( {
		name: 'wcsdi_eure',
		label: createElement( Etichetta, null ),
		content: createElement( Descrizione, null ),
		// Le istruzioni di pagamento compaiono dopo l'ordine, non al
		// checkout: nell'anteprima dell'ordine basta il nome del metodo.
		edit: createElement( Descrizione, null ),
		canMakePayment: function () { return true; },
		ariaLabel: titolo,
		supports: {
			features: settings.supports || [ 'products' ],
		},
	} );
} )(
	window.wc && window.wc.wcBlocksRegistry,
	window.wp && window.wp.element,
	window.wp && window.wp.htmlEntities
);
