# @mc/db · acceso a datos

Drizzle sobre `pg` (Supabase por el pooler `:6543`) y sobre PGlite
(Postgres embebido para pruebas y modo demo), con **un solo contrato**:
toda consulta corre dentro de una transacción que ya sabe su workspace.
Ninguna pantalla, server action ni job recibe `workspace_id` como
parámetro suelto.

```
src/client.ts      withWorkspace / asWorker / withCatalogs sobre pg
src/pglite.ts      lo mismo sobre PGlite
src/embedded.ts    PGlite con db/migrations + db/seed, corriendo como mc_app
src/from-env.ts    cómo la web elige entre los dos (DATABASE_URL o demo)
src/tls.ts         la CA de Supabase, verificada siempre (nunca rejectUnauthorized: false)
src/schema/        tablas y vistas del MVP, curadas desde db/migrations
src/queries/       un archivo por módulo: cimientos, catalogos, resumen, ventas,
                   cotizar, campanas, finanzas, conexiones
test/pglite.ts     openTestDb(): la base para las pruebas de cualquier paquete
scripts/introspect.mjs   drizzle-kit pull sobre PGlite, para curar el esquema
```

## Qué importar, y de dónde

| Qué | Desde | Ejemplo |
|---|---|---|
| Cliente, tipos, esquema y operadores de Drizzle | `@mc/db` | `import { createDbFromEnv, deal, eq, desc, CURRENT_WORKSPACE } from '@mc/db'` |
| Consultas de un módulo | `@mc/db/queries/<módulo>` | `import { listInvoices } from '@mc/db/queries/finanzas'` |
| Construir una base a mano (worker, scripts) | `@mc/db/client` | `import { createPgDb, createPool, type CatalogDb } from '@mc/db/client'` |
| Base para pruebas | `@mc/db/test/pglite` | `import { openTestDb } from '@mc/db/test/pglite'` |

El tipo `Db` que entrega el barril **no** tiene `withCatalogs`: una
transacción sin workspace sobre una tabla con RLS devuelve cero filas sin
avisar, y el paquete se vende como la barandilla que impide equivocarse.
Los catálogos se leen con nombre (`@mc/db/queries/catalogos`) y el
cliente completo (`CatalogDb`) sale por `@mc/db/client`, que es lo que
usan el worker y las pruebas.

Cada módulo es dueño de su espacio de nombres y dos módulos pueden
llamar igual a una función: las consultas nuevas se importan por
subruta. La raíz reexporta además las de Finanzas, Conexiones y
Campañas, que ya se importaban desde `@mc/db` antes de CIM-2; si dos
nombres chocan, `tsc` lo señala (TS2308). Los operadores de Drizzle
(`eq`, `and`, `or`, `desc`, `asc`, `sql`, `count`, `inArray`, `isNull`,
…) salen de la raíz para que ni la web ni el worker dependan de
`drizzle-orm` ni cuiden su versión. `isUuid` / `UUID_RE` también, para
validar ids que llegan de una ruta o un formulario antes de consultar.

## Los cinco usos

### 1. Leer con workspace (pantallas y server actions)

```ts
import { withWorkspace } from '@/lib/db';          // apps/web: el workspace lo pone lib/workspace/current.ts
import { listPipeline } from '@mc/db/queries/ventas';

const deals = await withWorkspace((tx) => listPipeline(tx));
```

Fuera de la web (worker, scripts) se abre igual pero con el id explícito:

```ts
const deals = await db.withWorkspace(workspaceId, (tx) => tx.db.select().from(dealPipeline));
```

`tx.db` es Drizzle atado a la transacción; `tx.query(text, params)` es
SQL con parámetros para lo que Drizzle no expresa bien. RLS filtra las
lecturas: desde otro workspace, cero filas; sin workspace, cero filas.

### 2. Insertar con `CURRENT_WORKSPACE`

```ts
await db.withWorkspace(wsId, (tx) =>
  tx.db.insert(deal).values({ workspaceId: CURRENT_WORKSPACE, companyId, name, stageId: 'nuevo' }),
);
```

`CURRENT_WORKSPACE` es `current_workspace_id()` evaluado en la base.
Escribir el uuid de otro workspace falla con `row-level security`. Las
tablas hijas sin `workspace_id` (`quote_item`, `rate_card_item`,
`deal_stage_history`, `campaign_post`, …) heredan la política del padre
(migración 0018): si no ves la cotización, no ves ni escribes sus ítems.

### 3. Catálogo sin workspace

```ts
import { listPlatforms, listPipelineStages } from '@mc/db/queries/catalogos';

const plataformas = await listPlatforms(db);
```

Son siete y están ahí con nombre: `platform`, `niche`,
`niche_cpm_benchmark`, `pipeline_stage`, `signal_source`,
`feature_flag` y `job_definition`. Por debajo abren `withCatalogs`, la
transacción sin workspace, que **no** sale del barril: en una tabla con
RLS devuelve cero filas sin avisar, y quien la use por descuido verá una
lista vacía y buscará el error en la pantalla. Se llamaba
`withoutWorkspace`, que además sonaba a «todos los workspaces» — que es
lo que hace `asWorker`. Sigue accesible desde `@mc/db/client` para el
worker y las pruebas; `test/rls.test.ts` demuestra las cero filas.

`company` y `contact` **no** son catálogos aunque no tengan
`workspace_id`. Desde la migración 0019 `contact` lleva RLS propia: se
ve si su fuente es pública (`public_website`, `public_profile`,
`press`) o si la empresa está vinculada a mi workspace por
`company_link`. `company` sí es global a propósito: nombre, dominio y
sector, sin PII. `app_user` es lo único que sigue sin política, y va con
CIM-3 (necesita `app.user_id`); `test/schema.test.ts` lo deja a la vista
como `todo`.

### 4. Job global con `asWorker`

```ts
const porVencer = await db.asWorker((tx) =>
  tx.db.select().from(socialConnection).where(lt(socialConnection.expiresAt, limite)),
);
```

`SET LOCAL ROLE mc_worker` dentro de la transacción: RLS no aplica,
**cada escritura filtra por `workspace_id` a mano**. Solo funciona si el
rol de conexión es miembro de `mc_worker` (`mc_migrator` en Supabase,
tras `GRANT mc_worker TO mc_migrator` con `scripts/supabase-admin.sh`;
`mc_app` no lo es a propósito). En PGlite embebido siempre funciona.

### 5. Prueba con `openTestDb`

```ts
import { openTestDb, WORKSPACE_LAURA } from '@mc/db/test/pglite';

const t = await openTestDb();                 // migraciones + seed, sesión como mc_app, sin red
await t.admin(`INSERT INTO workspace …`);     // superusuario, para preparar escenarios
const filas = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => …);
await t.close();
```

`openTestDb({ seeds: false })` deja la base vacía. Con
`TEST_DATABASE_URL` corre contra un Postgres real ya migrado y con seed
(nunca Supabase: el helper se niega), con el rol de la aplicación; para
`admin()` hace falta `TEST_DATABASE_ADMIN_URL` con un superusuario o el
dueño de las tablas. Así corre el CI (`.github/workflows/ci.yml`, job
«contra-postgres-real»): un rol `mc_app_ci` miembro de `mc_app` y de
`mc_worker`, y `mc` como administrador. Es lo que ejercita el runner de
`pg` (BEGIN/COMMIT/ROLLBACK, `set_config` sobre un cliente prestado, la
devolución al pool) que PGlite no toca. Los paquetes con su propia copia
del bucle de migraciones (`connectors/test/helpers/pglite.ts`,
`worker/src/runner/db-pglite.ts`) pueden reemplazarla por este helper
(CON-2b).

## Lo que hace el cliente por ti

- **Timeouts.** Toda transacción arranca con `SET LOCAL statement_timeout`
  e `idle_in_transaction_session_timeout` (15 s; `DbOptions` en
  `createPgDb` / `createEmbeddedDb`). El pool de `pg` espera 5 s por una
  conexión y cierra las ociosas a los 30 s (`PoolOptions`).
- **Manijas que mueren con la transacción.** Usar `tx.db` o `tx.query`
  después de que `fn` terminó lanza `TransactionClosedError`. Un
  `return tx` accidental no corre fuera de transacción y sin workspace.
- **Validación del workspace.** `withWorkspace('laura', …)` rechaza antes
  de abrir nada: tiene que ser un UUID.
- **Sin transacciones anidadas.** Llamar a `withWorkspace`,
  `withCatalogs` o `asWorker` desde dentro de otra transacción del
  mismo cliente lanza `NestedTransactionError` antes de tocar el driver,
  en `pg` y en PGlite por igual. Sobre `pg` abriría una segunda conexión
  que no ve lo que la primera aún no confirmó; sobre PGlite esperaría
  para siempre a la transacción que la contiene. Se reutiliza el `tx`
  que ya se tiene; dos transacciones en paralelo desde fuera sí valen.
- **Conexiones rotas fuera del pool.** Si el `ROLLBACK` falla, la
  conexión se devuelve al pool con el error y `pg` la destruye en vez de
  prestársela, con la transacción a medias, a la siguiente petición.
- **TLS, con una sola fuente de verdad.** Contra un host de Supabase se
  verifica con la CA de `db/certs/` (embebida para Vercel);
  `PGSSLROOTCERT` manda si existe. Y un `?sslmode=…` pegado a la URL
  **lanza** en vez de ganar: `pg` re-parsea la cadena de conexión
  después de la configuración explícita, así que `sslmode=no-verify`
  dejaría `rejectUnauthorized: false`, `disable` mandaría texto plano a
  Supabase y `require` descartaría la CA embebida. Si el certificado
  falla, `make db.cert`; nunca el parámetro. En un host sin CA propia el
  parámetro se traduce a una opción `ssl` explícita y se borra de la URL.
- **Las mismas decisiones en el worker.** `apps/worker/src/runner/db.ts`
  importa `tlsFor` / `hostOf` / `resolveTls` de aquí en vez de tener su
  copia: era el mismo camino de seguridad escrito dos veces, y solo uno
  tenía prueba.

## Ciclo de una migración nueva

1. `db/migrations/00NN_lo_que_sea.sql` (las aplicadas son inmutables).
   Antes, `git fetch` y mirar el número más alto en todas las ramas
   activas: dos archivos con el mismo número detienen el runner.
2. `make db.check` — aplica todas en PGlite con el mismo runner que
   Supabase (`db/lib/aplicar.mjs`).
3. `pnpm --filter @mc/db introspect` — `drizzle-kit pull` sobre PGlite,
   deja `.introspect/schema.ts` (no se versiona).
4. Curar `src/schema/<dominio>.ts` a mano con el estilo de los demás
   (helpers en `src/schema/_tipos.ts`).
5. `pnpm --filter @mc/db test` — `test/schema.test.ts` compara columna a
   columna con la base y falla si algo falta o difiere; y comprueba que
   toda tabla de tenant (o hija de una) tiene RLS.
6. El integrador aplica en Supabase: `make db.migrate`.

Nunca al revés: no hay `drizzle-kit generate` ni `push`.

## Verificar de verdad: `--force`

La caché de turbo es local a la máquina y **se comparte entre todos los
clones del repositorio**, incluidos los worktrees de `.claude/worktrees`,
y no distingue la rama. `pnpm turbo run typecheck lint test` puede dar
14/14 «cache hit» replayando los logs de otro worktree: verde sin haber
ejecutado nada de esta rama. Para que el verde signifique algo:

```bash
pnpm turbo run typecheck lint test --force     # o TURBO_FORCE=1
```

El job «calidad» del CI corre siempre con `--force`, que es el único
sitio donde el verde tiene que ser incuestionable.

Las suites de `@mc/db` y `@mc/worker` levantan PGlite (WASM) y esperan a
pg-boss con tiempos reales. Corren con `--test-isolation=none` (un solo
proceso, los archivos en orden) y `--test-timeout=120000`: con el
aislamiento por proceso, y varias instancias WASM arrancando a la vez,
el runner cancelaba archivos enteros con «Promise resolution is still
pending but the event loop has already resolved» en una máquina cargada
—justo lo que es un runner compartido de CI—. En un solo proceso es
además más rápido.

## Reglas del proyecto que este paquete impone

- El workspace lo fija el cliente por transacción, nunca la pantalla.
- Toda tabla con `workspace_id` lleva RLS. Sin excepciones desde 0019;
  `test/schema.test.ts` lo comprueba en cada corrida.
- La moneda, la zona horaria y el locale salen del workspace
  (`queries/cimientos.ts`), no de una constante. Colombia es el valor
  por defecto de un workspace, no del producto.
- Las métricas se insertan, no se actualizan (`*_snapshot`).
- Ninguna pantalla hace aritmética de métricas: un número derivado va en
  una vista (`src/schema/vistas.ts`) o en una consulta tipada.
- Dinero como `string` decimal (`numeric`) con moneda aparte; fechas
  `timestamptz` en UTC.
- Los tokens nunca tocan la base en claro (`secret_ref`).
