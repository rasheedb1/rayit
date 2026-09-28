# CIERRE-ACC · Cierre de la parte de Nicolás en Accesos (ACC-1, 2, 3, 5, 6 y 8)

Escrito para: Nicolás, que decide las cuestiones abiertas (§4), aplica
la migración y hace la prueba de humo en producción (§7); y Rasheed,
para §5. Fecha: 23 de septiembre de 2026. Rama
`nicolas/ACC-cierre-modulo`, desde `origin/main` (`2a388d6`), con
`origin/main` traído dos veces más en F5 (`5ad18fa`: CON-B y WRK;
`7ef8e2b`: CON-C). **Una
migración: `0040_scope_allows.sql`.**

**Resumen.** ACC-1, 2, 3, 5 y 8 ya estaban en main y en producción. Lo
que faltaba era ACC-6, el alcance dentro del workspace. Su rama se
integró sobre el main de hoy, y el alcance cubre ahora **todas las
funciones exportadas** de Campañas, Finanzas y Conexiones: de las 82
que consultan la base, 71 llevan alcance y 11 están declaradas sin él,
cada una con su motivo. La rama solo conocía 34. Dos pruebas lo sostienen:

- una de comportamiento por módulo, con dos creadoras en un workspace;
- una de convención, que lee el código y falla si una función nueva no
  pasa por `scopeFilter()`.

Sin filas de alcance nada cambia, y hoy nadie tiene filas. Quedan veinte
decisiones tuyas (§4), todas con la opción conservadora en el código. La
parte de ACC-6 que le toca a Rasheed está en §5.

---

## 0. Inventario

### 0.1 La foto, comprobada

| Cosa | Estado al empezar | Cómo se comprobó |
|---|---|---|
| `origin/main` | `2a388d6` (cierre de FIN), no `cf90d57`: entraron P0, CAM, CON-A y FIN | `git fetch` |
| Producción | FIN-cierre (`0bd7107`), con ACC-1/2/3/5/8 | memoria del cierre de FIN; se verifica en §7 |
| Supabase | última aplicada **0039**; `scope_allows` no existe; `membership_scope` con **0 filas**; **0041 (CAM) en main y SIN aplicar** | `make db.sql` de solo lectura (§6) |
| `nicolas/ACC-6-alcance-consultas` | local `df15135`, remota `52fb23c` | `git log --left-right` |
| CON-B | en `rayit-cierre-con-b`, **no en main** al empezar (el prompt lo daba como requisito). Entró durante el cierre y se trajo en F5·1 (§1.5) | `git log origin/main..nicolas/CON-B-pantalla` = 15 commits |
| `TODO(ACC-1)` en acciones | ninguno; la convención todavía aceptaba el comentario | `grep` |
| `TODO(ACC-5)` | dos: `conexiones/_lib/permisos.ts:13` y `queries/conexiones.ts:366` | `grep` |

### 0.2 La rama de ACC-6: qué traía cada lado

El prompt decía que la local (8 commits) y la remota (5) **divergían**.
No era así: `git merge-base --is-ancestor origin/… local` es verdadero y
`git log --left-right` no tiene ni un commit del lado remoto. La unión
es la local, que se subió por avance rápido: `52fb23c..df15135`.

| Lado | Commits propios | Qué traía |
|---|---|---|
| Remota (`52fb23c`) | 5 | plan; `membership_scope` + `scope_allows()` + `scopeFilter()` (como `0034_membership_scope.sql`); alcance en 34 funciones; revisión (`ON CONFLICT`); README y propuesta |
| Solo local (+3) | `57f725a`, `d768d10`, `df15135` | la migración pasa a `0035` (0034 era de ACC-3); merge de `origin/main` con ACC-1 y RES-6; límite de tiempo propio para los `describe` de alcance |

La cuenta de 8 contra 5 contaba commits sobre bases distintas: los tres
de más son el merge y los dos que lo rodean.

### 0.3 Cada historia contra su «terminado cuando» (backlog §5)

| Historia | Terminado cuando | Al empezar | Al cerrar |
|---|---|---|---|
| ACC-1 | Cada Server Action nueva abre con su `requirePermission()`; una prueba comprueba que el Mánager no trae `finanzas.flujo.ver` | main y producción | igual; la convención ya **no** acepta `// TODO(ACC-1)` en lugar de la llamada |
| ACC-2 | Crear una factura y conectar una cuenta dejan su fila; una prueba recorre las escrituras de `queries/` y falla si alguna no audita | main y producción | igual; la prueba ya **ve** los `UPDATE tabla alias SET` (antes un alias escondía la escritura) |
| ACC-3 | Migra en limpio y en Supabase; el seed deja los roles | main, Supabase y producción | igual |
| ACC-5 | Con sesión de Contador, `/campanas` responde 404 y no sale en el menú | main y producción | igual |
| ACC-6 (parte de Nicolás) | Un miembro con alcance a un creador no ve las campañas, los deals ni los posts del otro, **en ninguna función exportada** | rama, 185 commits detrás, 34 funciones, migración con número ocupado | **integrada**; 82 funciones que consultan (71 con alcance, 11 declaradas sin él); convención estática; 0040 |
| ACC-8 | El mánager conecta el TikTok del creador: el consentimiento queda a nombre del creador, con el mánager como operador, y le llega la notificación | main y producción | igual, más el caso con alcance en el callback de OAuth |

### 0.4 El plan que se siguió

F0: reconciliar la rama y subirla. F1: merge a esta rama; la migración
pasa a **0040** con solo lo que 0034 no trae. F2: alcance en todas las
funciones, en tres frentes en paralelo (uno por archivo), y la prueba de
convención. F3: pruebas por módulo, más escrituras y `ON CONFLICT`. F4:
deuda, tabla de decisiones y lista para Rasheed. F5: verificación,
PARADA 1 con la 0040, push a main y despliegue.

---

## 1. Lo que se hizo

### 1.1 El merge de `nicolas/ACC-6-alcance-consultas`

`git merge --no-ff`: nueve archivos en conflicto. Se tomó la versión de
main en todos y se reaplicó encima lo de la rama:

| Archivo | Conflicto | Resolución |
|---|---|---|
| `queries/{campanas,finanzas,conexiones}.ts` | main cambió casi todo (CAM-2..6, FIN-2..8, CON-5/7/10, ACC-8) | versión de main; el diff de la rama reaplicado función por función y extendido a las nuevas (§2) |
| `conexiones/_lib/{cuentas-service,oauth-handlers}.ts` | ACC-8 añadió `sin_permiso` en los mismos sitios | main + `ScopeError → "fuera_de_alcance"` en los dos |
| `oauth-handlers.test.ts` | pruebas de ACC-8 | main + la prueba de alcance, reescrita con el rol a medida de ACC-8 (el miembro sí puede conectar; solo el alcance lo para) |
| `packages/db/src/esquema.ts` | 0034 ya declara `membership_scope` en `PRIVILEGIOS_DE_LA_APP` | main + las dos firmas de `scope_allows` en `FUNCIONES_QUE_USA_EL_CODIGO` |
| `packages/db/test/aplicar.test.ts` | la entrada del hueco 0034 ya no hacía falta | main sin la línea del hueco 0040 (el archivo llega) |
| `packages/db/README.md`, `content/backlog.ts` | textos | main + el uso 9 (alcance) y las notas nuevas |

### 1.2 La migración `0040_scope_allows.sql`

Comparada línea a línea con la `0035_membership_scope.sql` de la rama:

| Sección de la 0035 | ¿La trae 0034? | En 0040 |
|---|---|---|
| `CREATE TABLE membership_scope` (mismas columnas, PK, FK compuesta con CASCADE, CHECK) | **sí**, §6 | — |
| RLS `ENABLE`/`FORCE` y la política `membership_scope_read` | **sí**, §6 | — |
| `REVOKE INSERT, UPDATE, DELETE … FROM mc_app` | **sí**, §10 | — |
| índice `campaign_post (post_id)` | no | **sí** |
| `scope_allows(text, uuid)` y `scope_allows(text, uuid[])`, `REVOKE … FROM PUBLIC`, `GRANT EXECUTE` a `mc_app` y `mc_worker` | no | **sí** |

Re-ejecutable (`CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE
FUNCTION`), con cabecera. `alcance-esquema.test.ts` la aplica dos veces
y comprueba que deja lo mismo.

**Convive con el código de producción de hoy**: solo AÑADE un índice y
dos funciones que ese código no llama. El código nuevo sí las llama y
las declara en `FUNCIONES_QUE_USA_EL_CODIGO`, así que la guardia de
producción exige la 0040 **antes** del despliegue: por eso va la PARADA 1.

### 1.3 `scope.ts`

La rama traía `scopeFilter`, `assertScopeAllows` y `ScopeError`. Se
añaden `UNSCOPED_ONLY` y `assertUnscoped()` para lo que es del espacio
entero y no cuelga de nadie (un gasto, la configuración financiera):
solo lo ve y lo toca quien no tiene alcance. Tiene nombre propio para
que se lea como una decisión y no como un olvido.

### 1.4 Deuda resuelta

| Qué | Dónde |
|---|---|
| La convención de ACC-1 aceptaba `// TODO(ACC-1): <permiso>` en vez de la llamada. Ya no hay rama sin catálogo que lo necesite: ahora falla y dice qué llamada poner | `apps/web/lib/permisos/convencion.test.ts`, `README.md` |
| `TODO(ACC-5)` en la doble comprobación de permisos de Conexiones: resuelto (ACC-5 lee la base); el comentario explica por qué se queda la segunda barrera | `conexiones/_lib/permisos.ts`, `queries/conexiones.ts` |
| `audit-convencion` no veía `UPDATE campaign c SET` (con alias): una escritura podía esconderse de la bitácora. Lo encontraron dos de los frentes | `packages/db/test/audit-convencion.test.ts` |
| La huella del arnés de alcance leía como `mc_app` sin workspace: RLS escondía todo y «no escribió ni una fila» comparaba vacío con vacío. Ahora lee como la dueña, incluye `notification` y `audit_log`, y falla si sale vacía | `packages/db/test/alcance.ts` |
| Notas viejas del tablero: ACC-1 («resuelve toda sesión como Dueño»), ACC-3 («falta aplicar 0034»), ACC-8 («Dueño hasta ACC-5») | `content/backlog.ts` |

### 1.5 El segundo merge de `origin/main` (F5·1)

Mientras se cerraba ACC entraron CON-B (la tabla de Conexiones de CON-4)
y WRK (`--once`). Tres conflictos, resueltos a favor de main con el
alcance encima (commit `062a9fa`):

| Archivo | Resolución |
|---|---|
| `queries/conexiones.ts` | `listAccounts` de CON-B (con el LATERAL de huecos de CON-7) + `SCOPE_CONNECTION` en su WHERE |
| `conexiones/_lib/messages.ts` | los textos de CON-B y el bloque `alcance` |
| `conexiones/page.tsx` | la página de CON-B pidiendo también `service.alcance()`; `TablaDeCuentas` recibe `fueraDeAlcance` y cambia su vacío por la frase |

**La convención mordió sola:** `alcance-convencion.test.ts` señaló la
función nueva de CON-B, `getMetricRequirement`. Es un catálogo global
sin `workspace_id` (0024 §7.1), así que fue a la lista sin alcance con
su motivo. Justo para esto se escribió la prueba.

### 1.6 El tercer merge de `origin/main` (CON-C)

Luego entró CON-C (CON-8 OAuth de YouTube y CON-12 proveedor de TikTok),
con dos arreglos de pruebas que dependían del reloj: la bandeja de FIN-4
(`d94e18a`) y la ficha de CAM (`e9e84e1`, lo mismo que había arreglado
esta rama en `d3c116b`). Cinco conflictos, resueltos a favor de main
con el alcance encima (commit `f379cb9`). El upsert de `addPublicAccount`
de CON-12 lleva el filtro en su `DO UPDATE`, y `findPublicAccountByHandle`
(ahora también encuentra cuentas de proveedor) sigue lanzando
`ScopeError`. **La convención volvió a morder**: señaló
`setAccountAccessMode` (CON-12), que es una escritura y ahora lleva alcance.

---

## 2. Inventario del alcance: cada función exportada

`packages/db/test/alcance-convencion.test.ts` genera esta lista del
código. Una función que consulta la base tiene que componer `SCOPE_*`,
llamar a `assertScopeAllows()`/`assertUnscoped()`, usar `UNSCOPED_ONLY`
o llamar a otra función del archivo que lo haga. Si no, tiene que estar
en `SIN_ALCANCE_DECLARADAS` con su motivo. Las marcadas «sin» son las
once de esa lista.

### 2.1 `queries/campanas.ts`, `campanas/reporte.ts` y `campanas/reporte-publico.ts` (29 con consulta + 1 pura; `brandNoDataReasonFor` e `isBrandSnapshotDue` son reexportaciones de core)

| Función | Alcance |
|---|---|
| `listCampaigns`, `getCampaign`, `updateCampaign`, `transitionCampaign` | `SCOPE_CAMPAIGN` (creator `c.creator_id`, company `c.company_id`, campaign `c.id`); los UPDATE con `EXISTS` sobre la campaña filtrada |
| `listCampaignPosts`, `listLinkablePosts`, `suggestPosts`, `linkPost`, `unlinkPost`, `setPrimaryPost` | la campaña filtrada y `scopePost()` (creator del post; marca y campaña por el ARRAY de sus campañas); quitar o marcar como principal exige también el post en el alcance |
| `createCampaignFromQuote` | la cotización con creadora y marca en alcance; si su campaña viva cae fuera, `ScopeError` |
| `addBrandInput`, `openBrandCsvImport`, `importBrandCsv`, `listBrandInputs` | por `lockEditableCampaign`/`campaignDatesAndCurrency`, filtradas: `CampaignNotFoundError` antes de escribir |
| `getResultInputs`, `upsertResult`, `computeCampaignResult`, `getCampaignResult` | por la campaña (el `INSERT … SELECT FROM campaign c` no inserta fuera del alcance) |
| `listBrandFollowers`, `brandPlatformsReadOn`, `recordBrandSnapshot` | por la campaña; `recordBrandSnapshot` la usan la web y el worker (al worker le deja pasar: sin persona) |
| `listCampaignReports`, `getReport`, `generateReport`, `markReportSent` | `JOIN campaign c` con `SCOPE_CAMPAIGN`; los UPDATE de `report`, también |
| `listCampaignsToCompute` | **sin**: solo el worker (`campaign-compute.ts`) |
| `canRecomputeResult` | **sin**: pregunta por un privilegio de `mc_app`, no lee filas |
| `readPublicReport` (`reporte-publico.ts`) | **sin**: lectura pública por slug, sin persona |
| `brandAccountsOf`, `brandNoDataReasonFor`, `isBrandSnapshotDue` | puras |

### 2.2 `queries/finanzas.ts` (31 con consulta + 2 puras)

| Función | Alcance |
|---|---|
| `listInvoices`, `getInvoice`, `transitionInvoice`, `listReminders` | `SCOPE_INVOICE` (creadora por la campaña; sin campaña, fuera de todo alcance por creadora) |
| `countLiveInvoicesInCurrency` | `SCOPE_INVOICE` (la llama la página de Configuración) |
| `listReceivables`, `getReceivablesKpis` | `SCOPE_RECEIVABLE`, pagos por `SCOPE_PAYMENT`, reserva por `SCOPE_TAX_RESERVE` |
| `listCompanies` | `SCOPE_COMPANY_LINK` (marcas con campaña de la creadora/campaña del alcance) |
| `listCampaignsForInvoice`, `createInvoiceFromCampaign` | `SCOPE_CAMPAIGN` |
| `createInvoice` | empresa, campaña y cotización filtradas; `assertScopeAllows` antes del INSERT |
| `recordPayment`, `getPayment`, `listPayments` | por su factura (`FOR UPDATE OF i` con `SCOPE_INVOICE`) |
| `markReminderSent` | `SCOPE_REMINDER` (EXISTS sobre la factura); fuera, `false` |
| `getCashflowInputs` | facturas `SCOPE_INVOICE`, negocios `SCOPE_DEAL`, gastos `UNSCOPED_ONLY`, pagos de plataforma `SCOPE_PAYOUT` |
| `listPlatformPayouts`, `getPlatformPayoutMonths`, `getPlatformPayoutKpis` | `SCOPE_PAYOUT` (solo creadora; marca y campaña `null`) |
| `importPlatformPayouts`, `createPlatformPayout` | `assertScopeAllows({creator, company: null, campaign: null})` por creadora del lote |
| `getExpense`, `getExpenseMonth` | `UNSCOPED_ONLY` |
| `createExpense`, `updateExpense`, `updateFinanceSettings` | `assertUnscoped` antes de escribir |
| `getReserveState`, `getFinanceSettings`, `listPayoutPlatforms`, `getWorkspaceToday` | **sin**: configuración o catálogo del espacio |
| `countInvoicesInOtherCurrency` | **sin**: solo la llama `updateFinanceSettings`, después de `assertUnscoped` |
| `receivablesSearchTerm`, `bloqueParaBitacora` | puras |

### 2.3 `queries/conexiones.ts` (22 con consulta + 1 pura)

| Función | Alcance |
|---|---|
| `listConnections`, `findConnectionByAccount`, `listAccounts` | cuenta: creator `c.creator_id`; marca y campaña `null` (una cuenta no es de una marca) |
| `findPublicAccountByHandle` | solo la usa el callback de OAuth, que escribe: si la fila por @ es de un creador fuera del alcance, `ScopeError` (con `null`, el callback duplicaría la cuenta) |
| `getConsentCreator`, `getDefaultCreatorId` | el primer perfil de creador **del alcance**; si el espacio tiene creadores pero ninguno en el alcance, `ScopeError` (no «no hay creador»); si no tiene ninguno, `NoCreatorProfile` |
| `getConnectionCreator`, `disconnectConnection`, `recordAccountSnapshot`, `markAccountLookupFailure` | cuenta filtrada; fuera, `ConnectionNotFound` o `false` |
| `listConsents`, `recordConsent`, `getAccountAudience`, `listAccountAudience` | por la cuenta |
| `upsertConnection`, `addPublicAccount`, `upgradePublicAccountToOAuth` | si la cuenta ya es de otra creadora fuera del alcance, `ScopeError` **antes** de escribir; el `ON CONFLICT DO UPDATE` lleva el filtro como segunda barrera |
| `notifyConnectionAdded` | solo una cuenta viva que el alcance ve; si no, `false` sin fila |
| `getSessionMember`, `sessionHasPermission` | **sin**: identidad y permiso de quien pregunta, no datos de un creador |
| `getMetricRequirement` (CON-B) | **sin**: catálogo global de prerrequisitos, sin workspace |
| `setAccountAccessMode` (CON-12) | `SCOPE_CONNECTION` en el UPDATE: fuera del alcance, `false` sin tocar la fila |
| `publicSecretRef` | pura |

### 2.4 El worker

`mc_worker` **no** filtra por alcance: un job no es una persona. Dos
pruebas lo sostienen:

- `alcance-esquema.test.ts`: con `asWorker`, `scope_allows()` devuelve
  verdadero.
- `alcance-convencion.test.ts`: ningún archivo de `apps/worker/src`
  compone el alcance ni lee `membership_scope`.

Lo que escribe un job, la web lo filtra al leerlo. Está dicho en
`apps/worker/README.md` y en el README de `@mc/db` (uso 9).

---

## 3. Costuras

| Contrato | Con | Prueba |
|---|---|---|
| La 0040 da `scope_allows()` sobre la tabla de 0034 (sin 0035 de por medio) | ACC-3 | `alcance-esquema.test.ts` (14): RLS y privilegios de 0034, semántica, re-aplicar 0040 |
| Toda función de Campañas/Finanzas/Conexiones pasa por el alcance | ACC-6 | `alcance-convencion.test.ts` (estática) + `alcance-{campanas,finanzas,conexiones}.test.ts` (comportamiento, con control de la dueña) |
| Un miembro acotado que autoriza por OAuth una cuenta ya conectada a otra creadora vuelve con `?error=fuera_de_alcance` y la fila no cambia | CON-3 / ACC-8 | `oauth-handlers.test.ts` «alcance (ACC-6)» |
| Agregar por @ una cuenta de otra creadora: `fuera_de_alcance` con su frase | CON-10 | `alcance-conexiones.test.ts` (`addPublicAccount` rechaza con `ScopeError`) + `cuentas-service.ts` |
| Permiso y alcance son capas distintas: `sessionHasPermission` no mira el alcance | ACC-5 / ACC-8 | `alcance-conexiones.test.ts` (prueba propia) |
| El worker calcula con todos los posts; la web lee filtrado | CAM-5 / WRK | `alcance-convencion.test.ts` (worker) + `campaign-compute.test.ts` |
| Los KPI y el flujo de caja de un miembro acotado suman lo que ve su lista, nada más | FIN-3 / FIN-6 | `alcance-finanzas.test.ts` (KPI, flujo y pagos de plataforma con montos exactos) |
| Sin filas de alcance, nada cambia | todo el producto | las suites de cada módulo, sin tocar, en verde (§6) |

Hoy ninguna pantalla depende de algo apagado por el alcance: sin filas,
nadie ve menos. La pantalla que escribe el alcance es de ACC-4.

---

## 4. Decisiones pendientes de Nicolás

En todas quedó en el código la opción conservadora. «Si dices lo
contrario» indica el archivo y el tamaño del cambio.

| # | Dónde | Pregunta | En el código | Recomiendo | Si dices lo contrario |
|---|---|---|---|---|---|
| 1 | `ACC-1.md:72` | ¿Módulo `cuenta` aparte para lo que solo tiene el Dueño? | `equipo.workspace.configurar` | Dejarlo | Renombrar en `core/permisos.ts` + migración nueva que corrija `permission`/`role_permission` (la semilla viaja en 0034) · M |
| 2 | `ACC-1.md:100` | ¿El Mánager de creador ve facturas (`finanzas.factura.ver`) o solo el cobro? | solo `finanzas.cobro.ver` | Dejarlo hasta tener alcance en uso: con alcance por creadora, las facturas sin campaña se le ocultan igual (#13) | Una línea de la matriz en `permisos.ts` + migración `role_permission` · S |
| 3 | `ACC-1.md:105` | ¿«Actualizar» una cuenta por @ basta con `conexiones.cuenta.ver`? | exige `conexiones.cuenta.conectar` (gasta cuota) | Dejarlo | Una línea en `conexiones/actions.ts` y la doble comprobación de `cuentas-service.ts` · S |
| 4 | `ACC-1.md:120` | Permiso mínimo de Finanzas: `factura.ver` o `cobro.ver` | `finanzas.factura.ver`: el Mánager no abre `/finanzas` | Pasar a `cobro.ver` cuando alguien tenga alcance de verdad: `/finanzas` es hoy la pantalla de cobro (FIN-3) | `PERMISO_MINIMO` en `permisos.ts` + la prueba de ACC-5 del Mánager · S |
| 5 | `ACC-1.md:154` | `SinPermisoError` en una Server Action: ¿frontera del segmento o mensaje en el formulario? | frontera (`error.tsx`) | (b) mensaje en el formulario cuando haya roles reales en el piloto | `messageOf` de cada módulo + la convención pasa a «primera línea del try» · S por módulo |
| 6 | `ACC-2.md:116` | Dependencia `@mc/db → @mc/connectors` para reutilizar `redactSecrets` | tomada | Dejarla | Mover `redact.ts` a `@mc/core` y reexportar · un commit |
| 7 | `ACC-2.md:239` | ¿`audit.ts` pasa a la columna de Rasheed? | Nicolás | Dejarlo con Nicolás | Una línea del backlog |
| 8 | `ACC-3.md:88` | `admin` de un workspace de creador: ¿Dueño o Mánager? | Mánager (el relleno nunca sube a nadie); hoy no hay filas `admin` | Dejarlo | Una línea del `CASE` de 0034 §5; como ya está aplicada, sería una migración nueva · S |
| 9 | `ACC-3.md:239` | `0023`: ¿hueco declarado o archivo vacío? | hueco declarado (`aplicar.test.ts`) | Hueco: un 0023 nuevo se aplicaría fuera de orden detrás de 0041 | `0023_reservada.sql` vacío + quitar la línea · S |
| 10 | `ACC-5.md:360` | La portada del plan (`/`) enlaza todos los módulos a cualquiera | visible para todos | Sacar «Plan», «Cimientos» y «Reglas» del marco de quien no es del equipo antes del piloto | `nav.tsx` + un permiso o una lista del equipo · S |
| 11 | `ACC-8.md:98` | `ipHash` = `sha256(ip)` sin sal | resumida | Dejarlo | Volver a la IP en claro: una línea en `consent.ts` |
| 12 | `ACC-8.md:158` | Andrés conectando el Instagram de Laura en la demo pública | en el seed | Dejarlo | Quitar el bloque delimitado del seed |
| 13 | `ACC-6.md:376` | Factura sin campaña bajo alcance por creadora | se oculta | Dejarlo (las históricas del seed no tienen campaña: un mánager acotado no las verá) | `SCOPE_INVOICE` en `finanzas.ts`: el ancla `creator` pasaría a `coalesce(ca.creator_id, <creador del workspace>)` · S |
| 14 | `ACC-6.md:380` | Post sin campaña bajo alcance por marca o campaña | se oculta | Dejarlo; revisarlo en AGE-4 | `scopePost()` en `campanas.ts` · S |
| 15 | `ACC-6.md:383` | Entre tipos: ¿intersección o unión? | intersección | Dejarlo | `scopeFilter()` unir con `OR` en vez de `AND` · S, pero cambia todas las pruebas de alcance |
| 16 | `ACC-6.md` §0.3 D3 | Cuentas y perfiles de creador con alcance por marca o campaña | se ocultan (no hay camino de una cuenta a una marca) | Dejarlo | `SCOPE_CONNECTION` con `company`/`campaign` a un ARRAY de las campañas de la creadora · S |
| 17 | `finanzas.ts` (`UNSCOPED_ONLY`) | Gastos y configuración financiera para quien tiene alcance | no los ve ni los toca | Dejarlo: un gasto no es de nadie | Cambiar `UNSCOPED_ONLY`/`assertUnscoped` en cuatro funciones · S |
| 18 | `finanzas.ts` (`SCOPE_PAYOUT`) | Ingresos de plataforma con alcance por marca o campaña | se ocultan (solo tienen creadora) | Dejarlo | `company`/`campaign` de `SCOPE_PAYOUT` · S |
| 19 | `finanzas.ts` (`SCOPE_DEAL`) | Un negocio en el flujo de caja con alcance por campaña | se ve si alguna campaña salió de él (hay camino real, como `company_link`) | Dejarlo | ancla `campaign: null` · una línea |
| 20 | `reporte.ts` (`generateReport`) | Reporte generado por alguien con alcance por creadora: ¿incluye posts de otra creadora asociados a la campaña? | no: enseña lo que ve quien lo genera | Dejarlo (en el MVP una campaña es de una creadora) | `generateReport` leería los posts sin `scopePost` · S |

---

## 5. Lo que necesita Rasheed (antes de ACC-4 y ACC-7)

| # | Qué | Archivos | Tamaño |
|---|---|---|---|
| 1 | `requirePermission()` como primera línea de sus Server Actions, con el permiso que ya les asigna `ACC-1.md` §4; y añadir sus módulos a `MODULOS_CON_CONVENCION` | `app/(app)/ventas/actions.ts` (12 acciones), `app/(app)/cotizar/actions.ts` (14), `app/(app)/resumen/importar/actions.ts` (1); `lib/permisos/convencion.test.ts` | M |
| 2 | Puerta en cada página (`requireModuleAccess`/`requirePagePermission`) y añadir sus módulos a `MODULOS_CON_PUERTA_EN_PAGINA` | Resumen: `(panel)/page.tsx`, `importar/page.tsx`. Ventas: `(inicio)`, `empresas/(lista)`, `empresas/nueva`, `empresas/[id]/(ficha)`. Cotizar: `(tarifario)`, `media-kit/(lista)`, `media-kit/[id]/(detalle)`, `cotizaciones/(lista)`, `cotizaciones/nueva`, `cotizaciones/[id]/(detalle)`, `…/editar`, `…/vista`; `lib/permisos/paginas.test.ts` | M |
| 3 | Visto bueno a los tres `layout.tsx` que ACC-5 escribió en sus carpetas (idénticos a los de Nicolás) | `app/(app)/{resumen,ventas,cotizar}/layout.tsx` | S |
| 4 | Alcance en sus consultas: el arnés sirve tal cual (`test/alcance.ts`, con `sembrarExtra`); un `test/alcance-<modulo>.test.ts` por módulo y sus archivos en `ARCHIVOS` de `alcance-convencion.test.ts` | `queries/ventas.ts` (26 exportadas), `queries/cotizar/*.ts` (48, incluida `campana.ts`), `queries/resumen.ts` (12) | L |
| 5 | Seed: no hay Contador. El Mánager sí (Andrés, seed 0003, rol de fábrica `manager`, ACC-8). Una Contadora de demo deja probar ACC-5 en la copia sin llaves | `db/seed/` | S |
| 6 | ACC-4 escribe `membership_scope`: necesita sus políticas de INSERT/DELETE (hoy `mc_app` solo lee, 0034 §10) y cambiar `PRIVILEGIOS_DE_LA_APP` | una migración suya + `esquema.ts` | M |
| 7 | Cotizar llama a `createCampaignFromQuote` (CAM-2), que ahora filtra la cotización por alcance: con alcance por campaña, «Crear campaña» da «la cotización no existe» sobre una cotización que Cotizar sí enseña, y `codigoDe()` no conoce `ScopeError` (cae al mensaje genérico). Se arregla al acotar Cotizar (#4) y reconociendo `ScopeError` en `codigoDe` | `app/(app)/cotizar/actions.ts` (`codigoDe`, `crearCampanaConVentana`) | S |
| 8 | ACC-7: la política por creador puede ser `CREATE POLICY … AS RESTRICTIVE USING (scope_allows('creator', creator_id))`. `invoice` no tiene `creator_id` (llega por `campaign`), y una restrictiva también filtra los `ON CONFLICT DO UPDATE` | su migración | M |

---

## 6. Verificación

### 6.1 Pruebas, build y esquema (sobre `f379cb9`, con `origin/main` = `7ef8e2b` dentro)

| Qué | Resultado |
|---|---|
| `pnpm verificar` (typecheck, lint y test de todo) | typecheck y lint limpios en los cinco paquetes. Pruebas: `@mc/core` 267/267 · `@mc/connectors` 234/234 · raíz 8/8 · `@mc/db` **1037/1037** · `@mc/web` **1268/1268** + 1 todo (corrida aparte: turbo canceló la web cuando falló el worker) · `@mc/worker` 147/150 (abajo) |
| Las 3 rojas del worker | **No son de este cierre.** Dos son `costuras-con.test.ts` «las 16 líneas base y los 59 puntajes son los mismos que calcula db/seed/0002» (CON-A): pasada la medianoche UTC (00:20–00:40 UTC del 24-sep, 19:20 en Bogotá) las medianas de `completion` y `skip_3s` del seed y las de CON-6 difieren. **Falla igual en `origin/main`** (lo corrí en un worktree desprendido de `7ef8e2b`: 10/11, el mismo caso). La tercera, `oauth-refresh.test.ts` «el reintento solo toca lo que quedó pendiente (flaky)», es de carga: sola pasa 6/6 dos veces seguidas |
| Pruebas de alcance | `alcance-esquema` 15 · `alcance-campanas` 64 · `alcance-finanzas` 75 · `alcance-conexiones` 54 · `alcance-convencion` 8, dentro de las 1037 de `@mc/db`; web: el caso de OAuth, las frases de Gastos, Ingresos y Conexiones |
| Que muerden | quitando el filtro de `getPayment`, `getReport`, `listConsents`, `notifyConnectionAdded`, `getConsentCreator`, `markAccountLookupFailure` y `unlinkPost` (uno por vez), su prueba falla con el nombre de la función; la convención señaló sola `getMetricRequirement` (CON-B) y `setAccountAccessMode` (CON-12) al traer main |
| `next build` | en verde |
| `make db.check` | 40 migraciones en limpio (0040 antes que 0041), 98 tablas, 10 vistas, 252 índices |
| Guardia contra Supabase (solo lectura, código de esta rama) | **roja, como debe**: «faltan 0040_scope_allows.sql y 0041_campaign_result_escritura_web.sql; faltan scope_allows(text,uuid) y scope_allows(text,uuid[])». Por eso la PARADA 1 |
| Supabase (solo lectura, `make db.sql`) | última aplicada 0039 · `scope_allows` no existe · índice `campaign_post_post_id_idx` no existe · `membership_scope` con 0 filas |

### 6.2 En dev

Postgres embebido con un seed **temporal y sin commitear** (las dos
creadoras del arnés y el miembro acotado a Laura, con rol Dueño para que
abra todo) y un parche local de dos líneas en `lib/workspace/current.ts`
para que `DEMO_USER_ID` fije también la identidad de la transacción (lo
que ACC-6.md §4.3 propone a Rasheed). Dos servidores: :3186 como el
miembro y :3187 como la dueña. El seed y el parche se quitaron al terminar.

| Pantalla | Miembro (alcance: Laura) | Dueña (sin alcance) |
|---|---|---|
| `/campanas` | 200, sin «Playa con Marca de Sofía» (la primera respuesta de dev trae el texto del seed en el payload de depuración, como anotó la rama; la segunda, cero menciones) | 200, con ella |
| `/campanas/<campaña de Sofía>` | la página de no encontrado (`NEXT_HTTP_ERROR_FALLBACK;404`; el código es 200 porque la ruta tiene `loading.tsx` y el estado ya salió, igual que con un id de otro workspace) | la ficha |
| `/finanzas`, `/finanzas/facturas` | 200, sin FV-2026-901 ni «Marca de Sofía» | 200, con las dos |
| `/finanzas/facturas/<factura de Sofía>` | **404** | 200 |
| `/conexiones` | 200, sin @sofia.viaja | 200, con @sofia.viaja (11 menciones) |
| `/finanzas/{gastos,ingresos,flujo,configuracion}` | 200 las cuatro | 200 las cuatro |
| `/conexiones?error=fuera_de_alcance` | la frase, en su recuadro de error | — |

Capturas a **390 px** (DevTools con `Emulation.setDeviceMetricsOverride`,
porque Chrome sin cabeza no baja de 500) en **claro y oscuro**
(`mc.theme` en localStorage) de `/conexiones?error=fuera_de_alcance` y de
`/finanzas` como el miembro: el recuadro de error y los KPI se leen en
los dos temas y nada se sale de la columna.

### 6.3 Revisión (`/code-review`, nivel alto)

| # | Hallazgo | Resolución |
|---|---|---|
| 1 | `unlinkPost`, `setPrimaryPost` y `linkPost(isPrimary)` miraban el alcance de la campaña y no el del post: se podía quitar un enlace que la ficha no enseña | **Arreglado**: los dos exigen el post en el alcance; prueba en `alcance-campanas` (el miembro recibe `false` y el enlace sigue). Desmarcar el principal anterior sí toca un post oculto: «un solo principal» es de la campaña, que sí se ve (comentado) |
| 2 | Con alcance por marca, un post sin campaña no se ve ni se asocia | **Justificado**: decisión #14 de §4 (se oculta: la opción conservadora) |
| 3 | Con alcance por marca o campaña, «Agregar» y el arranque de OAuth decían «el espacio no tiene perfil de creador» | **Arreglado**: `getConsentCreator` lanza `ScopeError` si hay creadores y ninguno en el alcance; el arranque lo traduce a `fuera_de_alcance` y no va a la plataforma (prueba en `oauth-handlers.test.ts`) |
| 4 | «Agregar» gastaba la lectura pública (cuota de la casa) antes de comprobar el alcance | **Arreglado**: el control previo comprueba creador y @ en el alcance antes de llamar a la plataforma |
| 5 | Con `findPublicAccountByHandle` filtrado, el callback de OAuth podía duplicar una cuenta por @ de un creador fuera del alcance | **Arreglado**: lanza `ScopeError` en vez de `null` (prueba del caso en `alcance-conexiones`) |
| 6 | Cotizar no está acotado y `codigoDe()` no conoce `ScopeError` | **Justificado**: carpeta de Rasheed; en §5 #7 |
| 7 | Gastos leía el mes y el flujo antes de saber que no los iba a pintar | **Arreglado**: pregunta el alcance primero |
| 8 | Conexiones abría dos transacciones seguidas | **Arreglado**: en paralelo, con `Promise.all` |
| 9 | Los `UPDATE` sin alias (para la convención de ACC-2) ya no hacían falta | **Arreglado**: con alias y el filtro directo; fuera los comentarios que decían lo contrario |
| 10 | El JSDoc de Gastos quedó desplazado en `messages.ts` | **Arreglado** |

### 6.4 Revisión de seguridad (`/security-review`)

Sin hallazgos de confianza alta. Revisado y descartado:

- **Inyección SQL en `scopeFilter()`**: las anclas y el `kind` son
  literales del módulo; todo valor va por `$n`.
- **`scope_allows()`**: `SECURITY INVOKER`, sin `EXECUTE` para `PUBLIC`,
  sin `SECURITY DEFINER` ni GRANT de escritura.
- **Las ramas `ON CONFLICT`**: filtradas, y además rechazadas antes con
  `ScopeError`.
- **Las escrituras de seguimiento**: detrás de una lectura con alcance y
  `FOR UPDATE`.
- **Secretos**: ninguno en URLs ni en los mensajes nuevos.

Anotado por debajo del umbral:

- `getConsentCreator` revela que existe *algún* creador fuera del
  alcance, nunca cuál.
- El `before` de la bitácora de `linkPost`/`setPrimaryPost` puede
  nombrar el id del principal anterior aunque esté oculto. La bitácora no
  la lee la persona acotada.

## 7. Producción y guion de humo

### 7.1 PARADA 1 · migración `0040_scope_allows.sql`

| | |
|---|---|
| Qué hace | Crea el índice `campaign_post_post_id_idx` y las funciones `scope_allows(text, uuid)` y `scope_allows(text, uuid[])` (`LANGUAGE sql STABLE`, `SECURITY INVOKER`), sin `EXECUTE` para `PUBLIC`, con `EXECUTE` para `mc_app` y `mc_worker` |
| Por qué | El código de esta rama compone `scope_allows()` en todas las consultas de Campañas, Finanzas y Conexiones y la declara en `FUNCIONES_QUE_USA_EL_CODIGO`: sin ella la guardia no deja desplegar y las pantallas fallarían al primer clic |
| Por qué convive con el código de producción de hoy | Solo AÑADE: un índice (no cambia ninguna consulta vieja) y dos funciones que el código de hoy no llama. No toca tablas, políticas ni privilegios. `membership_scope` sigue vacía, así que cuando llegue el código nuevo nadie ve menos |
| Qué más aplica el mismo comando | La **0041** de CAM (`GRANT INSERT, UPDATE` en `campaign_result` a `mc_app` con políticas restrictivas), que está en main desde el cierre de CAM y sigue sin aplicar. Convive igual: solo añade privilegios que el código de hoy ya espera («Recalcular») |
| Re-ejecutable | `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, REVOKE/GRANT idempotentes; `alcance-esquema.test.ts` la aplica dos veces |
| Comando | `cd /Users/nicolasduarte/Documents/influ/rayit/platform && make db.migrate` |
| Después | `make db.guardia` desde el clon principal y me pegas CONTINUAR-DESPLIEGUE |

**Aplicada el 24-sep (00:5x UTC)** desde este worktree (el clon
principal está en `29460e3` y no tiene la 0040), con el mismo comando
del Makefile y las credenciales de `rayit/platform/.env.local`:
`✓ 0040_scope_allows.sql (421 ms)`, `✓ 0041_campaign_result_escritura_web.sql
(340 ms)`, «2 migración(es) nueva(s). Esquema: 98 tablas, 10 vistas, 252
índices». Producción, todavía con el código anterior, siguió en 200.

### 7.2 El despliegue

| Paso | Resultado |
|---|---|
| `git fetch` + merge de `origin/main` | main seguía en `7ef8e2b`: nada nuevo, no hubo que volver a verificar |
| `git push origin HEAD:main` | avance rápido `7ef8e2b..af1acee` |
| Plan B (producción anterior) | `https://on-cue-ils7qhmu5-influ3.vercel.app` (CON-C, `58fb163`). Para volver: `./scripts/vercel.sh run rollback https://on-cue-ils7qhmu5-influ3.vercel.app --yes` desde `rayit-deploy/platform`. **Ojo:** ese código no llama a `scope_allows()`, así que convive con la 0040 |
| Despliegue | desde `rayit-deploy` (detached en `af1acee`): `https://on-cue-3qosxbrqg-influ3.vercel.app`, alias `on-cue-web.vercel.app` |
| API de Vercel | `/v13/deployments/dpl_8K3jiLnyTfkXeDh914QYCRbKpXf8`: `gitCommitSha af1aceee…`, `readyState READY`, `target production`; el alias `on-cue-web.vercel.app` → `dpl_8K3jiLnyTfkXeDh914QYCRbKpXf8` |
| Rutas | 200 en `/`, `/login`, `/campanas`, `/campanas/<Café Alma>`, `/finanzas`, `/finanzas/facturas`, `/finanzas/facturas/nueva`, `/finanzas/gastos`, `/finanzas/flujo`, `/finanzas/ingresos`, `…/importar`, `…/nuevo`, `/finanzas/configuracion`, `/conexiones`, `/conexiones?error=fuera_de_alcance`, `/accesos`, `/resumen`, `/ventas`, `/cotizar`. Las públicas con un slug que no existe, 404: `/reporte/…`, `/cotizacion/…`, `/kit/…`. **Ninguna en 500.** Las pantallas pintan su título real, no la frontera de error |
| Guardia | «Guardia en verde: 40 migraciones (la última, 0041_campaign_result_escritura_web.sql), 83 tablas aisladas, nada sin declarar». Corrida desde `rayit-deploy` (el código desplegado). Desde el clon principal sale roja porque ese código (`29460e3`) no conoce 0034; está anotado desde el cierre de CON-A |
| `make db.sql` (solo lectura) | última `0041_campaign_result_escritura_web.sql` · `membership_scope` con 0 filas · `mc_app` ejecuta las dos firmas de `scope_allows` · `anon` no |

### 7.3 Guion de humo (para Nicolás, con su sesión en producción)

Hoy nadie tiene filas de alcance, así que **todo tiene que verse igual
que antes del despliegue**. Lo que se prueba es que el filtro nuevo no
esconde nada a quien no tiene alcance, y que las escrituras que cambiaron
siguen funcionando. Solo los pasos 7 y 8 escriben en la base real.

| # | Pantalla | Qué hacer | Qué tienes que ver | ¿Escribe? |
|---|---|---|---|---|
| 1 | `/campanas` | Abrir | las mismas campañas y cifras de siempre | no |
| 2 | La ficha de una campaña con posts | Abrir | los posts asociados con sus views, el resultado y las facturas | no |
| 3 | `/finanzas` | Abrir | los cuatro KPI y las cuentas por cobrar de siempre, sin cambios | no |
| 4 | `/finanzas/gastos` | Abrir | los gastos del mes y la proyección. **No** la frase «Los gastos no están en tu alcance» | no |
| 5 | `/finanzas/ingresos` y `/finanzas/flujo` | Abrir | lo de siempre; si Ingresos está vacío, «Todavía no hay ingresos…», **no** la frase de alcance | no |
| 6 | `/conexiones` | Abrir | tus cuentas, incluida @selvathegolden; **no** «Las cuentas conectadas no están en tu alcance» | no |
| 7 | La ficha de una campaña **tuya de prueba** | «Editar seguimiento», cambiar el código y guardar; luego dejarlo como estaba | se guarda y la ficha lo enseña (prueba el `UPDATE campaign c` nuevo con alcance) | **sí**: `campaign` y dos filas de `audit_log` |
| 8 | Esa misma ficha, si tiene dos posts | «Marcar principal» en el otro post y volver | cambia la pastilla «Principal» (prueba `setPrimaryPost`, que ahora exige el post en el alcance) | **sí**: `campaign_post` y `audit_log` |
| 9 | `/conexiones?error=fuera_de_alcance` | Abrir | la frase «Tu acceso a este espacio no alcanza a ese creador o a esa cuenta…» | no |

Si algo de 1 a 6 sale vacío o distinto, es el alcance: vuelve al plan B
de §7.2 y avísame.

## 8. Fuera de alcance, con su historia

| Qué | Por qué | Historia |
|---|---|---|
| La pantalla que asigna alcance | fuera del prompt | ACC-4 (Rasheed) |
| Alcance en Ventas, Cotizar y Resumen | carpetas de Rasheed | ACC-6, parte de Rasheed (§5.4) |
| RLS por creador | endurecimiento | ACC-7 |
| Roles a medida | | ACC-9 |
| `costuras-con.test.ts` (worker): las líneas base de CON-6 difieren del seed entre las 00:00 y las 05:00 UTC (medianas de `completion` y `skip_3s`); falla igual en main | es del módulo CON-A, no de accesos; se ve en §6.1 | CON-A (siguiente pasada) |
| `recordConsent` no comprueba que `creatorId` sea la creadora de la cuenta; `notifyConnectionAdded` no comprueba que `userId` sea su titular | hoy los llamadores lo derivan en el servidor (`getConsentCreator`/`getConnectionCreator`), así que no es explotable. Es endurecimiento de ACC-8, no de alcance | ACC-8 (siguiente pasada) |
