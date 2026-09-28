# Cierre del módulo CON, parte A · Datos: CON-6 y CON-2b

Escrito para: Nicolás (decisiones y guion de humo) y Rasheed (§7, lo que
toca carpetas suyas). Fecha: 23 de septiembre de 2026. Rama
`nicolas/CON-A-datos`, worktree `rayit-cierre-con-a`, desde `origin/main`
`098b25a` (P0 ya dentro).

---

## 0. Inventario (F0)

| Qué | Dónde estaba al empezar | Qué faltaba según su «terminado cuando» (backlog-mvp §5) |
|---|---|---|
| CON-5 · recolector | En `main` | Nada de esta parte (la prueba en vivo es de CON-C) |
| CON-6 · línea base y puntaje | `nicolas/CON-6-linea-base-puntaje` en GitHub (`0592e19`, 11 commits, 59 detrás de `main`) | Estar en `main`; costuras con CON-5, CAM-5 y RES sin prueba automática (la comparación con el seed era una verificación a mano, §4 de su propuesta) |
| CON-2b · el worker sobre `@mc/db` | Pendiente | El bucle propio de migraciones en `apps/worker/src/runner/db-pglite.ts` **y** en `packages/connectors/test/helpers/pglite.ts` (la nota de CIM-2 en backlog-mvp §8 los nombra a los dos) |
| Encadenamiento collect → compute | Solo por hora (`0009`) | `compute.*` podía correr antes de que terminara `collect.*` (ver §3) |

**`../rayit-con6`**: tenía un merge de `origin/main` (`cf90d57`) a medias
con tres archivos `UU` (`apps/worker/README.md`,
`apps/worker/src/jobs/conexiones/index.ts`, `apps/worker/test/runner.test.ts`).
Solo tenía los marcadores, sin nada resuelto. Esos mismos tres conflictos
se resolvieron aquí (§1). **Ese worktree se puede borrar**: su rama
local está igual que la de GitHub (`0592e19`), y todo lo suyo ya está en
`nicolas/CON-A-datos`. Para borrarlo:
`git worktree remove --force ../rayit-con6` desde el clon principal (el
`--force` hace falta por el merge a medias).

**Plan**: merge de CON-6 → CON-2b en el worker y en connectors →
encadenamiento en el runner → costuras con prueba → `--demo` hasta
compute → revisión → push a `main` y despliegue de la web (el worker no
se despliega: WRK).

## 1. Merges y conflictos (F1)

`git merge --no-ff origin/nicolas/CON-6-linea-base-puntaje` → `a3f4dbc`.
Tres conflictos, los tres de unión: `main` trajo CON-7 después de que
CON-6 se ramificara, y las dos ramas añaden jobs en los mismos sitios.

| Archivo | Resolución |
|---|---|
| `apps/worker/src/jobs/conexiones/index.ts` | El array lleva los jobs de las dos: CON-5, CON-6 y `collect.demographics` |
| `apps/worker/test/runner.test.ts` | 15 con handler, 11 sin handler (main 13/13 + los 2 de CON-6); `conHandler` con los once |
| `apps/worker/README.md` | La línea de pruebas y el árbol de `src/jobs/conexiones` nombran CON-6 y CON-7 |

`pnpm verificar` después del merge: 15/15 tareas (connectors 202, raíz 8,
core 248, web 956 + 1 todo, db 763, worker 102).

## 2. Historias

### CON-6 · Línea base y puntaje · **hecha** (en producción corre cuando esté WRK)

*Terminado cuando:* «Un post con el doble de views que la mediana queda
con `outlier_tier = outlier`».

| Prueba | Qué fija |
|---|---|
| `apps/worker/test/compute-baseline-post-score.test.ts` (16) | El doble de la mediana → `outlier`; el video de tres días se mide a 72 h; con menos de ocho videos, null; dos workspaces sin cruce; un aviso por nivel; el corte no retrocede; el tope sobre el valor redondeado; un locale inválido no tumba el aviso |
| `apps/worker/test/costuras-con.test.ts` (11) | Las costuras de §3, las 16 líneas base y los 59 puntajes idénticos a `db/seed/0002` |
| `packages/core/test/scoring.test.ts` | `medianOf`/`percentileOf` con lista vacía → null, engagement, guardados por mil |

En dev, el `--demo` (§4). En producción: el worker no corre (WRK), así
que en Supabase siguen las filas que sembró `0002`; `job_definition`
trae las dos filas con sus horarios (§9).

### CON-2b · El worker sobre `@mc/db` · **hecha**

*Terminado cuando:* «`apps/worker` y `packages/connectors` no definen un
bucle de migraciones propio; sus pruebas siguen en verde».

- `apps/worker/src/runner/db-pglite.ts` llama a `applyMigrations` de
  `db/lib/aplicar.mjs` (el mismo runner de `openTestDb` y de
  `make db.migrate`), importado por `@mc/db/embedded`. Si una migración
  falla, cierra el PGlite.
- `packages/connectors/test/helpers/pglite.ts` hace lo mismo, importado
  por ruta: `@mc/db` depende de `@mc/connectors` y el paquete no puede
  depender de vuelta.
- Los seeds del arnés del worker salen de `applySeeds`
  (`applyRepoSeeds()`); `campaign-compute` y `recordatorios` dejan su
  bucle.
- Pruebas: `apps/worker/test/migraciones.test.ts` (5): cada archivo de
  `db/migrations` queda en `schema_migrations` del worker con su
  checksum; worker y `openTestDb` terminan con la misma tabla; una
  migración nueva en el directorio se aplica al abrir; dos con el mismo
  número detienen el arranque (el bucle viejo las aplicaba a las dos).
  `packages/connectors/test/migraciones.test.ts` (1): lo mismo para
  connectors.
- El `TODO(CIM-2)` de `runner/db.ts` pasó a decisión escrita: el pool
  Postgres del worker se queda propio (withWorkspace fija un workspace y
  mc_worker existe para cruzarlos; pg-boss necesita un pool sin cambio
  de rol). Lo que tiene que ser idéntico (TLS y migraciones) ya se
  comparte.

## 3. Costuras

| Contrato | Prueba | Qué falla si se rompe |
|---|---|---|
| **CON-5 → CON-6** | `costuras-con.test.ts` «cada recolección dispara…» y «cada video queda puntuado…» | Dos `collect.post_metrics` **reales** sobre la respuesta grabada de YouTube (3 videos, reloj 3-sep 15:00 y 4-sep 15:00). La cadena corre sola y en orden (ids de `job_run`), con `metadata.tras`. Cortes 72, 24 y 24 (el mayor alcanzado y medido), `views_at_cut` de la lectura de ese corte (la de 24 h, no la de 48), `views_vs_median`/`outlier_tier` null con menos de ocho videos, `is_outlier = false`, `baseline_id` puesto y la mediana calculada igual |
| **Encadenamiento** | `costuras-con.test.ts` «encadenamiento en el registro» y «un job que falla entero…» | `next()` de cada job; un `after` a un job que no existe o un ciclo no arrancan; `failed` y un `ok` con `processed = 0` no encadenan; `partial` sí, con el `workspaceId` del de arriba |
| **CON-6 → CAM-5** | `costuras-con.test.ts` «sin línea base…» y «con la línea base de compute.baseline, la cifra exacta» | Sobre el seed, con las líneas base del seed borradas: `campaign.compute` deja `views_vs_median` null y `missing_inputs` con `baseline`; tras `compute.baseline` da **4.496** en Café Alma |
| **CON-6 = seed** | «las 16 líneas base y los 59 puntajes…» | Fila por fila: muestra, cinco medianas, p25, p75, fiabilidad; corte, views al corte, múltiplo, nivel |
| **CON-6 → RES-3** (Rasheed) | «CON-6 → RES-3: el contrato de lectura…» | RES **todavía no lee** el puntaje (grep: ninguna consulta de `resumen` toca `post_score`, `creator_post_board` ni `creator_baseline`). Las dos consultas de `CON-6.md` §2 dan el top 5 (d01 5,971× breakout, d06 3,710, d18 2,662, d02 2,469, d28 2,359) y los seis avisos con `action_url = /resumen` |
| **CON-6 → COT** (media kit, Rasheed) | Sin prueba nueva | `queries/cotizar/media-kit.ts` lee `creator_baseline` por `creator_id` (la más reciente del corte del tarifario) y calcula su propio «× mediana» a propósito (comentario en el archivo). Lo que escribe CON-6 tiene la forma que lee; lo cubren las pruebas de COT |

**Encadenamiento: por qué y cómo (sin migración).** `0009` dice:
`collect.post_metrics` a las 05:00 (600 s, 5 intentos),
`compute.baseline` a las 05:40 (300 s) y `compute.post_score` a las
05:45. Por hora sola, un reintento de la recolección puede terminar
después de las 05:40, y una línea base lenta puede seguir corriendo
cuando arranca el puntaje: el número del día saldría con datos de ayer.
El arreglo va en el runner: `defineJob(id, fn, { after: [...] })`.
Cuando el de arriba termina `ok`/`partial` y procesó algo, el runner
encola el de abajo con el mismo `workspaceId`, `singletonKey`
`tras:<alcance>` y `{ source: 'chain', after }` (que llega a
`job_run.metadata.tras`). Los crons se quedan como red de seguridad.
No hace falta la 0042.

## 4. El `--demo` (F4)

`pnpm --filter @mc/worker start -- --demo`, sin `INSTAGRAM_HOUSE_TOKEN`
ni `GOOGLE_API_KEY` (respuestas grabadas, reloj fijo en
`DEMO_GRABADO_INICIO` = 21-sep 16:00 UTC). Salida real, recortada a
`job_run.metadata` sin `bossJobId`:

```
demo CON-5: collect.post_metrics (corrida 1)
  id 15 ok processed 3 · snapshots 3, candidatos 3, capturedAt 2026-09-21T16:00Z   (Instagram)
  id 17 ok processed 3 · snapshots 3, candidatos 3, capturedAt 2026-09-21T16:00Z   (YouTube)
demo CON-5: collect.post_metrics (corrida 2)
  id 19 ok processed 3 · snapshots 3, capturedAt 2026-09-22T16:00Z
  id 22 ok processed 3 · snapshots 3, capturedAt 2026-09-22T16:00Z
demo CON-6: job_run de compute.* (encadenados: metadata.tras)
  id 16 compute.baseline   ok 0 · tras collect.post_metrics, cuentas 0, videosEnVentana 0
  id 18 compute.baseline   ok 0 · tras collect.post_metrics, cuentas 0, videosEnVentana 0
  id 20 compute.baseline   ok 2 · tras collect.post_metrics, cuentas 1, videosEnVentana 2, computedAt 2026-09-22T16:00Z
  id 21 compute.post_score ok 2 · tras compute.baseline, candidatos 2, sinLineaBase 2, outliers [], avisados []
  id 23 compute.baseline   ok 0 · tras collect.post_metrics, cuentas 1, repetidas 2 (mismo instante: no escribe, no encadena)
demo CON-6: creator_baseline
  instagram 24 h  · muestra 1 · mediana 141200.00 · is_reliable false
  instagram 168 h · muestra 1 · mediana null      · is_reliable false
demo CON-6: post_score
  instagram …b01 · corte 24  · views_at_cut 141200 · views_vs_median null · outlier_tier null
  instagram …b03 · corte 168 · views_at_cut null   · views_vs_median null · outlier_tier null
  sinCorteMedido: 4
```

Se lee así. En la primera ronda ningún video ha llegado a un corte, así
que la línea base sale vacía. En la segunda, el Instagram de 47 h se
mide a 24 h y el de 172 h a 168 h; los dos quedan con múltiplo null,
porque hay un video por corte y hacen falta ocho. Los otros cuatro (un
Instagram de 97,5 h y los tres de YouTube, de más de 400 h) no tienen
una lectura dentro de la banda de su corte y se quedan sin fila, que es
la regla. `…b03` tiene `views_at_cut` null porque la respuesta de
Instagram por @ no trae views de ese post: null, no cero.

## 5. Revisión (F4)

`/code-review` en nivel alto sobre `origin/main...nicolas/CON-A-datos`: 10
hallazgos.

| # | Hallazgo | Qué se hizo |
|---|---|---|
| 1 | `cap()` comparaba sin redondear; Postgres redondea a la escala y desborda (99,9999997 en `numeric(8,6)`) | **Arreglado** + prueba |
| 2 | `workspace.locale` inválido hace lanzar `Intl.NumberFormat` y deshace el puntaje del workspace cada noche | **Arreglado** (cae al DEFAULT de la columna) + prueba |
| 3 | La cadena encadenaba también un `ok` con `processed = 0` | **Arreglado** + prueba |
| 4 | Agrupar con spread era cuadrático | **Arreglado** |
| 5 | La espera del demo podía cortar con un post_score de la primera ronda | **Arreglado** |
| 6 | Nombres nuevos del runner en español | **Arreglado** (`enqueueChained`, `enabledIds`, `withoutChaining`) |
| 7 | La primera corrida avisa también de outliers viejos (un alta con historial manda una ráfaga) | **Justificado → decisión D3** (§6): es de producto |
| 8 | Un `collect.post_metrics` con solo `connectionId` encadena un recálculo de todos los workspaces | **Justificado**: ningún envío lo hace (la web no encola este job; el demo y las pruebas mandan `workspaceId`); el recálculo es correcto e idempotente, solo más caro. Si aparece un envío así, el arreglo es que el job devuelva su alcance en `JobResult` |
| 9 | Cron y cadena duplican el recálculo nocturno (2 baseline, hasta 3 post_score) | **Justificado**: idempotente (0 avisos repetidos, el corte no baja); sobre el seed son 0,9 s y 3,3 s. Quitar los crons pide migración y quitaría la red de seguridad |
| 10 | `post_metrics_at_cut` no filtra por workspace antes del `DISTINCT ON`: cada corrida ordena las lecturas de todos | **Justificado** para el MVP (una demo, pocos creadores); es una vista de Rasheed: §6 |
| — | El adaptador `exec` de PGlite repetido (worker, arnés, connectors, `embedded.ts`) | **Justificado**: son 3 líneas; la mejora es exportar `pgliteExec` de `db/lib/aplicar.mjs` (§6) |
| — | Identificadores en español en el código ya fusionado de CON-6 (`debeAvisar`, `TOPES`…) y `post_score` con `DO UPDATE` | **Justificado**: renombrar exports ya fusionados es ruido sin cambio de comportamiento; `post_score` no es una tabla de métricas sino el puntaje vigente, con `PRIMARY KEY (post_id)` desde `0003` |

`/security-review`: no se corrió. El cierre no toca permisos,
consentimiento, enlaces públicos, secretos ni dinero; el payload del
encadenamiento solo lleva `source`, `after` (un id de job validado con
el patrón de `defineJob`) y `workspaceId`. Hay pruebas de que CON-6 no
filtra secretos: `compute-baseline-post-score.test.ts`, «nada de lo que
escribe CON-6 lleva la referencia del secreto».

## 6. Decisiones pendientes de Nicolás

Ninguna se cambió: en el código quedó la opción conservadora.

| # | Dónde | Pregunta | Lo que hay en el código | Recomendación | Si dices lo contrario |
|---|---|---|---|---|---|
| D1 | `docs/propuestas/CON-6.md:217` · `apps/worker/src/jobs/conexiones/compute-baseline.ts:215` | ¿Una mediana por red, o por red y formato (reel, foto, historia)? | Por red, como `0003` y el seed | Por red en el MVP; separar por `surface` cuando una cuenta real mezcle formatos en volumen | Migración (columna `surface` en `creator_baseline` y en su `UNIQUE`) + `PARTITION BY` y `claveDe` en `compute-baseline.ts` y el `JOIN` de `compute-post-score.ts`. Cambio M, fase 2 |
| D2 | `docs/propuestas/CON-6.md:223` · `apps/worker/src/jobs/conexiones/compute-post-score.ts:335` | ¿A quién le llega el aviso de outlier? | `user_id = NULL`: a todo el workspace, como `oauth.refresh` | Dejarlo así hasta que RES-3 filtre por rol; ahí, solo a quien tenga `resumen.*` | Unas 10 líneas en `compute-post-score.ts` (una fila por usuario con el permiso, leído de `role_permission`) y prueba. Cambio S, sin migración |
| D3 | Nueva (revisión, hallazgo 7) · `compute-post-score.ts:331` | ¿Se avisa de un video viejo que se puntúa por primera vez (alta con historial, CSV)? | Sí: el primer puntaje de cada video ≥ 2× avisa, tenga la edad que tenga | Avisar solo si el video se publicó hace 30 días o menos (el corte mayor, `AGE_CUTS_HOURS`, más un día); los viejos se puntúan sin aviso | Una condición en `compute-post-score.ts` y una prueba. **Ojo**: la demo de RES-3 pasaría de 6 avisos a los de los videos recientes del seed |
| D4 | `docs/propuestas/CON-5.md:123` y `:240` | ¿Fusionar posts entre una conexión de CSV y una por @? | No se fusiona | Es de CON-5 y se cierra en CON-C; aquí solo se anota porque CON-6 contaría el video dos veces en la mediana si llegara a pasar | Lo cuenta `CIERRE-CON-C.md` |

## 7. Lo que necesita Rasheed

1. **Una línea en `packages/db/src/embedded.ts`** (ya en la rama y en
   `main`, anotada): `export { applyMigrations, applySeeds, type
   MigrationExec }`. Es la re-exportación del runner que el worker usa
   para su embebido. Si prefieres otra forma (una entrada
   `./migrar` en `package.json`, o `pgliteExec` en `db/lib/aplicar.mjs`
   para quitar las cuatro copias del adaptador de tres líneas), dímelo y
   lo cambio en el worker.
2. **`post_metrics_at_cut`** (hallazgo 10): los dos compute filtran por
   workspace en el `JOIN`, y la vista ordena antes las lecturas de todos.
   No urge; cuando crezca la base, una función con el `workspace_id` como
   parámetro (o un índice que el planificador pueda usar) lo acota.
3. **RES-3**: el contrato de lectura está en `CON-6.md` §2 y ahora tiene
   prueba (§3). Nada que cambiar en tu lado.
4. **Nada de migraciones.** El encadenamiento no pidió la 0042.

## 8. Fuera de alcance

| Qué | Por qué | Historia |
|---|---|---|
| Desplegar el worker (esquema `pgboss`, `GRANT mc_worker TO mc_migrator`) | Lo pide el prompt | WRK |
| CON-7 | En `main`, espera la prueba en vivo | CON-C |
| La prueba en vivo de CON-5 (faltan `INSTAGRAM_HOUSE_TOKEN` y `GOOGLE_API_KEY` en Vercel) | Credenciales | CON-C |
| «Mis videos» (pantalla del puntaje) y la lista de RES-3 | Otras historias | RES-3 (Rasheed), fase 2 |
| Mediana por formato, aviso a quién, aviso de videos viejos | Decisiones D1–D3 | CON-6 fase 2 |

## 9. Producción (F5)

**Verificación antes de subir** (sobre `3a681d4`, con `main` integrado
después del cierre de CAM): `pnpm verificar` 15/15 tareas, sin caché:
connectors 203/203 · raíz 8/8 · core 248/248 · web 970 + 1 todo (115
archivos) · db 769/769 · worker 120/120, sin canceladas. `next build`
sale con 0. Sin migración: no hay `db.check` que correr por CON-A.

**En dev** (`next dev -p 3171`, base embebida con el seed): `/`,
`/conexiones`, `/campanas` y `/resumen` responden 200. No hay pantalla
nueva ni cambiada (el único archivo web es `content/backlog.ts`, cuyas
notas no se pintan: la portada solo cuenta), así que la revisión a
400 px y en tema oscuro no aplica a este cierre.

**Subida.** `git push origin HEAD:nicolas/CON-A-datos` y
`git push origin HEAD:main` por avance rápido (`1bfa0ac..3a681d4`).
Despliegue desde `rayit-deploy` en detached `origin/main`, después de
que terminara el de CAM (`1bfa0ac`), que estaba construyéndose al llegar.

| Qué | Resultado |
|---|---|
| Plan B (producción anterior) | `https://on-cue-92gduqy5o-influ3.vercel.app` (`1bfa0ac`, cierre de CAM) |
| Despliegue nuevo | `https://on-cue-cr4agc9cv-influ3.vercel.app` · `dpl_DJd5DHvxebu2Sz8RMC5F2NdC9Q24` |
| `api /v13/deployments/…` | `READY`, `target production`, `meta.gitCommitSha = 3a681d4054a3…` |
| Alias | `on-cue-web.vercel.app` → `dpl_DJd5DHvxebu2Sz8RMC5F2NdC9Q24` |
| Rutas | `/` 200 · `/conexiones` 200 · `/campanas` 200 · `/resumen` 200 · `/login` 200 · `/reporte/esto-no-existe` 404; ninguna con la frontera de error |
| `job_definition` (lectura como `mc_app`) | `collect.post_metrics` `0 5 * * *` 600 s · `compute.baseline` `40 5 * * *` 300 s · `compute.post_score` `45 5 * * *` 300 s; las tres `enabled`, 5 intentos |
| Lo que tiene Supabase de CON-6 (workspace de la demo) | 32 filas de `creator_baseline` (el seed se aplicó dos días distintos y la tabla es append-only), 67 de `post_score`, **0** corridas de `compute.*` en `job_run`: lo sembró `0002` y el worker no corre (WRK) |
| `make db.guardia` | **Roja por una sola causa, que no es de CON-A**: «faltan 1 migración(es) por aplicar: `0041_campaign_result_escritura_web.sql`». Es la PARADA 1 de CAM (`CIERRE-CAM.md` §8.1), que llegó a `main` sin aplicar. Se corrió desde `rayit-deploy` (el código desplegado); desde el clon principal (`29460e3`, desactualizado) da además falsos positivos de código viejo (`membership.role`). El despliegue anterior tenía la misma falla, así que volver al plan B no la arregla: **no se hizo rollback**. Se pone verde con `make db.migrate` (la 0041) |

### Guion de humo para Nicolás

CON-A no cambia ninguna pantalla: lo que se comprueba en producción es
que nada se rompió y que la costura con CAM lee la línea base. Marcado
**[escribe]** lo que toca la base real.

1. `https://on-cue-web.vercel.app/` con tu sesión: en la portada, el
   módulo Conexiones cuenta CON-6 y CON-2b como hechas.
2. `/conexiones`: tus cuentas, como antes (CON-A no toca la pantalla).
3. `/resumen`: lo de siempre. Resumen todavía no lee el puntaje (RES-3).
4. `/campanas` → **Café Alma · Lanzamiento cold brew** → «Resultado».
   Si ya aplicaste la 0041 de CAM, **[escribe]** **Recalcular**: tiene que
   aparecer «4,5× tu mediana». Ese 4,496 sale de `creator_baseline`, la
   tabla de CON-6, y es la misma cifra que prueba
   `costuras-con.test.ts`. Sin la 0041, la ficha lo dice con una frase y
   no hay botón.
5. En tu máquina (no toca producción):
   `cd platform && pnpm --filter @mc/worker start -- --demo`. A los pocos
   segundos imprime `demo CON-6: job_run de compute.*` con `tras:
   collect.post_metrics`, la línea base y los dos puntajes de §4.
   Ctrl-C para salir.
