# Revisión de Nicolás a la fase 9 de Rasheed (`rasheed/integracion`, 9-oct-2026)

Escrito para: Rasheed (qué se aprobó y con qué cambios) y para quien
mezcle `rasheed/integracion` en `main`.

Revisado: `origin/rasheed/integracion` en `1b7777a0` (7-oct) contra
`origin/main` en `50145b34`. Base de la revisión: `docs/fases-rasheed.md`
§9 y §10, `docs/propuestas/CIERRE-ACC.md` §7bis y
`docs/propuestas/CIM-12.md`. Tres revisores leyeron los diffs completos
de las carpetas de Nicolás (uno por historia); `pnpm verificar` corrió
entero sobre la rama en un worktree limpio.

## Veredicto

**Rasheed puede mezclar `integracion` en `main`.** Las cinco historias
que tocan archivos de Nicolás quedan APROBADAS, con cuatro cambios
pequeños que se hicieron en esta misma revisión (rama
`nicolas/revision-fase-9`, que nace de `1b7777a0`), y una prueba de la
rama que estaba roja y se arregló.

## 0. Lo que `pnpm verificar` dijo de la rama tal cual (1b7777a0)

14 de 15 tareas en verde: raíz, `@mc/core` 547, `@mc/connectors` 304,
`@mc/worker` 440, `@mc/web` 2 176 (+1 todo); `@mc/db` **1 628 con 2
rojas** en `test/ids-sin-contador.test.ts`: «se aplica la migración de
CIM-11 y nada más» y «faltan 1 migración(es)». Causa: la 0084 del 7-oct
(VEN-17) quedó DETRÁS de la 0083 y la prueba asumía que la de CIM-11 era
la última. Arreglado en esta rama: la prueba exige exactamente las
migraciones desde la de CIM-11 hasta la última (hoy 0083 y 0084) y el
conteo en el mensaje de la guardia.

## 1. ACC-4 · pantalla Equipo (CIERRE-ACC §7bis)

| Archivo | Qué cambia | Prueba | Veredicto |
|---|---|---|---|
| `packages/db/src/queries/accesos.ts` | `getSessionPermissions` lee `session_permission_keys()` (0078) en vez de su JOIN; con `extra_permissions = '{}'` (todas las filas de hoy) el resultado es idéntico; la función no es SECURITY DEFINER, así que la RLS es la misma; el CHECK de 0078 limita las casillas a 5 claves, ninguna de Campañas ni de Equipo | `accesos-sesion.test.ts` (8 casos intactos), `equipo.test.ts:225` | **APRUEBO**. Condición operativa: 0078–0080 aplicadas ANTES del deploy, si no `permisosDeLaSesion` cae en toda sesión |
| `packages/db/src/queries/conexiones.ts` | `sessionHasPermission` igual que arriba (ACC-8 sigue preguntando lo mismo) | `equipo.test.ts:231` | **APRUEBO** |
| `packages/core/src/permisos.ts` | `permisosQueFaltan` como única regla; `permisosOtorgables` y `puedeAsignarRol` salen de ella con el mismo resultado; `ROLE_KEYS` | `core/test/permisos.test.ts:209,223`; la matriz no cambia (el Contador sigue sin Campañas) | **APRUEBO** (nota: `schema/accesos.ts` conserva otro `ROLE_KEYS` idéntico; unificar cuando toque) |
| `components/nav.tsx` | Accesos sale de las herramientas y entra en Producto como «Equipo» por `productModules`; la puerta sigue siendo `puedeAbrir` | `nav.test.tsx:30,61,79` | **APRUEBO** |
| `content/modules.ts` | `name` «Equipo», `group` `producto`; `/equipo` → `/accesos` | `modules.test.ts:16,62,71`; `paginas.test.ts:21` | **APRUEBO** |
| `components/ui/confirm-action.tsx` (+ prueba, README) | Componente nuevo del kit: tokens de `globals.css`, textos por props, 5 casos | — | **APRUEBO CON CAMBIO, hecho**: faltaba su `Section` en `/kit` (README del kit, paso 3). Añadida con cuatro variantes |

Además, en `conexiones.ts` y `lib/permisos/sesion.ts` viajan cambios de
**ACC-7** que §7bis no lista: `findPublicAccountByHandle` pregunta
`public_account_out_of_scope()` y lanza `ScopeError` cuando el @ es de
otra creadora fuera del alcance (antes creaba otra fila);
`upgradePublicAccountToOAuth` usa `writeOrScopeError` con una sonda de
visibilidad; `usuarioDeDemo` se muda a `lib/workspace/demo.ts` y se
reexporta. Son defensivos, los cubre `alcance-rls.test.ts:946` y
`sesion.test.ts`. **APRUEBO** (que ACC-7.md los liste).

## 2. RES-3 · lo que importa esta semana (fases-rasheed §9)

Todo lo de la tabla de §9 está en el código. El aviso se escribe en la
**misma transacción** que el UPDATE de estado en los cuatro sitios; el
candado `pg_advisory_xact_lock` va antes del `INSERT … WHERE NOT
EXISTS`; `workspace_id` explícito en todas las consultas; sin PII ni
secretos en el aviso; los UPDATE del recolector son textualmente los
mismos.

| Punto que pedía visto bueno | Veredicto |
|---|---|
| (a) Título nuevo y un solo productor en los dos `markNeedsReauth` | **APRUEBO**. El título viejo no lo usaba Conexiones (CON-4 lee `status`/`status_detail`); la única prueba que lo esperaba ya está actualizada |
| (b) Barrido `remindBrokenAccounts` en `oauth.refresh` | **APRUEBO CON CAMBIO, hecho**: miraba `ctx.signal` una sola vez antes del bucle; en el turno (CIM-7) seguía corriendo detrás del presupuesto. Ahora recibe la señal y corta el bucle; prueba nueva en `lo-que-importa.test.ts` |
| (c) Productor mínimo (candado + regla de 7 días) | **APRUEBO**, con un ajuste hecho: «se leyó bien después del aviso» miraba solo `last_synced_at`, que la reautorización desde la web no escribe; ahora mira `greatest(last_synced_at, connected_at)`. Queda abierto (no bloquea): `markRead` de collect.posts devuelve una cuenta a `active` sin tocar ninguna marca, así que una cuenta arreglada por esa vía y rota otra vez en menos de 7 días espera a la semana |

Fuera de la tabla de §9 y aceptado: `compute-post-score.ts` usa
`videoName` de core (un título vacío cae a la descripción; mejora) y
`platformName` se muda a `aviso-cuenta.ts`. Falta un caso que cuente el
aviso warning del camino `not_found` de `collect.account_metrics` (hoy
cubierto por transitividad con `markAccountError`): para la siguiente
vuelta de RES-3.

## 3. CIM-11 · ids sin contador (fases-rasheed §10)

| Qué | Veredicto |
|---|---|
| **0083 entera** | **APRUEBO**. Conserva filas (`USING gen_random_uuid()` fila a fila), reescribe las dos referencias en jsonb (runId de la bitácora, claims del perfil), re-ejecutable, una transacción con `lock_timeout = 15s`. Su prueba convierte con los seeds dentro (más de 1 000 lecturas) |
| (A) runId como texto | **APRUEBO**. `runIdOf` falla al abrir la corrida si no hay fila, dentro de la transacción; antes `Number(undefined)` daba NaN en silencio |
| (B) última corrida por fecha | **APRUEBO CON CAMBIO, hecho**: `ORDEN_ULTIMA_CORRIDA` no llevaba el id al final (la salud de main sí desempataba por `r.id DESC`); añadido `id DESC` en `queries/worker.ts` y en las dos funciones de 0083 §4b |
| (C) un registro por fecha | **APRUEBO** |
| Corte `at_cut` de `queries/campanas.ts` | **APRUEBO**: sin empate, el mismo reporte; con empate gana la fuente y al final el id. Observación para CAM: `getResultInputs` ordena `captured_at DESC` y la vista `post_metrics_at_cut` `ASC`; ya era así en main |

§10 está incompleto: también tocó `packages/db/src/audit.ts` (runId en
texto; `auditAsJob` ya no acepta `entityId === ""`) y
`queries/resumen.ts` (`ORDEN_ULTIMA_LECTURA`). Los dos están bien.

## 4. CIM-7 · worker por turnos (a posteriori)

El runner del PR 1 ya estaba en `main` (504427c7, 4a46d2c1, bd135b5b) y
en producción desde el 28-sep; esta rama no lo cambia salvo el tipo del
runId. `recorrer.ts` solo importa tipos del runner; `--once` y el proceso
largo siguen igual. **APRUEBO**. Lo que se vio en producción
(`exhausted`/`failed`) tiene historia propia, VEN-17, y la 0084.

## 5. CIM-12 · verificar determinista

Solo pruebas y helpers (`harness.ts`, `pglite.ts`, `package.json` del
worker, `from-env.ts` con `snapshot: true` solo en modo embebido). Nada
cambia lo que un job escribe en producción; ningún `.skip` nuevo; el
conteo de casos sube en todos los archivos. Tres cifras literales
cambiaron por el reloj anclado al 5-oct (`costuras-con.test.ts`,
`campanas/[id]/reporte.test.tsx`): 4 496 → 4 466, 2 469 → 2 400,
0,824 → 0,812; son las de la demo anclada, no un cambio de cálculo.
**APRUEBO**.

## 6. Choque con las ramas de QA de Nicolás

Un merge de prueba (`--no-commit`, abortado) de `nicolas/QA-modulos-sprint`
y de `nicolas/QA-9-5-modulos` sobre la rama da **seis archivos en
conflicto**, los mismos en las dos:

| Archivo | Resolución propuesta |
|---|---|
| `apps/worker/src/jobs/conexiones/_posts.ts` | Lo de RES-3 (transacción + `notifyBrokenAccount`) se queda; encima, lo del QA (token vencido se renueva antes de leer) |
| `apps/worker/test/helpers/harness.ts` | La versión de CIM-12 (foto + reloj); reaplicar lo que el QA añadió |
| `apps/worker/test/campaign-compute.test.ts` | CIM-12 (siembra anclada al 28-sep) y las aserciones del QA |
| `packages/db/test/campanas.test.ts` | CIM-11 (orden por fecha) y los casos nuevos del QA |
| `apps/web/app/(app)/campanas/ciclo-db.test.ts` | Igual: CIM-12 (`snapshot: true`, techos) + casos del QA |
| `apps/web/app/(app)/finanzas/ingresos/integracion.test.ts` | CIM-12 (`acercarAHoy` con una sola regex) + lo del QA |

Decisión: la fase 9 entra en `main` primero (esta revisión); las dos
ramas de QA se rebasan encima después (son de Nicolás y están en su
máquina, una con cambios sin commitear).

## 8. Lo que pasó después: `main` y producción (9-oct-2026)

- `main` avanzó por avance rápido de `00c49413` a **`c20d1bbe`**
  (`nicolas/revision-fase-9`, misma rama en GitHub): la fase 9 entera,
  los cuatro cambios de la revisión, dos merges de `origin/main` (el QA
  del 5-oct y los dos commits de Instagram del 9-oct, con seis archivos
  en conflicto resueltos como dice §6 y cuatro pruebas ajustadas a los
  ids uuid y a la siembra fija) y un arreglo de `.vercelignore`: el build
  de Vercel caía con «Cannot find module '@mc/db/test/tiempos'» porque
  `**/test/` dejaba fuera la carpeta entera y `lib/testing/tiempos.ts`
  (CIM-12) la importa; pasa a `**/test/**` con la excepción.
- `pnpm verificar` sobre `c20d1bbe` (worktree limpio): **15/15 tareas**;
  raíz 15, `@mc/core` 548, `@mc/connectors` 311, `@mc/db` 1 633 (3
  saltadas de siempre), `@mc/worker` 446, `@mc/web` 2 182 (+1 todo); 0
  fallos, 0 canceladas. `make db.check` 0001–0084 en verde.
- Receta de 0083 (ventas-outreach §5.2), hora UTC: build de producción
  sin dominio listo (`on-cue-8lefmkizz-influ3.vercel.app`, READY,
  `c20d1bbe`) → `make db.migrate` 21:17:19–21:17:27 (0078 568 ms, 0079
  364, 0080 313, 0081 353, 0082 357, 0083 1 194, 0084 341) → `make
  db.guardia` «en verde: 83 migraciones, 102 tablas aisladas» → `vercel
  promote` 21:17:34–21:17:38. La ventana con la web vieja viva fue de
  19 segundos. El cron de pg_cron no se desinstaló (pide el token de
  administración, solo en la máquina de Rasheed): un turno que cayera en
  esa ventana se reintenta al minuto siguiente.
- `make db.seed`: los trece seeds aplicados, 0011 (equipo), 0012 (lo que
  importa) y 0013 (agencia) por primera vez.
- Humo en https://on-cue-web.vercel.app (sirve `c20d1bbe`): `/`, `/login`,
  `/resumen`, `/accesos`, `/legal` 200; `/api/cron/tick` sin Bearer 401.
  La demo enseña «Lo que importa esta semana» con «Entendido» y la fila
  «dejó de darnos las cifras»; `/accesos` enseña Equipo con «Invitar».
- Lo que no se comprobó desde esta máquina: `make cron.status` (token de
  administración) y la demo de la agencia como Diego (`DEMO_USER_ID` no
  va en Vercel; se mira en local contra la copia).

## 7. Lo que queda abierto para Rasheed (no bloquea el merge)

1. `ACC-7.md` y `fases-rasheed.md` §10: listar `conexiones.ts`,
   `sesion.ts`, `marca-service.ts` (ACC-7) y `audit.ts`, `resumen.ts`
   (CIM-11).
2. RES-3: un caso para el aviso warning de `collect.account_metrics`
   (`not_found`) y, si CON-10 lo acepta, una marca de «se arregló» que
   `markRead` escriba.
3. `ROLE_KEYS` duplicado en `schema/accesos.ts` y `core/permisos.ts`.
4. El comentario «Equipo al final del grupo» vale solo con las
   banderas de fase 2 apagadas.
