#!/usr/bin/env bash
# Provisioning one-shot: WordPress installato, WooCommerce e plugin attivi.
set -euo pipefail
cd "$(dirname "$0")"

WC_VERSION="${WC_VERSION:-11.0.1}"

docker compose up -d db wordpress anvil

echo "[setup] attendo che WordPress e il database siano pronti..."
until docker compose run --rm -T wpcli db check >/dev/null 2>&1; do sleep 3; done

if ! docker compose run --rm -T wpcli core is-installed >/dev/null 2>&1; then
  echo "[setup] installo WordPress..."
  docker compose run --rm -T wpcli core install \
    --url=http://localhost:8080 \
    --title="WC Stablecoin SdI (dev)" \
    --admin_user=admin --admin_password=admin \
    --admin_email=dev@example.test --skip-email
fi

# WooCommerce. Il percorso normale e' wp plugin install, che pero' fallisce su
# Docker Desktop per Windows: il container wp-cli e' su Alpine e non riesce a
# scrivere nella directory di staging del volume condiviso con l'immagine
# Debian di WordPress. Si ripiega allora sullo scaricamento diretto, che non
# dipende dai permessi del volume.
if ! docker compose run --rm -T wpcli plugin is-installed woocommerce >/dev/null 2>&1; then
  echo "[setup] installo WooCommerce ${WC_VERSION}..."
  if ! docker compose run --rm -T wpcli plugin install woocommerce --version="${WC_VERSION}" >/dev/null 2>&1; then
    echo "[setup] installazione via wp-cli non riuscita, scarico il pacchetto..."
    tmp="$(mktemp -d)"
    curl -sL -o "${tmp}/wc.zip" "https://downloads.wordpress.org/plugin/woocommerce.${WC_VERSION}.zip"
    (cd "${tmp}" && unzip -q wc.zip)
    docker compose cp "${tmp}/woocommerce" wordpress:/var/www/html/wp-content/plugins/woocommerce
    docker compose exec -T wordpress chown -R www-data:www-data /var/www/html/wp-content/plugins/woocommerce
    rm -rf "${tmp}"
  fi
fi

docker compose run --rm -T wpcli plugin activate woocommerce wc-stablecoin-sdi

# Il segreto condiviso con il servizio di rilevamento deve coincidere con
# WCSDI_SHARED_SECRET nel .env, altrimenti le notifiche vengono respinte.
if [ -f .env ]; then
  secret="$(grep -E '^WCSDI_SHARED_SECRET=' .env | cut -d= -f2- || true)"
  if [ -n "${secret}" ]; then
    docker compose run --rm -T wpcli option update wcsdi_watcher_secret "${secret}" >/dev/null
    echo "[setup] segreto del watcher allineato al .env"
  fi
fi

docker compose run --rm -T wpcli option update permalink_structure '/%postname%/' >/dev/null
docker compose run --rm -T wpcli rewrite flush >/dev/null 2>&1 || true

echo
echo "[setup] pronto: http://localhost:8080/wp-admin  (admin / admin)"
echo "[setup] chain locale: http://localhost:8545 (anvil, chain-id 31337)"
echo
echo "[setup] Nota: l'immagine di WordPress non riscrive /wp-json/, quindi la"
echo "        REST API si raggiunge come http://localhost:8080/?rest_route=/..."
echo "        E' la forma gia' impostata in WCSDI_PLUGIN_URL nel .env.example."
