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
| `INSTAGRAM_HOUSE_TOKEN`, `GOOGLE_API_KEY` | `collect.account_metrics` (CON-10), `brand.snapshot` (CAM-3) y los dos `collect` de publicaciones (CON-5): el token de la cuenta profesional de On Cue para `business_discovery` y la API key de YouTube. Sin ellas la plataforma se salta y se avisa. | — |
| `COLLECT_POSTS_MAX` | Publicaciones nuevas por cuenta y corrida de `collect.posts`. | `25` |
| `COLLECT_MAX_AGE_HOURS` | Hasta qué edad se le sigue tomando lectura a una publicación. Por defecto 720 h (el último corte de `scoring.ts`) más siete días de gracia. | `888` |
| `COLLECT_YOUTUBE_UNITS_RESERVE` | Unidades de la cuota diaria de YouTube que `collect.post_metrics` no gasta, para que queden para la pantalla y un reintento. | `500` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Las usará el refresher de YouTube (CON-8). Hoy no se leen. | — |

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
- **Encadenamiento**: si tu job tiene que correr DESPUÉS de otro, no lo
  resuelvas con la hora del cron; decláralo:
  `defineJob('compute.baseline', fn, { after: ['collect.post_metrics'] })`.
  Cuando el de arriba termina `ok` o `partial` (hubo datos), el runner
  encola el tuyo con el mismo `workspaceId` (sin él, para todos),
  `singletonKey` `tras:<workspace>` y `{ source: 'chain', after }` en el
  payload, que llega a `job_run.metadata.tras`. Un `failed` no encadena.
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
a las 05:00 con `timeout_s` 600 y cuatro intentos: un reintento puede
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

Las de integración aplican TODAS las migraciones reales con el runner
de `@mc/db` (`test/migraciones.test.ts` falla si una no queda en
`schema_migrations`), y los seeds con `applyRepoSeeds()` del arnés (la `0014` da
los privilegios a `mc_worker`; la `0015` crea `connection_secret`; la
`0039`, `metric_gap`) y corren como `mc_worker`: si un privilegio
faltara, las pruebas fallan.

**Los tiempos**: cada archivo abre SU propia base embebida en su
`before`, y con 35 migraciones eso cuesta de 84 a 200 s según la carga
de la máquina. Por eso `--test-timeout` es de 300 s y los `before` de
cada archivo llevan `{ timeout: 600_000 }`: con `--test-isolation=none`,
un `before` que se pasa de su límite **cancela la suite entera del
paquete**, y el informe dice `pass 0, cancelled 704` sin señalar quién
tardó. Si añades un archivo de integración, dale el mismo límite y, si
puedes, mete varios casos en el mismo arnés en vez de abrir otro. No tocan Supabase nunca. pg-boss 12 trae adaptador para pglite (`fromPglite`,
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
src/jobs/conexiones/         oauth.refresh · collect.account_metrics (CON-10) · collect.posts y collect.post_metrics (CON-5) · _posts.ts (lo común de los dos)
                             compute.baseline · compute.post_score (línea base y puntaje, CON-6) · collect.demographics (audiencia, CON-7)
src/jobs/campanas/           brand.snapshot (seguidores públicos de la marca de cada campaña, CAM-3)
src/jobs/finanzas/           finance.reminders (recordatorios de cobro, FIN-4)
test/                        integración (pglite) y unitarias
```
