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

Dos de esos catálogos —`pipeline_stage` y `feature_flag`— tienen filas
globales (`workspace_id NULL`) y filas de un workspace, y desde la
migración **0020** llevan RLS. Por eso sus dos lecturas no reciben
ningún id:

```ts
const globales = await listPipelineStages(db);              // sin workspace: solo las compartidas
const mias     = await withWorkspace((tx) => listPipelineStages(tx)); // las compartidas + las del workspace
```

Antes tomaban `{ workspaceId }` como parámetro suelto —lo único que el
contrato de este paquete no permite en ningún otro sitio— y el filtro
lo hacía JavaScript: quien pasara el id de otro tenant leía sus etapas
o le encendía una bandera. Ahora el filtro lo pone la base.

`company` y `contact` **no** son catálogos aunque no tengan
`workspace_id`.

- `contact` (PII: correo, teléfono, LinkedIn) lleva `owner_workspace_id`
  desde **0020**, puesto por la base: se ve si es mío, o si no tiene
  dueño y su fuente es pública (`public_website`, `public_profile`,
  `press`) —el catálogo que llena el worker—, y solo lo escribe su
  dueño (**0025**: hasta entonces se veían los públicos de cualquiera,
  y eso decía qué marcas prospectaba cada quien). Y la baja es
  definitiva: un trigger impide que `opted_out` vuelva a `false`.
- `company` lleva `owner_workspace_id` desde **0024** y se lee «sin
  dueño o mía» desde **0025**: sin dueño es el catálogo compartido; con
  dueño, la ficha de un workspace. Si dos workspaces trabajan con la
  misma marca, cada uno tiene su ficha (el dominio es único por dueño,
  no en toda la base). Solo su dueño la renombra o la borra.
- `app_user` lleva RLS desde **0020**: se ve uno mismo y quien comparta
  workspace; el alta es la fila de `current_user_id()` (**0025**) y no
  hay política de `DELETE`.
- `workspace`, la raíz del inquilino, lleva RLS desde **0024**. Se ve
  una fila, la de la transacción; se renombra la propia; se crea la de
  la transacción (el registro de CIM-3 será `withWorkspace(nuevoId)`);
  no hay política de `DELETE` ni privilegio para hacerlo.
- **Una fila no puede nombrar otra que su transacción no ve** (**0025**).
  La clave ajena la comprueba Postgres sin RLS; el disparador
  `assert_reference_visible`, enganchado a cada clave hacia una tabla
  con RLS, rechaza con 23503 —el mismo error que un id que no existe—
  un `company_id`, un `stage_id` o un `deal_id` que quien escribe no
  puede leer.

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
  Y tampoco un constructor de consulta capturado dentro y esperado
  fuera (`const q = tx.db.select()…; await q` después): el cliente que
  Drizzle recibe va envuelto, así que la espera tardía lanza igual.
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
- **El pool nunca se queda sin oyente de `error`.** `pg` emite `error`
  en el Pool cuando se rompe una conexión **ociosa** —el pooler de
  Supabase las cierra de forma rutinaria— y un `EventEmitter` sin
  oyente de `error` **lanza**: eso no tumbaba una petición, tumbaba el
  proceso de Next entero. `createPool` deja siempre uno; con
  `PoolOptions.onError` lo manda quien construye el pool a su logger.
- **Que la base tenga el esquema del repositorio.** `createDbFromEnv`
  lo comprueba una vez al construir el cliente
  (`assertSchemaUpToDate`): migraciones aplicadas vs. `db/migrations`;
  **todas** las tablas de `public` que la base declara, aisladas salvo
  las de `EXCEPCIONES_SIN_AISLAMIENTO`; y los privilegios que `mc_app`
  conserva sobre lo que `PRIVILEGIOS_DE_LA_APP` declara de solo
  lectura. En desarrollo avisa con `make db.migrate`; con
  `NODE_ENV=production`, lanza (salida explícita:
  `ALLOW_STALE_SCHEMA=1`, que lo baja a aviso). El contrato de este paquete —RLS aísla
  cada workspace— lo cumplen las políticas, no el código: contra una
  base atrasada todo compila, las rutas responden 200 y el aislamiento
  no existe. El worker lo pregunta también, en su `preflight`.
- **TLS, con una sola fuente de verdad.** Contra un host de Supabase se
  verifica con la CA de `db/certs/` (embebida para Vercel);
  `PGSSLROOTCERT` manda si existe. Y un `?sslmode=…` pegado a la URL
  **lanza** en vez de ganar: `pg` re-parsea la cadena de conexión
  después de la configuración explícita, así que `sslmode=no-verify`
  dejaría `rejectUnauthorized: false`, `disable` mandaría texto plano a
  Supabase y `require` descartaría la CA embebida. Lo mismo con los
  otros cuatro parámetros que `pg-connection-string` convierte en
  `ssl`: `sslrootcert` sustituía la CA del repositorio por la del
  archivo que diga la URL, `sslcert` / `sslkey` metían un certificado
  de cliente y `sslnegotiation=direct` dejaba `ssl: true` con el
  almacén del sistema, que no conoce la CA de Supabase. Si el
  certificado falla, `make db.cert`; nunca el parámetro. En un host sin
  CA propia, `sslmode`/`ssl` deciden si hay TLS, `sslrootcert` aporta la
  CA, y todos se borran de la URL; los otros tres se rechazan (su sitio
  es `PoolOptions`, donde se ven).
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
5. Si la tabla es nueva, **no hay que apuntarla en ninguna lista**: la
   guardia de `src/esquema.ts` está invertida y exige aislamiento a
   todo lo que encuentre en `public`. Lo que sí hay que escribir es la
   política, en la misma migración, y que **cada** política permisiva
   aísle por sí sola (`col = current_workspace_id()`, o un `EXISTS`
   correlacionado sobre el padre; ver `src/politicas.ts`). Si la tabla
   tiene claves ajenas hacia tablas con RLS, engancha
   `assert_reference_visible` a cada una (el bucle de 0025 §7 sirve de
   modelo). Si de verdad es global —un catálogo que llena una migración,
   una observación sin inquilino— se declara en
   `EXCEPCIONES_SIN_AISLAMIENTO` **con su motivo**, y se le quita a
   `mc_app` lo que no necesite en `PRIVILEGIOS_DE_LA_APP`.
6. `pnpm --filter @mc/db test` — `test/schema.test.ts` compara columna a
   columna con la base y falla si algo falta o difiere; y comprueba que
   ninguna tabla se quedó sin aislamiento ni excepción declarada, que
   ninguna excepción sobra y que `mc_app` no tiene privilegios de más.
7. El integrador aplica en Supabase: `make db.migrate`.

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
- **Toda tabla de `public` lleva aislamiento** (ENABLE + FORCE + al
  menos una política), no solo las que tienen `workspace_id`. Las
  excepciones se declaran una a una, con su motivo, en
  `EXCEPCIONES_SIN_AISLAMIENTO`; una tabla nueva sin política y sin
  excepción rompe la prueba. La regla anterior —«toda tabla con
  `workspace_id`»— se leyó al pie de la letra durante cinco rondas y
  por eso `workspace`, cuya clave se llama `id`, se quedó sin política
  hasta 0024.
- **Cada política permisiva aísla por sí sola.** Se combinan con OR:
  una abierta junto a una buena abre la tabla. La guardia las evalúa
  una por una y comando por comando; las abiertas a propósito van en
  `POLITICAS_ABIERTAS_DECLARADAS` con su motivo.
- **`mc_app` tiene los privilegios mínimos.** RLS no protege una tabla
  sin política: la protege el `GRANT`. `PRIVILEGIOS_DE_LA_APP` dice qué
  puede hacer sobre cada catálogo y la guardia lo comprueba, también en
  producción. Nunca tiene TRUNCATE, TRIGGER, REFERENCES ni MAINTAIN, ni
  privilegios sobre una vista materializada o una tabla foránea, ni
  EXECUTE sobre una función SECURITY DEFINER; y ningún otro rol que no
  esté en `ROLES_CON_ACCESO_DECLARADOS` tiene nada en `public`.
- La moneda, la zona horaria y el locale salen del workspace
  (`queries/cimientos.ts`), no de una constante. Colombia es el valor
  por defecto de un workspace, no del producto.
- Las métricas se insertan, no se actualizan (`*_snapshot`), y las
  escribe el worker: `mc_app` solo las lee (**0025**).
- Ninguna pantalla hace aritmética de métricas: un número derivado va en
  una vista (`src/schema/vistas.ts`) o en una consulta tipada.
- Dinero como `string` decimal (`numeric`) con moneda aparte; fechas
  `timestamptz` en UTC.
- Los tokens nunca tocan la base en claro (`secret_ref`).
