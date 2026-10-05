# CIM-12 · `pnpm verificar` determinista

Rasheed, 5-oct-2026. Rama `rasheed/CIM-12-verificar-determinista-r2`.

## Causa

Todos los rojos al azar de la puerta eran de **carga**, no de lógica, más
unas pocas pruebas que **dependían del día**:

1. **Cada proceso de pruebas volvía a migrar PGlite** (77 migraciones,
   de 5 a 60 s según la carga) y, en la web, **volvía a sembrar la demo**.
   Vitest abría un proceso por núcleo (10) y cada uno sembraba la suya;
   con dos `pnpm verificar` a la vez eran 20 procesos sembrando en 11
   núcleos, con cuatro más de 40. Los `beforeAll` pasaban de su techo y
   vitest perdía su propio RPC («Timeout calling onTaskUpdate»).
2. **El worker corría con `--test-isolation=none`**: cuarenta workers de
   pg-boss vivos en el mismo hilo, y `guard.attempts` contaba los `fetch`
   de otros archivos (ronda 1).
3. **Pruebas que clavaban cifras de un día**: la mediana de la demo
   (la parrilla del seed 0002 cuenta desde hoy y los posts de campaña del
   0003 tienen fecha fija), los posts asociables y los meses del CSV de
   AdSense (ronda 1).
4. **Un candado huérfano** de la foto de disco (un Ctrl-C o un agente
   reiniciado mientras se construía) hacía esperar hasta diez minutos, en
   silencio, a todos los demás (ronda 2).

## Arreglo

| Qué | Dónde |
|---|---|
| La base migrada es una **foto en disco** compartida entre procesos y entre paquetes; la huella cubre migraciones, extensiones, `aplicar.mjs`, `foto.mjs` y el módulo que prepara la base | `db/lib/foto.mjs` |
| El candado lleva `pid@host` y un **latido** (mtime cada 2 s). Un pid muerto en esta máquina libera el candado al instante; a los 10 s de espera se avisa por stderr con el pid y la ruta | `db/lib/foto.mjs`, probado en `db/lib/foto.test.mjs` |
| **Una sola** `abrirSuperusuario` para el worker y los conectores (antes, dos `preparar` copiados bajo la misma clave) y un solo `execPglite` | `db/lib/foto.mjs` |
| La web **siembra la demo una vez por corrida**: el `globalSetup` de vitest fija `MC_PGLITE_CORRIDA` y la foto sembrada va a una carpeta de esa corrida, que se borra al terminar | `apps/web/vitest.global-setup.ts`, `packages/db/src/embedded.ts` |
| Vitest con **un tercio de los núcleos** (`MC_TEST_WORKERS` lo fija) | `apps/web/vitest.config.ts` |
| **Dos `pnpm verificar` a la vez** como mucho en toda la máquina, entre clones; el tercero espera turno y lo dice | `scripts/verificar.sh` |
| Ningún archivo de pruebas de la web lleva un techo propio: `SETUP_TIMEOUT_MS` (el de @mc/db), `PRUEBA_DB_TIMEOUT_MS`, `PRUEBA_LENTA_MS`, `ESPERA_UI_MS` | `apps/web/lib/testing/tiempos.ts`, `packages/db/test/tiempos.ts` |
| Las cifras de la demo **vuelven a estar fijas** sembrando como si fuera el 28-sep (`relojDias`), y el oráculo de las pruebas de cada día usa `calcularResultado` de @mc/core, no una copia de la fórmula | `packages/db/test/demo-anclada.test.ts`, `packages/db/test/demo.ts` |
| `estres-verificar.sh` con `--paralelo P`, `--help`, una fila por tanda, la carga de cada corrida y los archivos en FAIL; `make verificar.estres` | `scripts/estres-verificar.sh`, `Makefile` |

## Decisiones

- **La foto sembrada va a disco por corrida, no por día.** La revisión
  proponía una clave con el día UTC. No basta: los seeds cuentan desde
  `now()` con precisión de horas (un token que vence «dentro de 50
  minutos», un correo «hace 3 horas»), y una foto sembrada a las 8 y
  cargada a las 18 daría otra demo. La clave lleva igualmente el día UTC
  y `MC_RELOJ_DIAS`, pero lo que manda es la corrida.
- **Latido de 30 s, no de 15, y solo para candados de otra máquina.** En
  la misma máquina manda el pid: mientras viva, se espera (salvo cinco
  minutos sin latido, que es un proceso colgado). PGlite es WASM en el
  hilo principal y una migración grande bloquea el bucle de eventos, y
  con él el latido, varios segundos con la máquina a carga 100: con 15 s
  un segundo proceso le habría quitado el candado a uno vivo.
- **Un tercio de los núcleos para vitest, no un cuarto.** Medido sin
  carga: 41 s con 10 procesos, 58 s con 3, 84 s con 2. Con el turno de
  `verificar.sh` (dos a la vez) un tercio deja 2 × 3 procesos de vitest
  más las dos tareas de turbo en 11 núcleos.
- **El seed no se toca.** Anclar la parrilla del 0002 a los posts de
  campaña haría envejecer la demo de producción (`make db.seed`). Se
  ancla la siembra de las pruebas (desplazarReloj, el mismo de
  `make db.seed.check DIAS=…`).
- **`PRUEBA_DB_TIMEOUT_MS` es 300 s**, el más alto de los que había
  sueltos, para no bajarle el techo a ninguna prueba; los techos no
  arreglan nada, solo deciden cuándo una prueba colgada falla.
- **El turno vive en `/tmp/mc-verificar-turnos-UID`, no en `$TMPDIR`**:
  dos sesiones del mismo usuario pueden tener `$TMPDIR` distintos.

## Archivos de Nicolás que se tocaron

Cambios mínimos, ninguno de lógica de producto:

| Archivo | Qué cambió | Por qué |
|---|---|---|
| `packages/connectors/test/helpers/pglite.ts` | `openMigratedPglite` llama a `abrirSuperusuario` | Migraba en cada archivo; ahora abre la foto compartida, con la misma función que el worker |
| `apps/worker/test/helpers/harness.ts` | `openTestDatabase` llama a `abrirSuperusuario`; `applyRepoSeeds` usa `execPglite` | Lo mismo; el `preparar` copiado desapareció |
| `apps/worker/src/runner/db-pglite.ts` | `PgliteDatabase.open` usa `execPglite` de @mc/db | Era la tercera copia del mismo exec; sin cambio de comportamiento |
| `apps/worker/package.json` | `test` con `--test-isolation=process` | Con `none`, cuarenta pg-boss en un hilo y `guard.attempts` contando fetch ajenos |
| `apps/worker/test/costuras-con.test.ts` | El múltiplo de Café Alma y los cinco mejores comparan contra el oráculo de `@mc/db/test/demo` | Dependían del día de la siembra; la cifra fija vive en `packages/db/test/demo-anclada.test.ts` |
| `apps/worker/test/campaign-compute.test.ts` | El múltiplo contra el oráculo | Igual |
| `apps/web/app/(app)/conexiones/_lib/cuentas-service.test.ts`, `oauth-handlers.test.ts`, `pagina.test.tsx` | `snapshot: true` al abrir la base; techos de `lib/testing/tiempos.ts` | Sembraban la demo en cada archivo (el hook de 60 s que fallaba) |
| `apps/web/app/(app)/campanas/_lib/marca-service.test.ts`, `ciclo-db.test.ts`, `ficha-db.test.tsx`, `[id]/reporte.test.tsx`, `[id]/recalcular-db.test.ts` | `snapshot: true`; el múltiplo de `ciclo-db` contra el oráculo; techos de `tiempos.ts` | Lo mismo, y la mediana que cambia con el día |
| `apps/web/app/(app)/finanzas/ingresos/integracion.test.ts` | Los meses del CSV se reemplazan de una pasada; techo de `tiempos.ts` | Tres `replace` seguidos chocaban en octubre |

## Resultado

Ver la nota de CIM-12 en `apps/web/content/backlog.ts`, con las tandas de
`make verificar.estres` y la carga de cada una.
