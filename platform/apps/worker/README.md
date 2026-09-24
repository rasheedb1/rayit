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
pnpm --filter @mc/worker start -- --pglite   # Postgres embebido vacío con las 13 migraciones
pnpm --filter @mc/worker start -- --demo     # lo anterior + 3 conexiones y un oauth.refresh en vivo
```

`--demo` siembra una conexión que vence en 10 minutos (se renueva), una
en 3 horas (intacta) y una revocada (pasa a `needs_reauth` con su
notificación), encola `oauth.refresh` y a los cuatro segundos imprime
`job_run`, `social_connection` y `notification`. El embebido aplica
todas las migraciones del repo, incluida `0014` con los privilegios de
`mc_worker`, y corre las consultas como ese rol: es el mismo reparto que
en Supabase.

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
| `OAUTH_REFRESH_MARGIN_MINUTES` | Con cuánta anticipación renueva `oauth.refresh` (tokens de horas: TikTok, YouTube). | `30` |
| `OAUTH_REFRESH_MARGIN_MINUTES_INSTAGRAM` | Margen para Instagram, cuyo token dura 60 días y Meta solo renueva con más de 24 h de vida. | `10080` (7 días) |
| `SECRET_STORE` | `encrypted` (connection_secret cifrado con `TOKEN_ENCRYPTION_KEY`, el real desde CON-3), `env` (lee `env:NOMBRE`) o `memory`. | `encrypted` |
| `TOKEN_ENCRYPTION_KEY` | 32 bytes en base64 (la del vault). Sin ella el worker no arranca; `_V2` y `_CURRENT` para rotar. | obligatoria |
| `TOKEN_REFRESHER` | `real` (TikTok e Instagram sobre el cliente de CON-1; YouTube llega con CON-8) o `fake`. | `real` |
| `TIKTOK_LOGIN_CLIENT_KEY`, `TIKTOK_LOGIN_CLIENT_SECRET`, `TIKTOK_BUSINESS_APP_ID`, `TIKTOK_BUSINESS_APP_SECRET`, `META_APP_ID`, `META_APP_SECRET` | Las apps con las que se renueva cada token. Sin una app, sus conexiones fallan como `not_configured` (transitorio, sin reintento inmediato) y el arranque lo avisa. | — |
| `PGSSLROOTCERT` | Ruta al CA de Supabase; relativa a `platform/`. | `db/certs/supabase-root-2021.crt` |
| `LOG_LEVEL` / `LOG_FORMAT` | `debug|info|warn|error` · `json|pretty`. | `info` / `json` |
| `INSTAGRAM_HOUSE_TOKEN`, `GOOGLE_API_KEY` | `collect.account_metrics` (CON-10): el token de la cuenta profesional de On Cue para `business_discovery` y la API key de YouTube. Sin ellas la plataforma se salta y se avisa. | — |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | El adaptador de Gmail del motor de cadencias (VEN-10) las usa para renovar un token de buzón vencido; las usará también el refresher de YouTube (CON-8). Sin ellas, un correo con el token vencido queda como fallo transitorio. | — |
| `UNIPILE_DSN`, `UNIPILE_ACCESS_TOKEN` | LinkedIn e Instagram del motor de cadencias. Sin ellas esos canales no se reclaman: sus toques esperan en la cola. | — |
| `OUTREACH_CHANNELS` | `real` (Gmail y Unipile) o `fake` (buzón en memoria, nada sale de la máquina). | `real` |
| `APP_URL` | Origen público de la web, para el enlace de baja de cada correo. Sin él (ni `VERCEL_PROJECT_PRODUCTION_URL`) el correo real no se reclama. | — |

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
- Devuelve `{ processed, failed, metadata? }`. `metadata` va a
  `job_run.metadata` pasando por el redactor: ids y fechas sí, tokens
  jamás.
- Revisa `ctx.signal` en bucles largos: se dispara al vencer `timeout_s`
  y al apagar el worker.
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
migración 0051 (grupo `sales`). Las consultas viven en
`packages/db/src/queries/outreach/` (`enroll`, `claim`, `send`,
`replies`), la programación pura en `packages/core/src/outreach/`.

| Job | Cada | Qué hace |
|---|---|---|
| `outbound.dispatch` | 2 min | **Zombis** de más de 5 min en `processing`: si nunca llegaron al proveedor (sin `send_started_at`) vuelven a la cola; si llegaron, `failed` y aviso, sin reenviar. **Reclamo** de hasta 50 toques vencidos (o los que quepan en el tiempo de la corrida, a 2 s cada uno, hasta 30 s antes del timeout) con `UPDATE … RETURNING`: fuera de la ventana laboral o en fin de semana van a la apertura; un paso no sale mientras uno anterior de su enrolamiento siga en la cola (programado, reclamado, retenido, o un borrador que espera al generador); un correo a una dirección que rebotó para siempre (`contact.email_invalid`, VEN-15) se cancela; sin cuenta conectada esperan una hora (un aviso por canal y día); con un tope lleno van al siguiente día hábil y los pasos de detrás se corren con ellos. El tope de una cuenta es el que rige en `outreach_channel_account_limits` (VEN-9) pasado por la curva de calentamiento de VEN-15 (`warmupDailyLimit`), en la zona del workspace: el mismo número que enseña `/ventas/politica`. **Envío**, uno por uno: `send_started_at` en su propia transacción, y en otra la relectura (toque, enrolamiento, ficha, lista global, interruptor, cuenta), la composición (el pie de VEN-15 con la página de baja y la dirección postal, la cabecera `List-Unsubscribe` de un clic a `/baja/<token>/un-clic`, el hilo; una respuesta en el hilo sin correo anterior se retiene) y el adaptador. El enrolamiento queda bloqueado mientras dura el envío: una respuesta que llega a la vez espera o se ve. Un paso que sale tarde arrastra a los de detrás. Transitorio → reintento con espera creciente, dentro de la ventana, hasta 5; ambiguo (corte después de enviar) → antes de reintentar se pregunta al proveedor si salió (`findSent`); rebote → se cancela ese canal y la cadencia termina en `bounced`; cuenta caída, o no disponible por algo nuestro (sin el token en el almacén) → espera sin gastar intento. **Lo no intentado** (timeout, apagado) vuelve a la cola con su intento descontado, sin su enlace de baja y con su plaza del tope, que vuelve al día en que se reservó (`caps_reserved_on`). |
| `outbound.replies` | 5 min | Respaldo del webhook de Unipile y única vía del correo: lee TODOS los hilos de los últimos 30 días (también los de cadencias que ya respondieron o completaron) por turno, en páginas de 200 hasta 30 s antes del timeout: primero los nunca leídos, después los que hace más que no se leen (`replies_checked_at`). Escribe `outbound_message` entrante; una respuesta marca `replied` y cancela lo pendiente; una baja marca la ficha y las de su correo y cancela todo lo suyo pendiente en cualquier secuencia, como el enlace de baja; un «fuera de oficina» (Auto-Submitted, X-Autoreply) se guarda sin cancelar ni avisar, salvo que pida la baja. Lo que hace una respuesta lo decide `applyInboundEffects` de `@mc/db`, la misma función que usa el webhook de Unipile (r4). |
| `outbound.bounces` | 30 min | Los rebotes de Gmail (VEN-15): lee el buzón de cada cuenta de correo conectada con el `GmailChannel` del despachador (`bounceMailboxFor`, r4) y un rebote duro marca `contact.email_invalid`, cancela los correos pendientes de la ficha y cierra en `bounced` la cadencia sin nada vivo (`markContactEmailInvalid`, lo mismo que un rebote síncrono al enviar). Sin llaves de Google, «canal no configurado». |

Adaptadores en `src/jobs/ventas/canales/` con una sola interfaz
(`ChannelSender`, `ChannelReader`): Gmail y Unipile (LinkedIn e
Instagram) son adaptadores finos sobre los clientes de VEN-9 en
`@mc/connectors` (`GmailApi`, `UnipileApi`: su HTTP, su MIME, su
bitácora en `api_call_log` y sus errores), y `fake` para las pruebas y
la demo. Sin `GOOGLE_CLIENT_ID/SECRET` el correo está «no configurado»
(no se reclama, no gasta intentos); sin `UNIPILE_DSN` y
`UNIPILE_ACCESS_TOKEN`, LinkedIn e Instagram. La guardia de
placeholders (`@mc/core`) corre en el punto de envío, sobre el mensaje
final (asunto y pie incluidos). `held_reason` guarda un código
(`@mc/core/outreach/messages`, `holdReasonText` lo traduce) y un mensaje
retenido deja un aviso que lleva a la ficha de la empresa. El tope de una
cuenta es uno por canal (`accountActionType`), sea invitación o mensaje.
`OUTREACH_CHANNELS=fake` se ignora con `NODE_ENV=production`.

Una pasada a mano, con la misma conexión que el worker:

```bash
pnpm --filter @mc/worker run job:dispatch                  # canales reales
pnpm --filter @mc/worker run job:dispatch -- --canal-falso --workspace 00000002-0000-4000-8000-000000000001
                                                           # buzón en memoria; el envío queda en outbound_touch
pnpm --filter @mc/worker run job:replies                   # respuestas de los hilos abiertos
pnpm --filter @mc/worker run job:dispatch -- --demo        # Postgres embebido con migraciones y seeds: apagada no envía, encendida sí
```

`--canal-falso` se niega contra una base que no es local salvo con
`--workspace` de la demo: deja como enviados mensajes que nadie recibió.
Contra Supabase necesita, como `job:seguimientos`, `GRANT mc_worker TO
mc_migrator` y las migraciones de outreach aplicadas (0037 y las de
VEN-9-canales, VEN-15 y 0051, con los números que les dé el integrador
detrás de la serie de main: ver la cabecera de `0051_motor_cadencias.sql`). El runner
(`src/runner/`) es el de CON-2: el motor no le cambia nada, solo suma sus
dos jobs en `src/jobs/ventas/index.ts`.

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

## Pruebas

```bash
pnpm --filter @mc/worker test        # integración sobre Postgres embebido (pglite), ~45 s; incluye collect.account_metrics por @; incluye oauth.refresh con el almacén cifrado y los refreshers reales sobre fixtures
pnpm --filter @mc/connectors test    # conectores: unitarias con fetch falso y pglite para api_quota_usage, sin red
pnpm --filter @mc/worker typecheck lint
```

Las de integración aplican las 15 migraciones reales (la `0014` da los
privilegios a `mc_worker`; la `0015` crea `connection_secret`) y corren como `mc_worker`: si un privilegio
faltara, las pruebas fallan. No tocan Supabase nunca. pg-boss 12 trae adaptador para pglite (`fromPglite`,
`backend: 'pglite'`); no hace falta Docker.

## Estructura

```
src/index.ts                 arranque, --install, --pglite, --demo, apagado limpio
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
src/jobs/conexiones/         oauth.refresh · collect.account_metrics (cuentas por @ y autorizadas, CON-10)
src/jobs/ventas/             sales.follow_ups · outbound.dispatch · outbound.replies · canales/ (VEN-10)
test/                        integración (pglite) y unitarias
```
