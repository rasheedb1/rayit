# CON-5 · Recolector de posts y métricas — plan y lo que necesita Rasheed

Escrito para: Nicolás (dueño de Conexiones) y Rasheed (dueño de
`db/migrations/`, de `queries/resumen.ts` y del despliegue del worker).
Fecha: 23 de septiembre de 2026. Rama `nicolas/CON-5-recolector-posts`,
worktree `rayit-con5`.

**Qué es.** Los dos jobs que llenan `post` y `post_metric_snapshot` para
las cuentas del workspace con las fuentes que el MVP tiene (CON-10):
Instagram por `business_discovery` con el token de la casa, YouTube por
Data API con API key y —solo si hay conexión `direct_oauth`— los
clientes autorizados de CON-1. TikTok por @ no tiene fuente de posts:
sus videos entran por el CSV de TikTok Studio (RES-2) y estos jobs los
dejan en paz.

Es la entrada de datos de Resumen (RES-1 lee `post` y
`post_metric_snapshot`), y lo que van a leer CON-6 (línea base y
puntaje), CAM-5 (resultado de campaña) y «Mis videos» (fase 2).

---

## 0. Plan (fase 1)

### 0.1 Lo que se leyó antes de diseñar (23-sep-2026, documentación oficial)

| Qué | Dónde | Qué dice |
|---|---|---|
| Campos de `IG Media` | developers.facebook.com/docs/instagram-platform/reference/instagram-media/ | `id`, `caption`, `comments_count`, `like_count`, `media_type` (`IMAGE`·`VIDEO`·`CAROUSEL_ALBUM`), `media_product_type` (`AD`·`FEED`·`STORY`·`REELS`, **solo API con Facebook Login**), `media_url`, `permalink`, `thumbnail_url` (solo VIDEO), `timestamp` (ISO 8601 UTC), `username`, `shortcode`, `is_shared_to_feed`, `view_count` (**solo Business Discovery**, vistas de reels, incluye pagado y orgánico). `like_count` se omite si el dueño oculta los likes. |
| `business_discovery` y su edge `media` | developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/business-discovery/ y .../instagram-graph-api/reference/ig-user/business_discovery | El ejemplo pide `media{comments_count,like_count,view_count}`. «The `/media` edge supports cursor-based pagination, so when accessing it via field expansion, the response will include `before` and `after` cursors if the response contains multiple pages of data. Unlike standard cursor-based pagination, however, the response will not include `previous` or `next` fields.» «Data about age-gated Instagram professional accounts will not be returned.» |
| `videos.list` de YouTube | developers.google.com/youtube/v3/docs/videos/list y .../docs/videos | Coste **1 unidad**; `id` es «a comma-separated list of the YouTube video ID(s)» (la página no publica un máximo; el repo usa 50 desde CON-1). `statistics`: `viewCount`, `likeCount`, `commentCount`; `dislikeCount` solo para el dueño autenticado desde el 13-dic-2021; `favoriteCount` está deprecado y siempre vale 0. `contentDetails.duration` en ISO 8601 (`PT15M33S`); `snippet.publishedAt` en ISO 8601. |

**Lo que NO da la fuente pública, y por eso queda `null` en el MVP:**

| Métrica | Instagram por @ | YouTube por @ | Qué la desbloquea |
|---|---|---|---|
| `views` | solo reels (`view_count`); feed y carrusel → `null` | sí (`viewCount`) | — |
| `reach` | no | no | OAuth del dueño (`media_insights`) |
| `saves` | no | no | OAuth del dueño |
| `shares` | no | no | OAuth del dueño |
| retención (`avg_watch_time_s`, `completion_rate`, `skip_rate_3s`, cuartiles) | no | no | OAuth del dueño (Instagram insights, YouTube Analytics) |
| `profile_visits`, `follows_from_post` | no | no | OAuth del dueño |
| `reach_followers` / `reach_non_followers` | no | no | OAuth del dueño |

La regla del repositorio se cumple sin excepción: **una celda sin dato
es `null`, nunca `0`.** `total_interactions` solo se calcula cuando hay
al menos un término (misma regla que RES-2, `num_nonnulls`).

### 0.2 Decisiones

**1 · Un solo modelo de fuente con dos estrategias (`PostSource`).**

```ts
interface PostSource {
  platformId; label; missing: readonly string[];
  /** ¿Puede preguntar por un post concreto por su id? */
  supportsLookupById: boolean;
  /** Por qué esta fuente no lista posts, en español; null si sí lista. */
  noPostsNoteEs: string | null;
  listRecentPosts(target, { since, max, signal }): AsyncIterable<NormalizedVideo>;
  postMetrics(target, ids, { signal }): Promise<PostMetricsResult[]>;
}
```

Una implementación **pública** por plataforma (Instagram
`business_discovery.media`, YouTube `channels.list` +
`playlistItems.list` + `videos.list`) y otra **autorizada** sobre los
clientes de CON-1 (`tiktokDisplay.iterateVideos`/`queryVideos`,
`instagram.iterateMedia` + `mediaInsights`, `youtube` con el token del
canal), elegida por `social_connection.access_mode`. Así, encender
`OAUTH_CONNECT=1` no cambia una línea de los jobs.

*Descartado*: un job por plataforma (tres veces la misma máquina de
cuota, errores y upsert) y un `if` por plataforma dentro del job (lo que
hoy es un `if` de dos ramas serían seis al llegar CON-8 y CON-12).

TikTok `public_profile`: `noPostsNoteEs` explica que sus videos entran
por el archivo de TikTok Studio; la cuenta se anota en
`metadata.sinFuenteDePosts` y **no** cuenta como fallo.

**2 · `collect.posts` (cron `0 */6`).** Descubre posts por cuenta y hace
`upsert` por el UNIQUE natural `(platform_id, external_post_id,
connection_id)`.

- `first_seen_at` **no se toca nunca** en el `DO UPDATE`: es la primera
  vez que nosotros vimos el post, no la última.
- Cada columna de texto opcional entra con
  `COALESCE(EXCLUDED.x, post.x)`: la API manda donde tiene dato y nunca
  borra con un `null` lo que ya había (esa es la mitad de la regla de
  fusión con el CSV, punto 3).
- `deleted_on_platform = false` al volver a verlo (un post que reaparece
  deja de estar marcado).
- **Ventana**: `since` = `max(published_at)` de los posts que ya
  conocemos de esa conexión; `max` = 25 posts. Se paginan páginas hasta
  agotar `max` o hasta ver un post con `published_at <= since`, lo que
  ocurra primero. **Fuente del 25**: es el `limit` por defecto de
  `/me/media` en `instagram-api.ts` (CON-1) y cabe en una sola página de
  las dos fuentes; con el cron de 6 h haría falta publicar 26 videos en
  seis horas para perder uno, y la corrida siguiente lo recoge igual
  porque `since` no avanza más allá de lo que se guardó.

**3 · La regla de fusión con el CSV (para Rasheed).** La identidad de un
post es `(platform_id, external_post_id, connection_id)`, el UNIQUE de
0003. De ahí salen dos casos distintos:

- **Misma conexión** (un CSV importado sobre la cuenta por @, o una
  cuenta que luego se autoriza): es el **mismo post**. El `upsert` de
  `collect.posts` actualiza identidad y metadatos (la API manda), y los
  snapshots del CSV se conservan intactos porque van a
  `post_metric_snapshot` con `source = 'csv_import'` y esa tabla es
  append-only. Resumen ya los distingue: `getFreshnessByConnection`
  separa `dia_api` (`source <> 'csv_import'`) de `dia_csv`.
- **Conexiones distintas**: `ensureCsvConnection` (RES-2) crea su propia
  fila `access_mode = 'manual_csv'` con
  `external_account_id = 'csv:<handle>'`. Un video de TikTok importado
  por CSV y el mismo video leído por API serían **dos filas de `post`**.
  Hoy no puede pasar (TikTok no tiene fuente de posts por @ y el CSV es
  solo de TikTok Studio), así que **CON-5 no fusiona entre conexiones**:
  sería adivinar. Si mañana el CSV se usa para Instagram o YouTube, la
  fusión correcta es unificar la *conexión*, no el post — y eso es una
  historia aparte (ver §3). **DECISIÓN PENDIENTE DE NICOLÁS**, tomada
  por lo conservador: no fusionar y dejarlo escrito.

**4 · `collect.post_metrics` (cron `0 5`).** Un snapshot por post activo:

- `captured_at` = `ctx.now()` (nunca `Date.now()`), un solo instante
  para toda la corrida.
- `age_hours` = `round(EXTRACT(EPOCH FROM (captured_at - p.published_at)) / 3600.0, 2)`,
  calculado **en SQL sobre `post.published_at`**, exactamente la misma
  expresión que usa `importCsvReadings` (RES-2): así dos lecturas del
  mismo video por caminos distintos son comparables al decimal.
- `source = 'api'` (es lo que Resumen cuenta como «lectura de la API»).
- `raw` = la respuesta cruda del item, pasada por `redactSecrets`.
- `null` donde la API no dio el dato.
- **Tope de edad**: `720 h` (el corte más alto de `AGE_CUTS_HOURS` en
  `packages/core/src/scoring.ts`) más **7 días de gracia** = 888 h, para
  que el corte de 720 h tenga siempre una lectura posterior con la que
  interpolar. **Salvo** que el post esté en una campaña abierta
  (`campaign_post` → `campaign.status IN ('planned','live','measuring')`),
  que se sigue midiendo hasta `ends_on + 30 días` (CAM-5). La regla es
  pura y vive en `packages/core/src/recoleccion.ts`.

**5 · Idempotencia.**

- Dos corridas el mismo día producen **dos filas** por post: es
  append-only a propósito, y es lo que dibuja
  `post_metrics_daily_delta`.
- Un post nunca se duplica: lo impide el UNIQUE de `post`.
- Una corrida abortada a mitad no repite lo hecho **al reintentar**:
  cuando `ctx.attempt > 1`, un post que ya tiene un snapshot `'api'` de
  los últimos 60 minutos se salta y se cuenta en
  `metadata.yaMedidos`. En el primer intento no se salta nada (si no,
  un envío manual después del cron no dejaría fila y el criterio de
  «dos corridas, dos filas» dejaría de cumplirse).

**6 · Cuota.**

- `business_discovery` va contra el token de la casa. El `HttpCore` ya
  lo cuenta en una sola ventana (la regla de `instagram` en
  `quota/limits.ts` es 200/hora y las llamadas de la casa llevan
  `connection_id = null`, así que comparten cubo). Encima, el job pone
  un tope por corrida, `COLLECT_INSTAGRAM_CALLS_PER_RUN` (por defecto
  **150**), para dejar 50 llamadas/hora libres a `collect.account_metrics`
  y a la pantalla.
- YouTube: 1 unidad por llamada, presupuesto diario de 10 000
  (`quota/limits.ts`, persistido en `api_quota_usage`). El job consulta
  `core.quota.usedToday(...)` antes de cada lote y deja de pedir cuando
  quedan menos de `COLLECT_YOUTUBE_UNITS_RESERVE` (por defecto **500**)
  unidades.
- Agotada la cuota: lo que falta queda para mañana, con
  `metadata.deferred` y **`retry: false`** (el siguiente tick del cron
  es el reintento).

**7 · Errores** (mismo reparto que `collect.account_metrics`):

| Qué pasó | Qué hace el job |
|---|---|
| `not_found` / `not_discoverable` / `invalid_handle` | `social_connection.status = 'error'` con `status_detail` en español |
| `auth` (Meta 190, HTTP 401) | `status = 'needs_reauth'`, `status_detail`, y una fila en `notification` (`kind = 'connection_error'`, `severity = 'critical'`, `action_url = '/conexiones'`) |
| `quota` | se para esa plataforma, `deferred`, `retry: false` |
| transitorio | cuenta como `failed`; pg-boss reintenta |
| `ctx.signal` abortada | se deja de llamar; lo pendiente cuenta como `failed` |

Nunca hay un fallo silencioso: todo cuenta en
`metadata { descubiertos, snapshots, saltados, errores, … }`.

**8 · `deleted_on_platform`: se marca en `collect.post_metrics`, no en
`collect.posts`.** Es la única desviación de la forma que pedía el
enunciado, y la razón es el coste: marcar un borrado exige preguntar por
los ids **que ya conocemos**, y eso es justamente lo que hace
`collect.post_metrics` todos los días. Hacerlo también en
`collect.posts` duplicaría las llamadas sin aprender nada nuevo. Solo
las fuentes con `supportsLookupById` (YouTube pública, TikTok e
Instagram autorizadas) pueden marcarlo; `business_discovery` no permite
preguntar por un medio concreto, así que **un post de Instagram por @
que el creador borre se queda sin lecturas nuevas pero no se marca**, y
así está documentado.

**9 · Lectura para la pantalla.** En `queries/conexiones.ts`,
`listAccounts` añade `postsCount` (posts vivos de esa conexión) y
`lastPostSnapshotAt` (última lectura de contenido). La fila de
`/conexiones` lo dice sin pantalla nueva. No se toca `queries/resumen.ts`.

### 0.3 Qué se construye

```
packages/connectors/src/posts/
  types.ts                 PostSource, PostSourceTarget, PostMetricsResult, PostCollectionError
  instagram-posts.ts       business_discovery.media con el token de la casa
  youtube-posts.ts         channels.list(contentDetails) + playlistItems.list + videos.list
  tiktok-posts.ts          sin fuente por @: noPostsNoteEs
  authorized.ts            la estrategia con el token del dueño (CON-1)
  index.ts                 createPublicPostSources(core, env) · createAuthorizedPostSource(core, …)
packages/connectors/src/platforms/instagram-api.ts   + businessDiscoveryMedia() y su normalizador
packages/connectors/src/platforms/youtube-api.ts     + channelWithUploadsByHandle()
packages/connectors/fixtures/instagram/business_discovery.media.{ok,empty,paginated,nulls}.json
packages/connectors/fixtures/youtube/channels.list.handle.uploads.ok.json
packages/core/src/recoleccion.ts                     la regla de hasta cuándo se mide un post
packages/db/src/queries/conexiones.ts                postsCount y lastPostSnapshotAt en listAccounts
apps/worker/src/jobs/conexiones/collect-posts.ts
apps/worker/src/jobs/conexiones/collect-post-metrics.ts
apps/worker/src/jobs/conexiones/_posts.ts            lo común: selección de cuentas, fuente por access_mode
apps/worker/src/jobs/conexiones/index.ts             + los dos jobs
apps/web/app/(app)/conexiones/page.tsx               la fila dice cuántas publicaciones y hasta cuándo
```

**Ninguna migración.** `collect.posts` y `collect.post_metrics` ya están
en `job_definition` (0009, líneas 28 y 29), `mc_worker` ya tiene
`INSERT`/`UPDATE` sobre `post` y `post_metric_snapshot` (0014) y las
vistas que hacen falta son las de 0010.

### 0.4 Dudas resueltas por lo conservador

1. **¿`views` de Instagram por @ en feed?** No existe: `view_count` es
   de reels. Queda `null`, no `0`.
2. **¿Fusionar posts entre una conexión de CSV y una por @?** No (§0.2
   punto 3). **DECISIÓN PENDIENTE DE NICOLÁS.**
3. **¿Cuántas páginas por cuenta?** Una (25 posts) por corrida, cuatro
   veces al día. Es el tope conservador contra la cuota de la casa.

---

## 1. Qué lee Resumen y qué le dejo (para Rasheed)

`queries/resumen.ts` ya lee todo lo que estos jobs escriben, sin
cambios:

| Dónde lo lee | Qué necesita | Qué le deja CON-5 |
|---|---|---|
| `getResumenCoverage` | `post` + algún `post_metric_snapshot` | una fila de `post` por video y al menos un snapshot al día |
| `getFreshnessByConnection` | `max(captured_at) FILTER (source <> 'csv_import')` | `source = 'api'`, así que cuenta como `dia_api` |
| `getViewsByWeek` (`SQL_VIEWS_CONTENIDO`) | `post.published_at`, `post.deleted_on_platform`, `post_metrics_latest.views` | `published_at` de la plataforma; `deleted_on_platform` solo cuando la API confirma el borrado |
| KPIs de contenido | `post_metrics_latest.reach`, `.saves`, `.reach_non_followers`, `.views` | `views` sí (YouTube y reels de Instagram); `reach`, `saves` y `reach_non_followers` en `null` hasta que haya OAuth — los `FILTER` de Rasheed ya excluyen los nulos, así que sus razones no se contaminan |

**No hace falta nada de Rasheed para que esto funcione.** Lo único que
le pido es que lea §0.2 punto 3 (fusión con el CSV) por si RES-2 se
extiende a Instagram o YouTube.

---

## 2. Qué exige OAuth, y por eso queda `null` en el MVP

`reach`, `saves`, `shares`, `reposts`, `total_interactions` completo,
`profile_visits`, `follows_from_post`, `link_clicks`,
`reach_followers`/`reach_non_followers` y toda la retención
(`avg_watch_time_s`, `total_watch_time_s`, `completion_rate`,
`skip_rate_3s`, `views_p25..p100`) solo existen con el permiso del
dueño de la cuenta: `instagram.media.insights` (CON-3, hoy detrás de
`OAUTH_CONNECT=1`) y YouTube Analytics (CON-8, pospuesta). El código de
la estrategia autorizada ya está escrito y probado con fixtures: el día
que se encienda la bandera, esas columnas se llenan solas.

---

## 3. Lo que va a leer lo que viene

- **CON-6** (línea base y puntaje): `post_metrics_at_cut` a 24/72/168/720 h
  y `post_metrics_latest`. CON-5 garantiza una lectura diaria hasta las
  888 h, que es lo que hace que el corte de 720 h tenga dato.
- **CAM-5** (resultado de campaña): `post_metrics_daily_delta` de los
  posts de `campaign_post` mientras la campaña esté abierta y hasta
  `ends_on + 30 días`.
- **«Mis videos»** (fase 2): `creator_post_board`, que ya une `post`,
  `post_metrics_latest` y `post_score`.

---

## 4. Variables de entorno nuevas (opcionales, con valor por defecto)

Ninguna hace falta para que el job arranque; todas tienen defecto y
**no son secretos**, así que no tocan el vault:

| Variable | Para qué | Por defecto |
|---|---|---|
| `COLLECT_POSTS_MAX` | Posts nuevos por cuenta y corrida | `25` |
| `COLLECT_INSTAGRAM_CALLS_PER_RUN` | Tope de llamadas al token de la casa por corrida | `150` |
| `COLLECT_YOUTUBE_UNITS_RESERVE` | Unidades de YouTube que el recolector no gasta | `500` |
| `COLLECT_MAX_AGE_HOURS` | Tope de edad para seguir midiendo | `888` (720 + 7 días) |

Las que sí son secretos ya existen desde CON-10:
`INSTAGRAM_HOUSE_TOKEN` y `GOOGLE_API_KEY`.
