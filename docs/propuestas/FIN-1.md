# FIN-1 · Facturas — lo que Rasheed tiene que saber

Escrito para: Rasheed (dueño de `packages/db/src/client.ts`, `schema/`,
`lib/auth/` y `lib/workspace/`) y quien revise el PR de FIN-1.
Fecha: 21 de septiembre de 2026. Rama `nicolas/FIN-1-facturas`, sobre
`nicolas/CIM-8-seed-finanzas-campanas`.

---

## 1. Lo provisional que abrí en tus carpetas, y cómo lo reemplazas

Ni `packages/db` (CIM-1/CIM-2) ni `lib/workspace` (CIM-3) ni el kit
(CIM-5) estaban en `main`. Para que FIN-1 corriera de punta a punta sin
tocar `client.ts` ni `schema/`, hice esto:

| Qué | Dónde | Cuándo se va |
|---|---|---|
| Paquete `@mc/db` mínimo: `package.json`, `tsconfig.json`, `src/index.ts` | `packages/db/` | Lo absorbes en CIM-1. Solo es tuyo `src/index.ts`: reexporta lo de `provisional/` y `queries/finanzas.ts`. |
| Cliente con transacción por workspace: `createPgDb(pool)` y `createPgliteDb(pglite)`, ambos con `withWorkspace(workspaceId, fn)` que hace `BEGIN`, `set_config('app.workspace_id', $1, true)`, `fn(tx)`, `COMMIT`/`ROLLBACK` | `packages/db/src/provisional/client.ts` | Cuando exista `client.ts`. Mis consultas solo dependen de la interfaz `WorkspaceTx { workspaceId; query(text, params) }`: si tu cliente la cumple (o Drizzle expone `tx.execute`), el cambio es la importación. |
| Postgres embebido que migra como un rol **sin BYPASSRLS** y carga los seeds | `packages/db/src/provisional/embedded.ts` | Vale la pena conservarlo para las pruebas de integración y como "modo demo" de la web sin `DATABASE_URL` (nunca en producción: `from-env.ts` lanza). Si lo mueves a `test/`, avísame. |
| `createDbFromEnv()`: `DATABASE_URL` → node-postgres con la CA de `db/certs`; sin ella en desarrollo → embebido | `packages/db/src/provisional/from-env.ts` | Cuando `client.ts` exponga el pool configurado. |
| Workspace actual: `MC_WORKSPACE_ID` o el de la creadora del seed | `apps/web/app/(app)/finanzas/_lib/workspace.ts` | Cuando CIM-3 exponga `lib/workspace/`. Es el **único** lugar del módulo que conoce el workspace. |
| Dependencias: `zod` 4.6 (8 MB instalado, ~15 kB en el bundle) en `@mc/web`; `pg` y `@types/pg` en `@mc/db` (pg ya estaba en la raíz) | `package.json` de cada uno | zod la pide el prompt para las Server Actions. Se avisa en el daily. |

En `next.config.ts`: `transpilePackages: ["@mc/core", "@mc/db"]` y
`serverExternalPackages: ["pg", "@electric-sql/pglite"]`. En el
`tsconfig` de la web, `allowImportingTsExtensions` porque `@mc/core` y
`@mc/db` importan con extensión `.ts` (lo exige `node --test` con
strip-types).

## 2. El esquema Drizzle que necesito (CIM-2)

Tablas del MVP que toca Finanzas, con las columnas tal como están en
0008 (nada nuevo, ninguna migración):

- `invoice`: todas. En particular `number` (con `UNIQUE (workspace_id,
  number)`), `subtotal`, `tax`, `withholding`, `total`, `paid_amount`
  como `numeric(14,2)` → **string** en TypeScript (`{ mode: "string" }`
  o el equivalente); `issued_on`, `due_on` como `date` → string
  `YYYY-MM-DD`, no `Date`; `status` como `text` con el union
  `'draft'|'sent'|'partial'|'paid'|'overdue'|'void'`.
- `company` (`id`, `name`), `company_link` (para saber qué empresas son
  del workspace: `company` no tiene RLS, `company_link` sí).
- `campaign` (`id`, `name`, `company_id`, `quote_id`, `amount`,
  `currency`, `status`) y `quote.payment_terms_days`.
- Vista `receivables` como relación de solo lectura (`pgView`), y
  `payment`, `tax_reserve` para los KPIs (FIN-2 y FIN-3 las escriben).

Mientras no exista, `queries/finanzas.ts` usa SQL con parámetros sobre
el cliente. Está escrito para que la migración a Drizzle sea consulta
por consulta.

## 3. Decisiones de dominio

1. **`overdue` se deriva, no se persiste.** `deriveStatus(invoice,
   hoy)` en `packages/core/src/facturacion.ts` devuelve `overdue` para
   `sent`/`partial` con `due_on < hoy` (vence hoy no es vencida; venció
   ayer sí). La vista `receivables` ya lo hace con `aging_bucket`, así
   que la lista y el detalle leen `status` persistido + `derivedStatus`
   y `bucket` calculados. La máquina de estados acepta `sent|partial →
   overdue` por si el job de recordatorios (FIN-4, sprint 5) decide
   persistirlo; hoy nadie lo escribe. Ventaja: no hay job que pueda
   atrasarse y dejar una factura "al día" que venció anoche.
2. **`total = subtotal + IVA`.** Es el total de la factura electrónica.
   La retención en la fuente (11 % por servicios, editable) se calcula y
   se guarda en `withholding` como lo que la marca retendrá al pagar; no
   se resta del total. `net = total − withholding` es lo que entra al
   banco y se muestra en el formulario y en el detalle. FIN-2 decide
   cómo registrar el pago neto + el certificado de retención para llegar
   a `paid_amount = total`.
3. **Aritmética decimal sin librería.** BigInt de centavos, redondeo
   half-up, tasas con hasta seis decimales. Cabe en 60 líneas de core y
   evita una dependencia; `decimal.js` (~30 kB) quedaría para cuando haga
   falta división o potencias. El total del formulario se calcula en el
   navegador con la misma función que guarda la Server Action.
4. **Numeración `FV-AAAA-NNN`** por workspace y año de emisión, mínimo
   tres dígitos y sin truncar a partir de 1000. Igual que el seed 0003
   (la última es `FV-2026-011`; la app siguió con `FV-2026-012`). En
   `createInvoice`: `pg_advisory_xact_lock(hashtext('invoice-number:' ||
   workspace || ':' || año))` dentro de la transacción, luego el mayor
   número del año (ordenado por longitud y valor) y `INSERT`. Dos
   creaciones concurrentes se serializan; no chocan en el UNIQUE ni
   saltan números. La prueba con `Promise.all` corre en PGlite
   (serializa) y contra `TEST_DATABASE_URL` (concurrencia real).
5. **Aislamiento.** Ninguna consulta recibe `workspace_id`: las lecturas
   las filtra RLS (FORCE en 0010; la base embebida migra como un rol sin
   `BYPASSRLS` para que sea verdad también en las pruebas) y los `INSERT`
   usan `current_workspace_id()`. Antes de insertar se comprueba que la
   empresa esté en `company_link` y la campaña en `campaign` del
   workspace, porque la FK a `company` no distingue workspaces.
6. **"Desde una campaña" vive en el formulario de factura nueva**, como
   selector opcional que prellena empresa, campaña y monto (el `amount`
   de la campaña es lo acordado con IVA incluido; `subtotalFromTotal` lo
   descompone). Además, `facturarCampana(campaignId)` (Server Action
   exportada desde `app/(app)/finanzas/index.ts`) crea el borrador y
   abre el detalle: es lo que CAM-1 enlaza con el botón «Facturar».
7. **Fechas en UTC.** "Hoy" del formulario es `new
   Date().toISOString().slice(0, 10)`; a las 8 p. m. de Bogotá ya es
   mañana. Es la regla del repo; si molesta en la demo, se toma la
   fecha del workspace (`timezone`) cuando CIM-3 la exponga.

## 4. Qué faltaba del kit (CIM-5)

`components/ui/` no existía. Agregué el subconjunto que Finanzas
necesita, con las props exactas del borrador de API de CIM-5
(`docs/propuestas/CIM-5-kit.md`): `Button`, `Pill`, `Field`, `Input`,
`Select`, `Textarea`, `MoneyInput`, `DateInput`, `EmptyState`, `Kpi`,
`KpiRow`, `DataTable`, `CellMain`, más `lib/format.ts` con pruebas. Si
CIM-5 aterriza primero, el merge toma los suyos y estas pantallas
siguen compilando porque la API es la misma. Faltan en el kit:
`LineChart`, `BarChart`, `ChartCard`, `DataAsOf`, `onRowClick`, orden y
paginación. En `globals.css` agregué `--warn`/`--warn-bg` (CIM-4 trae
el juego completo de tokens del mock).

## 5. Verificación

- `pnpm --filter @mc/core test`: 23 pruebas (17 de facturación).
- `pnpm --filter @mc/db test`: 13 pruebas de integración en Postgres
  embebido con el seed 0003.
- `pnpm --filter @mc/web test`: 6 pruebas de `lib/format.ts`.
- `typecheck`, `lint` y `build` de la web en verde.
- En la app corriendo sin `DATABASE_URL` (modo demo): la factura desde
  la campaña Café Alma sale como `FV-2026-012` con empresa, campaña y
  `COP 3.100.000`; `Marcar enviada` y `Anular` funcionan; una
  transición inválida devuelve el mensaje en español; el formulario
  devuelve los errores de zod con `aria-invalid` (verificado por HTTP
  sin JavaScript; el foco al primer error es un efecto de cliente que
  no se ejercitó sin navegador).

## 6. Pendiente de ti

- [ ] CIM-2: `client.ts` con `withWorkspace` (o equivalente) y el
      esquema de §2. Yo cambio las importaciones y borro `provisional/`.
- [ ] CIM-3: `lib/workspace/` con el workspace de la sesión. Yo borro
      `_lib/workspace.ts`.
- [ ] Vault: si la web va a leer Supabase en desarrollo, hace falta
      `DATABASE_URL` en el entorno de `pnpm --filter @mc/web dev`
      (`.env.local` está en `platform/`, no en `apps/web/`). Sin ella
      arranca en modo demo, que es lo que enseña la demo del viernes.

## 7. Despliegue (hecho el 22 de septiembre; antes era de CIM-7)

`scripts/vercel.sh` desplegaba `apps/web` a secas; desde FIN-1 la web
importa `@mc/core` y `@mc/db`, así que se sube `platform/` entero con
Root Directory = `apps/web` en el proyecto de Vercel. Lo que quedó:

- `make vercel.dir DIR=.` guarda en el vault qué directorio se
  despliega (nuevo subcomando `dir`). `make vercel.link` escribe el
  enlace local **con los `settings` del proyecto**: sin ellos, la CLI
  "detecta" la configuración local en el primer deploy y la guarda en el
  proyecto, borrando el Root Directory (pasó una vez). `make vercel.deploy`
  y `make vercel.deploy PROD=1` funcionan tal cual.
- Si el proyecto no existe con ese nombre, `vercel.link` lo **crea**:
  al renombrarse el proyecto a `on-cue-web`, un `make vercel.link` creó
  un duplicado `multicampaign-web`. Se borró. Enlazar por nombre:
  `make vercel.link NOMBRE=on-cue-web`.
- Variables en Vercel: `DATABASE_URL` (pooler :6543, `mc_app`) en
  producción y preview. Sin ella la app falla a propósito.
- La CA de Supabase va embebida en `@mc/db` (`supabase-ca.ts`);
  `make db.cert` la regenera y una prueba avisa si diverge.
- `.vercelignore` de `platform/` no debe excluir `packages/db`.
- El CI vive ahora en `.github/workflows/ci.yml` de la raíz (la copia en
  `platform/.github/` nunca corrió) y usa pnpm.
