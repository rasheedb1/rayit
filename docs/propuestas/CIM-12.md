# CIM-12 · `pnpm verificar` determinista

Rasheed, 5-oct-2026. Rama `rasheed/CIM-12-verificar-determinista-r5`
(sobre la r4, con `rasheed/integracion` al día). Lo nuevo de cada ronda,
en «Ronda 4» y «Ronda 5» al final de «Arreglo».

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
| `turbo.json` deja pasar `MC_RELOJ_*`, `MC_TEST_WORKERS` y `MC_PGLITE_FOTO*`; cada proceso con el reloj movido lo dice y el estrés cuenta las tareas que no lo dijeron (en la r5, `MC_RELOJ_*` pasa al hash: «Ronda 5») | `turbo.json`, `scripts/estres-verificar.sh` |
| **Dos `pnpm verificar` a la vez** en toda la máquina; la espera tiene techo (`MC_VERIFICAR_ESPERA_MAX`, ~~600 s~~ 1800 s desde la r4, sale con 75) y un turno se libera si su pid murió, si el pid es de otro proceso (otra hora de arranque) o si tiene más de dos horas | `scripts/verificar.sh`, `scripts/pruebas/verificar.test.mjs` |
| `pnpm verificar --filter=…` vuelve a pasar las banderas a turbo | `scripts/verificar.sh` |
| Los techos salen de lo medido: `SETUP_TIMEOUT_MS` 180 s, `PRUEBA_DB_TIMEOUT_MS` 60 s, `--test-timeout` de `@mc/db` 120 s | `packages/db/test/tiempos.ts`, `apps/web/lib/testing/tiempos.ts` |
| `embedded.ts` ya no mete `foto.mjs` ni el reloj en el bundle de la web: los carga con un `import()` que webpack no sigue, sin `import.meta.url`. El build vuelve a «Compiled successfully» sin avisos y el bundle del turno, a sus tres rutas permitidas | `packages/db/src/embedded.ts`, `db/lib/reloj.mjs`, `revisar-bundle-turno.mjs` |
| Las pruebas que despachan la demo usan la última apertura ya llegada del horario de envío, no la próxima | `apps/worker/test/helpers/ventana.ts`, `tick.test.ts`, `outreach-demo.test.ts`, `tick-postgres.test.ts` |
| El reloj de las pruebas guarda `performance.now` al cargar: `vi.useFakeTimers()` lo finge, y leyéndolo en cada llamada los `afterEach` con `vi.useRealTimers()` se colgaban | `scripts/pruebas/reloj.mjs` |
| `estres-verificar.sh --dias 2,7,30,90` (la máquina en esas fechas), `--ancla-rotando` (el día de las pruebas, los siete de la semana) y `--sin-ancla` | `scripts/estres-verificar.sh`, `make verificar.estres` |

### Ronda 4

| Qué | Dónde |
|---|---|
| **Las facturas que crean las pruebas de Finanzas vencen relativo al `now()` de la base** (`diaDelEspacio(n)`), no el 21 o el 23 de octubre. Con la fecha fija, el 14-oct «draft → sent → void» caía en «vence pronto», se paraba antes de cobrar, y la factura que dejaba abierta tumbaba otras tres (FIN-6 y los KPI): el job «contra-postgres-real» del CI, que no se ancla, se habría puesto rojo solo | `packages/db/test/finanzas.test.ts` |
| La numeración de Cotizar se prueba en el cambio de año 2099→2100, no en el de 2027: en un Postgres sembrado en 2027 la demo ya numera COT-2027-001…005 | `packages/db/test/cotizar.test.ts` |
| El pago de Sofía de las pruebas de alcance, «hace tres días» pero nunca antes del 1 de enero: del 1 al 3 de enero caía fuera de «cobrado en el año» | `packages/db/test/alcance.ts` |
| **El modo demo abre la base al arrancar el servidor** (`instrumentation.ts` → `abrirBaseDeLaDemo`), no dentro de la primera petición: en `next dev` sin `DATABASE_URL` la primera página que abría la base daba 500 con «failed to pipe response · RangeError: Maximum call stack size exceeded» | `apps/web/instrumentation.ts`, `apps/web/lib/db/cliente.ts` |
| **Techos con nombre y medida**, sin un número suelto: `PRUEBA_DB_TIMEOUT_MS` y `PRUEBA_SCRIPT_TIMEOUT_MS` en `@mc/db/test/tiempos`, `DESCRIBE_DB_TIMEOUT_MS` (= arranque + pruebas) para los describe que abren su base (antes 900 s), `ESPERA_UI_LARGA_MS` en la web. El worker baja de `--test-timeout=300000` a 120 s, como `@mc/db`; sus hooks de 600, 300, 240 y 180 s pasan a `SETUP_TIMEOUT` | `packages/db/test/tiempos.ts`, `apps/web/lib/testing/tiempos.ts`, `apps/worker/test/**` |
| La prueba del tick siguiente del worker calcula su día sola (el primer día hábil después de hoy), sin leer una variable que llenaba la prueba anterior | `apps/worker/test/tick.test.ts` |
| Cifras literales del 5-oct en las suites ancladas (4,466, el top 5, seis avisos, 0,812); el oráculo de `test/demo.ts` queda solo en `@mc/db`, que también corre sin ancla contra Postgres real | `apps/worker/test/costuras-con.test.ts`, `campaign-compute.test.ts` (4,496: siembra el 28-sep), `apps/web/app/(app)/campanas/ciclo-db.test.ts` |
| **Un solo reemplazo de `Date`** para el ancla y para la máquina | `scripts/pruebas/fecha.mjs` (`instalarDate`, `horaReal`, `etiqueta`), con sus pruebas |
| **El estrés cuenta el reloj por tarea sin mirar el prefijo de turbo**: cada proceso dice `reloj[@mc/db#test]: …` y la lista de tareas sale de `turbo run test --dry=json`. Con dos tareas escribiendo a la vez turbo deja prefijos como `@mc/db:test:@mc/worker:test:`, y la r3 los contaba como «tareas sin reloj» | `scripts/pruebas/estres-contar.sh` y su prueba con un registro mezclado |
| Cada tanda del estrés en su carpeta (`tanda.XXXXXX`), también con `ESTRES_DIR`: dos estrés en la misma carpeta se leían los `.codigo` | `scripts/estres-verificar.sh` |
| `--filtro PAQUETE` en el estrés (`FILTRO=` en make) para la tanda de control del CI: `SIN_ANCLA=1 FILTRO=@mc/db DIAS=9,60` | `scripts/estres-verificar.sh`, `Makefile` |
| La espera de turno llega a 1800 s (antes 600) y el 75 dice «NO es un rojo… vuelve a lanzarlo»; CLAUDE.md pide a los agentes relanzar ante un 75 | `scripts/verificar.sh`, `CLAUDE.md` |

### Ronda 5

| Qué | Dónde |
|---|---|
| **La hora de arranque de un turno se lee y se escribe en C** (`LC_ALL=C ps -o lstart=`). `ps` la daba en el idioma de quien lo llamaba: un verificar lanzado desde una Terminal en español escribía «lun 5 oct …», un agente (sin `LANG`) leía «Mon Oct 5 …» para el mismo pid, lo daba por reciclado y le quitaba el turno: tres verificar a la vez. Un turno de una versión anterior con la hora en otro idioma no se compara: se le cree al pid (la salvaguarda de dos horas lo suelta si no era él). Dos pruebas nuevas, que fallan con el script de la r4: dos turnos con la hora en es_ES → sale con 75 sin liberar nada; un verificar de verdad lanzado con `LC_ALL=es_ES.UTF-8` y otro con `LC_ALL=C` → el segundo espera | `scripts/verificar.sh`, `scripts/pruebas/verificar.test.mjs` |
| Con `MC_VERIFICAR_ESPERA_MAX=0` (como lo lanza el estrés) el aviso dice «espero turno (sin techo)», no «como mucho 0 s» | `scripts/verificar.sh` y su prueba |
| **`MC_RELOJ_*` entran en el hash de turbo** (el `env` de cada tarea `test`, no `globalPassThroughEnv`), y las tareas de pruebas de `@mc/db`, del worker y de los conectores tienen entre sus `inputs` los archivos de la raíz que cargan (`scripts/pruebas/**`, `db/lib/**`, seeds, `packages/db/test/tiempos.ts`). Comprobado con `turbo run test --dry=json`: `MC_RELOJ_DIAS=90`, `MC_RELOJ_ANCLA_DIAS=3`, un cambio en `reloj.mjs`, en `foto.mjs` o en `tiempos.ts` cambian el hash de las cuatro tareas; `MC_TEST_WORKERS` no (no cambia el resultado). Antes, `MC_RELOJ_DIAS=90 pnpm turbo run test` daba HIT y repetía el verde de +0 | `turbo.json`, `packages/db/README.md` («Verificar de verdad») |
| Los últimos techos sueltos, a `tiempos.ts`: los tres describe de `alcance-esquema` a `DESCRIBE_DB_TIMEOUT_MS` (eran 600 s), la prueba de migraciones de los conectores a `SETUP_TIMEOUT_MS` (300 s), y la de `canales_last_error_codigo` al `--test-timeout` del paquete (`PRUEBA_SCRIPT_TIMEOUT_MS`, el mismo 120 s que tenía escrito) | `packages/db/test/{alcance-esquema,canales}.test.ts`, `packages/connectors/test/migraciones.test.ts` |
| `instrumentation.ts` comprueba el modo demo ANTES de importar el cliente de base: en producción, con `DATABASE_URL` o en el turno del worker, el arranque en frío ya no carga ese grafo. `abrirBaseDeLaDemo` mantiene la misma guarda; una prueba nueva fija los cinco casos | `apps/web/instrumentation.ts`, `instrumentation.test.ts` |
| `apps/worker/src/runner/db-pglite.ts` vuelve a `rasheed/integracion`: la deduplicación del exec (r2) no hacía falta para la puerta y es código de producción del runner de Nicolás. Queda propuesta para un PR suyo | — |
| El comentario del CI sobre `pnpm verificar` dice lo que es (`scripts/verificar.sh`: turno, `--force --concurrency=2 --continue`) y la causa de las cancelaciones (SIGTERM de turbo), con enlace a «Mecanismo» | `.github/workflows/ci.yml` |
| El fallo de producción visto el 5-oct (`outbound.replies` en `failed`, `collect.account_metrics` agotado) tiene historia propia, **VEN-17**; el pendiente del seed 0003 está en la nota de **CIM-8**, la historia de su dueño | `apps/web/content/backlog.ts`, `docs/backlog-mvp.md` |

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
- **r4 · Finanzas: fechas relativas y no «la demo anclada».** La revisión
  proponía, como alternativa, abrir esas pruebas sobre
  `createEmbeddedDb({ relojDias: diasHasta('2026-10-05') })` como las de
  campañas. No sirve aquí: `relojDias` solo mueve el reloj de los SEEDS al
  sembrar; «vence pronto» y las ocho semanas se calculan al CONSULTAR,
  con el `CURRENT_DATE` de ese momento, y un Postgres real no se puede
  mover. Lo que se rompía eran facturas que la propia prueba creaba con
  fecha fija: pasarlas a `hoy + n` es el arreglo de raíz, y las pruebas
  siguen corriendo contra Postgres real en el CI.
- **r4 · El modo demo se abre en `instrumentation.ts`.** Comprobado con
  `next dev` en limpio (`.next` borrado): en `7b6c3fbc` (antes de esta
  historia) `/resumen` daba 200 a la primera; con la r3, 500, y con
  `snapshot: false` en `from-env.ts`, 200 otra vez. Lo dispara abrir la
  base desde la foto (miles de `await` encadenados) dentro de la primera
  petición; abierta al arrancar, `/resumen`, `/ventas`, `/finanzas`,
  `/cotizar`, `/campanas` y `/conexiones` dan 200 a la primera. El
  servidor tarda unos segundos más en decir «Ready» (abre la base antes);
  con `DATABASE_URL`, en producción o en las pruebas no hace nada.
- **r4 · Cifras literales en las suites ancladas.** El worker y la web
  corren siempre con el ancla, así que la demo que ven es la del 5-oct
  y sus cifras son fijas (comprobado: iguales de a−1 a a+9). Comparar
  contra `calcularResultado`, el mismo código que se prueba, no
  demostraba nada. `@mc/db` conserva el oráculo solo donde corre también
  sin ancla, contra Postgres real.
- **r4 · 1800 s de espera de turno, sin cálculo por cola.** Calcularlo
  con la duración media necesitaría guardar historiales de corridas;
  un techo fijo holgado (unas diez corridas por delante con dos turnos)
  da lo mismo para quien espera, y el 75 sigue existiendo para un turno
  colgado de verdad.

## Archivos de Nicolás que se tocaron

Cambios mínimos, ninguno de lógica de producto:

| Archivo | Qué cambió | Por qué |
|---|---|---|
| `packages/connectors/test/helpers/pglite.ts` | `openMigratedPglite` llama a `abrirSuperusuario` (r2) | Migraba en cada archivo |
| `apps/worker/test/helpers/harness.ts` | `abrirSuperusuario` y `applyRepoSeeds` de `@mc/db/embedded`; `SETUP_TIMEOUT` de `@mc/db/test/tiempos`; `applyRepoSeeds(db, { relojDias })` | La foto, un solo techo y la demo anclada |
| ~~`apps/worker/src/runner/db-pglite.ts`~~ | ~~`execPglite` de `@mc/db` (r2)~~ — revertido en la r5: igual que en `rasheed/integracion` | La puerta no lo necesita y es código de producción del runner. Propuesto aparte: que `PgliteDatabase.open` use `execPglite` de `@mc/db/embedded` en vez de su propia copia del exec (tres líneas), en un PR que revise Nicolás |
| `apps/worker/package.json` | `--test-isolation=process` (r2); `--import ../../scripts/pruebas/reloj.mjs` | Un archivo por proceso; el reloj de las pruebas |
| `apps/worker/test/campaign-compute.test.ts` | Siembra la demo del 28-sep; techo común | Fresko pasaba a 30 días el 7-oct |
| `apps/worker/test/costuras-con.test.ts` | El múltiplo contra el oráculo de `@mc/db/test/demo` (r2) | Dependía del día de la siembra |
| `apps/web/app/(app)/conexiones/_lib/*.test.ts`, `campanas/**/*.test.ts`, `finanzas/ingresos/integracion.test.ts` | `snapshot: true`; techos de `lib/testing/tiempos.ts`; un comentario viejo | Sembraban la demo en cada archivo (r2) |
| `packages/db/test/finanzas.test.ts` (r4) | `diaDelEspacio(n)`: las facturas que crean cinco pruebas vencen relativo a hoy; `hoyEnElEspacio` la usa | Vencimientos fijos de octubre: rojo sin ancla desde el 14-oct |
| `packages/db/test/alcance.ts` (r4) | El pago de Sofía nunca antes del 1 de enero; el describe con `DESCRIBE_DB_TIMEOUT_MS` en vez de 900 s | Rojo del 1 al 3 de enero sin ancla; un techo sin medida |
| `apps/worker/test/costuras-con.test.ts`, `campaign-compute.test.ts` (r4) | Cifras literales (5-oct y 28-sep); sus `before` con `SETUP_TIMEOUT` y sus describe con `DESCRIBE_DB_TIMEOUT` | El oráculo era casi tautológico; con `--test-timeout` a 120 s, el techo del arranque tiene que ser explícito |
| `apps/worker/test/{once,migraciones,punta-a-punta,recordatorios}.test.ts`, `helpers/harness.ts` (r4) | Sus 600/300/180 s, a `SETUP_TIMEOUT`; `punta-a-punta` abre la foto (`snapshot: true`) en vez de migrar | Techos propios sin medida; una migración entera de más en cada corrida |
| `apps/web/app/(app)/conexiones/_lib/{cuentas-service,oauth-handlers}.test.ts`, `campanas/[id]/{aporte,asociar}.test.tsx` (r4) | `vi.setConfig({ testTimeout: 120_000 })` → `PRUEBA_DB_TIMEOUT_MS`; `LARGO`/`asyncUtilTimeout` → `PRUEBA_LENTA_MS`/`ESPERA_UI_LARGA_MS`; las esperas de 2 s → la común; el comentario viejo de oauth-handlers | Números propios que el README decía que no existían |
| `packages/connectors/test/migraciones.test.ts` (r5) | `{ timeout: 300_000 }` → `SETUP_TIMEOUT_MS`, importado por ruta de `packages/db/test/tiempos.ts` (como `helpers/pglite.ts` importa `db/lib`: `@mc/db` depende de los conectores y no al revés) | El último techo propio de los conectores |
| `packages/db/test/alcance-esquema.test.ts` (r5) | Sus tres describe, de 600 s a `DESCRIBE_DB_TIMEOUT_MS` | Con 600 s, un describe colgado tardaba diez minutos en dar rojo |
| `apps/web/content/backlog.ts`, nota de CIM-8 (r5) | El pendiente del seed 0003 con su fecha (30-dic) y el arreglo propuesto | Estaba solo en la nota de CIM-12, que nadie de Finanzas lee |

## CIM-1 y CIM-7

- **CIM-1, hecha.** `mc_worker_login` (miembro de `mc_worker`) existe
  desde el 28-sep y el worker corre por turnos en la web
  (`/api/cron/tick`); el proceso largo con pg-boss no se usa en
  producción.
- **CIM-7, en curso.** El disparador existe (pg_cron de Supabase llama
  cada minuto firmando el turno; `make cron.status` en verde el 5-oct).
  Único pendiente técnico: conectar GitHub a Vercel para que un merge a
  `main` publique solo (un clic de Rasheed; hoy, `make vercel.deploy
  PROD=1`). Falta además la aprobación **a posteriori** de Nicolás del
  runner ya integrado: el PR 1 (`rasheed/CIM-7-runner-1`) está entero en
  `rasheed/integracion` (`git log rasheed/integracion..rasheed/CIM-7-runner-1`
  sale vacío) y, con ella, en producción. Visto en la revisión del 5-oct:
  cada turno marca `collect.account_metrics` y `outbound.replies` como
  agotados (`exhausted`), y `outbound.replies` sale en `failed` (corrida
  1236). Desde la r5 tiene historia propia, **VEN-17**, y la nota de
  CIM-7 la cita.

## Pendiente

- ~~Cuatro pruebas de Finanzas con vencimientos fijos de octubre~~ y
  ~~la numeración de Cotizar en 2027~~: arregladas en la r4 (arriba).
  `@mc/db` sin ancla, con la máquina a +0, +9, +60 y +75 días (hasta el
  19-dic): verde.
- **Los gastos recurrentes del seed 0003 tienen fechas absolutas** (julio,
  agosto y septiembre de 2026). La proyección de gastos mira los 120
  días anteriores a hoy, así que **desde el 30-dic-2026** el job
  «contra-postgres-real» del CI (sin ancla) dará rojo en **seis** pruebas
  de gastos y flujo (`finanzas.test.ts`: «trae los gastos recurrentes de
  la ventana», «los gastos y la reserva del seed», «el seed proyecta 3,7 M
  al mes», «un gasto recurrente aparece proyectado»;
  `finanzas-costuras.test.ts`: «un abono, un gasto recurrente nuevo…» y
  «una suscripción anual…»). Medido en la r5 con
  `estres-verificar.sh 1 --dias 86 --sin-ancla --filtro @mc/db` (el
  30-dic): `ℹ fail 6`. La r4 decía siete y contaba «marcar como error es
  editar», que pasa. La propia prueba lo avisa con su
  motivo («Los del seed 0003 están con fechas absolutas de 2026: hay que
  pasarlos a fechas relativas»). No es de las pruebas sino del seed, y
  arreglarlo cambia la demo de producción y las pruebas que leen
  «septiembre de 2026» (gastos por mes, la web de Finanzas): es de
  Nicolás (CIM-8). Propuesta: sembrar los recurrentes en los tres meses
  cerrados anteriores a `CURRENT_DATE` y que las pruebas pidan
  `ultimoMesCerrado()` en vez de `'2026-09'`. La puerta local no lo ve
  (ancla); el job del CI sí, y con un mensaje que dice qué hacer. Desde
  la r5 está en la nota de CIM-8, la historia de Nicolás, con la fecha.
  No se añadió al CI un paso de aviso adelantado (`--dias 60
  --sin-ancla`): daría rojo en cada PR desde el 31-oct por algo que
  ningún PR cambia; la fecha en la nota de su dueño es el aviso.

## Resultado

### Ronda 5

Tandas del 5-oct (noche) con `scripts/estres-verificar.sh` sobre la r5
(con `rasheed/integracion` al día, CON-3 incluido), con otros agentes
trabajando en la máquina.

| Tanda | Corridas | Reloj | Carga (1 min) inicio → máx | Segundos por corrida | Fallidas · archivos en FAIL · canceladas · tareas sin su reloj |
|---|---|---|---|---|---|
| A · `N=10 P=2` | 10 | m+0 | 5,2 → 33,9 | 245–265 | 0 · 0 · 0 · — |
| B · `N=8 DIAS=2,7,30,90` | 8 | m+2, +7, +30, +90 (dos de cada) | 11,8 → 22,9 | 242–264 | 0 · 0 · 0 · 0 |
| Control · `1 --dias 86 --sin-ancla --filtro @mc/db` | 1 | m+86 sin ancla (el 30-dic, como el job del CI) | 7,2 → 8,8 | 72 | 6 · 0 · 0 · 0: los gastos del seed 0003 («Pendiente»), el rojo esperado |

- **18 corridas de a dos sin una prueba fallida ni cancelada**, 10 con
  la máquina en hoy y 8 con la máquina a +2, +7, +30 y +90 días, sobre
  el código de la r5. Es el criterio de la historia.
- El control confirma que el reloj se mueve dentro de turbo con
  `MC_RELOJ_*` ya en el `env` de las tareas, y deja el número exacto del
  pendiente de CIM-8: 6 pruebas, no 7.
- `pnpm verificar` (15 tareas) y `pnpm --filter @mc/web build` en verde;
  el build, «Compiled successfully» y el bundle del turno con sus tres
  rutas permitidas.
- `node --test scripts/pruebas/verificar.test.mjs`: 11 pruebas en verde;
  las dos del idioma fallan con el `verificar.sh` de la r4 (comprobado
  poniéndolo en su sitio: «el turno 1 era de …, que ya no está; lo
  libero» con el dueño vivo).

### Ronda 4

Tandas del 5-oct (tarde) con `scripts/estres-verificar.sh` de la r4, con
otros agentes trabajando en la máquina. Cada tanda en su carpeta
(`tanda.XXXXXX`) y el reloj contado por etiqueta.

| Tanda | Corridas | Reloj | Carga (1 min) inicio → máx | Segundos por corrida | Fallidas · archivos en FAIL · canceladas · tareas sin su reloj |
|---|---|---|---|---|---|
| C · `SIN_ANCLA=1 FILTRO=@mc/db DIAS=9,60,75 N=3 P=3` | 3 | m+9, +60, +75, sin ancla (lo que verá el job del CI el 14-oct, el 4-dic y el 19-dic) | 6,3 → 13,3 | 84–148 (una esperó turno 86 s) | 0 · 0 · 0 · 0 |
| A · `N=10 P=2` | 10 | m+0 | 9,8 → 46,8 | 253–413 | 0 · 0 · 0 · — |
| F · `N=10 ANCLA=1` (`--ancla-rotando`) | 10 | a+0 … a+9 (lunes 5 a miércoles 14, con el festivo del 12-oct) | 9,1 → 53,0 | 231–250 | 0 · 0 · 0 · 0 |
| B · `N=4 DIAS=2,90` | 4 | m+2, m+90 | 14,1 → 28,3 | 236–245 | 0 · 0 · 0 · 0 |

- **27 corridas sin una prueba fallida ni cancelada.** a+9 (el 14-oct),
  que en la r3 tumbaba cuatro de Finanzas, en verde; y `@mc/db` entero
  sin ancla, como en el CI contra Postgres real, en verde hasta el 19-dic
  (los gastos del seed caen el 30-dic: «Pendiente»).
- Lo más lento medido en A y F (de ahí los techos de
  `packages/db/test/tiempos.ts`): una prueba de `@mc/db`, 3,2 s; el
  describe de alcance más largo, 3,3 s; una del worker, 15,5 s; una de la
  web (el CSV de 5 MB), 9,2 s.
- `pnpm verificar` (15 tareas) y `pnpm --filter @mc/web build` en verde
  sobre la r4; el build, «Compiled successfully» y el bundle del turno
  con sus tres rutas permitidas.
- `next dev` en limpio sin `DATABASE_URL`: `/resumen`, `/ventas`,
  `/finanzas`, `/cotizar`, `/campanas` y `/conexiones` en 200 a la
  primera.

### Ronda 3

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
