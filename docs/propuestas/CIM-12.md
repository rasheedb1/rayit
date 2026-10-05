# CIM-12 · `pnpm verificar` determinista

Rasheed, 5-oct-2026. Rama `rasheed/CIM-12-verificar-determinista-r3`
(sobre la r2).

## Mecanismo

El síntoma con el que se abrió la historia (25-sep): una corrida de
`pnpm verificar` informó las 735 pruebas de `@mc/db` como canceladas con
«Promise resolution is still pending but the event loop has already
resolved». No había una promesa de PGlite sin resolver. Medido el 5-oct
con Node 24.21 y 25.2 (el de la máquina y el del CI):

- El runner de node:test ya **no** cancela una prueba porque el bucle de
  eventos se quede vacío: en su `beforeExit` arma un `setInterval` y
  espera a las pruebas pendientes. Una prueba que espera una promesa que
  nunca llega se queda colgada hasta `--test-timeout`; no se cancela
  (probado con `await new Promise(() => {})` dentro de un `test` y de un
  `before`, con y sin `--test`, con aislamiento `none` y `process`).
- Ese mensaje sale en otro sitio: el manejador de **SIGINT y SIGTERM**
  del runner llama a la misma salida con `kill = true`, no espera, y da
  por canceladas con ese texto todas las pruebas que quedan (está en el
  `harness.js` del propio binario de Node). Reproducido: un `node --test`
  con cinco pruebas de un segundo, `kill -TERM` al segundo y medio →
  `pass 1, cancelled 4`, «Promise resolution is still pending…».
- **Quién mandaba la señal: turbo.** Sin `--continue`, cuando una tarea
  falla turbo mata a las que siguen corriendo. Reproducido con un
  monorepo de juguete (`a#test` que sale con 1 a los dos segundos, `b#test`
  con ocho pruebas de node:test): `b:test: ℹ cancelled 6`, con el mismo
  mensaje. El 25-sep `pnpm verificar` era `turbo run … --concurrency=2`
  sin `--continue`: lo que falló aquel día fue OTRA tarea (las del worker
  y la web que daban rojo por tiempo bajo carga), y turbo se llevó por
  delante a `@mc/db`, que estaba sana. Por eso «las demás corridas y la
  suite suelta, en verde».
- Lo mismo pasa cuando un agente corta un Bash a los 600 s: SIGTERM a
  todo el árbol y las pruebas pendientes salen «canceladas». En
  `estres-verificar.sh`, la columna `cancel.` distinta de cero quiere
  decir eso: alguien mató el proceso.

Arreglos de esta clase:

- `pnpm verificar` corre turbo con `--continue` (ya en la r2; ahora la
  prueba de `scripts/verificar.sh` lo fija): un rojo de una tarea ya no
  cancela las demás, y el informe dice cuál falló.
- Los rojos por tiempo que lo disparaban se quitaron de raíz (abajo).
- Las pruebas de carreras de `@mc/db` (cotizar, outreach) ya no esperan
  a secas el aviso que da una transacción desde dentro: si la
  transacción fallaba antes de avisar, la prueba se colgaba dos minutos
  y su error salía como un rechazo sin dueño. `esperarAviso`
  (`packages/db/test/carrera.ts`) corre el aviso contra la transacción.
- El `setTimeout` con ref de la espera del candado de `db/lib/foto.mjs`
  sí importa fuera de node:test: un proceso suelto que espera la foto de
  otro saldría con el `await` sin resolver. Con un `.unref()` ahí,
  «dos procesos a la vez» de `foto.test.mjs` falla (comprobado). Y
  `foto.test.mjs` tiene ahora una prueba que espera un candado ajeno
  dentro del propio runner, sin hijos que mantengan vivo el bucle.

## Causa de los rojos al azar

1. **Carga.** Cada proceso de pruebas volvía a migrar PGlite (77
   migraciones, de 5 a 60 s según la carga) y, en la web, a sembrar la
   demo; vitest abría un proceso por núcleo. Con dos `pnpm verificar` a
   la vez los `beforeAll` pasaban de su techo y vitest perdía su RPC.
2. **El worker con `--test-isolation=none`**: cuarenta workers de pg-boss
   vivos en el mismo hilo, y `guard.attempts` contaba los `fetch` de
   otros archivos.
3. **El día.** La demo mezcla fechas relativas a hoy con hechos de fecha
   fija, y muchas pruebas comparan contra ella. Con el reloj de la
   máquina la puerta se ponía roja sola: desde el 7-oct a las 06:00 UTC
   (la lectura de 30 días del TikTok de Fresko entra en el seed y su
   resultado pasa de 7 a 30 días), desde noviembre (la curva de Café Alma
   deja de medirse a los 90 días) y desde diciembre (los gastos de
   septiembre salen de la ventana de Finanzas, el año de la numeración).
   La r2 decía tenerlo resuelto y no era cierto: turbo corre las tareas
   en modo estricto, `MC_RELOJ_DIAS` no estaba en `turbo.json` y **el
   reloj nunca se movió dentro de `pnpm verificar`**; las tandas «con el
   reloj rotando» daban verde sin probar nada. Con la variable pasando,
   a +90 días caían 16 pruebas de `@mc/db` (Finanzas, Cotizar, campañas),
   2 del worker, 2 de la web y 3 de `foto.test.mjs`.
4. **El día de la semana.** Moviendo el ancla día a día
   (`--ancla-rotando`) salieron tres pruebas que solo pasaban ciertos
   días, todas de Rasheed: el despacho de la demo del worker
   (`tick.test.ts`, `outreach-demo.test.ts`, y la misma en
   `tick-postgres.test.ts` del CI) pedía «ahora, o la PRÓXIMA apertura»
   del horario de envío, que un sábado, un domingo o un festivo de
   Colombia cae en el futuro del `now()` de la base, y el despacho no
   reclamaba nada; la prueba del tick siguiente usaba el 6-oct fijo y,
   desde ese día, la corrida de la anterior quedaba después y su tick
   salía como cubierto; y el asistente de importación fijaba la
   exportación al 12-sep, que deja de valer en cuanto una fecha del
   archivo leída en día/mes (el 9-oct) pasa. Ahora la demo despacha en
   la última apertura ya llegada (`test/helpers/ventana.ts`), el tick
   siguiente es el día hábil siguiente a ese, y la exportación es la de
   hoy.
5. **Un candado huérfano** de la foto de disco hacía esperar hasta diez
   minutos, en silencio (r2).

## Arreglo

| Qué | Dónde |
|---|---|
| La base migrada es una **foto en disco** compartida entre procesos y paquetes; la huella cubre migraciones, extensiones, `aplicar.mjs`, `foto.mjs` y el módulo que prepara la base | `db/lib/foto.mjs` |
| El candado lleva `pid@host` y un **latido**; un pid muerto lo libera al instante. Las edades se miden con la hora de la máquina (`performance`), no con `Date`: con el reloj de las pruebas movido, un candado vivo parecía de hace meses | `db/lib/foto.mjs`, `db/lib/foto.test.mjs` |
| La web **siembra la demo una vez por corrida**; vitest con **un tercio de los núcleos** | `apps/web/vitest.global-setup.ts`, `vitest.config.ts` |
| **El reloj de las pruebas anclado** al 5-oct-2026 15:00 UTC en `@mc/db`, `@mc/worker` y `@mc/web` (Date y, con él, el `now()` de PGlite); el tiempo corre desde ahí y todos los procesos de una corrida comparten origen | `scripts/pruebas/reloj.mjs`, scripts `test`, `vitest.config.ts` |
| **Las cifras de campañas con fecha fija** (la lista con views, los posts de Café Alma, el corte de Fresko, el recálculo del worker) miran la demo sembrada el 28-sep y comparan contra ese día: pasan con o sin ancla, también contra un Postgres real | `packages/db/test/campanas.test.ts`, `apps/worker/test/campaign-compute.test.ts` |
| `turbo.json` deja pasar `MC_RELOJ_*`, `MC_TEST_WORKERS` y `MC_PGLITE_FOTO*`; cada proceso con el reloj movido lo dice y el estrés cuenta las tareas que no lo dijeron | `turbo.json`, `scripts/estres-verificar.sh` |
| **Dos `pnpm verificar` a la vez** en toda la máquina; la espera tiene techo (`MC_VERIFICAR_ESPERA_MAX`, 600 s, sale con 75) y un turno se libera si su pid murió, si el pid es de otro proceso (otra hora de arranque) o si tiene más de dos horas | `scripts/verificar.sh`, `scripts/pruebas/verificar.test.mjs` |
| `pnpm verificar --filter=…` vuelve a pasar las banderas a turbo | `scripts/verificar.sh` |
| Los techos salen de lo medido: `SETUP_TIMEOUT_MS` 180 s, `PRUEBA_DB_TIMEOUT_MS` 60 s, `--test-timeout` de `@mc/db` 120 s | `packages/db/test/tiempos.ts`, `apps/web/lib/testing/tiempos.ts` |
| `embedded.ts` ya no mete `foto.mjs` ni el reloj en el bundle de la web: los carga con un `import()` que webpack no sigue, sin `import.meta.url`. El build vuelve a «Compiled successfully» sin avisos y el bundle del turno, a sus tres rutas permitidas | `packages/db/src/embedded.ts`, `db/lib/reloj.mjs`, `revisar-bundle-turno.mjs` |
| Las pruebas que despachan la demo usan la última apertura ya llegada del horario de envío, no la próxima | `apps/worker/test/helpers/ventana.ts`, `tick.test.ts`, `outreach-demo.test.ts`, `tick-postgres.test.ts` |
| El reloj de las pruebas guarda `performance.now` al cargar: `vi.useFakeTimers()` lo finge, y leyéndolo en cada llamada los `afterEach` con `vi.useRealTimers()` se colgaban | `scripts/pruebas/reloj.mjs` |
| `estres-verificar.sh --dias 2,7,30,90` (la máquina en esas fechas), `--ancla-rotando` (el día de las pruebas, los siete de la semana) y `--sin-ancla` | `scripts/estres-verificar.sh`, `make verificar.estres` |

## Decisiones

- **Anclar el reloj de las pruebas, no reescribir la demo.** Los gastos
  de septiembre, los posts de campaña y la numeración de 2026 son hechos
  de la demo (seed 0003, de Nicolás) y las pruebas de Finanzas lo dicen
  ellas mismas («hay que pasarlos a fechas relativas… o esta lectura ya
  no prueba nada»). Que la demo de producción envejezca es asunto de
  `make db.seed.check`, no de la puerta: la puerta tiene que dar lo
  mismo el día que sea. Se ancla el día, no la hora del proceso: el
  tiempo sigue corriendo para los plazos y los `waitFor`.
- **El 5-oct como ancla**, el día en que la puerta entera se midió en
  verde, a las 15:00 UTC (el mismo día de UTC−12 a UTC+8). Moverlo es
  una decisión: cambia las cifras que ven las pruebas.
- **Con `TEST_DATABASE_URL` no se ancla**: el reloj de un Postgres real
  no se mueve, y un Date anclado contra un `now()` real daría rojos que
  no existen. Las pruebas de campañas con fecha fija abren siempre el
  embebido anclado, así que el job «contra-postgres-real» del CI ya no
  depende del día por ellas; las de Finanzas sí (ver «Pendiente»).
- **`--dias` mueve la máquina, `--ancla` mueve el día de las pruebas.**
  Con el ancla puesta, la máquina a +90 no cambia nada en las suites de
  la demo: es justo lo que se quiere demostrar, y por eso la tanda
  `--sin-ancla` enseña que el reloj sí se mueve y que sin ancla hay rojo.
  Mover el ancla sirve para cazar pruebas que dependen del día de la
  semana o de una fecha cercana; más allá de unos días empieza a medir
  la demo y no las pruebas (a+9, Finanzas: «Resultado»).
- **Los techos no arreglan nada**: solo deciden cuándo una prueba
  colgada da rojo. Se fijan con margen sobre lo medido, no «el más alto
  que había»: con el techo de 900 s de la r2, una prueba de cuatro
  minutos también habría pasado el estrés.
- **El turno vive en `/tmp/mc-verificar-turnos-UID`, no en `$TMPDIR`**:
  dos sesiones del mismo usuario pueden tener `$TMPDIR` distintos.

## Archivos de Nicolás que se tocaron

Cambios mínimos, ninguno de lógica de producto:

| Archivo | Qué cambió | Por qué |
|---|---|---|
| `packages/connectors/test/helpers/pglite.ts` | `openMigratedPglite` llama a `abrirSuperusuario` (r2) | Migraba en cada archivo |
| `apps/worker/test/helpers/harness.ts` | `abrirSuperusuario` y `applyRepoSeeds` de `@mc/db/embedded`; `SETUP_TIMEOUT` de `@mc/db/test/tiempos`; `applyRepoSeeds(db, { relojDias })` | La foto, un solo techo y la demo anclada |
| `apps/worker/src/runner/db-pglite.ts` | `execPglite` de `@mc/db` (r2) | Era la tercera copia del mismo exec |
| `apps/worker/package.json` | `--test-isolation=process` (r2); `--import ../../scripts/pruebas/reloj.mjs` | Un archivo por proceso; el reloj de las pruebas |
| `apps/worker/test/campaign-compute.test.ts` | Siembra la demo del 28-sep; techo común | Fresko pasaba a 30 días el 7-oct |
| `apps/worker/test/costuras-con.test.ts` | El múltiplo contra el oráculo de `@mc/db/test/demo` (r2) | Dependía del día de la siembra |
| `apps/web/app/(app)/conexiones/_lib/*.test.ts`, `campanas/**/*.test.ts`, `finanzas/ingresos/integracion.test.ts` | `snapshot: true`; techos de `lib/testing/tiempos.ts`; un comentario viejo | Sembraban la demo en cada archivo (r2) |

## CIM-1 y CIM-7

- **CIM-1, hecha.** `mc_worker_login` (miembro de `mc_worker`) existe
  desde el 28-sep y el worker corre por turnos en la web
  (`/api/cron/tick`); el proceso largo con pg-boss no se usa en
  producción.
- **CIM-7, en curso.** El disparador existe (pg_cron de Supabase llama
  cada minuto firmando el turno; `make cron.status` en verde el 5-oct).
  Falta conectar GitHub a Vercel para que un merge a `main` publique solo
  (un clic de Rasheed; hoy, `make vercel.deploy PROD=1`) y la aprobación
  de Nicolás del PR 1 del runner (`rasheed/CIM-7-runner-1`). Visto en la
  revisión del 5-oct: `make cron.status` muestra en cada turno dos jobs
  en `exhausted`, `collect.account_metrics` y `outbound.replies`, sin
  historia propia todavía.

## Pendiente

- **Cuatro pruebas de Finanzas con vencimientos fijos de octubre**
  (`packages/db/test/finanzas.test.ts`: «draft → sent → void», «trae las
  tres facturas por cobrar», «ocho semanas…», «y los KPI de Finanzas se
  mueven con el cobro») cambian de resultado desde el 14-oct. Con el
  ancla la puerta no las ve; para Nicolás: fechas relativas a
  CURRENT_DATE o la demo anclada, como las de campañas.

- **El job «contra-postgres-real» del CI corre con el reloj de verdad**
  (un Postgres real no se ancla) y sus pruebas de Finanzas y Cotizar
  dependen de la demo de septiembre: desde diciembre darán rojo ahí. Lo
  arregla pasar los gastos y la numeración del seed 0003 a fechas
  relativas (de Nicolás) o anclar esas pruebas como las de campañas.

## Resultado

Tandas del 5-oct con `scripts/estres-verificar.sh`, `pnpm verificar`
entero, de a dos, con otros agentes trabajando en la máquina (11
núcleos). «m+N» es la máquina N días adelante; «a+N», el ancla de las
pruebas N días adelante.

| Tanda | Corridas | Reloj | Carga (1 min) inicio → máx | Segundos por corrida | Fallidas · archivos en FAIL · canceladas · tareas sin su reloj |
|---|---|---|---|---|---|
| A · `make verificar.estres N=10 P=2` | 10 | m+0 | 5,1 → 77,5 | 279–340 | 0 · 0 · 0 · — |
| B · `N=8 DIAS=2,7,30,90` | 8 | m+2, +7, +30, +90 (dos de cada) | 20,1 → 60,7 | 248–331 | 0 · 0 · 0 · 0 |
| E · `N=10 DIAS=1` (`--dias-rotando`) | 10 | m+0 … m+9 | 7,6 → 71,9 | 238–282 | 0 · 0 · 0 · 0 |
| F · `N=10 ANCLA=1` (`--ancla-rotando`) | 10 | a+0 … a+9 | 17,2 → 42,5 | 252–265 | a+0 … a+8: 0 · 0 · 0 · 0. a+9: 4 de Finanzas (abajo) |
| D · `N=2 DIAS=2,90 SIN_ANCLA=1` (control) | 2 | m+2 y m+90, sin ancla | 15,8 → 30,6 | 244–248 | m+2: 0. m+90: 13 de `@mc/db` (Finanzas, Cotizar) y 1 de la web |

- **A, B y E son el criterio de la historia**: 28 corridas de a dos sin
  una prueba fallida ni cancelada, también con la máquina a +2, +7, +30 y
  +90 días y en los diez días siguientes. La espera de turno fue 0 en
  todas: solo corría este estrés.
- **D es el control**: sin el ancla el reloj sí se mueve. A +2 días ya
  no cae nada (las campañas miran la demo del 28-sep); a +90 caen las de
  Finanzas y Cotizar que dependen de la demo de septiembre y el formato
  de fecha de Ventas, que pone el año cuando no es el actual.
- **F, con el ancla rotando, encontró tres pruebas que dependían del día
  de la semana** (arregladas, «Causa» 4) en una primera tanda de 7 (5 en
  rojo). Tras el arreglo, a+0 … a+8 (lunes 5 a martes 13, con un fin de
  semana y el festivo del 12-oct) en verde. A **a+9 (el 14-oct)** caen
  cuatro pruebas de Finanzas (`finanzas.test.ts`, de Nicolás) que crean
  facturas con vencimientos fijos de octubre: desde ese día entran en
  «vence pronto» y en las ocho semanas del flujo. Con el ancla la puerta
  no lo ve; sin ella daría rojo el 14-oct real. Queda en «Pendiente».
- Lo más lento medido en A, B y E: la primera suite de `@mc/db` (siembra
  la demo) 41 s; la prueba más lenta de la web, 6 s; la del worker, 11 s.
  De ahí salen los techos (`SETUP_TIMEOUT_MS` 180 s,
  `PRUEBA_DB_TIMEOUT_MS` 60 s, `--test-timeout` de `@mc/db` 120 s).
- `pnpm --filter @mc/web build`: «Compiled successfully», sin avisos, y el
  bundle del turno con sus tres rutas permitidas de siempre.
