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
| `platform/db/migrations/0036_demografia_de_cuenta.sql` | `metric_gap`, el UNIQUE que le faltaba a `audience_breakdown`, y las filas nuevas de `metric_requirement` |
| `platform/apps/worker/src/jobs/conexiones/prerrequisitos-demografia.ts` | Función **pura**: qué puede pedirse a cada cuenta y, si no, qué `metric_requirement` lo explica |
| `platform/apps/worker/src/jobs/conexiones/collect-demographics.ts` | El job `collect.demographics` (cron `20 5`, ya en `job_definition` de 0009) |
| `platform/packages/db/src/queries/conexiones.ts` | El contrato de lectura para RES-4: `getAccountAudience` / `listAccountAudience` |
| `platform/packages/connectors/fixtures/…` | Tres respuestas grabadas nuevas (Instagram `city`, YouTube canal) |
| `platform/packages/connectors/src/platforms/youtube-api.ts` | La constante del scope de Analytics (dato del conector, no del job) |

No se toca ninguna pantalla: la demografía en pantalla es RES-4. Y no
hay Server Action, así que no entra `requirePermission` (ACC-1) ni
`audit()` (ACC-2): lo que escribe es un job del worker, que mide, y lo
que añade a `queries/conexiones.ts` son dos funciones de **solo
lectura** (la prueba de convención de ACC-2 solo alcanza a las que
escriben).

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
| Instagram | `access_mode = 'direct_oauth'` y el token vivo | `ig.demographics.auth` |
| | `account_type ≠ 'personal'` | `ig.insights.account_type` |
| | seguidores conocidos ≥ 100 | `ig.demographics` |
| TikTok | `access_mode = 'direct_oauth'` y el token vivo | `tt.audience.auth` |
| | `account_type ≠ 'personal'` | `tt.audience.account_type` |
| | `scopes` incluye `user.insights` | `tt.audience.scope` |
| | seguidores conocidos ≥ 100 | `tt.audience_age` |
| YouTube | `access_mode = 'direct_oauth'` y el token vivo | `yt.demographics.auth` |
| | `scopes` incluye `yt-analytics.readonly` | `yt.analytics.scope` |
| Facebook | — | fuera de alcance (§0.4) |

**Seguidores desconocidos no es «menos de cien».** Si la cuenta nunca
tuvo snapshot, el prerrequisito de los cien seguidores **no** se da por
fallado: se llama, y si la plataforma responde que no hay bastantes
(Meta: `code 100`, `error_subcode 2108006`), *ahí* se escribe
`ig.demographics`. Un nulo no es un cero, tampoco aquí.

**«El token vivo» es parte de la autorización.** Una conexión en
`needs_reauth` está tan lejos del dato como una que nunca se autorizó, y
por la misma razón. Antes se quedaba fuera de la consulta del job y su
celda vacía no tenía ninguna explicación; ahora entra y se lleva su
`owner_authorization`.

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
tabla **no tenía** (0003 solo dejó dos índices no únicos). 0036 añade

```sql
CREATE UNIQUE INDEX audience_breakdown_account_uniq
  ON audience_breakdown (connection_id, day, population, dimension, bucket)
  WHERE scope = 'account';
```

y el INSERT va con `ON CONFLICT DO NOTHING`. **No se borra ni se
reescribe nada**: la tabla es append-only (regla del repo) y `mc_app` ni
siquiera tiene INSERT sobre ella (0025 §5). Dos corridas el mismo día
dejan exactamente las mismas filas.

El corto-circuito es **por dimensión, no por cuenta**: si la corrida de
esta mañana se cortó en el cuarto corte de Instagram, la siguiente pide
solo ese y no da el día por hecho porque hubiera «algo». Y lo que sí
respondió antes del fallo se guarda igual: la cuota ya se gastó, y tirar
tres cortes buenos porque el cuarto falló los hace pagar dos veces.

La migración además **desduplica antes de crear el índice**. Darla por
limpia sería contradictorio —el motivo de la sección es que los
duplicados eran posibles—, y sin ese paso una base sucia aborta la
migración entera y se queda sin `metric_gap` mientras el worker ya
registra el job.

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

0036 crea `metric_gap`: **una fila viva por (conexión, grupo de
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
ni «cien seguidores». 0036 amplía el CHECK con `owner_authorization` y
añade cinco filas:

| id | red | `requirement` | Qué dice |
|---|---|---|---|
| `ig.demographics.auth` | instagram | `owner_authorization` | «Esta cuenta se agregó por su @… Para ver la demografía, el dueño tiene que autorizar la lectura de sus cifras.» |
| `tt.audience.auth` | tiktok | `owner_authorization` | ídem, más el aviso del trámite de TikTok |
| `yt.demographics.auth` | youtube | `owner_authorization` | ídem |
| `ig.insights.account_type` | instagram | `business_account` | «Instagram solo entrega audiencia en cuentas profesionales…» |
| `yt.analytics.scope` | youtube | `scope_video_insights` | «Falta el permiso de YouTube Analytics…» |
| `tt.audience.account_type` | tiktok | `business_account` | «La demografía de TikTok solo existe en cuentas Business… ten en cuenta que pierde Creator Rewards.» |
| `tt.audience.scope` | tiktok | `scope_video_insights` | «Falta el permiso de audiencia de la cuenta…» |

Las siete de 0011 se dejan intactas: son inmutables y siguen valiendo.

> **DESVÍO DEL CRITERIO DE TERMINADO, PENDIENTE DE NICOLÁS.** El
> enunciado decía que una cuenta personal de TikTok quedara con
> `tt.insights.scope` o `tt.audience_age`. No se hace, y esta es la
> razón: `tt.insights.scope` es del grupo `retencion_y_audiencia` y su
> texto dice «vuelve a conectar la cuenta y acepta el permiso de
> insights». A una cuenta **personal** eso la manda a una puerta que no
> abre —el scope es de la app de negocio y antes hay que pasar la cuenta
> a Business, perdiendo Creator Rewards—, y además el `metric_group`
> guardado (`demografia_de_cuenta`) contradiría el de la fila. De ahí
> las dos filas propias. Si prefieres la letra del criterio, es cambiar
> dos `return` en `prerrequisitos-demografia.ts`.

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

El «último día» se busca **por dimensión**, no por cuenta: un día en que
la plataforma entrega la edad pero no el país no puede borrar de la
pantalla el país que sí se leyó ayer. Por eso cada `dimensions[]` lleva
su propio `day`.

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

---

## 1. Qué recolecta y qué escribe, cuenta por cuenta

Una corrida de `collect.demographics` mira cada conexión viva del
workspace y toma **una** de estas cuatro salidas:

| Salida | Cuándo | Qué queda escrito | Llamadas |
|---|---|---|---|
| **Ya estaba** | Hay filas de `audience_breakdown` de hoy para esa cuenta | nada | 0 |
| **Dato** | Pasa los prerrequisitos y la API responde | las filas del día en `audience_breakdown`, y se borra su `metric_gap` | 1 (TikTok), 2 (YouTube), 4 (Instagram) |
| **Hueco** | Falta un prerrequisito, o la API confirma que falta | una fila en `metric_gap` con el `requirement_id` | **0** si se detectó antes; 1 si lo dijo la API |
| **Fallo** | Red, 5xx, cuota, token muerto | nada nuevo; `auth` pasa la conexión a `needs_reauth` | 1 |

`job_run.metadata` los separa: `saved`, `alreadyToday`, `gaps`
(id de conexión → requisito), `unsupported`, `errored`, `transient`. No
lleva ni un token: `metadata` pasa por el redactor del logger.

## 2. La migración `0036_demografia_de_cuenta.sql` (para revisar y aplicar)

Tres cosas, todas re-ejecutables. Va detrás de 0034 (ACC-3, ya aplicada) y 0035 (CAM-3), y no depende de
ninguna de las dos.

1. `audience_breakdown_account_uniq`: índice único parcial sobre
   `(connection_id, day, population, dimension, bucket) WHERE scope = 'account'`.
   Sin él, dos corridas el mismo día duplicaban cada bucket y la
   pantalla sumaba el doble.
2. `metric_requirement`: el CHECK de `requirement` acepta
   `owner_authorization`, y entran cinco filas nuevas (§0.2 (5)).
3. `metric_gap`: tabla nueva, con `workspace_id`, su política de RLS en
   `FORCE`, y `REVOKE INSERT, UPDATE, DELETE … FROM mc_app` —la escribe
   el worker, que es quien mide; la web solo la lee, como con
   `audience_breakdown` (0025 §5).

Comprobado con `make db.check` (Postgres embebido: 35 migraciones,
98 tablas, 248 índices) y con la guardia de aislamiento de `packages/db`
(`test/schema.test.ts`), que exige política a toda tabla nueva con
`workspace_id` y se negaría a pasar si `metric_gap` no la tuviera.

**Choque de números.** La rama de ACC-6 trae otra `0034`
(`membership_scope`) y al integrarse tendrá que moverse; si el
integrador la pone en `0036`, esta pasa a `0037`. No depende de nada
posterior a `0011`, así que renumerarla es cambiarle el nombre.

**No hace falta tocar `packages/db/src/schema/`** (tuyo): la guardia no
exige que una tabla nueva esté en el esquema Drizzle mientras esté
aislada —es el mismo caso de `connection_secret` (0015)—. Si prefieres
tenerla tipada, es un `pgTable` de siete columnas.

## 3. Lo que necesito de ti, Rasheed

1. **Aplicar 0036** en la cola única, detrás de 0034 (ACC-3) y 0035 (CAM-3).
2. **Nada más en el código.** `queries/conexiones.ts`,
   `apps/worker/src/jobs/conexiones/` y `packages/connectors/` son míos,
   y la migración es del tipo que ya firmamos con 0014, 0015, 0016 y
   0022 (pasa `db.check`; `db.guardia` va contra Supabase y no puedo
   correrla sin el vault).

## 4. El contrato de lectura para RES-4 (tuyo, sprint 6)

Ya está en `@mc/db`, importable por subruta como el resto del módulo:

```ts
import { getAccountAudience, listAccountAudience } from '@mc/db/queries/conexiones';

const a = await withWorkspace((tx) => getAccountAudience(tx, connectionId));
```

Devuelve, por cuenta:

```ts
{
  connectionId, platformId, handle,
  day: '2026-09-23' | null,        // null = nunca hubo demografía
  dimensions: [                     // solo las que SÍ llegaron
    { population: 'followers', dimension: 'age',
      buckets: [{ bucket: '13-17', share: null, absolute: 8200 }, …] },
    { population: 'viewers', dimension: 'age_gender',
      buckets: [{ bucket: '25-34|F', share: 0.279, absolute: null }, …] },
  ],
  gaps: [                           // vacío si no falta nada
    { metricGroup: 'demografia_de_cuenta', requirementId: 'tt.audience.auth',
      requirement: 'owner_authorization', messageEs: 'Esta cuenta se agregó por su @…',
      fixUrl: null, day: '2026-09-23', detectedAt: '2026-09-23T05:20:00.000Z' },
  ],
}
```

Cuatro cosas que te ahorran decisiones en la pantalla:

- **`messageEs` ya viene escrito**, de la migración. La pantalla no
  redacta la frase; si mañana cambia, cambia en una migración y no en
  el JSX. Es la regla de «una ausencia se explica con una frase».
- **Los buckets llegan ordenados** como se pintan: la edad y edad×género
  en su orden natural (`13-17`, `18-24`, …), y el país y la ciudad por
  tamaño, de mayor a menor.
- **`share` y `absolute` no son intercambiables y uno de los dos es
  `null` siempre**: Instagram da personas, YouTube y TikTok dan
  porcentajes. Un nulo no es un cero, y no lo conviertas: si enseñas
  porcentajes sobre los absolutos de Instagram, di sobre qué total.
- **Los `share` no suman 1** (§0.2 (3)). En el fixture de YouTube suman
  0,91 porque Analytics omite los tramos con pocas vistas. No los
  normalices: la diferencia es información.

Lo que **no** trae y sigue siendo de RES-4: `online_followers` («cuándo
publicar»), que es otra métrica y otra tabla, y la demografía por post.

## 5. Verificación (23 de septiembre de 2026)

Todo contra respuestas grabadas, sin red (`withoutNetwork()`:
`guard.attempts === 0`) y sin tocar Supabase.

### 5.1 El worker de verdad, en Postgres embebido

Cinco cuentas de un workspace: Instagram autorizada, TikTok Business,
TikTok personal, canal de YouTube con el scope de Analytics, y una
cuenta agregada por `@`. Una corrida de `collect.demographics`:

```
job_run  status=ok  procesados=5  fallidos=0  ms=2857

audience_breakdown (39 filas, scope account, día 2026-09-23)
  instagram  cafealma           followers  age         25-34    share=—         personas=164000
  instagram  cafealma           followers  city        Bogotá, Bogota            personas=141000
  instagram  cafealma           followers  gender      F                         personas=288000
  tiktok     laura.cocinafacil  followers  country     CO       share=0.820000  personas=—
  youtube    NutriveOficial     viewers    age_gender  25-34|F  share=0.279000  personas=—
  youtube    NutriveOficial     viewers    country     CO       share=—         personas=31000
  …

metric_gap · por qué NO hay demografía
  instagram/selvathegolden (public_profile) → owner_authorization
      «Esta cuenta se agregó por su @, y lo que Instagram publica no
        incluye la audiencia. Para verla, el dueño tiene que autorizar
        la lectura de sus cifras.»
  tiktok/laura.personal (direct_oauth) → scope_video_insights
      «Falta el permiso de analítica de video. Vuelve a conectar la
        cuenta y acepta el permiso de insights.»

api_call_log · a quién se llamó
  instagram.account.demographics  cafealma           ok=true   (×4, un corte cada una)
  tiktok.business.get             laura.cocinafacil  ok=true
  youtube.analytics.query         NutriveOficial     ok=true   (×2)
  fetch fuera de los fixtures: 0
```

Siete llamadas para tres cuentas con dato. **Cero** para las dos que no
cumplen el prerrequisito, que es el criterio de terminado.

### 5.2 Pruebas automáticas

| Qué | Dónde |
|---|---|
| La decisión de llamar o no, camino por camino, en 2 s | `apps/worker/test/prerrequisitos-demografia.test.ts` (7) |
| El job de punta a punta sobre fixtures | `apps/worker/test/collect-demographics.test.ts` (4) |
| El contrato de lectura, el orden y el aislamiento por RLS | `packages/db/test/demografia.test.ts` (4) |
| Que la tabla nueva está aislada y `mc_app` no la escribe | `packages/db/test/schema.test.ts` (68, ya existían) |
| El esquema en Postgres embebido | `make db.check` |

## 6. Qué falta para la prueba en vivo (el bloqueo)

La historia está construida y probada contra respuestas grabadas. Para
darla por terminada de verdad hace falta, por este orden:

1. **Una conexión autorizada de verdad.** `OAUTH_CONNECT=1` y el flujo
   de CON-3 con una cuenta profesional de Instagram. Es el camino más
   corto: el de Meta no depende de ningún trámite y `me/insights` con
   `instagram_business_manage_insights` ya está implementado y grabado.
2. **YouTube**: depende de CON-8 (OAuth del canal) y de que el consentimiento
   incluya `yt-analytics.readonly`, que **no** viene con `youtube.readonly`.
3. **TikTok**: depende del trámite **CON-9** (Accounts API Access
   Application Form). Sin él no hay `user.insights` y toda cuenta de
   TikTok queda con su `metric_gap`, que es exactamente lo que la
   pantalla debe enseñar mientras tanto.

Mientras no llegue (1), lo que el producto enseña de demografía es la
frase que explica por qué no la hay — que es el 100 % de lo que puede
enseñar hoy con honestidad, y era el objetivo de la historia.

---

## 7. Las dos revisiones

### 7.1 `/code-review` en nivel alto · seis hallazgos, seis arreglados

| # | Qué | Qué se hizo |
|---|---|---|
| 1 | Un error **definitivo** de una cuenta apagaba el `retry: false` de la cuota agotada de **otra**, y pg-boss quemaba los reintentos contra el mismo muro | `onlyQuota` solo lo decide lo que de verdad entra en `transient`. La rama `permanent` ya no lo toca |
| 2 | Los cuatro cortes de Instagram se acumulaban en memoria: si fallaba el cuarto, los tres buenos se tiraban, la cuota se gastaba dos veces y no se escribía nada | `readDemographics` devuelve `{ rows, error }`. Lo que respondió se guarda, y el fallo se trata después |
| 3 | El índice único se creaba sin desduplicar, en una migración cuyo motivo es justamente que había duplicados. En una base sucia, 0036 abortaba entera y `metric_gap` no llegaba a existir | Un `DELETE` previo que conserva la lectura más reciente de cada grupo, explicado en la cabecera |
| 4 | `tt.insights.scope` es del grupo `retencion_y_audiencia` y su texto manda a una cuenta personal a una puerta que no abre | Dos filas propias: `tt.audience.account_type` y `tt.audience.scope`. Es el desvío del criterio que está marcado en §0.2 (5) |
| 5 | Una conexión en `needs_reauth` quedaba fuera de la consulta del job, así que su celda vacía no tenía explicación **ninguna** | Entra en el `SELECT`, y `planDemographics` la trata como lo que es: una autorización que hay que rehacer |
| 6 | `max(day)` por cuenta: un día en que la plataforma entregaba menos cortes **borraba** de la pantalla el corte que sí se leyó ayer, y el hueco que lo explicaría se borraba en la misma escritura | El último día se busca por dimensión, y cada dimensión lleva su propio `day` |

Los seis tienen prueba: la 1 y la 4 en `prerrequisitos-demografia.test.ts`
(milisegundos), la 2 y la 5 en `collect-demographics.test.ts`, la 3 en
`make db.check`, y la 6 en `packages/db/test/demografia.test.ts`
(«el corte que hoy no llegó sigue siendo el de la última vez»).

### 7.2 Lo que solo se vio corriendo el worker

Ninguna prueba lo miraba, porque todas comprobaban que hubiera **una**
frase, no cuál. Al leer la salida de la corrida apareció esto:

```
youtube/CanalCaido (direct_oauth, needs_reauth) → owner_authorization
    «Este canal se agregó por su @, y la API pública no da audiencia…»
```

El canal **no** se agregó por su @: se autorizó, y el permiso se cayó.
Las tres filas `*.auth` daban por hecho el camino de CON-10, y desde el
arreglo 5 del code-review llegan aquí también las autorizaciones caídas.
Los tres textos se reescribieron para no afirmar cómo se agregó la
cuenta, que en la mitad de los casos sería falso, y la prueba de
`@mc/db` ahora lo exige explícitamente.

### 7.3 `/security-review` · cero hallazgos

Se corrió porque la historia toca privilegios (`REVOKE` sobre una tabla
nueva), RLS y la clasificación de errores de las plataformas. Comprobó
el aislamiento de `metric_gap`, que las cinco escrituras del worker
—que corre como `mc_worker` y se salta RLS— llevan su `workspace_id`
explícito, que no hay una sola concatenación de SQL, y que ni el token
ni el cuerpo crudo de la plataforma llegan a la base, al log ni a
`job_run.metadata`.

De las dos observaciones que dejó por debajo del umbral se adoptó una:
`metric_gap` queda declarada en `PRIVILEGIOS_DE_LA_APP`
(`packages/db/src/esquema.ts`). Sin esa línea, la guardia solo vigila
los privilegios de las tablas declaradas, y un `GRANT … ON ALL TABLES`
futuro le habría devuelto a `mc_app` la escritura sin que nadie lo
notara. La otra —que el `ON CONFLICT` de `writeGap` no refresca
`workspace_id`— solo importaría si una `social_connection` cambiara de
workspace, cosa que hoy ningún código hace.
