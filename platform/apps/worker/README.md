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
| `OUTREACH_CHANNELS` | `real` (Gmail y Unipile) o `fake` (buzón en memoria, nada sale de la máquina). `fake` solo contra Postgres embebido o una base local: contra Supabase, o con `NODE_ENV=production`, el worker no arranca. | `real` |
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
| `outbound.dispatch` | 2 min | Rescata zombis, reclama hasta 50 toques vencidos y los envía uno por uno (ver «El despachador», abajo). |
| `outbound.replies` | 5 min | Lee las respuestas de todos los hilos abiertos y aplica su efecto: respuesta, baja o fuera de oficina (ver «El lector de respuestas»). |
| `outbound.bounces` | 30 min | Los rebotes de Gmail (VEN-15), buzón por buzón con el `GmailChannel` del despachador: un rebote duro marca `contact.email_invalid`, cancela sus correos y cierra la cadencia en `bounced`. Sin llaves de Google, «canal no configurado». |
| `outbound.generate` | 2 min | Redacta con IA, primero, lo que una persona pidió desde el editor del pitch (con su pista y sus instrucciones) y después los borradores de los pasos con `generate_with_ai` cuya hora cae en el próximo día y cuyos pasos anteriores ya salieron; nunca para quien pidió la baja (también la de este espacio) o tiene el correo rebotado (VEN-12). Tras un fallo, espera 2, 8, 30 y 120 minutos; tras tres respuestas ilegibles del modelo se rinde y el toque de la cadencia queda retenido con `llm_error` (0058). La señal del job llega a la llamada al modelo y no empieza otro toque con menos de 90 s de plazo. Sin `ANTHROPIC_API_KEY`, esperan: «redacción con IA no configurada», y la web lo lee de `job_run` (`outreach_writer_status`). |
| `outbound.review` | 2 min (al minuto impar) | La puerta de calidad de cada borrador redactado: pre-vuelo, juez con la rúbrica del paso, hasta cinco regeneraciones y «enviar el mejor»; deja el toque en `scheduled` o `held` con su motivo (o en `draft` si lo pidió una persona), y cada intento en `outbound_review` con nota y lo que costó escribirlo y juzgarlo, numerado dentro de su corrida (`run`, 0058). Toma tres por corrida; si el plazo se acaba a mitad, escribe los intentos ya pagados antes de soltar el turno. No toma ni pisa un borrador cuyo texto escribió una persona (VEN-12). |
| `outbound.intent` | 3 min | La intención de cada respuesta nueva (VEN-14): primero devuelve lo que tenía fecha de vuelta (una pausa por «fuera de la oficina» a `active`; un «ahora no» de hace noventa días a la bandeja de aprobación, retenido con `cooldown_over`, nunca enviado solo). Después clasifica lo entrante sin clasificar con `claude-haiku-4-5-20251001` (o el clasificador falso con `OUTREACH_WRITER=fake`) y aplica sus efectos: interesado mueve el negocio a «En conversación» con «Responder hoy»; ahora no enfría el enrolamiento noventa días; fuera de oficina pausa hasta la fecha; baja marca las fichas del espacio; referido lo propone en la bandeja; ambigua (o confianza menor de 0,7) avisa para que una persona la lea. Cada llamada va a `outbound_llm_call` (`classify`) con la decisión guardada en la misma transacción, y mira el tope diario antes de gastar; el lote se reparte entre workspaces (cinco de cada uno como mucho) y uno sin presupuesto no entra. Nada se paga dos veces: una respuesta ilegible queda ambigua, y si aplicar los efectos falla se reintentan solo los efectos; al tercer fallo queda ambigua con un aviso. Sin `ANTHROPIC_API_KEY`, no clasifica y lo dice (la bandeja lo lee con `outreach_classifier_status`, 0065). |

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
     `min_gap_seconds`, 0052 §1) → espera su turno.
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
   diga en la ficha «Sí, salió» o «No salió: enviarlo» (0053); rebote →
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
   `stop_company_on_reply` (0054, encendido por defecto), pone en pausa
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
mano («Sí, salió», 0053): con él, el lector lee ese hilo y la respuesta
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
la demo. Sin `GOOGLE_CLIENT_ID/SECRET` el correo está «no configurado»
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
src/jobs/ventas/             sales.follow_ups · outbound.dispatch · outbound.replies · canales/ (VEN-10) · outbound.generate · outbound.review (VEN-12) · outbound.intent (VEN-14)
test/                        integración (pglite) y unitarias
```
