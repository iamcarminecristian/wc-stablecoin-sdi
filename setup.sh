#!/usr/bin/env bash
# Provisioning one-shot: WordPress installato, WooCommerce e plugin attivi.
set -euo pipefail
cd "$(dirname "$0")"

docker compose up -d db wordpress anvil

echo "[setup] attendo che WordPress e il database siano pronti..."
until docker compose run --rm wpcli db check >/dev/null 2>&1; do sleep 3; done

if ! docker compose run --rm wpcli core is-installed >/dev/null 2>&1; then
  echo "[setup] installo WordPress..."
  docker compose run --rm wpcli core install \
    --url=http://localhost:8080 \
    --title="WC Stablecoin SdI (dev)" \
    --admin_user=admin --admin_password=admin \
    --admin_email=dev@example.test --skip-email
fi

docker compose run --rm wpcli plugin is-installed woocommerce >/dev/null 2>&1 \
  || docker compose run --rm wpcli plugin install woocommerce
docker compose run --rm wpcli plugin activate woocommerce wc-stablecoin-sdi
docker compose run --rm wpcli option update permalink_structure '/%postname%/' >/dev/null
docker compose run --rm wpcli rewrite flush >/dev/null

echo
echo "[setup] pronto: http://localhost:8080/wp-admin  (admin / admin)"
echo "[setup] chain locale: http://localhost:8545 (anvil, chain-id 31337)"
