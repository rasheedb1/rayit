# On Cue · plataforma

Producto para que creadores y agencias midan, creen, vendan y cobren.
Este directorio es el código real. Los mocks del dashboard viven en
`../dashboard/` y siguen siendo la referencia visual.

## Arrancar en cinco minutos

Contra **Supabase**, que es donde vive la base de verdad:

```bash
make db.unlock           # descifra las credenciales (pide la frase una vez)
make db.info             # 13 migraciones, 88 tablas, 10 vistas
make dev                 # web + worker + analizador de video
```

Contra **Postgres local**, si prefieres trabajar sin red:

```bash
cp .env.example .env     # rellenar lo que haga falta; lo local ya funciona
make up                  # Postgres + almacenamiento + correo, y migra
make seed                # catálogo y el workspace de demostración (Laura · Cocina fácil)
make dev
```

El mismo workspace de demostración se carga en Supabase con `make
db.seed` (pide antes `make db.unlock`), y se verifica sin base ninguna
con `make db.seed.check`: Postgres embebido, cuatro pasadas y las cifras
del mock.

`make help` lista todo. Los comandos `db.*` van a Supabase; el resto, a
Docker. El manual está en [../docs/base-de-datos.md](../docs/base-de-datos.md).

Sin Docker a mano, el esquema se puede verificar igual:

```bash
npm install
node db/migrate.mjs --pglite
```

Eso levanta un Postgres embebido, aplica las trece migraciones y reporta
cuántas tablas, vistas e índices quedaron. Es lo mismo que corre el CI en
cada pull request.

## La puerta de calidad

```bash
pnpm verificar      # = turbo run typecheck lint test --force --concurrency=2
```

Es **este** comando, no `pnpm turbo run typecheck lint test` a secas, y
por dos razones medidas:

- **`--force`.** La caché de turbo es por contenido, no por rama, y se
  comparte entre worktrees: una corrida en una rama recién creada
  contestó «14/14 cache hit, FULL TURBO» replayando los registros de
  otro worktree, es decir, verde sin ejecutar nada. `test` además ya no
  se cachea en `turbo.json` (cada suite levanta su propio Postgres
  embebido: cachearla no ahorra casi nada y sí miente).
- **`--concurrency=2`.** Con la concurrencia por defecto, `@mc/db`,
  `@mc/worker` y `@mc/web` levantan PGlite y pg-boss a la vez y las
  pruebas del worker mueren con «Promise resolution is still pending but
  the event loop has already resolved» una de cada cinco corridas.

`make verificar` hace lo mismo. Y `pnpm --filter @mc/web build` aparte,
que es lo que despliega Vercel.

## Mapa del repositorio

```
db/migrations/     El esquema. Trece archivos, en orden, inmutables.
db/migrate.mjs     Runner. Aplica contra Supabase, Postgres local o embebido.
db/sql.mjs         Consola SQL contra Supabase.
db/certs/          CA raíz de Supabase (pública, versionada).
secrets/           Credenciales cifradas + su manual.
scripts/           vault.sh (cifrar/descifrar), github.sh, vercel.sh.
db/seed/           Catálogo base (0001) y el workspace de demostración (0002 ventas y métricas, 0003 finanzas y campañas). verify/ los comprueba.
apps/web/          Dashboard (Next.js).
apps/worker/       Trabajos en segundo plano (Node + pg-boss).
apps/media/        Analizador de video (Python: ffmpeg, ASR, OCR).
packages/db/       Tipos y consultas compartidas.
packages/core/     Reglas de negocio: puntajes, semáforo, tarifas.
packages/connectors/  Clientes de TikTok, Meta y Google.
```

## Reglas del repositorio

1. **Una migración aplicada es inmutable.** Si algo está mal, se corrige
   con una migración nueva. El runner y el CI rechazan un archivo que
   cambió después de aplicarse.
2. **Las métricas no se actualizan, se insertan.** Todas las tablas
   `*_snapshot` y `*_curve` son append-only. El delta se calcula al leer.
3. **Ninguna pantalla hace aritmética de métricas.** Si un número es
   derivado, existe una vista que lo entrega.
4. **Los tokens nunca tocan la base en claro.** La tabla guarda una
   referencia al vault y los metadatos.
5. **Toda tabla con `workspace_id` tiene RLS activo.** Agregar una tabla
   de negocio sin aislamiento hace fallar la migración a propósito.

## Qué entrega cada plataforma

Verificado contra documentación oficial el 20 de septiembre de 2026. El
detalle completo está en `../docs/research/tiktok-api-campos.md`.

| | TikTok | Instagram | YouTube | Facebook |
|---|---|---|---|---|
| Retención por segundo | **sí** (Accounts API) | no | curva de audiencia | no |
| Likes por segundo | **sí** | no | no | no |
| Demografía por video | **sí** (país, ciudad, género) | no | sí | parcial |
| Fuente de las vistas | **sí** | no | sí | no |
| Descargar el mp4 | prohibido | solo propios | sí | sí |
| Frescura del dato | 24 a 48 h | ~48 h | ~48 h | ~48 h |
| Historia disponible | 365 días | completa | completa | completa |

El hallazgo que define la arquitectura: TikTok **sí** entrega retención
segundo a segundo, pero no por la API de la que habla todo el mundo
(Display API, que da cuatro contadores) sino por la Accounts API de
TikTok for Business, con el permiso `video.insights`. Son dos
aplicaciones distintas, con dos trámites distintos.
