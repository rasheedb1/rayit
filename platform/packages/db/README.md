# @mc/db · acceso a datos

Drizzle sobre `pg` (Supabase por el pooler `:6543`) y sobre PGlite
(Postgres embebido para pruebas y modo demo), con **un solo contrato**:
toda consulta corre dentro de una transacción que ya sabe su workspace.
Ninguna pantalla, server action ni job recibe `workspace_id` como
parámetro suelto.

```
src/client.ts      withWorkspace / withoutWorkspace / asWorker sobre pg
src/pglite.ts      lo mismo sobre PGlite
src/embedded.ts    PGlite con db/migrations + db/seed, corriendo como mc_app
src/from-env.ts    cómo la web elige entre los dos (DATABASE_URL o demo)
src/tls.ts         la CA de Supabase, verificada siempre (nunca rejectUnauthorized: false)
src/schema/        tablas y vistas del MVP, curadas desde db/migrations
src/queries/       un archivo por módulo: resumen, ventas, cotizar, campanas, finanzas, conexiones
test/pglite.ts     openTestDb(): la base para las pruebas de cualquier paquete
scripts/introspect.mjs   drizzle-kit pull sobre PGlite, para curar el esquema
```

## Qué importar, y de dónde

| Qué | Desde | Ejemplo |
|---|---|---|
| Cliente, tipos, esquema y operadores de Drizzle | `@mc/db` | `import { createDbFromEnv, deal, eq, desc, CURRENT_WORKSPACE } from '@mc/db'` |
| Consultas de un módulo | `@mc/db/queries/<módulo>` | `import { listInvoices } from '@mc/db/queries/finanzas'` |
| Base para pruebas | `@mc/db/test/pglite` | `import { openTestDb } from '@mc/db/test/pglite'` |

La raíz **no** reexporta consultas: cada módulo es dueño de su espacio
de nombres y dos módulos pueden llamar igual a una función. Los
operadores de Drizzle (`eq`, `and`, `or`, `desc`, `asc`, `sql`,
`count`, `inArray`, `isNull`, …) sí salen de la raíz para que ni la web
ni el worker dependan de `drizzle-orm` ni cuiden su versión.

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
(migración 0016): si no ves la cotización, no ves ni escribes sus ítems.

### 3. Catálogo sin workspace

```ts
const plataformas = await db.withoutWorkspace((tx) => tx.db.select().from(platform));
```

Solo para `platform`, `niche`, `niche_cpm_benchmark`, `pipeline_stage`,
`feature_flag`, `signal_source`, `job_definition`, `company`, `contact`
y `workspace`. En una tabla con RLS devuelve cero filas sin avisar; la
prueba `test/rls.test.ts` lo demuestra.

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
`TEST_DATABASE_URL` corre contra un Postgres real (nunca Supabase: el
helper se niega). Los paquetes con su propia copia del bucle de
migraciones (`connectors/test/helpers/pglite.ts`,
`worker/src/runner/db-pglite.ts`) pueden reemplazarla por este helper.

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
- **TLS.** Contra un host de Supabase se verifica con la CA de
  `db/certs/` (embebida para Vercel). `PGSSLROOTCERT` manda si existe.

## Ciclo de una migración nueva

1. `db/migrations/00NN_lo_que_sea.sql` (las aplicadas son inmutables).
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

## Reglas del proyecto que este paquete impone

- El workspace lo fija el cliente por transacción, nunca la pantalla.
- Las métricas se insertan, no se actualizan (`*_snapshot`).
- Ninguna pantalla hace aritmética de métricas: un número derivado va en
  una vista (`src/schema/vistas.ts`) o en una consulta tipada.
- Dinero como `string` decimal (`numeric`) con moneda aparte; fechas
  `timestamptz` en UTC.
- Los tokens nunca tocan la base en claro (`secret_ref`).
