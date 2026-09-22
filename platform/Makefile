SHELL := /bin/bash
.DEFAULT_GOAL := help
DB_URL ?= postgres://mc:mc@localhost:5432/oncue

.PHONY: help up down logs reset migrate migrate-check seed psql web worker media dev fmt test \
        db.unlock db.lock db.status db.migrate db.sql db.info db.cert db.check db.seed.check \
        github.set github.install github.install-forzado github.mine github.uninstall \
        github.status github.check \
        vercel.set vercel.dir vercel.link vercel.rename vercel.unlink vercel.status vercel.check vercel.deploy vercel.run \
        arranque

help: ## Muestra esta ayuda
	@grep -E '^[a-zA-Z_.-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-16s\033[0m %s\n", $$1, $$2}'

up: ## Levanta base de datos, almacenamiento y correo
	docker compose up -d
	@echo "esperando a Postgres..."
	@until docker compose exec -T db pg_isready -U mc -d oncue >/dev/null 2>&1; do sleep 1; done
	@$(MAKE) migrate
	@echo ""
	@echo "  Postgres   localhost:5432   (mc / mc / oncue)"
	@echo "  MinIO      localhost:9001   (mc / mcmcmcmc)"
	@echo "  Correo     localhost:8025"

down: ## Apaga todo (conserva los datos)
	docker compose down

reset: ## Borra la base y la vuelve a crear desde cero
	docker compose down -v
	$(MAKE) up

logs: ## Sigue los logs
	docker compose logs -f

migrate: ## Aplica las migraciones pendientes
	@node db/migrate.mjs "$(DB_URL)"

migrate-check: ## Verifica las migraciones con Postgres embebido (sin Docker)
	@node db/migrate.mjs --pglite

seed: ## Carga datos de ejemplo (la creadora ficticia y su nicho)
	@node db/migrate.mjs "$(DB_URL)" --seed

psql: ## Abre una consola SQL
	docker compose exec db psql -U mc -d oncue

dev: ## Arranca web + worker + media en paralelo
	pnpm turbo run dev --parallel

web: ## Solo el dashboard
	pnpm --filter @mc/web dev

worker: ## Solo los trabajos en segundo plano
	pnpm --filter @mc/worker dev

media: ## Solo el analizador de video (Python)
	cd apps/media && uv run uvicorn main:app --reload --port 8100

fmt: ## Formatea el código
	pnpm turbo run format

test: ## Corre las pruebas
	pnpm turbo run test

arranque: ## Deja esta máquina lista: credenciales, remoto y comprobaciones
	@./scripts/arranque.sh

# =====================================================================
# Supabase · la base de datos de verdad
# ---------------------------------------------------------------------
# Los objetivos de arriba (up, migrate, psql) trabajan contra el
# Postgres local de Docker. Los de aquí abajo, contra Supabase.
#
# Empieza SIEMPRE por  make db.unlock.  Todo lo demás lo necesita.
# =====================================================================

db.unlock: ## Descifra las credenciales de Supabase -> .env.local
	@./scripts/vault.sh unlock

db.lock: ## Vuelve a cifrar .env.local (tras cambiar una credencial)
	@./scripts/vault.sh lock

db.status: ## Qué hay en el vault, sin revelar los valores
	@./scripts/vault.sh status

db.migrate: ## Aplica las migraciones pendientes en Supabase
	@test -f .env.local || { echo "  Corre primero: make db.unlock"; exit 1; }
	@node db/migrate.mjs "$$(grep '^DATABASE_URL_DIRECT=' .env.local | cut -d= -f2-)"

db.seed: ## Carga el catálogo y el workspace de demostración (Laura · Cocina fácil) en Supabase
	@test -f .env.local || { echo "  Corre primero: make db.unlock"; exit 1; }
	@node db/migrate.mjs "$$(grep '^DATABASE_URL_DIRECT=' .env.local | cut -d= -f2-)" --seed

db.sql: ## Consulta SQL.  make db.sql Q="select * from platform"
	@node db/sql.mjs $(if $(ADMIN),--admin,) "$(Q)"

db.info: ## Estado de la base: tablas, filas, migraciones aplicadas
	@node db/sql.mjs "select (select count(*) from schema_migrations) as migraciones, \
	  (select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE') as tablas, \
	  (select count(*) from information_schema.views where table_schema='public') as vistas, \
	  (select max(applied_at)::timestamp(0) from schema_migrations) as ultima_migracion"

db.check: ## Verifica el esquema en Postgres embebido, sin tocar Supabase
	@node db/migrate.mjs --pglite

db.seed.check: ## Verifica los seeds en Postgres embebido: dos pasadas, conteos y cifras (DIAS=40 adelanta el reloj)
	@node db/seed/verify/run.mjs $(SEED) $(if $(DIAS),--dias $(DIAS))

db.cert: ## Vuelve a bajar el certificado raíz de Supabase (y la copia embebida en @mc/db)
	@curl -sL https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt \
	  -o db/certs/supabase-root-2021.crt && echo "  certificado actualizado"
	@node db/scripts/embed-ca.mjs && echo "  packages/db/src/provisional/supabase-ca.ts regenerado"

# =====================================================================
# GitHub · el token compartido
# ---------------------------------------------------------------------
# El token vive cifrado en secrets/github.env.enc, con la MISMA frase de
# paso que la base de datos. Quien ya corrió 'make db.unlock' no necesita
# ningún secreto nuevo: le basta 'make github.install'.
#
# Al clonar el repositorio por primera vez:  make github.install
# =====================================================================

github.set: ## Guarda o rota el token de GitHub (lo pide sin mostrarlo)
	@./scripts/github.sh set

github.install: ## Configura el remoto y el credential helper en ESTE clon
	@./scripts/github.sh install

github.mine: ## Empuja con TUS credenciales, no con el token compartido
	@./scripts/github.sh mine

github.install-forzado: ## Usa el token compartido aunque tengas cuenta propia
	@./scripts/github.sh install --forzar

github.uninstall: ## Quita el helper de este clon (no borra el vault)
	@./scripts/github.sh uninstall

github.status: ## Qué hay guardado y cómo está este clon, sin revelar el token
	@./scripts/github.sh status

github.check: ## Pregunta a GitHub: qué usuario, qué permisos, cuándo expira
	@./scripts/github.sh check

# =====================================================================
# Vercel · el despliegue del dashboard
# ---------------------------------------------------------------------
# Mismo trato que GitHub: el token vive cifrado en secrets/vercel.env.enc
# con la MISMA frase de paso. Quien ya corrió 'make db.unlock' puede
# desplegar sin pedir nada nuevo.
#
# Al clonar el repositorio por primera vez:  make vercel.link
# =====================================================================

vercel.set: ## Guarda o rota el token de Vercel (lo pide sin mostrarlo)
	@./scripts/vercel.sh set

vercel.dir: ## Qué directorio se despliega.  make vercel.dir DIR=.   (Root Directory apps/web en Vercel)
	@./scripts/vercel.sh dir $(DIR)

vercel.link: ## Crea o adopta el proyecto y lo enlaza en ESTE clon
	@./scripts/vercel.sh link $(NOMBRE)

vercel.rename: ## Renombra el proyecto en Vercel y conserva la URL vieja.  make vercel.rename NOMBRE=on-cue-web
	@./scripts/vercel.sh rename $(NOMBRE)

vercel.unlink: ## Quita el enlace local (no toca el vault)
	@./scripts/vercel.sh unlink

vercel.status: ## Qué hay guardado y cómo está este clon, sin revelar el token
	@./scripts/vercel.sh status

vercel.check: ## Pregunta a Vercel: qué cuenta, qué equipo, cuándo expira
	@./scripts/vercel.sh check

vercel.deploy: ## Despliega apps/web. Vista previa, o PROD=1 para producción
	@./scripts/vercel.sh deploy $(if $(PROD),--prod,)

vercel.run: ## Cualquier comando de la CLI.  make vercel.run ARGS="logs --follow"
	@./scripts/vercel.sh run $(ARGS)
