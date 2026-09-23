# ACC-6 · Alcance en las consultas — propuesta

> Historia ACC-6 (épico ACC, sprint 6). Rama `nicolas/ACC-6-alcance-consultas`.
> Escrito el 23 de septiembre de 2026, antes de tocar código (§0) y
> completado al cerrar (§1 en adelante).

La tenencia la garantiza RLS (`workspace_id = current_workspace_id()`).
El **alcance** —«Ana ve solo lo de Camilo», «el ejecutivo ve solo las
marcas que tiene asignadas»— lo pone cada consulta de `@mc/db`, con un
solo helper (`scopeFilter()`), y una prueba por módulo demuestra que
ninguna función exportada se lo salta. Sin filas de alcance, se ve todo
el workspace: en el MVP nadie tiene filas de alcance y nada cambia.

---

## 0. Plan (fase 1)

### 0.1 Lo que se comprobó antes de diseñar (23-sep)

- **ACC-3 no existe en ninguna rama.** `git fetch` y `git ls-tree` sobre
  todas las ramas locales y remotas: la migración más alta es
  `0033_una_aceptada_por_negocio.sql`; `0023` sigue siendo el hueco que
  reservó la propuesta ACC; no hay `membership_scope`, ni
  `packages/db/src/scope.ts`, ni `permisos.ts` (ACC-1), ni `audit.ts`
  (ACC-2). Los worktrees `rayit-acc1` y `rayit-acc2` están en el commit de
  `main` sin cambios.
- **La guardia del esquema** (`packages/db/src/esquema.ts`,
  `test/schema.test.ts`) exige de toda tabla nueva de `public`: ENABLE +
  FORCE + política que aísle sola; que `mc_app` no conserve más
  privilegios que los declarados en `PRIVILEGIOS_DE_LA_APP` (ALTER DEFAULT
  PRIVILEGES le da los cuatro al nacer); y el disparador
  `assert_reference_visible` en cada clave ajena hacia una tabla con RLS
  **solo si `mc_app` tiene INSERT o UPDATE** sobre la hija. Una tabla sin
  esquema Drizzle no rompe ninguna prueba (`TABLAS_MVP` es una lista a
  mano y la comparación columna a columna recorre `src/schema`). Una
  función que el código llame tiene que estar en
  `FUNCIONES_QUE_USA_EL_CODIGO` para que la guardia de producción avise
  antes del primer 500.
- **Quién es la persona en la transacción**: desde CIM-3 la web abre
  `withWorkspace(wsId, fn, { userId, email })`, así que
  `current_user_id()` (0019) está fijado en toda transacción con sesión.
  En modo demo (copia sin llaves de Supabase) no hay identidad:
  `current_user_id()` es NULL.
- **Columnas de alcance por tabla raíz** (de `db/migrations`): `campaign`
  tiene `creator_id` (opcional), `company_id`, `id`; `invoice` tiene
  `company_id` y `campaign_id` (opcional) y llega al creador por la
  campaña; `social_connection`, `post`, `data_consent` y
  `creator_profile` tienen `creator_id`; `campaign_post`,
  `account_metric_snapshot`, `payment` y `tax_reserve` no tienen ninguna y
  se unen a su padre; `company_link` solo tiene `company_id`. Las vistas
  `creator_post_board` y `connection_health` exponen `creator_id`;
  `receivables` expone `company_id` y `campaign_id`.
- **El worker no usa ninguna función de `queries/{campanas,finanzas,
  conexiones}.ts`**: el alcance es de la web (mc_app); mc_worker corre sin
  workspace fijado y `scope_allows()` devuelve verdadero (sin filas, todo).

### 0.2 Qué se construye

| Archivo | Qué |
|---|---|
| `db/migrations/0034_membership_scope.sql` | **Nuevo.** La tabla `membership_scope` tal cual la fase 4 de la propuesta ACC (re-ejecutable: `CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS`, `CREATE OR REPLACE FUNCTION`), su RLS, `mc_app` solo con SELECT, y las funciones `scope_allows(text, uuid)` y `scope_allows(text, uuid[])`. |
| `packages/db/src/scope.ts` | **Nuevo.** `scopeFilter(anchors)` (el `WHERE` que compone cada consulta), `assertScopeAllows(tx, …)` (para las altas) y `ScopeError`. |
| `packages/db/src/index.ts` | Reexporta `scopeFilter`, `ScopeError`. |
| `packages/db/src/esquema.ts` | `membership_scope` en `PRIVILEGIOS_DE_LA_APP` (SELECT) y las dos firmas en `FUNCIONES_QUE_USA_EL_CODIGO`. Es un archivo de la guardia (Rasheed lo escribió); son dos entradas declarativas, sin lógica. |
| `packages/db/src/queries/campanas.ts` | Alcance en las 11 funciones exportadas. |
| `packages/db/src/queries/finanzas.ts` | Alcance en las 8. |
| `packages/db/src/queries/conexiones.ts` | Alcance en las 14 con transacción (más `publicSecretRef`, pura). |
| `packages/db/test/alcance.ts` | Escenario compartido: dos creadoras en el workspace de Laura, un miembro con alcance a una. |
| `packages/db/test/alcance-esquema.test.ts` | La migración: RLS, privilegios, semántica de `scope_allows`, re-ejecución. |
| `packages/db/test/alcance-{campanas,finanzas,conexiones}.test.ts` | Una prueba por módulo: el bucle sobre TODAS las funciones exportadas. |
| `packages/db/README.md` | Uso 8: alcance. |
| `apps/web/content/backlog.ts` | Estado y nota de ACC-6 (solo mi entrada). |
| `docs/propuestas/ACC-6.md` | Este documento. |

### 0.3 Decisiones (con lo que se descartó y por qué)

**D1 · La tabla `membership_scope` nace en `0034`, no en `0023`, y ACC-3
la absorbe.** «DECISIÓN PENDIENTE DE NICOLÁS.» La historia depende de
ACC-3 y ACC-3 no está. Tres salidas:

| | Qué | Por qué no / por qué sí |
|---|---|---|
| a | Esperar a ACC-3 | Deja la historia sin nada que probar; el modo de trabajo dice entregar completo bajo supuestos. |
| b | Escribir `0023_access_control.sql` entera aquí | Recicla el número reservado sin preguntar (prohibido en el bloque común), y mete en ACC-6 el esquema de roles, invitaciones y concesiones que es de ACC-3. |
| c | **Una migración mínima `0034_membership_scope.sql`** con SOLO la tabla del alcance (la de la fase 4, sin cambiar una columna) y las funciones | Es la opción conservadora: número por la regla del bloque común (máximo en todas las ramas + 1), re-ejecutable, y ACC-3 la escribe con `CREATE TABLE IF NOT EXISTS membership_scope` (o quita esa tabla de su archivo). Si Rasheed prefiere que todo lo de accesos viva en una sola migración, esta se funde en ACC-3 antes de aplicar: nada de lo de aquí está en Supabase. |

Se toma **c**. La tabla es exactamente la de la propuesta (PK compuesta,
FK compuesta hacia `membership` con `ON DELETE CASCADE`, CHECK de
`scope_type`), para que fundirla en ACC-3 sea borrar líneas, no
reconciliar dos versiones.

**D2 · El alcance se evalúa en SQL, con `scope_allows()`, no en
TypeScript con parámetros.** La alternativa era leer las filas de alcance
al entrar en cada función (`const scope = await loadScope(tx)`) y componer
`$n::uuid[]` en cada consulta. Se descartó porque (1) cada función ya
numera sus parámetros a mano y añadir uno en el medio es la clase de
edición que se equivoca en silencio; (2) una función SQL es lo que ACC-7
puede llamar desde una política de RLS —el mismo predicado, escrito una
sola vez—; (3) `current_user_id()` ya está fijado en la transacción, así
que la base sabe quién pregunta sin que nadie se lo pase. La función es
`LANGUAGE sql STABLE` y `SECURITY INVOKER`: lee `membership_scope` bajo
la RLS del workspace fijado. (Corregido al implementar: no se expande en
línea, así que `scopeFilter()` pone delante un `EXISTS` sin correlación
que decide una vez por consulta, y la función solo corre por fila cuando
la persona sí tiene alcance de ese tipo.)

```sql
scope_allows(kind text, target uuid)     -- ¿este id está en mi alcance de ese tipo?
scope_allows(kind text, targets uuid[])  -- ¿alguno de estos lo está?
```

Ambas devuelven verdadero si el miembro **no tiene** filas de ese tipo
(sin filas = todo el workspace). Un `target` NULL nunca está en alcance
(«un nulo no es un cero»): con alcance por creador, una campaña sin
`creator_id` no es de nadie y no se ve.

**D3 · Semántica: Y entre tipos, O dentro de un tipo, y lo que no tiene
columna se une a su padre; si no hay camino, se oculta.** Un miembro con
alcance por creador Y por marca ve la intersección (las campañas de
Camilo con la marca X), no la unión. Es la lectura más restrictiva, que
es la conservadora: se muestra menos, nunca más. Dentro de un tipo, dos
filas son «Camilo o Sofía».

Cada tabla raíz declara un ancla por tipo: la columna, una subconsulta
hacia su padre, o un arreglo de ids cuando la relación es uno-a-muchos.
La tabla, el ancla y la razón:

| Tabla / vista | creator | company | campaign |
|---|---|---|---|
| `campaign` c | `c.creator_id` | `c.company_id` | `c.id` |
| `invoice` i (+ `campaign` ca) | `ca.creator_id` (por la campaña; sin campaña, oculta) | `i.company_id` | `i.campaign_id` |
| `receivables` r | `(SELECT creator_id FROM campaign WHERE id = r.campaign_id)` | `r.company_id` | `r.campaign_id` |
| `payment` p | por su factura (las tres anclas de la factura; un pago sin factura se oculta bajo cualquier alcance) | | |
| `tax_reserve` t | por su pago → factura | | |
| `creator_post_board` b / `post` p | `b.creator_id` | `ARRAY(campañas del post → company_id)` | `ARRAY(campañas del post)` |
| `campaign_post` | siempre unida a `campaign`, que ya filtra | | |
| `social_connection` c / `connection_health` h | `c.creator_id` | *sin camino: oculta* | *sin camino: oculta* |
| `creator_profile` | `id` | *sin camino: oculta* | *sin camino: oculta* |
| `data_consent`, `account_metric_snapshot` | por su conexión | | |
| `company_link` l | `ARRAY(creadores con campaña de esa marca)` | `l.company_id` | `ARRAY(campañas de esa marca)` |
| `quote` q (solo en `createCampaignFromQuote`) | `q.creator_id` | `q.company_id` | *NULL: una campaña nueva nunca está en un alcance por campaña* |

«Sin camino: oculta» quiere decir que un ejecutivo con alcance por marca
o por campaña no ve cuentas conectadas ni perfiles de creador: una cuenta
es de un creador, no de una marca, y no hay forma honesta de decidir cuál
mostrarle. Se descartó «sin camino: se ignora ese tipo» porque abre por
defecto, y una política de alcance abierta no se ve como un bug.

La derivación de `company_link` («las marcas con las que mi creador tiene
campaña») es la única que va del padre al hijo. Se descartó ocultar todas
las marcas al miembro con alcance por creador porque entonces no podría
crear una factura de una campaña que sí ve (createInvoice comprueba
`company_link`). Y se descartó mostrarle todas porque el catálogo de
marcas de una agencia es exactamente lo que AGE-4 quiere acotar.

**D4 · Leer fuera del alcance es «no existe»; crear algo que quedaría
fuera del alcance falla antes de escribir.** Una lectura con id fuera del
alcance devuelve `null`, lista vacía o el mismo `…NotFound` que devuelve
hoy una fila de otro workspace: no se confirma que exista (la regla de
ACC-5, 404 y no 403). Una alta cuyo resultado el propio autor no podría
leer —crear una campaña con alcance por campaña, una factura sin campaña
con alcance por creador, conectar una cuenta de otro creador— se rechaza
**antes** del INSERT con `ScopeError` (`messageEs`: «Eso quedaría fuera de
tu alcance en este espacio.»), o con el `…NotFound` del insumo cuando el
insumo mismo está fuera (la cotización, el creador, la empresa). Es el
mismo principio que 0025 §3 en la base: una fila no puede nombrar otra
que quien escribe no ve.

**D5 · `mc_app` solo puede LEER `membership_scope`.** Escribir filas de
alcance es la pantalla de Equipo (ACC-4, Rasheed) y sus políticas de
INSERT/DELETE; ACC-6 no las necesita y no las adelanta. Con SELECT solo,
la guardia no exige `assert_reference_visible` sobre la FK compuesta
(que el bucle de 0025 §7 no sabría enganchar). La política de lectura es
`workspace_id = current_workspace_id()`: la pantalla de Equipo listará el
alcance de cada miembro del espacio. Se descartó `AND user_id =
current_user_id()` («solo mi alcance») porque no lo necesita nadie hoy y
ACC-4 tendría que quitarlo.

**D6 · La prueba por módulo recorre `Object.entries(import * as m)` y
exige un caso por función exportada.** Cada archivo de prueba tiene un
mapa `nombre → caso`; una función exportada que no esté en el mapa hace
fallar la prueba con su nombre (es la señal de la fase 8 de la propuesta:
«el alcance se aplica en 9 de 10 consultas»). Cada caso se corre **dos
veces**: como la dueña (sin filas de alcance) tiene que devolver o tocar
lo de Sofía —así la prueba demuestra que el escenario existe—; como el
miembro con alcance a Laura, el resultado serializado no puede contener
ningún id de Sofía y las escrituras tienen que rechazarse sin dejar fila.
Las funciones puras (`publicSecretRef`) se declaran como tales en el mapa.

**D7 · Verificación en dev.** En una copia sin llaves de Supabase no hay
identidad (`current_user_id()` NULL), así que el alcance no se puede ver
en el navegador sin una sesión, y con llaves no se puede sembrar
`membership_scope` en Supabase (nunca se escribe ahí). Para verlo en
pantalla se usa un atajo **local y sin commitear**: una seed temporal con
el escenario y `DEMO_USER_ID` leído en `lib/workspace/current.ts` junto a
`DEMO_WORKSPACE_ID`. Ese atajo se propone a Rasheed (§4) como cambio de
seis líneas en su carpeta; mientras tanto, lo que se pega abajo (§5) es
la salida real del servidor de dev con ese parche puesto y quitado.

**D8 · Sin esquema Drizzle.** `packages/db/src/schema/` es de Rasheed y
ninguna consulta mía usa el ORM para esta tabla. El `schema/accesos.ts`
propuesto va en §4 para que lo pegue cuando integre ACC-3.

**D9 · Contrato con ACC-7.** Cuando Rasheed endurezca con RLS por
`creator_id` en `social_connection`, `post`, `campaign` y `deal`, la
política puede ser literalmente `USING (scope_allows('creator',
creator_id))` como política **restrictiva** (`AS RESTRICTIVE`) junto a la
de workspace: así no abre nada (una restrictiva solo quita) y el
predicado es el mismo que aplican las consultas. Queda en §4.

### 0.4 Fuera de alcance

- Alcance en `queries/{ventas,cotizar,resumen,identidad}.ts` (Rasheed;
  esta historia es «los dos, por módulo»).
- RLS por creador (ACC-7), pantallas de agencia (AGE), la pantalla que
  escribe el alcance (ACC-4), `requirePermission()` (ACC-1: no está en
  main; las Server Actions de mis módulos siguen con su `// TODO(ACC-1)`).
- `workspace_grant.scope` (concesiones entre workspaces): cuando exista,
  el que entra por una concesión recibe sus filas en `membership_scope`
  del workspace del creador; `scope_allows()` no cambia.

### 0.5 Dudas que resolví solo

- ¿Alcance por campaña sobre `listLinkablePosts`? Un miembro con alcance
  a la campaña X ve, como asociables, solo posts que ya cuelguen de otra
  campaña de su alcance: casi siempre ninguno. Es correcto y es raro;
  lo que un ejecutivo con alcance por campaña hace es mirar, no asociar.
  Lo apunto para AGE-4.
- ¿`getDefaultCreatorId` con alcance? Devuelve el primer creador **del
  alcance** (`creator_profile` filtrado). Así el mánager con alcance a
  Camilo agrega cuentas de Camilo sin que la pantalla sepa de alcance. Sin
  creador en alcance: `NoCreatorProfile`, con su frase.
- ¿Y si alguien inserta filas de alcance en el workspace de un creador
  del MVP? Verá menos, nunca más. No hay pantalla que lo haga hasta ACC-4.

---

## 1. Cómo quedó

- **34 funciones exportadas con alcance**: 11 en `campanas.ts`, 8 en
  `finanzas.ts` y 15 en `conexiones.ts` (una de ellas pura,
  `publicSecretRef`). Cada tabla raíz declara su ancla una sola vez
  (`SCOPE_CAMPAIGN`, `SCOPE_INVOICE`, `SCOPE_CONNECTION`, …) y cada
  SELECT, UPDATE y DELETE la compone.
- **Las altas** se rechazan antes de escribir: con `ScopeError` cuando la
  fila nueva quedaría fuera del alcance (factura sin campaña bajo
  alcance por creadora, campaña viva de la cotización reasignada, cuenta
  de otra creadora en una rama `ON CONFLICT`), o con el `…NotFound` del
  insumo cuando el insumo no se ve.
- **La web no cambió de comportamiento** para nadie sin filas de
  alcance. Los dos servicios de Conexiones traducen `ScopeError` a
  «fuera_de_alcance» con su frase.
- **Barato sin alcance**: cada tipo empieza por un `EXISTS` sin
  correlación que Postgres evalúa una vez por consulta.

## 2. La migración `0034_membership_scope.sql` (para revisar y aplicar)

| Sección | Qué | Nota para el integrador |
|---|---|---|
| 1 | `membership_scope` tal cual la fase 4 de la propuesta ACC, e índice `campaign_post (post_id)` | `CREATE … IF NOT EXISTS`: re-ejecutable |
| 2 | RLS `FOR SELECT` por `workspace_id`; `mc_app` solo SELECT | Declarado en `PRIVILEGIOS_DE_LA_APP` |
| 3 | `scope_allows(text, uuid)` y `scope_allows(text, uuid[])`, SECURITY INVOKER, sin EXECUTE para PUBLIC | Declaradas en `FUNCIONES_QUE_USA_EL_CODIGO`: **sin 0034 en la base, la guardia de producción no deja arrancar la web** |

Orden en la cola del integrador: después de 0033. No crea roles ni
necesita el token de administración.

## 3. El contrato con ACC-7 (Rasheed)

La política por creador puede usar el mismo predicado, como política
**restrictiva** para que no abra nada:

```sql
CREATE POLICY campaign_scope ON campaign AS RESTRICTIVE
  USING (scope_allows('creator', creator_id));
```

Con eso, una consulta cruda que olvide `scopeFilter()` tampoco devuelve
filas de otro creador (el «terminado cuando» de ACC-7). Ojo con dos
cosas al escribirla: `invoice` no tiene `creator_id` (llega por
`campaign`), y una restrictiva también filtra los `ON CONFLICT DO
UPDATE`, que es justo lo que la revisión de ACC-6 tuvo que cerrar a mano.

## 4. Lo que necesita Rasheed

1. **Aplicar 0034 en Supabase** (`make db.migrate` y `make db.guardia`)
   **antes** de desplegar esta rama. Si ACC-3 llega antes, puede fundir
   la tabla en su migración y dejar aquí solo las funciones.
2. **Esquema Drizzle** propuesto para `src/schema/accesos.ts` (ninguna
   consulta lo usa hoy; la prueba de esquema no lo exige):

   ```ts
   export const MEMBERSHIP_SCOPE_TYPES = ['creator', 'company', 'campaign'] as const;
   export const membershipScope = pgTable('membership_scope', {
     workspaceId: uuid('workspace_id').notNull(),
     userId: uuid('user_id').notNull(),
     scopeType: text('scope_type', { enum: MEMBERSHIP_SCOPE_TYPES }).notNull(),
     scopeId: uuid('scope_id').notNull(),
     createdAt: createdAt(),
   }, (t) => [
     primaryKey({ columns: [t.workspaceId, t.userId, t.scopeType, t.scopeId] }),
     foreignKey({ columns: [t.workspaceId, t.userId], foreignColumns: [membership.workspaceId, membership.userId] }).onDelete('cascade'),
   ]);
   ```
3. **`DEMO_USER_ID` en `lib/workspace/current.ts`** (opcional, seis
   líneas): en una copia sin llaves, fijar también la identidad de la
   transacción. Es lo que usé, sin commitear, para verlo en dev (§5).
4. **Alcance en Ventas, Cotizar y Resumen**: el arnés
   `test/alcance.ts` sirve tal cual; basta un
   `test/alcance-ventas.test.ts` con su mapa de casos.
5. **ACC-4** escribe `membership_scope`: necesita sus políticas de
   INSERT y DELETE y quitar la tabla de `PRIVILEGIOS_DE_LA_APP` (o
   ampliar lo declarado).

## 5. Verificación

- Pruebas: ver la salida en el PR. `@mc/db` completo en verde, más las
  cuatro de alcance y la del callback de OAuth con un miembro acotado.
- Comprobación de que la prueba muerde: quitar el filtro de `getInvoice`
  y exportar una función nueva sin caso hace fallar tres pruebas, con el
  nombre de la función.
- Dev (embebido, seed temporal con el escenario, `DEMO_USER_ID` del
  miembro con alcance a Laura en :3186 y sin identidad en :3187):

  | Pantalla | Miembro (alcance Laura) | Sin alcance |
  |---|---|---|
  | `/campanas` | 5 campañas, nada de Sofía | 6, con «Playa con Marca de Sofía» |
  | `/campanas/<campaña de Sofía>` | página de «no encontrado» | ficha de Sofía |
  | `/finanzas` | sin FV-2026-901 | con FV-2026-901 |
  | `/finanzas/facturas/<factura de Sofía>` | «no encontrado» | «Factura FV-2026-901» |
  | `/finanzas/facturas/nueva` | sin la marca ni la campaña de Sofía | con las dos |
  | `/conexiones` | sin @sofia.viaja | con @sofia.viaja |

  En dev, la primera respuesta de cada servidor lleva en el payload de
  depuración de React el texto de los seeds (le pasa igual a 0004): es
  información de desarrollo, no sale en producción ni depende de ACC-6.

## 6. Revisión (/code-review, nivel alto)

| # | Hallazgo | Resolución |
|---|---|---|
| 1 | `upsertConnection`: la rama `ON CONFLICT` reescribía la cuenta de otra creadora | Arreglado: `WHERE` de alcance en el `DO UPDATE` y `ScopeError`; prueba en db y en el callback de OAuth |
| 2 | `addPublicAccount`: igual, y 500 en la web | Arreglado igual; `cuentas-service` devuelve «fuera_de_alcance» |
| 3 | Con alcance por marca, un post sin campaña no se ve ni se asocia | **Justificado**: un post sin campaña es de la creadora, no de la marca. DECISIÓN PENDIENTE (§8) |
| 4 | `markAccountLookupFailure` pasaba a lanzar y la web no lo atrapaba | Arreglado: devuelve si anotó, sin tapar el error original |
| 5 | `createInvoice` no comprobaba el alcance de `quoteId` | Arreglado, con prueba |
| 6 | `createCampaignFromQuote` chocaba con el índice único si la campaña viva estaba fuera | Arreglado: búsqueda sin filtro y `ScopeError`; prueba |
| 7 | `upgradePublicAccountToOAuth` chocaba con el UNIQUE y la web decía «temporal» | Arreglado: `ScopeError` antes del UPDATE y «fuera_de_alcance» |
| 8 | Poner el alcance a mano en cada consulta es frágil | **Justificado**: es la decisión C de la propuesta ACC; la red de seguridad es ACC-7 (§3) y la prueba por módulo |
| 9 | Subconsultas correlacionadas en los KPI y `JOIN post` en la lista | En parte: el `JOIN post` pasó a subconsulta que solo corre con alcance. Las de los KPI solo corren con alcance (el `EXISTS` sin correlación va primero) |
| 10 | CTE `mias` en español; nombres de las pruebas en español | CTE renombrada a `scoped_receivables`. Las pruebas siguen el estilo de las vecinas (`cercaDelMock`, `laura`) |

## 7. Revisión de seguridad (/security-review)

Sin hallazgos de confianza alta. Revisados y descartados: inyección SQL
en `scopeFilter` (todas las anclas son literales del módulo; los valores
van por `$n`), privilegios de `scope_allows()` (INVOKER, sin EXECUTE
para PUBLIC), escritura del alcance por `mc_app` (no tiene privilegio),
las ramas `ON CONFLICT` (cerradas en §6) y las escrituras de seguimiento
(todas van detrás de una lectura con alcance y `FOR UPDATE`).

## 8. Decisiones pendientes de Nicolás

1. **0034 aparte o dentro de ACC-3** (D1). Tomada: aparte, re-ejecutable.
2. **Factura sin campaña bajo alcance por creadora: se oculta.** Coincide
   con el rol Mánager («solo el cobro de sus campañas»), pero en el seed
   la mayoría de las facturas históricas no tienen campaña: un mánager
   acotado no las verá.
3. **Post sin campaña bajo alcance por marca o por campaña: se oculta**
   (hallazgo 3). Un ejecutivo de marca no podrá asociar posts nuevos a
   sus campañas; lo apunto para AGE-4.
4. **Entre tipos, intersección** (D3).
