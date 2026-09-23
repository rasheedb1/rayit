# CON-7 · Demografía de audiencia (`collect.demographics`)

**Autor**: Nicolás · **Fecha**: 23 de septiembre de 2026 ·
**Rama**: `nicolas/CON-7-demografia-audiencia`

Un job diario que escribe `audience_breakdown` con la demografía de cada
cuenta conectada y, cuando la plataforma no la entrega, escribe **por qué**
en un sitio que la pantalla pueda leer. Es lo que RES-4 (Rasheed, sprint 6)
necesita para no pintar una celda vacía.

> **La historia queda BLOQUEADA para la prueba en vivo.** Ninguna fuente
> pública da demografía: `business_discovery` no la trae, YouTube la da
> solo por la Analytics API con OAuth y TikTok solo por la Accounts API
> con el trámite CON-9. Hoy `OAUTH_CONNECT` está apagado (decisión del
> 22-sep) y no hay ninguna conexión `direct_oauth` con los scopes de
> insights, así que **todo el trabajo va contra respuestas grabadas**.
> El código está completo y probado; lo que falta es una cuenta real
> autorizada. Detalle en §4.

---

## 0. Plan (fase 1)

### 0.1 Qué se construye y dónde

| Archivo | Qué |
|---|---|
| `platform/db/migrations/0034_demografia_de_cuenta.sql` | `metric_gap`, el UNIQUE que le faltaba a `audience_breakdown`, y las filas nuevas de `metric_requirement` |
| `platform/apps/worker/src/jobs/conexiones/prerrequisitos-demografia.ts` | Función **pura**: qué puede pedirse a cada cuenta y, si no, qué `metric_requirement` lo explica |
| `platform/apps/worker/src/jobs/conexiones/collect-demographics.ts` | El job `collect.demographics` (cron `20 5`, ya en `job_definition` de 0009) |
| `platform/packages/db/src/queries/conexiones.ts` | El contrato de lectura para RES-4: `getAccountAudience` / `listAccountAudience` |
| `platform/packages/connectors/fixtures/…` | Tres respuestas grabadas nuevas (Instagram `city`, YouTube canal) |
| `platform/packages/connectors/src/platforms/youtube-api.ts` | La constante del scope de Analytics (dato del conector, no del job) |

No se toca ninguna pantalla: la demografía en pantalla es RES-4.

### 0.2 Decisiones

**(1) Los prerrequisitos se evalúan ANTES de llamar, y la API puede
corregirnos después.**

El criterio de terminado lo exige: «ninguna llamada a la API se hace
cuando el prerrequisito falla». La evaluación es una función pura sobre
tres datos que ya están en la base —`access_mode`, `scopes` y
`account_type` de `social_connection`, y los seguidores del último
`account_metric_snapshot`— y devuelve o un plan de llamadas o el id de
la fila de `metric_requirement` que lo explica:

| Red | Se comprueba, en este orden | Si falla |
|---|---|---|
| Instagram | `access_mode = 'direct_oauth'` | `ig.demographics.auth` |
| | `account_type ≠ 'personal'` | `ig.insights.account_type` |
| | seguidores conocidos ≥ 100 | `ig.demographics` |
| TikTok | `access_mode = 'direct_oauth'` | `tt.audience.auth` |
| | `scopes` incluye `user.insights` | `tt.insights.scope` |
| | seguidores conocidos ≥ 100 | `tt.audience_age` |
| YouTube | `access_mode = 'direct_oauth'` | `yt.demographics.auth` |
| | `scopes` incluye `yt-analytics.readonly` | `yt.analytics.scope` |
| Facebook | — | fuera de alcance (§0.4) |

**Seguidores desconocidos no es «menos de cien».** Si la cuenta nunca
tuvo snapshot, el prerrequisito de los cien seguidores **no** se da por
fallado: se llama, y si la plataforma responde que no hay bastantes
(Meta: `code 100`, `error_subcode 2108006`), *ahí* se escribe
`ig.demographics`. Un nulo no es un cero, tampoco aquí.

Cuando la API responde con un error de permiso pese a haber pasado la
evaluación previa, el error se traduce a la misma fila de
`metric_requirement` y se escribe igual que si se hubiera detectado
antes. Un `auth` (token muerto) NO es un hueco de requisito: es un
problema de la conexión, y lo trata `oauth.refresh`.

*Alternativa descartada*: llamar siempre y clasificar el error. Es una
llamada tirada por cuenta y día contra cuotas que se pagan (YouTube
cobra unidades por petición), y deja a la pantalla esperando a que la
plataforma falle para poder explicar algo que ya sabíamos.

**(2) Un snapshot por día y cuenta, y se salta si ya hay uno de hoy.**

La demografía cambia despacio; el valor está en la serie, no en la
frescura. Antes de evaluar nada, el job pregunta si ya hay filas de
`audience_breakdown` con `scope = 'account'`, ese `connection_id` y el
`day` de hoy. Si las hay, la cuenta se salta entera: cero llamadas.

Para que eso sea idempotente de verdad hace falta un UNIQUE que la
tabla **no tenía** (0003 solo dejó dos índices no únicos). 0034 añade

```sql
CREATE UNIQUE INDEX audience_breakdown_account_uniq
  ON audience_breakdown (connection_id, day, population, dimension, bucket)
  WHERE scope = 'account';
```

y el INSERT va con `ON CONFLICT DO NOTHING`. **No se borra ni se
reescribe nada**: la tabla es append-only (regla del repo) y `mc_app` ni
siquiera tiene INSERT sobre ella (0025 §5). Dos corridas el mismo día
dejan exactamente las mismas filas.

*Alternativa descartada*: `DELETE` de las filas del día y reinsertar.
Rompe el append-only y deja una ventana en la que la pantalla no ve nada.

**(3) Los `share` se guardan tal cual, aunque no sumen 1.**

Las APIs redondean: los siete tramos de edad de YouTube suman 92,8 % en
el fixture porque Analytics omite los tramos con muy pocas vistas.
Normalizar para que sume 1 sería inventar. Se guarda lo que vino, y
`absolute` queda en `null` cuando la API dio porcentajes (YouTube,
TikTok) y `share` en `null` cuando dio absolutos (Instagram). La
pantalla calcula el porcentaje sobre el total que ve, y la suma que
enseñe será la que la plataforma dijo.

**(4) Dónde se escribe la razón: una tabla, no `status_detail`.**

`social_connection` no tiene ni `capabilities` ni `metadata`: la única
columna de texto libre es `status_detail`, y **no sirve**:

- Ya la usa `collect.account_metrics` (CON-10), que corre diez minutos
  antes (`10 5` contra `20 5`) y la deja con «TikTok no publica
  seguidores…» o con el error de la última lectura. Escribir encima la
  razón de la demografía **borraría** esa nota en `/conexiones`.
- Es **una** cadena, y una cuenta puede tener dos huecos a la vez
  (demografía y retención), cada uno con su requisito.
- No tiene ni el día ni la referencia a `metric_requirement`, así que la
  pantalla no puede enlazar el `fix_url` ni saber si la razón es de hoy.

0034 crea `metric_gap`: **una fila viva por (conexión, grupo de
métricas)**, con el `requirement_id`, el día y el instante en que se
detectó. Se reemplaza en cada corrida (`ON CONFLICT … DO UPDATE`) y se
borra en cuanto el dato llega. Es la tabla que hace que «la última
demografía, o la razón de que no haya» sea **una** consulta.

Tiene `workspace_id`, así que entra en RLS con su política, y `mc_app`
pierde INSERT/UPDATE/DELETE: la escribe el worker, que es quien mide
(mismo trato que `audience_breakdown`, 0025 §5).

> **DECISIÓN PENDIENTE DE NICOLÁS.** El prompt de la historia decía
> «propón una migración y usa `status_detail` mientras». Se tomó la
> opción conservadora en lo que importa —no pisar lo que escribe CON-10
> en una columna que ya está en pantalla— y la tabla se escribe en la
> migración siguiendo el precedente de 0014/0015/0016/0022 (una
> migración mía en `db/migrations/` si pasa `make db.check`). Si
> prefieres que `metric_gap` la firme Rasheed y que CON-7 espere, el job
> ya está aislado: la escritura del hueco vive en una sola función.

**(5) Filas nuevas de `metric_requirement`, y un valor nuevo de
`requirement`.**

Las siete filas de 0011 no cubren el caso del MVP: una cuenta agregada
por `@` (`access_mode = 'public_profile'`, CON-10) no puede dar
demografía **porque nadie autorizó**, y eso no es ni «cuenta business»
ni «cien seguidores». 0034 amplía el CHECK con `owner_authorization` y
añade cinco filas:

| id | red | `requirement` | Qué dice |
|---|---|---|---|
| `ig.demographics.auth` | instagram | `owner_authorization` | «Esta cuenta se agregó por su @… Para ver la demografía, el dueño tiene que autorizar la lectura de sus cifras.» |
| `tt.audience.auth` | tiktok | `owner_authorization` | ídem, más el aviso del trámite de TikTok |
| `yt.demographics.auth` | youtube | `owner_authorization` | ídem |
| `ig.insights.account_type` | instagram | `business_account` | «Instagram solo entrega audiencia en cuentas profesionales…» |
| `yt.analytics.scope` | youtube | `scope_video_insights` | «Falta el permiso de YouTube Analytics…» |

Las siete de 0011 se dejan intactas: son inmutables y siguen valiendo.
Para la cuenta personal de TikTok se usa `tt.insights.scope`, que es lo
que el criterio de terminado de la historia nombra.

**(6) El contrato de lectura para RES-4.**

En `packages/db/src/queries/conexiones.ts`, junto al resto del módulo:

```ts
getAccountAudience(tx, connectionId): Promise<AccountAudience | null>
listAccountAudience(tx): Promise<AccountAudience[]>

interface AccountAudience {
  connectionId: string;
  platformId: ConnectionPlatformId;
  handle: string | null;
  /** 'YYYY-MM-DD' del último día con demografía, o null si nunca hubo. */
  day: string | null;
  /** Las dimensiones que SÍ llegaron, cada una con sus buckets ordenados. */
  dimensions: AudienceDimension[];
  /** Por qué falta lo que falta. Vacío si no falta nada. */
  gaps: AudienceGap[];
}
```

`gaps` trae el `messageEs` y el `fixUrl` de `metric_requirement`: la
pantalla no escribe ni una frase propia, y si mañana cambia el texto de
un requisito, cambia en la migración y no en el JSX. Detalle en §2.

### 0.3 Lo que se decide al llamar a cada API

| Red | Llamada | `population` | `dimension` |
|---|---|---|---|
| Instagram | `audienceDemographics('followers', b)` para b ∈ age, gender, country, city | `followers` | la del breakdown |
| TikTok | `accountInfo({ startDate, endDate })` (una sola) | `followers` | `country`, `gender`, `age` |
| YouTube | `channelDemographics(…)` + `countryBreakdown(null, …)` | `viewers` | `age_gender`, `country` |

La ventana de los que la piden (TikTok y YouTube) es **los 28 días que
terminan ayer**: los datos llegan con 24–48 h de retraso (nota de 0011)
y pedir «hasta hoy» devuelve una fila a medio llenar. 28 días es el mes
móvil que usa la propia pantalla de TikTok y encaja con el
`this_month` que Instagram trae por defecto.

### 0.4 Fuera de alcance (y a qué historia va)

- **La pantalla de demografía y «cuándo publicar»**: RES-4 (Rasheed,
  sprint 6). Aquí solo se recolecta y se ofrece la consulta.
- **Demografía por post** (`scope = 'post'`): fase 2. YouTube la da por
  video y TikTok por país; las dos llamadas están en los conectores
  (`videoDemographics`, `countryBreakdown(videoId, …)`) sin usar.
- **`engaged_audience_demographics`** de Instagram (población
  `engaged`): duplica las llamadas y RES-4 no lo pide. El conector ya lo
  soporta: es cambiar un argumento.
- **Facebook**: Meta eliminó la demografía de página en 2024
  (`docs/investigacion-apis.md`, línea 19) y no hay conexiones de
  Facebook en el MVP. El job las cuenta como «sin fuente» y no llama.
- **`seguidores conectados por hora`** (el «cuándo publicar» de RES-4):
  es `online_followers`, otra métrica y otra tabla. No es demografía.
