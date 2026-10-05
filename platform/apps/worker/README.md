# @mc/worker · trabajos en segundo plano

Node + pg-boss sobre el mismo Postgres del producto. Lee `job_definition`
(migración 0009) para saber qué corre, cuándo y con qué límites, y deja
cada ejecución en `job_run`. Los jobs viven en la carpeta de su módulo;
el runner (`src/runner/`) no se toca para agregar uno.

## Correrlo

```bash
cd platform
make db.unlock                          # una vez: descifra .env.local
pnpm --filter @mc/worker install-schema # una vez por base: crea/migra el esquema pgboss
make worker                             # = pnpm --filter @mc/worker dev (recarga al guardar)
make dev                                # web + worker juntos (turbo)
```

Sin Supabase ni Docker, para ver el worker funcionando en esta máquina:

```bash
pnpm --filter @mc/worker start -- --pglite   # Postgres embebido vacío con todas las migraciones del repo
pnpm --filter @mc/worker start -- --demo     # lo anterior + 3 conexiones y un oauth.refresh en vivo
```

`--demo` siembra una conexión que vence en 10 minutos (se renueva), una
en 3 horas (intacta) y una revocada (pasa a `needs_reauth` con su
notificación), encola `oauth.refresh` y a los cuatro segundos imprime
`job_run`, `social_connection` y `notification`. Después corre los
recolectores de CON-5 sobre dos cuentas por @ (dos lecturas con un día
de diferencia) y, sin encolar nada a mano, la cadena de CON-6: tras cada
`collect.post_metrics` el runner encola `compute.baseline` y este
`compute.post_score` (ver «Encadenamiento»); el demo imprime su
`job_run.metadata` (con `tras`), `creator_baseline` y `post_score`. Sin
`INSTAGRAM_HOUSE_TOKEN` ni `GOOGLE_API_KEY` usa las respuestas grabadas
y el reloj arranca fijo en `DEMO_GRABADO_INICIO` (21-sep 16:00 UTC), para
que la salida no dependa de la hora del día.

El embebido aplica las migraciones con el runner de `@mc/db`
(`db/lib/aplicar.mjs`, el mismo de `openTestDb` y `make db.migrate`;
CON-2b): mismo orden, `schema_migrations` con los mismos checksums, y
dos archivos con el mismo número detienen el arranque. Incluye `0014`
con los privilegios de `mc_worker`, y las consultas corren como ese rol:
es el mismo reparto que en Supabase.

### Una pasada: `--once` (WRK)

```bash
pnpm --filter @mc/worker once        # corre lo vencido según job_definition y job_run, y sale
pnpm --filter @mc/worker salud       # última corrida de cada job, sin correr nada
```

Sin proceso largo ni pg-boss: por cada definición habilitada con cron y
handler calcula su último tick (`src/runner/cron.ts`, UTC) y la corre si
no hay una corrida global (`workspace_id` NULL) `ok` o `skipped` desde
ese tick. Una `running` viva (menos de `timeout_s + 30 s`) no se pisa;
`partial` y `failed` se reintentan en la pasada siguiente con la misma
regla que el proceso largo (`retry: false` lo evita y queda como
`metadata.noRetry`) hasta `max_attempts`, y una `running` colgada cuenta
como intento; lo encadenado (`after`) corre enseguida si hubo datos y
cubre su propio tick. Sale con 1 si alguna corrida terminó `failed` o si
una señal dejó jobs sin empezar. Al terminar
imprime la salud (`getWorkerHealth` de `@mc/db/queries/worker`) con
«Datos al <fecha>». No necesita el esquema `pgboss`, solo que el rol de
conexión pueda hacer `SET ROLE mc_worker`. Cada corrida se **reclama**
antes de empezar (CIM-7): con un candado por job
(`pg_advisory_xact_lock`, solo lo que dura una transacción corta) se
relee el estado de su tick y se abre ahí mismo la fila `running`, así
que dos pasadas a la vez no corren dos veces lo mismo. Era la
recomendación de [docs/propuestas/WRK.md](../../../docs/propuestas/WRK.md)
(`.github/workflows/worker-once.yml`, cada hora, apagado); el 27-sep
Rasheed eligió el modo **por turnos** (abajo), que es esta misma pasada
con un presupuesto de tiempo, cada minuto, desde la web.
No se corre a la vez que el proceso largo: el turno lo comprueba antes
de empezar y el proceso largo al arrancar (abajo, «Por turnos»).

Contra Supabase el worker arranca **solo cuando Rasheed aplique
[docs/propuestas/CON-2.md](../../../docs/propuestas/CON-2.md)** (esquema
`pgboss` y membresía de `mc_worker`). Hasta entonces, `make worker` y
`make dev` (que corren `src/dev.ts`) comprueban esas dos cosas antes de
arrancar y, si faltan, imprimen el comando exacto, listan `job_definition`
y salen con 0 en vez de caerse en bucle; `start` (producción) no degrada.
`make arranque` hace la misma comprobación. Para probar solo que
`@mc/db`, el TLS y las credenciales están bien, sin pg-boss:

```bash
make worker.humo                        # = pnpm --filter @mc/worker humo: lista job_definition por DATABASE_URL
```

### Por turnos: el worker en Vercel (CIM-7)

Sin un proceso siempre encendido: alguien llama cada minuto a
`POST /api/cron/tick` de la web con `Authorization: Bearer <CRON_SECRET>`,
y la ruta (`apps/web/app/api/cron/tick/route.ts`, `maxDuration` 60 s)
corre **un turno** de 45 s con `runTick` (`src/tick.ts`, exportado como
`@mc/worker/tick`):

1. **Programa** lo que toca: la pasada de `--once`, con los mismos crons
   de `job_definition` y `job_run` como cola. Cada corrida se reclama
   (arriba): dos turnos solapados, o uno repetido, no duplican nada.
2. **Procesa** lo vencido, `outbound.dispatch` primero (`TICK_FIRST`: un
   toque atrasado es lo único que nota un cliente), hasta tres corridas a
   la vez, y no empieza ninguna si quedan menos de 10 s. Lo encadenado no
   se adelanta a lo de arriba: si `collect.post_metrics` y
   `compute.baseline` están vencidos a la vez, el segundo espera a que el
   primero termine y corre como su encadenado, con los datos nuevos. Un
   fallo espera su backoff antes del reintento, el mismo que el proceso
   largo (`WORKER_RETRY_DELAY_S`·2^(intentos−1), con techo
   `WORKER_RETRY_DELAY_MAX_S`): un proveedor caído no recibe un golpe por
   minuto; mientras espera, el resumen lo deja en `left` con `backoff`.
   (Solo el turno lo pide, con `RunOnceOptions.backoff`; `--once` sigue
   reintentando en la pasada siguiente, como siempre.) Una corrida que
   lanza fuera de su job —la base falla al reclamarla, al leer la cuota o
   al cerrar su fila— no tumba el turno: queda en el log con su job, en
   `left` con `error`, y los demás recorredores terminan lo suyo antes de
   responder. Cada corrida recibe como `timeout_s`
   lo que queda del turno: la que se mide por su timeout termina sola
   (`outbound.dispatch` deja de reclamar y devuelve a su cola lo que no
   intentó); la que se pasa termina `failed`, `error = timeout`,
   `metadata.tickCut = true` (en la misma escritura que cierra la fila:
   otro turno nunca la ve como un intento), que **no gasta un intento**: el turno
   siguiente la retoma (`reason: resume`), hasta 20 cortes por tick del
   cron (`MAX_TICK_CUTS`). Lo que no llegó a empezar sigue vencido. Una
   fila de un turno muerto (Vercel lo mató, un redeploy) deja de estar
   viva a los `sliceS + 30 s`, el timeout que tuvo en el turno y que queda
   en la metadata del reclamo, no a los `timeout_s` de su definición
   (600 s en `collect.post_metrics`): no hay zombis.
3. **Responde** con el resumen (`TickSummary`: qué corrió, con qué
   estado, cuánto tardó, qué quedó y por qué) y deja **una línea** en el
   log de Vercel (`[cron/tick] {…}`). El logger del worker, sin
   `LOG_LEVEL`, solo escribe avisos y errores. `planMs` es lo que tardó
   la planificación y `orphanedBossJobs`, lo que espera en `pgboss.job`
   (abajo).

Sin nada vencido, el turno son cuatro consultas seguidas por **una sola
conexión** (el rol, las definiciones, el estado de todos los ticks en una
consulta y `pgboss.job`) y sale: Vercel Hobby cobra la CPU activa y aquí
no se espera a nada. `platform.limits` (la cuota de CON-1) se lee una vez
por instancia cada 5 min (`TICK_LIMITS_TTL_MS`, `tickQuota` en
`src/tick.ts`), no en cada turno; sus «entrada ignorada» (las de la
migración 0011) van a `debug`, con **un** aviso por instancia que dice
cuántas son, en vez de siete líneas por minuto en el log de Vercel. Y la
ruta carga el worker (~0,6 MB) con `import()` **después** de comprobar el
Bearer: un 401 a la URL pública no paga su arranque en frío
(`revisar-bundle-turno.mjs` falla el build si vuelve a los chunks de
carga siempre). El objetivo es **menos de 300 ms de pared**: tras el
despliegue, `make cron.status` enseña las últimas respuestas, con su
`elapsedMs` y su `planMs`. Los
handlers, el `SET ROLE mc_worker`, los secretos y los refreshers son los
del proceso (`src/recursos.ts`). **El turno y el proceso largo no se
encienden a la vez**: pg-boss no mira `job_run` y correrían dos veces
(dos generaciones con Anthropic, avisos duplicados). No lo dice solo
este README, lo impide la base (`src/runner/exclusion.ts`):

- El proceso largo (`start`, sin `--once`) toma al arrancar, en una
  conexión suya que retiene mientras vive,
  `pg_try_advisory_lock(hashtextextended('mc-worker:proceso-largo', 0))`.
  Si otro proceso largo ya lo tiene, no arranca (sale con 2 y el motivo).
  Si esa conexión se cae, el worker se detiene y sale con 1: sin el
  candado el turno ya no lo ve.
- El turno, antes de hacer nada, mira en `pg_locks` si ese candado lo
  tiene otra sesión. Si lo tiene, no corre nada: responde
  `left: [{ job: '*', reason: 'running' }]` y deja un aviso en el log.
  Mira `pg_locks` en vez de tomar el candado para que dos turnos
  solapados no se bloqueen entre sí.
- El proceso largo tampoco arranca si `job_run` tiene corridas de turnos
  (`bossJobId` `tick:…` o `metadata.sliceS`) de los últimos 5 min: el
  cron de Supabase está instalado contra esa base. Es justo el caso de
  un `pnpm --filter @mc/worker start` con el `.env.local` de
  `make db.unlock`, que apunta a **producción**. `make cron.uninstall`
  apaga el turno; `WORKER_ALLOW_WITH_TICK=1` arranca igual, a sabiendas.

La conexión del candado es una más del modo sesión del pooler (de las
15 por usuario y base) mientras viva el proceso largo. En PGlite (una
sola sesión) el candado no se ve desde el turno; lo prueba
`test/tick-postgres.test.ts` contra Postgres de verdad.

Lo que conviene saber de un turno de 45 s:

- `outbound.dispatch` y `outbound.replies` se guardan un margen antes de
  su timeout para no empezar un envío que no pueda acabar. Es el menor
  entre 30 s y el 25 % del timeout (`src/jobs/ventas/plazo.ts`): en el
  proceso largo (120 s) siguen siendo 30 s y 45 toques por pasada; en un
  turno (unos 40 s) son 10 s de margen y unos **15 toques por pasada**,
  cada dos minutos, unos 450 por hora para todos los workspaces. Con el
  margen fijo eran 5 toques y 150 por hora. La metadata de cada corrida
  dice cuántos podía reclamar (`claimBudget`). Si hace falta más, la
  palanca es la opción A (Pro: `maxDuration` y `TICK_BUDGET_MS` más
  largos).
- Un job que tarde más de lo que da el turno tiene que poder retomarse
  (revisar `ctx.signal` y saltarse lo ya hecho), como los de CON-5. El
  runner no puede matar un handler: si no mira la señal, sigue vivo con
  su conexión después del corte. Por eso todos los de Ventas la miran
  (`sales.follow_ups`, `outbound.alerts` y `sales.channels_release`
  desde CIM-7 r3; el primero, que es una transacción, lleva además un
  `statement_timeout` para que la base corte lo que siga vivo,
  `src/jobs/ventas/plazo.ts`).
- **En modo por turnos no hay trabajo a demanda.** El turno solo corre lo
  que el cron de `job_definition` dice que está vencido: un
  `boss.send(...)` (un «Recalcular» desde una pantalla, como el previsto
  para `campaign.compute`) no lo procesa nadie, y **una fila escrita a
  mano en `job_run` no lo pide**: `job_run` no tiene un estado de cola
  (su CHECK es `running/ok/failed/skipped/partial`) y una fila `ok` o
  `skipped` dejaría el tick por cubierto y SALTARÍA la corrida del cron.
  Para algo a demanda: esperar al cron, o correr
  `pnpm --filter @mc/worker once` a mano con la base de producción. Si
  hace falta de verdad, es una historia aparte: una tabla (o estado) de
  peticiones que `runOnce` consuma con el mismo `claimRun`. Para que un
  `boss.send` no pase en silencio, cada turno cuenta lo que espera en
  `pgboss.job` (`created` o `retry`), lo devuelve en `orphanedBossJobs` y
  avisa en el log si es más de 0. Para eso `mc_worker` tiene que poder
  leer `pgboss.job`, y pg-boss crea su esquema con el rol de conexión de
  `--install`, no con `mc_worker`: sin el GRANT
  ([CON-2 §«El turno y pgboss.job»](../../../docs/propuestas/CON-2.md))
  el turno devuelve `orphanedBossJobs: 'unreadable'` (no `null`, que es
  «no hay esquema») y avisa una vez por instancia con el GRANT que falta.
- **Conexiones.** El pool del turno es `2 × TICK_CONCURRENCY + 1` = 7:
  una corrida puede tener una transacción abierta y pedir otra conexión
  a la vez (`api_call_log` se escribe con `ctx.db`). Dos turnos
  solapados son 14, dentro de las 15 de modo sesión que el pooler de
  Supabase da por usuario. `WORKER_JOB_POOL_MAX` lo cambia; por debajo de
  7 un turno puede quedarse esperando conexión hasta el corte.
- **Nada espera para siempre** (`openTickDatabase` en `src/tick.ts`).
  Una conexión nueva se espera como mucho 5 s
  (`TICK_CONNECT_TIMEOUT_MS`): con el pooler colgado o sin clientes, el
  turno falla con su motivo en vez de quedarse hasta que Vercel mate la
  función. Cada conexión del turno fija, junto al `SET ROLE` y en la
  misma ida y vuelta, `statement_timeout` e
  `idle_in_transaction_session_timeout` iguales al presupuesto (45 s): un
  job cortado que no mira la señal, o metido en una sentencia larga
  (`compute.trait_lift`, `compute.baseline`), suelta su conexión de modo
  sesión a más tardar 45 s después, aunque la función quede congelada.
  Y la ruta no espera al turno más de `TICK_BUDGET_MS + TICK_CLOSE_MS`
  (48 s): si no respondió, contesta **504** y deja en el log «el turno
  no respondió a tiempo», que `make cron.status` traduce.
- **En local, el turno no toca producción.** `pnpm --filter @mc/web dev`
  carga el `.env.local` de `make db.unlock`, que apunta al Supabase de
  producción: un `curl` a la ruta correría el turno de verdad, en
  paralelo con el cron, con correo real. Por eso `runTickFromEnv` se
  niega (`ConfigError`) a correr contra una base que no es de esta
  máquina fuera del despliegue de producción de Vercel
  (`VERCEL_ENV=production`), salvo `TICK_ALLOW_REMOTE=1` a sabiendas.
  En modo real el correo no se reclama si `APP_URL` no es un origen
  https público (`publicAppUrl` en `jobs/ventas/canales`): con
  `http://localhost:3100`, el enlace de baja no abriría. La receta para
  probar la ruta en local está justo debajo de esta lista.
- **La salud** (`pnpm --filter @mc/worker salud`) no cuenta un corte como
  fallo: `failedSinceOk` los salta y, si la última corrida fue un corte,
  dice «cortado por el turno, se retoma» (`lastCut` en
  `@mc/db/queries/worker`). Salvo que no quepa nunca: con 20 cortes o más
  desde su última corrida buena (`cutsSinceOk` ≥ `MAX_TICK_CUTS`) dice
  «no cabe en el turno (N cortes): súbelo a Pro o pártelo», porque no se
  va a retomar (cada tick del cron agota sus cortes y espera al
  siguiente). `make cron.status` lo pone en rojo (`no_caben`).

**Probar la ruta de punta a punta en local**, contra el Postgres de
Docker y sin tocar producción (desde `platform/`):

```bash
make up && make seed
export CRON_SECRET=$(openssl rand -hex 32)
CRON_SECRET=$CRON_SECRET WORKER_DATABASE_URL=postgres://mc:mc@localhost:5432/oncue \
  SECRET_STORE=memory TOKEN_REFRESHER=fake OUTREACH_CHANNELS=fake \
  pnpm --filter @mc/web dev --port 3100
# en otra terminal, con el mismo CRON_SECRET exportado:
curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" localhost:3100/api/cron/tick
```

`SECRET_STORE=memory` y `TOKEN_REFRESHER=fake` porque en local no hay
`TOKEN_ENCRYPTION_KEY` ni apps de OAuth; `OUTREACH_CHANNELS=fake` saca
los toques de la demo por el canal falso. Sin Bearer, o con otro, la
misma llamada da 401. **Con `next start` no vale lo mismo**: pone
`NODE_ENV=production`, y ahí el canal falso está prohibido (la ruta
responde 500 con «OUTREACH_CHANNELS=fake no se permite en producción»
en el log). Con `next start`, quita `OUTREACH_CHANNELS` y deja los
canales en real sin llaves: salen como «no configurado» y sus toques
esperan.

**Lo que se tocó en `src/runner/` (carpeta de Nicolás), y por qué.** El
turno es la misma pasada que `--once`: la pila de pendientes, el
encadenado, la regla de reintento y el reclamo tenían que ser los mismos,
y envolver `runOnce` desde `src/tick.ts` no bastaba (el presupuesto y el
reclamo atómico ocurren entre corrida y corrida, dentro del bucle).
Copiarlo en `tick.ts` era duplicar la lógica, que el enunciado prohíbe.
Lo que `--once` no usa vive FUERA de `runner/`, en
`src/turno/recorrer.ts` (el presupuesto, los tres recorredores con
`blockedBy`, `outbound.dispatch` primero), y entra en `runOnce` por un
punto de extensión pequeño, `walk`; `--once` usa `sequentialWalk`, el
bucle de siempre. En `runner/` queda lo que de verdad comparten, en
**dos pull requests** para que Nicolás revise primero lo imprescindible y
aparte lo que solo mejora:

**PR 1 · lo imprescindible** (rama `rasheed/CIM-7-runner-1`, sobre
`rasheed/integracion`; sin él el turno no es correcto):

| Archivo | Qué | Por qué |
|---|---|---|
| `once.ts` | `claimRun`: candado por job (`pg_advisory_xact_lock`) + relectura del estado + fila `running`, en una transacción | Dos turnos solapados no corren dos veces lo mismo. Sin él, en Postgres real, las dos pasadas reclaman (`test/tick-postgres.test.ts`, `test/once-reclamo.test.ts`) |
| `once.ts` | `walk` en `RunOnceOptions` (`WalkControl`: la pila, `run(item, deadline?)`, `skip`), `sequentialWalk`; `sliceS` en el reclamo; `tickCut` en `closeMetadata`; los cortes (`cuts`, `MAX_TICK_CUTS`) en el estado del tick | El punto de extensión del turno (`src/turno/recorrer.ts`). Sin `walk` (`--once`), el mismo bucle que antes |
| `run.ts` | `RunInput.runId` y `RunInput.closeMetadata` | Abrir la fila en el reclamo y marcar `tickCut`/`noRetry` en la escritura que la cierra |
| `worker.ts` | `JOB_LOCK_PREFIX` y `recordSkipped` bajo ese candado | Dos turnos no dejan dos filas «sin handler» |
| `db.ts` | `connectionTimeoutMillis` y `sessionTimeoutMs` opcionales en `PostgresDatabaseOptions`; el `SET ROLE` y los timeouts en una sola consulta | Solo los pasa el turno; sin ellos, el proceso largo queda igual |
| `salud.ts` | «cortado por el turno, se retoma», o «no cabe en el turno» con `MAX_TICK_CUTS` cortes | La salud no enseña como fallo un job sano que se retoma, ni como sano uno que no va a terminar |

**PR 2 · lo opcional** (rama `rasheed/CIM-7-runner-2`, sobre el PR 1; no
cambia lo que hacen `--once` ni el proceso largo):

| Archivo | Qué | Por qué |
|---|---|---|
| `comun.ts` (nuevo) | `EXPIRE_MARGIN_S`, `JOB_LOCK_PREFIX`, `SKIPPED_NO_HANDLER`, `RoleError`, `assertRole`, `createQuota`, `recordSkipped`, **movidos tal cual**; `worker.ts` y `boss.ts` los reexportan con sus nombres | El turno los usa sin importar `worker.ts`/`boss.ts`, que arrastraban pg-boss entero a su bundle (de 1,15 MB a 0,59 MB; el build falla si vuelve: `apps/web/scripts/revisar-bundle-turno.mjs`) |
| `once.ts` | `planOnce` lee el estado de todos los ticks en una consulta (`tickStates`), la fila «sin handler» solo cuando falta, y la cuota solo si algo corre | Un turno vacío, una conexión y cuatro consultas, no una por definición |
| `once.ts` | `RunOnceOptions.backoff` (`verdict` con `lastFailedAt`, `retryDelayMs`), **opcional y apagado por defecto** | El turno pasa cada minuto y pide la espera entre reintentos del proceso largo (pg-boss); `--once` no la pasa y reintenta en la pasada siguiente, como siempre |

Si Nicolás no quiere el PR 2, el turno se adapta sin tocar `runner/`:
pierde la espera entre reintentos (un proveedor caído recibe
`max_attempts` golpes en `max_attempts` minutos), pg-boss vuelve a su
chunk dinámico (lo paga cada turno con Bearer, no un 401) y un turno
vacío hace una consulta por definición.

**Cambios que también ven el proceso largo y `--once`** (fuera de
`runner/`, y por eso no en la tabla de arriba). Ninguno cambia lo que
pasa en producción con la configuración de hoy, pero no es cierto que
«no pasen por nada de esto»:

| Dónde | Qué cambia para el proceso largo y `--once` |
|---|---|
| `jobs/ventas/canales` (`publicAppUrl`) | Con canales reales y un `APP_URL` que no es https público (`http://…`, `localhost`), `outbound.dispatch` deja de reclamar correo y lo avisa: antes lo enviaba con un enlace de baja que no abría. Con un https público reclama lo mismo que antes (`test/outreach-canales.test.ts`) |
| `jobs/ventas/seguimientos.ts` | `sales.follow_ups` fija `statement_timeout` a su plazo dentro de su transacción: una sentencia colgada la corta la base |
| `outbound.alerts`, `canales.release`, `seguimientos` | Miran `ctx.signal`: al apagar el proceso (SIGTERM) o al vencer su `timeout_s`, alerts y release paran entre un workspace (o una cuenta) y el siguiente y devuelven lo hecho, y `sales.follow_ups` deshace su transacción (es idempotente: la corrida siguiente deja lo mismo), en vez de seguir detrás del runner |
| `jobs/ventas/plazo.ts` | El margen de `outbound.dispatch` y `outbound.replies` es el menor entre 30 s y el 25 % del timeout: con los 120 s del proceso largo siguen siendo 30 s |
| `recordSkipped` | La misma fila «sin handler», ahora dentro de una transacción con candado |
| `--once` | Nada más: sin `backoff` (apagado por defecto) reintenta como antes; `planMs`, `durationMs` y `cut` son campos nuevos del resumen |

**Pendiente: la revisión de Nicolás antes del merge a `main`**, con su
aprobación explícita en el PR 1 (y, si lo quiere, en el PR 2) antes de
integrar el resto de CIM-7. Los dos PR llevan estas tablas en la
descripción y a Nicolás como revisor obligatorio; los abre quien integra
(los agentes no empujan ni abren PR), y el enlace va a la nota de CIM-7
en `apps/web/content/backlog.ts`.

**Variables en Vercel** (production), además de las que ya tiene la web:

| Variable | Qué es | Cómo se pone |
|---|---|---|
| `CRON_SECRET` | El Bearer de la ruta. **El mismo valor** que en el Vault de Supabase. Sin él (o con menos de 32 caracteres) la ruta responde 401 a todos. | `openssl rand -hex 32` en tu terminal (a un gestor de contraseñas, no a un archivo) y `make vercel.run ARGS="env add CRON_SECRET production"`, que lo pide por teclado (nunca como argumento: saldría en `ps` y en el historial) |
| `WORKER_DATABASE_URL` | La conexión del worker: pooler en **modo sesión** (`:5432`, el turno rechaza `:6543`), rol miembro de `mc_worker`. La buena es `mc_worker_login` de [WRK §1.1](../../../docs/propuestas/WRK.md): `DATABASE_URL_DIRECT` (`mc_migrator`) también sirve, pero puede hacer DDL y no debe vivir en Vercel. | `make vercel.run ARGS="env add WORKER_DATABASE_URL production"` |
| `TOKEN_ENCRYPTION_KEY`, `APP_URL` | Ya están: descifrar tokens y el enlace de baja. | — |
| `GOOGLE_OUTREACH_CLIENT_ID/SECRET`, `UNIPILE_DSN`, `UNIPILE_ACCESS_TOKEN`, `ANTHROPIC_API_KEY` | Los canales y el modelo del outreach. Sin ellas su canal queda «no configurado» y sus toques esperan. | `.env.example` dice de dónde sale cada una |

Tras cambiar variables, `make vercel.deploy PROD=1`.

**Opción B, hoy (Vercel Hobby + pg_cron de Supabase).** Hobby no deja un
Vercel Cron por minuto, así que llama Supabase. `make cron.install` hace
tres llamadas, en este orden, para que la tarea nunca dispare sin
secreto: `db/ops/cron-tick-vault.sql` comprueba que Vault está (sin
secretos); `db/ops/cron-tick-secreto.sql` guarda el secreto en
**Supabase Vault** (`on_cue_cron_secret`; la tarea lo lee de
`vault.decrypted_secrets` al disparar, en `cron.job` no queda el valor);
y `db/ops/cron-tick.sql` crea `pg_cron` y `pg_net` si faltan y programa
`on-cue-tick` cada minuto con `net.http_post`, que además no llama si el
secreto falta (`WHERE EXISTS`). Programa también `on-cue-tick-purga`, a
diario a las 03:17 UTC, que borra de `cron.job_run_details` lo de más
de 7 días: pg_cron deja una fila por disparo (1.440 al día) y nadie la
purga; `net._http_response` caduca sola.
El secreto va solo y en dos `SELECT` de nivel superior, sin bloque `DO`:
`pg_stat_statements` normaliza sus literales a `$1`, y un fallo del lote
de pg_cron no puede arrastrarlo al log de Postgres. Si la API rechaza
ese lote, `scripts/cron-tick.sh` no copia su respuesta (Postgres cita la
sentencia, `LINE 1: … update_secret(id, '<secreto>')`): imprime la
primera línea con el valor cambiado por `***`. Un matiz propio de
pg_net: `net.http_post` deja la petición, con su cabecera
`Authorization` en claro, en `net.http_request_queue` hasta que su
worker la manda (milisegundos); esa tabla solo la lee `postgres`, y
`make cron.status` cuenta sus filas (`cola_pg_net`) y avisa si crece
(pg_net atascado). Lo corre el dueño, con el token de administración:

```bash
cd platform
make cron.install      # pide CRON_SECRET sin mostrarlo (el mismo de Vercel); APP_URL=https://… para otra URL
make cron.status       # el estado en JSON y un veredicto en verde o en rojo (sale con 1 si no está sano)
```

`make cron.status` termina con **una línea de veredicto**
(`db/ops/cron-tick-veredicto.mjs`, sobre las respuestas de pg_net de los
últimos 5 min). **Decide la más reciente**, y para el error solo
cuentan las posteriores al último cambio del secreto en Vault
(`secreto_en_vault[0].updated_at`): un 401 que ya arregló
`make cron.install` no deja el chequeo en rojo, y las fallidas de antes
de la última salen como aviso. La más reciente 200 → «el turno responde»
con su `elapsedMs` medio; un **401** → el `CRON_SECRET` del Vault no es el de Vercel
(`make cron.install` con el de Vercel); un **500** → el turno falla,
mira los logs de Vercel (`[cron/tick]`; lo típico es que falte
`WORKER_DATABASE_URL`); un **504** → el turno no respondió a tiempo
(pooler colgado); `timed_out` → la ruta tarda más de 60 s; ninguna
respuesta → pg_cron no está disparando, salvo si el secreto cambió o la
tarea corrió por primera vez hace menos de 2 min: entonces es un aviso
(«Recién instalado: el primer turno llega en 1–2 min»), y
`make cron.install`, que llama a status al terminar, acaba en verde;
**jobs que no caben** → los que
llevan 20 cortes o más sin una corrida buena (`no_caben`), que no se van
a retomar solos. Avisa además si `outbound.dispatch` lleva más de 30 min
sin una pasada buena, si la cola de pg_net crece, y si la memoria
proyectada del mes pasa de 250 GB-h (abajo, «Cupos de Hobby»); si no,
dice en verde cuántos GB-h lleva camino de gastar. Sale con 1 si no está
sano: sirve de chequeo (a mano tras integrar, o desde cualquier cron que
avise).

Es idempotente: correrlo otra vez actualiza el secreto y deja una sola
tarea. Rotar el secreto es `make cron.install` con el nuevo y el mismo
valor en Vercel. `make cron.install` y `make cron.status` miran además
que en `pg_stat_statements` no haya ninguna llamada a Vault con el
literal (`db/ops/cron-tick-huellas.sql`); si la hubiera, dicen cómo
limpiarla (`pg_stat_statements_reset()`) y que hay que rotar.

**Cupos de Hobby, con números.** En Hobby, pasarse de un cupo **pausa
el proyecto entero** —la web del cliente incluida— hasta el mes
siguiente; no se paga el exceso. Lo que gasta el turno (llamada cada
minuto, función de 2 GB, que es el tamaño por defecto de Vercel):

| Cupo de Hobby al mes | Lo que gasta el turno | Cuenta |
|---|---|---|
| 1 000 000 invocaciones | **43 200** (4 %) | 1 440 llamadas al día × 30 |
| 360 GB-h de memoria aprovisionada | **24 GB-h por cada segundo de turno medio**: ~7 GB-h con turnos vacíos (~0,3 s), 240 GB-h a 10 s de media, **360 a 15 s**. Con turnos de ~40 s en la mitad de los minutos (media ~20 s), ~480: pausa | `elapsedMs` medio / 1000 × 43 200 × 2 GB / 3 600 |
| 4 h de CPU activa | Solo se ve en Vercel → Usage (el turno no la puede medir): cabe si la media es menor de **0,33 s de CPU por turno** (14 400 s / 43 200). Un turno es casi todo espera de red (Supabase, proveedores, Anthropic), así que la CPU es una fracción de su duración, pero cada turno abre su pool con TLS y cada arranque en frío carga el worker | 4 × 3 600 / 43 200 |

La web del cliente gasta de los mismos cupos. `make cron.status`
proyecta los GB-h del mes con la media de lo que guarda pg_net (unas 6 h
de respuestas) y avisa por encima de **250 GB-h** (unos 10 s de turno
medio). **Umbral para pasar a la opción A**: ese aviso, o la CPU activa
del mes por encima de ~2,5 h en Vercel → Usage, o cuando haya outreach de
verdad (varios workspaces con `generate`/`review`/`intent` llamando al
modelo cada 2–3 minutos: cada llamada es espera y alarga el turno). Y un
matiz que no es técnico: según los términos de Vercel, **Hobby es para
uso personal y no comercial**; On Cue cobra a sus clientes, así que la
opción B sirve para arrancar y probar, no para operar con clientes que
pagan. La decisión es de Rasheed y queda aquí con los números.

**Opción A, después (Vercel Pro + Vercel Cron).** Cambia solo quién
llama. Vercel Cron llama por **GET** y manda `Authorization: Bearer
$CRON_SECRET` solo, y la ruta acepta GET igual que POST:

1. `apps/web/vercel.json`:
   ```json
   { "crons": [{ "path": "/api/cron/tick", "schedule": "* * * * *" }] }
   ```
2. `make vercel.deploy PROD=1` y comprobar en Vercel → Cron Jobs que corre.
3. `make cron.uninstall`: retira las tareas de pg_cron (`on-cue-tick` y
   su purga) y borra su secreto del Vault. Con los dos encendidos no se duplica nada (cada corrida se
   reclama), pero se paga el doble de invocaciones.
4. Con Pro, si hace falta más aire: subir `maxDuration` en `route.ts` y
   `TICK_BUDGET_MS` en `app/api/cron/tick/_lib/turno.ts` a la par
   (el turno debe acabar unos 15 s antes).

## Variables de entorno (nombres, no valores)

| Variable | Para qué | Por defecto |
|---|---|---|
| `DATABASE_URL_DIRECT` | Conexión en **modo sesión** (pooler :5432). pg-boss y `SET ROLE` necesitan una sesión estable; el worker rechaza :6543. | obligatoria |
| `WORKER_DATABASE_URL` | Sustituye a la anterior cuando exista un rol de login propio del worker. | — |
| `WORKER_SET_ROLE` | Rol que asumen las consultas de negocio tras conectar. `none` para no cambiar. | `mc_worker` |
| `WORKER_GROUPS` | Grupos (`job_definition.queue`) que atiende este proceso: `collect,connections`. | todos |
| `WORKER_POLL_S` | Cada cuánto pregunta pg-boss por trabajo (≥ 0,5). | `2` |
| `WORKER_RETRY_DELAY_S` / `WORKER_RETRY_DELAY_MAX_S` | Base y tope del backoff exponencial entre reintentos. | `30` / `900` |
| `WORKER_STOP_TIMEOUT_S` | Cuánto espera a los jobs activos al recibir SIGTERM. | `30` |
| `WORKER_BOSS_SCHEMA` | Esquema de pg-boss. | `pgboss` |
| `WORKER_JOB_POOL_MAX` / `WORKER_BOSS_POOL_MAX` | Tamaño de los dos pools. | `8` / `4` |
| `OAUTH_REFRESH_MARGIN_MINUTES` | Con cuánta anticipación renueva `oauth.refresh` (tokens de horas: TikTok 24 h, YouTube 1 h). | `30` |
| `OAUTH_REFRESH_MARGIN_MINUTES_INSTAGRAM` | Margen para Instagram, cuyo token dura 60 días y Meta solo renueva con más de 24 h de vida. | `10080` (7 días) |
| `SECRET_STORE` | `encrypted` (connection_secret cifrado con `TOKEN_ENCRYPTION_KEY`, el real desde CON-3), `env` (lee `env:NOMBRE`) o `memory`. | `encrypted` |
| `TOKEN_ENCRYPTION_KEY` | 32 bytes en base64 (la del vault). Sin ella el worker no arranca; `_V2` y `_CURRENT` para rotar. | obligatoria |
| `TOKEN_REFRESHER` | `real` (TikTok, Instagram y YouTube sobre el cliente de CON-1) o `fake`. | `real` |
| `TIKTOK_LOGIN_CLIENT_KEY`, `TIKTOK_LOGIN_CLIENT_SECRET`, `TIKTOK_BUSINESS_APP_ID`, `TIKTOK_BUSINESS_APP_SECRET`, `META_APP_ID`, `META_APP_SECRET` | Las apps con las que se renueva cada token. Sin una app, sus conexiones fallan como `not_configured` (transitorio, sin reintento inmediato) y el arranque lo avisa. | — |
| `PGSSLROOTCERT` | Ruta al CA de Supabase; relativa a `platform/`. | `db/certs/supabase-root-2021.crt` |
| `LOG_LEVEL` / `LOG_FORMAT` | `debug|info|warn|error` · `json|pretty`. | `info` / `json` |
| `INSTAGRAM_HOUSE_TOKEN`, `GOOGLE_API_KEY` | `collect.account_metrics` (CON-10), `brand.snapshot` (CAM-3) y los dos `collect` de publicaciones (CON-5): el token de la cuenta profesional de On Cue para `business_discovery` y la API key de YouTube. Sin ellas la plataforma se salta y se avisa. | — |
| `GOOGLE_OUTREACH_CLIENT_ID`, `GOOGLE_OUTREACH_CLIENT_SECRET` | El cliente OAuth de Google SOLO del outreach (no el de YouTube, `GOOGLE_CLIENT_ID`): el adaptador de Gmail del motor de cadencias (VEN-10) lo usa para renovar un token de buzón vencido, y la liberación para revocarlo. Sin ellas, un correo con el token vencido queda como fallo transitorio. | — |
| `UNIPILE_DSN`, `UNIPILE_ACCESS_TOKEN` | LinkedIn e Instagram del motor de cadencias. Sin ellas esos canales no se reclaman: sus toques esperan en la cola. | — |
| `OUTREACH_CHANNELS` | `real` (Gmail y Unipile) o `fake` (buzón en memoria, nada sale de la máquina). `fake` solo contra Postgres embebido o una base local: contra Supabase, o con `NODE_ENV=production`, el worker no arranca. | `real` |
| `APP_URL` | Origen público de la web, para el enlace de baja de cada correo. Sin él (ni `VERCEL_PROJECT_PRODUCTION_URL`) el correo real no se reclama. | — |
| `COLLECT_POSTS_MAX` | Publicaciones nuevas por cuenta y corrida de `collect.posts`. | `25` |
| `COLLECT_MAX_AGE_HOURS` | Hasta qué edad se le sigue tomando lectura a una publicación. Por defecto 720 h (el último corte de `scoring.ts`) más siete días de gracia. | `888` |
| `COLLECT_YOUTUBE_UNITS_RESERVE` | Unidades de la cuota diaria de YouTube que `collect.post_metrics` no gasta, para que queden para la pantalla y un reintento. | `500` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | El refresher de YouTube (CON-8). Sin ellas sus renovaciones fallan como transitorio `not_configured`, nombrando la variable, y no se toca el estado de la cuenta. | — |

`make worker`, `humo` e `install-schema` cargan solo `platform/.env.local`
(lo que escribe `make db.unlock`) con `--env-file-if-exists`; no hay
dependencia de dotenv. `platform/.env` (el Postgres de Docker de
`.env.example`) no se lee: para apuntar el worker ahí, `WORKER_DATABASE_URL`
en `.env.local`.

Si Postgres rechaza las credenciales (`28P01`) o no se llega al host,
`dev` y `humo` lo dicen en una línea con el comando que lo arregla
(`make db.unlock`, `make db.info`) en vez del stack de `pg`; `humo` sale
con 2 y `dev` con 0, por la misma razón que arriba.

## Cómo agregar un job en tu módulo

```ts
// apps/worker/src/jobs/finanzas/recordatorios.ts
import { defineJob } from '../../runner/registry.ts';

export const recordatoriosJob = defineJob('finance.reminders', async (payload, ctx) => {
  const { rows } = await ctx.db.query('SELECT … FROM invoice WHERE workspace_id = $1 AND …', [ctx.workspaceId]);
  // … trabajo …
  return { processed: rows.length, failed: 0, metadata: { invoices: rows.map((r) => r.id) } };
});
```

```ts
// apps/worker/src/jobs/finanzas/index.ts
export const finanzasJobs = [recordatoriosJob];
// apps/worker/src/jobs/index.ts — la única línea fuera de tu carpeta
export const allJobs = [...conexionesJobs, ...finanzasJobs];
```

Reglas:

- El id (`finance.reminders`) tiene que existir en `job_definition`. De
  ahí salen cola, cron, `timeout_s`, `max_attempts` y `max_concurrency`.
  Si necesitas una fila nueva, es una migración (Rasheed).
- `max_concurrency` es la concurrencia **dentro** de una corrida (por
  plataforma, contra el rate limit de cada API): léelo en
  `ctx.definition.maxConcurrency`. Por defecto corre **una** instancia
  del job a la vez por proceso. Un job con un envío por entidad (un
  video, una factura) puede pedir `defineJob(id, fn, { instances: 'max' })`.
- Un job con cron tiene cola `stately`: un tick en cola y uno activo, así
  las corridas no se apilan ni se solapan aunque una tarde más que el
  intervalo. Si desde una pantalla encolas un envío manual en esa cola y
  no quieres que colapse con el cron, pásale su propio `singletonKey`.
- Si devuelves `failed > 0`, pg-boss reintenta (hasta `max_attempts`)
  salvo que devuelvas `retry: false`: hazlo cuando un reintento
  inmediato no ayude (rate limit con `Retry-After`, conector sin
  implementar). El siguiente tick del cron es el reintento.
- `ctx.db` corre como **`mc_worker`, que se salta RLS**. Cada escritura
  filtra por `workspace_id` explícitamente. Un `UPDATE` sin ese `WHERE`
  toca todos los clientes.
- **El worker no aplica alcance** (ACC-6). `membership_scope` acota lo
  que ve una PERSONA en la web; un job no es una persona:
  `scope_allows()` no encuentra filas sin `current_user_id()` y deja
  pasar todo, y ningún archivo de `src/` compone `scopeFilter()`
  (`packages/db/test/alcance-convencion.test.ts` lo comprueba). Lo que
  un job escriba, la web lo filtra al leer.
- Devuelve `{ processed, failed, metadata? }`. `metadata` va a
  `job_run.metadata` pasando por el redactor: ids y fechas sí, tokens
  jamás.
- Revisa `ctx.signal` en bucles largos: se dispara al vencer `timeout_s`
  y al apagar el worker.
- **Encadenamiento**: si tu job tiene que correr DESPUÉS de otro, no lo
  resuelvas con la hora del cron; decláralo:
  `defineJob('compute.baseline', fn, { after: ['collect.post_metrics'] })`.
  Cuando el de arriba termina `ok` o `partial` con `processed > 0`
  (hubo datos), el runner
  encola el tuyo con el mismo `workspaceId` (sin él, para todos),
  `singletonKey` `tras:<workspace>` y `{ source: 'chain', after }` en el
  payload, que llega a `job_run.metadata.tras`. Ni un `failed` ni un
  `ok` que no procesó nada encadenan.
  El cron se queda como red de seguridad, así que el job tiene que ser
  idempotente. Un `after` a un job no registrado o un ciclo impiden
  arrancar.
- Para encolar desde fuera del cron: `boss.send('finance.reminders',
  { workspaceId, entityType: 'invoice', entityId })`. Esos tres campos
  del payload se copian a `job_run`.
- Nada de `console.log`: usa `ctx.logger` (eslint lo impone). Todo lo
  que imprime pasa por el redactor.
- Las APIs de las plataformas se llaman por `ctx.connectors` (CON-1):
  `ctx.connectors.tiktokDisplay({ connectionId, tokens })`, `.instagram(…)`,
  `.youtube(…)`, `.tiktokAccounts(…, businessId)`. Cada intento deja su
  fila en `api_call_log` con el `connection_id`, la cuota es una por
  proceso (`api_quota_usage`) y las llamadas llevan `ctx.signal`. Un
  error sale como `PlatformApiError` con `kind`: `auth` → pasa la
  conexión a `needs_reauth`; `quota` → devuelve `retry: false`;
  `transient` → cuenta como fallo y pg-boss reintenta; `permanent` →
  el elemento falla y la conexión no se toca. Una llamada que no pasa
  por un conector se registra con `ctx.callLog.record(...)`. Detalle en
  `packages/connectors/README.md`.

## Motor de cadencias (Ventas, VEN-10)

Dos jobs de `src/jobs/ventas/`, programados por `job_definition` en la
migración 0056 (grupo `sales`). Las consultas viven en
`packages/db/src/queries/outreach/` (`enroll`, `claim`, `send`,
`replies`), la programación pura en `packages/core/src/outreach/`.

| Job | Cada | Qué hace |
|---|---|---|
| `outbound.dispatch` | 2 min | Rescata zombis, reclama hasta 50 toques vencidos y los envía uno por uno (ver «El despachador», abajo). |
| `outbound.replies` | 5 min | Lee las respuestas de todos los hilos abiertos y aplica su efecto: respuesta, baja o fuera de oficina (ver «El lector de respuestas»). |
| `outbound.bounces` | 30 min | Los rebotes de Gmail (VEN-15), buzón por buzón con el `GmailChannel` del despachador: un rebote duro marca `contact.email_invalid`, cancela sus correos y cierra la cadencia en `bounced`. Sin llaves de Google, «canal no configurado». |
| `outbound.generate` | 2 min | Redacta con IA, primero, lo que una persona pidió desde el editor del pitch (con su pista y sus instrucciones) y después los borradores de los pasos con `generate_with_ai` cuya hora cae en el próximo día y cuyos pasos anteriores ya salieron; nunca para quien pidió la baja (también la de este espacio) o tiene el correo rebotado (VEN-12). Tras un fallo, espera 2, 8, 30 y 120 minutos; tras tres respuestas ilegibles del modelo se rinde y el toque de la cadencia queda retenido con `llm_error` (0063). La señal del job llega a la llamada al modelo y no empieza otro toque con menos de 90 s de plazo. Sin `ANTHROPIC_API_KEY`, esperan: «redacción con IA no configurada», y la web lo lee de `job_run` (`outreach_writer_status`). |
| `outbound.review` | 2 min (al minuto impar) | La puerta de calidad de cada borrador redactado: pre-vuelo, juez con la rúbrica del paso, hasta cinco regeneraciones y «enviar el mejor»; deja el toque en `scheduled` o `held` con su motivo (o en `draft` si lo pidió una persona), y cada intento en `outbound_review` con nota y lo que costó escribirlo y juzgarlo, numerado dentro de su corrida (`run`, 0063). Toma tres por corrida; si el plazo se acaba a mitad, escribe los intentos ya pagados antes de soltar el turno. No toma ni pisa un borrador cuyo texto escribió una persona (VEN-12). |
| `outbound.intent` | 3 min | La intención de cada respuesta nueva (VEN-14): primero devuelve lo que tenía fecha de vuelta (una pausa por «fuera de la oficina» a `active`; un «ahora no» de hace noventa días a la bandeja de aprobación, retenido con `cooldown_over`, nunca enviado solo). Después clasifica lo entrante sin clasificar con `claude-haiku-4-5-20251001` (o el clasificador falso con `OUTREACH_WRITER=fake`) y aplica sus efectos: interesado mueve el negocio a «En conversación» con «Responder hoy»; ahora no enfría el enrolamiento noventa días; fuera de oficina pausa hasta la fecha; baja marca las fichas del espacio; referido lo propone en la bandeja; ambigua (o confianza menor de 0,7) avisa para que una persona la lea. Cada llamada va a `outbound_llm_call` (`classify`) con la decisión guardada en la misma transacción, y mira el tope diario antes de gastar; el lote se reparte entre workspaces (cinco de cada uno como mucho) y uno sin presupuesto no entra. Nada se paga dos veces: una respuesta ilegible queda ambigua, y si aplicar los efectos falla se reintentan solo los efectos; al tercer fallo queda ambigua con un aviso. Sin `ANTHROPIC_API_KEY`, no clasifica y lo dice (la bandeja lo lee con `outreach_classifier_status`, 0070). |

**El despachador** (`outbound.dispatch`), en este orden:

1. **Zombis** de más de 5 min en `processing`: si nunca llegaron al
   proveedor (sin `send_started_at`) vuelven a la cola; si llegaron,
   `failed` y aviso, sin reenviar.
2. **Reclamo** con `UPDATE … RETURNING` de hasta 50 toques vencidos (o
   los que quepan en el tiempo de la corrida, a 2 s cada uno, hasta 30 s
   antes del timeout). Sin gastar intento ni plaza:
   - fuera de la ventana laboral o en fin de semana → a la apertura;
   - un paso no sale mientras uno anterior de su enrolamiento siga en la
     cola (programado, reclamado, retenido, o un borrador que espera al
     generador);
   - una dirección que falta o está mal escrita → `skipped`
     (`no_address`, `invalid_address`), sin tumbar el lote;
   - un correo a una dirección que rebotó para siempre
     (`contact.email_invalid`, VEN-15) → cancelado;
   - **la cuenta**: la del último envío del enrolamiento por ese
     canal (el hilo vive en ese buzón); si está caída, el mensaje espera.
     Sin envío previo, cualquier cuenta conectada del canal con plaza.
     Sin ninguna, espera una hora (un aviso por canal y día);
   - la marca que ya recibió `max_touches_per_company` mensajes en 90
     días → cancelado (`company_cap`); la que recibió uno hace menos de
     `min_days_between_touches` → espera;
   - todas las cuentas con el tope lleno → al siguiente día hábil del
     workspace, con los pasos de detrás. El tope de una cuenta es el de
     `outreach_channel_account_limits` (VEN-9) pasado por la curva de
     calentamiento de VEN-15, el mismo número que enseña
     `/ventas/politica`;
   - cabe hoy pero no respeta el ritmo de la cuenta (`effective_hourly`,
     `min_gap_seconds`, 0057 §1) → espera su turno.
3. **Envío**, uno por uno, en tres transacciones: la relectura (toque,
   enrolamiento, ficha, lista global, interruptor, cuenta) y la decisión;
   `send_started_at`, solo si toca enviar; y otra relectura con la
   composición (pie de VEN-15 con la página de baja y la dirección
   postal, `List-Unsubscribe` de un clic, el hilo) y el adaptador, con el
   enrolamiento bloqueado mientras dura el envío. Un error nuestro antes
   de marcar el envío deja el toque sin `send_started_at`: los zombis lo
   devuelven a la cola, sin aviso. Una respuesta en el hilo cuyo correo
   anterior no tiene hilo conocido se retiene (`reply_without_thread`):
   nunca sale un «Re:» sin In-Reply-To. Un paso que sale tarde arrastra a
   los de detrás.
4. **Resultado**: transitorio → reintento con espera creciente, dentro
   de la ventana, hasta 5; ambiguo (corte después de enviar) → antes de
   reintentar se pregunta al proveedor si salió (`findSent`), y si no lo
   sabe decir se retiene (`unconfirmed_attempt`) para que una persona
   diga en la ficha «Sí, salió» o «No salió: enviarlo» (0058); rebote →
   se cancela ese canal y la cadencia termina en `bounced`; cuenta caída
   o sin su token → espera sin gastar intento.
5. **Lo no intentado** (timeout, apagado) vuelve a la cola con su intento
   descontado, sin su enlace de baja y con su plaza, que vuelve al día en
   que se reservó (`caps_reserved_on`).

**El lector de respuestas** (`outbound.replies`): respaldo del webhook
de Unipile y única vía del correo. Lee todos los hilos de los últimos 30
días (también los de cadencias que ya respondieron o completaron) por
turno, en páginas de 200: primero los nunca leídos, después los que hace
más que no se leen (`replies_checked_at`). Lo que hace cada mensaje lo
decide `applyInboundEffects` de `@mc/db`, la misma función del webhook:

1. una respuesta detiene a la persona en TODAS sus secuencias del
   workspace (`replied`, lo pendiente cancelado) y, con
   `stop_company_on_reply` (0059, encendido por defecto), pone en pausa
   las cadencias de las demás personas de la misma marca;
2. una baja marca las fichas PROPIAS del workspace del hilo con ese
   correo y cancela lo suyo en cualquier secuencia de ese workspace,
   nunca de otro; una ficha pública no se marca: la protege su
   enrolamiento en `opted_out`;
3. si en un correo la pide un tercero en copia, la cadencia se detiene y
   se avisa para revisar;
4. un «fuera de oficina» (Auto-Submitted, X-Autoreply) se guarda sin
   cancelar ni avisar, salvo que pida la baja;
5. una respuesta de LinkedIn o Instagram que solo trae un adjunto (una
   foto, una nota de voz) es una respuesta, con el cuerpo `[adjunto]`,
   igual que por el webhook.

Antes de leer, busca el hilo de los correos que una persona confirmó a
mano («Sí, salió», 0058): con él, el lector lee ese hilo y la respuesta
del paso siguiente, que esperaba retenida, vuelve a la cola.

**El interruptor.** Apagar (`disable_outreach`) cancela lo programado y
lo retenido con `outreach_disabled` y deja vivas las cadencias;
encender (`enableOutreach`, desde la web o `--encender`) lo devuelve a
la cola (`replanOutreach`): cada mensaje a su estado de antes, con su
texto, y si ya venció, replanificado desde ahora con los mismos días
hábiles entre pasos.

Adaptadores en `src/jobs/ventas/canales/` con una sola interfaz
(`ChannelSender`, `ChannelReader`): Gmail y Unipile (LinkedIn e
Instagram) son adaptadores finos sobre los clientes de VEN-9 en
`@mc/connectors` (`GmailApi`, `UnipileApi`: su HTTP, su MIME, su
bitácora en `api_call_log` y sus errores), y `fake` para las pruebas y
la demo. Sin `GOOGLE_OUTREACH_CLIENT_ID/SECRET` el correo está «no configurado»
(no se reclama, no gasta intentos); sin `UNIPILE_DSN` y
`UNIPILE_ACCESS_TOKEN`, LinkedIn e Instagram. La guardia de
placeholders (`@mc/core`) corre en el punto de envío, sobre el mensaje
final (asunto y pie incluidos). `held_reason` guarda un código
(`@mc/core/outreach/messages`, `holdReasonText` lo traduce) y un mensaje
retenido deja un aviso que lleva a la ficha de la empresa. El tope de una
cuenta es uno por canal (`accountActionType`), sea invitación o mensaje.
El canal falso sigue una sola regla (`fakeAllowed`, en
`canales/index.ts`), la misma para el worker programado y para
`job:dispatch`: Postgres embebido, una base local, o una corrida limitada
al workspace de la demo.

Una pasada a mano, con la misma conexión que el worker:

```bash
pnpm --filter @mc/worker run job:dispatch                  # canales reales
pnpm --filter @mc/worker run job:dispatch -- --canal-falso --workspace 00000002-0000-4000-8000-000000000001
                                                           # buzón en memoria; el envío queda en outbound_touch
pnpm --filter @mc/worker run job:replies                   # respuestas de los hilos abiertos
pnpm --filter @mc/worker run job:dispatch -- --demo        # Postgres embebido con migraciones y seeds: apagada no envía, encendida sí
```

Contra Supabase, el «terminado cuando» de VEN-10 con el workspace de la
demo es un comando por paso (docs/ventas-outreach.md §5.2):

```bash
W=00000002-0000-4000-8000-000000000001
pnpm --filter @mc/worker run job:dispatch -- --preparar-demo --workspace $W   # la demo como --demo, con el reloj de verdad y el envío apagado
pnpm --filter @mc/worker run job:dispatch -- --canal-falso --workspace $W     # apagada: 0 reclamados, 0 enviados
pnpm --filter @mc/worker run job:dispatch -- --encender --workspace $W        # enciende el envío de la demo
pnpm --filter @mc/worker run job:dispatch -- --canal-falso --workspace $W     # encendida: 1 reclamado, 1 enviado
```

`--canal-falso` se niega contra una base que no es local salvo con
`--workspace` de la demo: deja como enviados mensajes que nadie recibió.
Contra Supabase necesita, como `job:seguimientos`, `GRANT mc_worker TO
mc_migrator` y las migraciones de outreach aplicadas (0046 a 0060: las de
VEN-9-canales, VEN-15 y el motor, detrás de la serie de main; ver
docs/ventas-outreach.md §5.2). El runner
(`src/runner/`) es el de CON-2: el motor no le cambia nada, solo suma sus
dos jobs en `src/jobs/ventas/index.ts`.

## Los jobs que hay

| Job | Módulo | Qué hace |
|---|---|---|
| `oauth.refresh` | Conexiones (CON-2, CON-3) | Renueva los tokens que vencen pronto. |
| `collect.account_metrics` | Conexiones (CON-10) | Snapshot diario de las cuentas por @ y de las autorizadas. |
| `collect.posts` | Conexiones (CON-5) | Cada 6 h descubre las publicaciones nuevas de cada cuenta. Ver abajo. |
| `collect.post_metrics` | Conexiones (CON-5) | Cada día a las 05:00 UTC deja una lectura por publicación activa. Ver abajo. |
| `collect.demographics` | Conexiones (CON-7) | Cada día a las 05:20 UTC escribe `audience_breakdown` (scope `account`) con la audiencia de cada cuenta autorizada. Si a la cuenta le falta un prerrequisito **no llama a la API**: escribe el requisito en `metric_gap` (ver abajo). `metadata`: `saved`, `empty`, `alreadyToday`, `gaps`, `unsupported`, `errored`, `transient`. |
| `campaign.compute` | Campañas (CAM-5) | Cada día a las 07:30 UTC recalcula `campaign_result` de las campañas `live`, `measuring` y `reported` (las cerradas conservan el suyo). La cuenta es `calcularResultado` de `@mc/core`; el job lee con `getResultInputs` y escribe con `upsertResult` (`@mc/db`), con el `workspace_id` de cada campaña en cada consulta y una transacción por campaña. Con `{ workspaceId, campaignId }` en el payload calcula solo esa. `metadata`: `campaigns`, `computed`, `partial` (las que aún no llegan a 30 días), `failed`. |

`mapLimit` (concurrencia dentro de una corrida) vive en
`src/runner/concurrency.ts`; `oauth-refresh.ts` la reexporta.

## Cuando la plataforma NO da el dato: `metric_gap` (CON-7)

Una celda vacía manda a la persona a WhatsApp. `collect.demographics`
no la deja vacía: si a la cuenta le falta un prerrequisito —cien
seguidores, cuenta profesional, el permiso de insights, o sencillamente
que el dueño autorice la lectura— **no llama a la API** y escribe el
requisito en `metric_gap`, con el texto en español de
`metric_requirement` (migraciones `0011` y `0039`).

```sql
-- ¿Por qué esta cuenta no tiene demografía?
SELECT c.handle, r.requirement, r.message_es, g.day
  FROM metric_gap g
  JOIN metric_requirement r ON r.id = g.requirement_id
  JOIN social_connection c  ON c.id = g.connection_id
 WHERE g.metric_group = 'demografia_de_cuenta';
```

Es **una fila viva por (conexión, grupo)**: la corrida de hoy reemplaza
la de ayer y, en cuanto el dato llega, el job la borra. La historia de
qué se intentó vive en `job_run` y `api_call_log`, no aquí.

Quien escribe es el worker; la web solo lee (`getAccountAudience` /
`listAccountAudience` en `@mc/db/queries/conexiones`). Y la demografía
en sí es append-only: si ya hay filas de hoy para esa cuenta, el job se
la salta entera y no gasta ni una llamada.

## Los dos recolectores de publicaciones (CON-5)

| | `collect.posts` | `collect.post_metrics` |
|---|---|---|
| Cuándo | cada 6 h (`0 */6`) | cada día a las 05:00 UTC (`0 5`) |
| Qué hace | descubre publicaciones nuevas y hace *upsert* en `post` | deja una fila en `post_metric_snapshot` por publicación activa |
| Payload | `{ workspaceId?, connectionId?, max?, full? }` | `{ workspaceId?, connectionId?, maxAgeHours? }` |
| De dónde lee | `social_connection` con `access_mode` en `public_profile` o `direct_oauth`, viva y en estado `active` o `error` | lo mismo, más `post` y `campaign_post` |

`full: true` ignora lo que ya conocemos y vuelve a listar la ventana
entera; sirve para rellenar después de un fallo largo.

**Lo que dejan en `job_run.metadata`** (ids y conteos, nunca un token):

```
collect.posts         cuentas, max, nuevos, descubiertos{conexión: n}, revisadas[],
                      sinFuenteDePosts[], errores[], transitorios[], abortadas[],
                      diferidas[], sinConfigurar{plataforma: qué falta}
collect.post_metrics  capturedAt, maxAgeHours, candidatos, viejos, yaMedidos,
                      snapshots, medidas[], borrados[], sinFuenteDePosts[],
                      errores[], transitorios[], abortados, diferidos, sinConfigurar
```

`diferidas`/`diferidos` es «se acabó la cuota, queda para la próxima»
(y entonces el job devuelve `retry: false`: el siguiente tick del cron
es el reintento). `abortadas`/`abortados` es «se apagó el worker», que
sí mejora con un reintento y **no** se le apunta a la cuenta del
creador.

Reglas que conviene saber antes de tocarlos:

- **`post_metric_snapshot` es append-only.** Dos corridas el mismo día
  dejan dos filas a propósito: eso es lo que dibuja
  `post_metrics_daily_delta`. Lo único que no puede pasar es ir hacia
  atrás: una lectura anterior a la última guardada no entra.
- **Un reintento (`attempt > 1`) se salta lo que esa corrida ya midió**
  en los últimos 60 minutos, para retomar por donde iba en vez de
  empezar de cero.
- **`first_seen_at` y `last_synced_at` no se tocan.** El primero es la
  primera vez que vimos la publicación; el segundo es la frescura de la
  serie de cuenta (CON-10), y moverlo aquí taparía una sincronización
  rota en `connection_health` y en Resumen.
- **`deleted_on_platform` solo se marca donde la fuente sabe preguntar
  por id** (YouTube, y TikTok autorizada). `business_discovery` de
  Instagram no deja pedir un medio concreto: ahí, no saber no es saber
  que no está.
- **Hasta cuándo se mide** lo decide `shouldKeepMeasuring` de
  `@mc/core`: 888 h, salvo que la publicación esté en una campaña
  abierta, que se mide hasta `ends_on + 30 días` (CAM-5).


## Qué pasa cuando falla

| Situación | job_run | pg-boss |
|---|---|---|
| El handler lanza | `failed`, `error = "Clase: mensaje"` (el stack va al log) | reintenta con backoff hasta `max_attempts` |
| Excede `timeout_s` | `failed`, `error = "timeout"`, `metadata.timeoutS` | igual; además `expireInSeconds = timeout_s + 30` como red de seguridad |
| `failed > 0` y `processed > 0` | `partial`, con los contadores | reintenta, salvo `retry: false` (el job debe ser idempotente: lo ya hecho no se rehace) |
| `failed > 0` y `processed = 0` | `failed`, `error = "JobItemsFailedError: …"` | reintenta, salvo `retry: false` |
| El payload trae un `workspaceId` que ya no existe | la fila se abre sin workspace y lo anota en `metadata.workspaceIdIgnored` | la ejecución sigue |
| Definición sin handler | una fila `skipped` con `error = "sin handler"`, una sola mientras siga sin handler (los reinicios no la repiten) | no se crea cola de trabajo |
| `enabled = false` | nada | se retira el schedule si existía |
| El proceso recibe SIGTERM | los jobs activos terminan (hasta `WORKER_STOP_TIMEOUT_S`) | los que no terminaron vuelven a la cola al expirar |

Cada job es su propia cola en pg-boss (`job_definition.id`); `queue` es
el grupo lógico para repartir procesos con `WORKER_GROUPS`. Los crons
se guardan en `pgboss.schedule` con la clave `cron`: reiniciar el worker
no los duplica, y si cambia `default_cron` se actualiza al arrancar.

En `oauth.refresh`, un fallo **nuestro** (el SecretStore no tiene la
credencial, no pudo escribirla o no pudo descifrarla) nunca cambia el
estado de la cuenta del creador: queda como transitorio, ruidoso en el
log, y la conexión sigue `active`. Solo la plataforma (`invalid_grant`,
Meta `190`, revocado) o un refresh token vencido (TikTok) o un token de
larga duración vencido (Instagram, `refresh_expired`) la pasan a
`needs_reauth`. El job pasa `connectionId` y `secretRef` al refresher:
con `enc:tiktok-business:…` renueva contra la Accounts API.

## brand.snapshot (CAM-3)

Cada día a las 07:00 UTC (`job_definition`, 0009: cola `campaigns`,
600 s, concurrencia 2 por plataforma) lee los seguidores públicos de la
marca de cada campaña `planned`, `live` o `measuring` con
`brand_accounts` y en ventana: desde `brand_baseline_from` (o
`starts_on − 14`) hasta `ends_on + 30` (`isBrandSnapshotDue`, core).

- Una marca en varias campañas del mismo workspace se lee **una vez**
  (workspace, empresa, red, handle) y deja **una fila por campaña**:
  `brand_account_snapshot` es único por (campaña, red, día, con o sin
  cifra) desde 0035.
- Escribe con `recordBrandSnapshot` de `@mc/db/queries/campanas`, el
  mismo INSERT que «Actualizar ahora» en la ficha: solo INSERT, `ON
  CONFLICT DO NOTHING`. La primera lectura del día queda; una fila sin
  cifra de la mañana convive con la cifra que llegue después, y la ficha
  prefiere la que trae cifra. Nadie hace UPDATE.
- Sin cifra, la fila lleva `followers NULL` y la razón en `source`:
  `no_public_source` (TikTok, sin llamada), `not_found` (Meta 110, un
  YouTube vacío) o `not_discoverable` (cuenta personal o privada). Estas
  no cuentan como fallo; mañana se vuelve a mirar.
- Transitorio o fallo de la base al escribir → `failed`, sin fila,
  pg-boss reintenta (un fallo de escritura no corta las demás marcas).
  Cuota agotada → `failed` con `retry: false`. Fuente sin credencial → la red va a
  `metadata.skipped` con un aviso por corrida.
- `metadata`: `day`, `campaigns`, `targets` y listas de
  `{ campaignId, platformId }` por resultado (`snapshots`, `noSource`,
  `errored`, `transient`, `writeErrors`, `quota`). Sin handles ni tokens.

```sql
-- ¿Qué leyó hoy brand.snapshot y qué no?
SELECT c.name, s.platform_id, s.day, s.followers, s.source
  FROM brand_account_snapshot s JOIN campaign c ON c.id = s.campaign_id
 WHERE s.day = current_date ORDER BY c.name;
```

## finance.reminders · recordatorios de cobro (FIN-4)

Cada día a las 10:00 UTC recorre las facturas `sent` y `partial` y, para
cada una, mira en qué paso está respecto a `due_on`: **−7, 0, +7, +21 y
+45 días**, con el tono subiendo en cada uno (recordatorio amable, aviso
de vencimiento, primer aviso de mora, segundo, aviso formal). Redacta el
correo con `@mc/core` —`pasosPendientes()` y `redactarRecordatorio()`,
puras— y lo guarda como `notification` de tipo `invoice_overdue`, con el
asunto en `title_es` y el cuerpo en `body_es`.

Los datos de pago del correo (titular, NIT, banco, cuenta, enlace) salen
de `workspace.settings->'finanzas'` con `parseFinanceSettings` y
`datosDePagoDe` (FIN-8); sin banco, cuenta ni enlace, el correo dice
dónde configurarlos. Ni el banco ni la cuenta van a `job_run.metadata`
ni al log (hay prueba).

**No envía nada.** El envío real por SMTP es fase 2 y espera a CIM-10;
cuando llegue, marca `notification.emailed_at`. Hoy el creador lo copia
desde la bandeja de `/finanzas` y lo manda desde su correo.

Tres cosas que conviene saber antes de tocarlo:

- **Se ponen al día todos los pasos pendientes en una corrida**, no solo
  el último: no se envía nada, así que no hay a quién inundar. Para
  cambiarlo es `pendientes.slice(-1)` en `recordatorios.ts`.
- **El paso −7 caduca al vencer la factura.** Su texto dice «vence en N
  días»; con 41 días de mora sería falso. Por eso una factura vencida
  hace 41 días recibe **tres** recordatorios (0, +7 y +21) y no cuatro.
- **La idempotencia cuelga de `action_url`**
  (`/finanzas/facturas/<id>?recordatorio=<paso>`), no del título: el
  título es texto de producto y cambiar una palabra reemitiría todos los
  recordatorios de todas las facturas. Una segunda corrida el mismo día
  no escribe nada.

`invoice.reminders_sent` queda igual a cuántos recordatorios hay en la
bandeja para esa factura, y nunca baja; `last_reminder_at` es la última
corrida que escribió algo. El día lo pone la zona del workspace
(`hoyEnZona`), no UTC: a las 10:00 UTC en Bogotá son las 05:00.

## Cómo leer job_run

```sql
-- Últimas ejecuciones, con duración y resultado
SELECT id, job_id, status, attempt, started_at, duration_ms, items_processed, items_failed, error
  FROM job_run ORDER BY id DESC LIMIT 20;

-- ¿Por qué esta conexión no se renovó?
SELECT id, status, started_at, error, metadata
  FROM job_run
 WHERE job_id = 'oauth.refresh' AND metadata->'needsReauth' ? '<connection_id>';

-- Fallos de las últimas 24 h por job
SELECT job_id, count(*) FROM job_run
 WHERE status IN ('failed','partial') AND started_at > now() - interval '24 hours'
 GROUP BY 1 ORDER BY 2 DESC;
```

`metadata.bossJobId` cruza con `pgboss.job.id` cuando hace falta ver
el estado en la cola. Las llamadas salientes quedan en `api_call_log`
(una fila por intento, `endpoint` lógico como `tiktok.video.list` u
`oauth.refresh`, sin cuerpo ni token) y la cuota del día en
`api_quota_usage`:

```sql
-- ¿Qué llamó el worker hoy y cuántas fallaron?
SELECT platform_id, endpoint, count(*) FILTER (WHERE ok) AS ok, count(*) FILTER (WHERE NOT ok) AS fallidas,
       count(*) FILTER (WHERE rate_limited) AS rate_limited
  FROM api_call_log WHERE called_at > now() - interval '24 hours' GROUP BY 1, 2 ORDER BY 1, 2;

-- ¿Cuánta cuota de YouTube va hoy?
SELECT day, units_used, units_limit, calls FROM api_quota_usage WHERE platform_id = 'youtube' AND connection_id IS NULL ORDER BY day DESC LIMIT 1;
```

## Línea base y puntaje (CON-6)

Dos jobs nocturnos producen el número central del producto: **cuántas
veces su propia mediana hizo cada video, medido a la misma edad que los
demás**. Toda su aritmética sale de `@mc/core` (`scoring.ts`), nunca de
SQL suelto ni de una pantalla.

| Job | Cuándo | Qué escribe |
|---|---|---|
| `compute.baseline` | Tras cada `collect.post_metrics` con datos; y `40 5` de red | Una fila de `creator_baseline` por (workspace, creador, red, corte de edad) con la mediana, el p25 y el p75 de views, y la mediana de alcance, engagement, guardados por mil, completion y skip a 3 s. `is_reliable = sample_size >= 8`. |
| `compute.post_score` | Tras cada `compute.baseline`; y `45 5` de red | Una fila de `post_score` por video con `views_vs_median`, `outlier_tier`, `is_outlier` y, la primera vez que llega a cada nivel, una `notification` (`outlier`, `breakout`). |

**Por qué encadenados y no solo por hora.** `collect.post_metrics` corre
a las 05:00 con `timeout_s` 600 y cinco intentos: un reintento puede
terminar después de las 05:40, y `compute.baseline` (timeout 300 s)
puede seguir corriendo a las 05:45 cuando arranca `compute.post_score`.
Con la hora sola, el puntaje del día se calcularía con lecturas o
medianas de ayer. Con `after`, cada recolección con datos dispara
línea base → puntaje en ese orden; los crons de `0009` se quedan para el
día en que la recolección falle entera (la ventana cambia con el paso
del tiempo aunque no lleguen lecturas). Sin migración: las filas de
`job_definition` no cambian.

Las reglas que hay que saber antes de tocarlos:

- **El corte manda.** Un video se puntúa en el **mayor** corte de
  `AGE_CUTS_HOURS` (24, 72, 168, 720 h) que ya alcanzó **y midió**,
  contra la línea base de ESE corte, y el corte queda escrito en
  `age_hours_cut`. Un video de menos de 24 h no recibe fila: compararlo
  sería medirlo a otra edad que los demás.
- **«Midió» es la banda del corte** (`BANDAS`, en `compute-baseline.ts`):
  la lectura tiene que tener más horas que el corte anterior. Si a una
  cuenta se le dejó de recolectar, su video de 31 días con la última
  lectura a las 60 h se puntúa a las 72 h —lo que de verdad midió— y no
  a los 30 días con una cifra de hace un mes.
- **La ventana son los últimos `window_posts` (20) videos** que de
  verdad llegaron al corte —edad cumplida **y** lectura dentro de la
  banda—, sin los `deleted_on_platform`.
- **Un nulo no es un cero.** Sin ocho videos en ese corte,
  `views_vs_median` y `outlier_tier` quedan en `NULL` (la fila se
  escribe igual, con sus views reales). `is_outlier` es `NOT NULL`, así
  que el «todavía no sabemos» vive en las otras dos columnas y la
  pantalla lee esas.
- **`creator_baseline` es append-only** (su `UNIQUE` incluye
  `computed_at`): cada corrida deja su fila y el puntaje apunta con
  `baseline_id` a la que usó. `post_score` tiene `PRIMARY KEY (post_id)`:
  es el puntaje vigente y se reemplaza, pero su corte **nunca baja** y
  `notified_at` sobrevive al recálculo.
- **Se recalcula siempre**, también sin lecturas nuevas: la ventana
  cambia con el paso del tiempo (un video de seis días y medio entra
  mañana en el corte de 168 h con la lectura que ya tiene). Sobre el
  seed son 889 ms las 16 líneas base y 3,3 s los 59 puntajes.
- **Un aviso por video, y solo cuando SUBE de nivel.** El registro de
  «ya avisé» es la propia tabla `notification` (`kind` + `entity_id`),
  no una fecha: un video que sube de `outlier` a `breakout` avisa la
  segunda vez, ninguna corrida repite la primera, y uno que BAJA de
  `breakout` a `outlier` —pasa al cambiar de corte— no manda una buena
  noticia que no lo es (`debeAvisar()`).
- **Dependen de la migración `0024`** (`security_invoker` en las
  vistas), que ya está aplicada: los dos leen `post_metrics_at_cut`, y
  una vista sin esa opción corre con los privilegios de su dueño, así
  que `mc_worker` —que se salta RLS por rol— no se la salta a través de
  la vista y vería cero filas, sin un solo error en el log. Detalle en
  [docs/propuestas/CON-6.md](../../../docs/propuestas/CON-6.md) §5.

Para probarlos a mano sobre la demo:

```sql
SELECT platform_id, age_hours_cut, sample_size, median_views, is_reliable
  FROM creator_baseline ORDER BY computed_at DESC, platform_id, age_hours_cut;

SELECT p.platform_id, p.title, s.age_hours_cut, s.views_at_cut, s.views_vs_median, s.outlier_tier
  FROM post_score s JOIN post p ON p.id = s.post_id
 ORDER BY s.views_vs_median DESC NULLS LAST LIMIT 5;
```

## Pruebas

```bash
pnpm --filter @mc/worker test        # integración sobre Postgres embebido (pglite); incluye collect.account_metrics por @, brand.snapshot y finance.reminders sobre los seeds reales, los dos recolectores de CON-5 (descubrimiento, fusión con el archivo importado, dos lecturas y su delta, tope de edad, borrados, 401, señal abortada y reintento), compute.baseline + compute.post_score (CON-6) con dos workspaces, las costuras de CON-6 (collect → baseline → post_score encadenados, campaign.compute con la línea base de CON-6 y las 16 líneas base y 59 puntajes del seed), las migraciones con el runner de @mc/db (CON-2b), collect.demographics contra fixtures (CON-7) y oauth.refresh con el almacén cifrado y los refreshers reales
pnpm --filter @mc/connectors test    # conectores: unitarias con fetch falso y pglite para api_quota_usage, sin red
pnpm --filter @mc/worker typecheck lint
```

El modo por turnos (CIM-7) tiene las suyas: `test/tick.test.ts` (sobre
la foto con los seeds: respeta el presupuesto, corta y retoma sin gastar
intentos, dos turnos a la vez no duplican, el tope de cortes, lo
encadenado espera a lo de arriba con tres recorredores, el backoff entre
reintentos, y `outbound.dispatch` sacando el mensaje de la demo por el
canal falso), `test/senal-turno.test.ts` (los jobs de Ventas dejan de
trabajar con la señal disparada), `test/cron-tick-sql.test.ts` (el SQL
de `db/ops/` sin secretos en claro, idempotente, el orden de
`make cron.install`, la purga, y el token de administración fuera de la
línea de comandos de curl) y, en la web,
`app/api/cron/tick/_lib/turno.test.ts` (401 sin Bearer o con uno malo,
el resumen con el bueno, por GET y POST, el esquema `bearer` sin
mayúsculas, solo `/api/cron/tick` sin sesión, que toda
`app/api/cron/**/route.ts` exija el Bearer, y el 504 cuando el turno no
responde). `tick.test.ts` cubre además `outbound.dispatch` con más
toques vencidos de los que caben en una pasada (el turno corto envía
los que caben, el siguiente tick de `*/2` el resto, ninguno dos veces),
la guardia contra una base remota fuera de Vercel y la espera de
conexión acotada con un «pooler» que no contesta.

**Lo que PGlite no puede probar** está en `test/tick-postgres.test.ts`:
dos turnos con dos pools en el peor orden (el candado por job de
`claimRun` es lo único que evita la corrida doble; en PGlite las
transacciones se serializan y no se distingue), `outbound.dispatch` con
dos turnos a la vez, el pool de 7 conexiones y el `statement_timeout`
que corta la sentencia larga de un job cortado. Sin `TEST_DATABASE_URL`
se salta (`﹣ skipped` en `pnpm verificar`); en el CI corre siempre
(paso «El worker por turnos con dos pools»). En local, con Docker
(desde `platform/`):

```bash
make up && make seed      # Postgres 16, db/montaje-postgres-real.sql y las migraciones con seed
cd apps/worker && TEST_DATABASE_URL=postgres://mc_app_ci:ci@localhost:5432/oncue \
  TEST_DATABASE_ADMIN_URL=postgres://mc:mc@localhost:5432/oncue \
  node --test --experimental-strip-types --test-timeout=120000 test/tick-postgres.test.ts
```

Sin Docker, cualquier Postgres 16: el de `embedded-postgres`, con el
montaje y la migración que explica `packages/db/README.md` («Contra
Postgres real, en local»), y las mismas dos variables con su puerto.
Así se corrió el 28-sep-2026 (Postgres 16.14): 5 de 5 en verde.

El turno corre DENTRO del bundle de Next, y webpack congela
`import.meta.url` en la ruta de la máquina del build: un `readFileSync`
relativo al módulo da ENOENT en Vercel. Por eso los prompts de outreach
van incrustados (`packages/core/src/outreach/prompts.gen.ts`, que
regenera `make core.prompts` y vigila `test/outreach-prompts.test.ts` de
`@mc/core`), y el `build` de `@mc/web` termina con
`apps/web/scripts/revisar-bundle-turno.mjs`, que falla si el bundle de
`/api/cron/tick` lleva un `file:///` fuera de los permitidos (cada uno
con el motivo por el que esa ruta no se lee en producción).

Las de integración aplican TODAS las migraciones reales con el runner
de `@mc/db` (`test/migraciones.test.ts` falla si una no queda en
`schema_migrations`), y los seeds con `applyRepoSeeds()` del arnés (la `0014` da
los privilegios a `mc_worker`; la `0015` crea `connection_secret`; la
`0039`, `metric_gap`) y corren como `mc_worker`: si un privilegio
faltara, las pruebas fallan.

**Los tiempos** (CIM-12): cada archivo corre en SU proceso, uno detrás
de otro (`--test-isolation=process --test-concurrency=1`), y abre su
base desde la foto del esquema migrado que comparte con `@mc/db` y
`@mc/connectors` (`db/lib/foto.mjs`): se migra una vez por contenido de
`db/migrations`, no en cada archivo. Con `--test-isolation=none` los
`before` de todos los archivos arrancaban a la vez su worker de pg-boss
y seguían vivos hasta el final: cuarenta workers sondeando en el mismo
hilo, un `before` lento que tumbaba la suite entera y conteos de
llamadas que se cruzaban entre archivos. Si añades un archivo de
integración, mete varios casos en el mismo arnés en vez de abrir otro. No tocan Supabase nunca. pg-boss 12 trae adaptador para pglite (`fromPglite`,
`backend: 'pglite'`); no hace falta Docker.

## Estructura

```
src/index.ts                 arranque, --install, --pglite, --demo, apagado limpio
src/tick.ts                  el modo por turnos (CIM-7): runTick y runTickFromEnv, exportados como @mc/worker/tick
src/recursos.ts              secretos y refreshers: los mismos para el proceso, --once y los turnos
src/runner/once.ts           una pasada: lo vencido, el reclamo por job y el presupuesto de un turno
src/runner/config.ts         variables de entorno
src/runner/logger.ts         JSON por línea + redactor
src/runner/db.ts             pool de pg + SET ROLE mc_worker (Postgres real)
src/runner/db-pglite.ts      Postgres embebido (pruebas y demo)
src/runner/registry.ts       defineJob(), JobContext (db, secrets, connectors, callLog, signal…), JobResult   ← el contrato
src/runner/definitions.ts    lectura de job_definition
src/runner/boss.ts           job_definition → opciones de pg-boss
src/runner/run.ts            una ejecución: job_run running → ok/partial/failed
src/runner/worker.ts         arranque: colas, crons, handlers, resumen
src/jobs/index.ts            suma de los jobs de todos los módulos
src/jobs/conexiones/         oauth.refresh · collect.account_metrics (CON-10) · collect.posts y collect.post_metrics (CON-5) · _posts.ts (lo común de los dos)
                             compute.baseline · compute.post_score (línea base y puntaje, CON-6) · collect.demographics (audiencia, CON-7)
src/jobs/ventas/             sales.follow_ups · outbound.dispatch · outbound.replies · canales/ (VEN-10) · outbound.generate · outbound.review (VEN-12) · outbound.intent (VEN-14)
src/jobs/campanas/           brand.snapshot (seguidores públicos de la marca de cada campaña, CAM-3)
src/jobs/finanzas/           finance.reminders (recordatorios de cobro, FIN-4)
test/                        integración (pglite) y unitarias
```
