.PHONY: init up down nuke logs demo

init:      ## prima accensione: container + provisioning WordPress/WooCommerce
	./setup.sh

up:        ## riaccende l'ambiente già provisionato
	docker compose up -d db wordpress anvil

down:      ## spegne i container (dati preservati)
	docker compose down

nuke:      ## spegne e cancella i dati (DB e WordPress)
	docker compose down -v

logs:
	docker compose logs -f wordpress

demo:      ## deploya MockEURe sulla chain locale e simula un pagamento confermato
	cd tools/local-chain && npm install --silent && node deploy.mjs && node pay.mjs
