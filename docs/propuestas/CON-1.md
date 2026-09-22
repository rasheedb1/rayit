# CON-1 · Conectores con respuestas grabadas — plan y lo que necesita Rasheed

Escrito para: Rasheed (dueño de `db/migrations/`, `db/seed/0001_catalog.sql`
y del trámite CON-9) y quien revise el PR de CON-1.
Fecha: 22 de septiembre de 2026. Rama `nicolas/CON-1-conectores-grabados`,
worktree `rayit-con1`, desde `origin/main` (`bc72a12`).

---

## 0. Plan (fase 1)

### 0.1 Qué se construye y dónde

Todo vive en `packages/connectors/` (carpeta de Nicolás) salvo la
integración con el `JobContext`, que toca `apps/worker/src/runner/`
(también de Nicolás) y `apps/worker/src/jobs/conexiones/oauth-refresh.ts`.
No se toca `db/migrations/` ni `db/seed/0001_catalog.sql`.

```
packages/connectors/
  src/http/errors.ts        PlatformApiError + clasificador único (kind)
  src/http/retry.ts         backoff exponencial con jitter, Retry-After, señal
  src/http/client.ts        HttpCore: fetch/now/sleep inyectables, Bearer, log por intento
  src/quota/limits.ts       tabla de límites en código, con fuente y fecha por fila
  src/quota/manager.ts      QuotaManager en memoria + persistencia diaria (api_quota_usage)
  src/quota/postgres.ts     UPSERT sobre los dos índices únicos parciales
  src/log/sink.ts           CallLogSink, CallLogEntry
  src/log/postgres.ts       PostgresCallLogSink({ query })
  src/log/memory.ts         InMemoryCallLogSink
  src/normalize/types.ts    NormalizedPost, NormalizedPostMetrics, NormalizedAccountMetrics, NormalizedDemographics
  src/platforms/tiktok-display.ts   userInfo, listVideos, queryVideos, iterateVideos
  src/platforms/tiktok-accounts.ts  accountInfo, listVideos, videoInsights
  src/platforms/instagram-api.ts    me, media, mediaInsights, accountInsights, audienceDemographics, businessDiscovery
  src/platforms/youtube-api.ts      channelMine, uploadsPlaylistItems, videosById, channelByHandle, analyticsReport
  src/factory.ts            createConnectors(): lo que el worker cuelga en ctx.connectors
  src/testing/fixture-fetch.ts      FixtureFetch + loadFixture + withoutNetwork (exportado para el worker)
  fixtures/<plataforma>/<endpoint>[.<caso>].json
  scripts/record.ts         regraba fixtures con un token real (EnvSecretStore), anonimizando
  eslint.config.mjs         el mismo de apps/worker
  README.md
```

Los archivos `src/platforms/{tiktok,instagram,youtube}.ts` (refreshers,
CON-2) no se reescriben: sus cabeceras siguen documentando la renovación
y los clientes nuevos van en archivos aparte.

### 0.2 Decisiones

1. **Cliente HTTP: un núcleo y una clase por plataforma.** `HttpCore`
   recibe `fetch`, `now`, `sleep` y `random` inyectables (por defecto los
   globales), un `CallLogSink`, un `QuotaManager` y un logger mínimo.
   Cada llamada lleva `AbortSignal`. La credencial se pasa como
   `OAuthTokens` y el núcleo pone la cabecera (`Authorization: Bearer`
   en TikTok Display, Instagram y Google; `Access-Token` en TikTok
   Accounts, que no acepta Bearer). **Nunca va en la URL**, aunque Meta
   lo permita como `access_token=`: así no aparece en ningún log de
   acceso. Todo error y toda entrada de log pasan por `redactSecrets` y
   además por `scrubTokens`, que borra el valor literal del token si una
   plataforma lo devolviera en un mensaje. Alternativa descartada: un
   cliente por endpoint con `fetch` directo (como el `logApiCall` de
   CON-2): repite reintentos, cuota y log en cada sitio.
2. **Taxonomía de errores.** `PlatformApiError { platformId, endpoint,
   httpStatus, code, kind, messageEs, retryAfterS, requestId }` con
   `kind: 'transient' | 'permanent' | 'auth' | 'quota'`. Un solo
   clasificador (`classifyApiError`) que reutiliza `kindFromHttp` y
   `PERMANENT_CODES` de `token-refresher.ts` y añade lo que cada API
   documenta:
   - `auth`: HTTP 401; TikTok `access_token_invalid` y
     `scope_not_authorized` (ambos 401 según su tabla de errores); Meta
     `code 190` (cualquier subcódigo) y `code 10`/`200-299` de permisos
     se quedan en `permanent` (no es el token, es el permiso); Google
     401 y `reason: authError`.
   - `quota`: presupuesto agotado que no se arregla reintentando ahora:
     Google 403 `quotaExceeded` / `dailyLimitExceeded`; Meta códigos
     4, 17, 32, 613, 80002 (BUC/plataforma, ventana de horas); y lo que
     lance el `QuotaManager` antes de disparar.
   - `transient`: 429 (TikTok `rate_limit_exceeded`, Google
     `rateLimitExceeded`/`userRateLimitExceeded`), 5xx, red, timeout,
     señal abortada. Se reintenta.
   - `permanent`: 400/404 y el resto: `invalid_params`,
     `scope_permission_missed`, Meta 100 (parámetro o métrica no
     soportada), Google `playlistNotFound`.
   CON-5 convierte `auth` en `needs_reauth`, `quota` en `retry: false`
   hasta el siguiente tick, `transient` en fallo reintentable y
   `permanent` en un error por elemento que no toca la conexión.
3. **Reintentos.** Exponencial con jitter completo: base 1 s, factor 2,
   tope 30 s, `maxRetries` 3 por defecto (4 intentos), solo para
   `transient`. Si viene `Retry-After` (segundos o fecha HTTP) manda
   sobre el backoff. La señal corta la espera y el intento. Cada
   intento deja **su** fila en `api_call_log`. `auth`, `permanent` y
   `quota` no reintentan nunca.
4. **Cuota.** `QuotaManager` en memoria por proceso con dos piezas:
   ventanas deslizantes (`RateRule { scope: 'connection' | 'app',
   perEndpoint, windowS, max }`) y presupuesto diario (`DailyBudget {
   scope, units }`). `acquire()` **espera** (con `sleep` inyectado)
   cuando la siguiente llamada superaría una ventana y **lanza `quota`
   sin llamar** cuando el presupuesto del día ya no alcanza. Al cerrar
   cada intento, `commit()` suma unidades y persiste por `UPSERT` en
   `api_quota_usage` sobre los dos índices únicos parciales
   (`connection_id` nulo = cuota de app: YouTube). El contador del día
   se siembra desde la tabla la primera vez que se toca (así dos
   procesos o un reinicio no parten de cero). El día es **UTC**, regla
   del repo; la cuota de YouTube se reinicia a medianoche del Pacífico,
   así que nuestro corte es conservador unas horas. Tabla en
   `quota/limits.ts` con fuente y fecha por fila; `platform.limits`
   (vacío en 0002) la sobreescribe cuando exista, con el JSON de la
   sección 1 de este documento.
5. **Registro.** `CallLogSink { record(entry): Promise<void> }` con
   `PostgresCallLogSink({ query })` (en el worker, `ctx.db`) e
   `InMemoryCallLogSink`. La entrada lleva exactamente las columnas de
   `api_call_log`; `error_message` es el mensaje de la plataforma
   recortado a 500 caracteres, sin cuerpo y sin token. Escribir el log
   nunca tumba la llamada: un fallo del sink se registra en el logger
   como `warn` y se sigue.
6. **Endpoints y normalización.** Cada método devuelve `{ data, raw }`:
   `data` es el tipo normalizado y `raw` el cuerpo tal cual (para
   `post_metric_snapshot.raw`). Los nombres de `NormalizedPostMetrics`
   son las columnas de `post_metric_snapshot`; `NormalizedAccountMetrics`
   las de `account_metric_snapshot`; `NormalizedDemographics` filas de
   `audience_breakdown` (`population`, `dimension`, `bucket`, `share`,
   `absolute`). Donde la API no da el dato, `null`, nunca `0`; un
   contador que sí viene en 0 se conserva en 0. Paginación como
   `AsyncIterable` de páginas con `maxPages` (por defecto 10).
7. **Fixtures.** `fixtures/<plataforma>/<endpoint>[.<caso>].json` con
   `{ meta, request: { method, urlPattern, body? }, response }`, donde
   `response` puede ser un objeto o una **lista** consumida en orden
   (`server_error_then_ok`). Hoy salen de los ejemplos de la
   documentación (`source: 'docs'`); `scripts/record.ts` los regraba
   con un token real (`EnvSecretStore`, `env:NOMBRE`) anonimizando ids
   y handles. `FixtureFetch` casa método, URL (regex) y cuerpo
   (subconjunto) y falla con la lista de lo que esperaba ante una
   llamada no prevista. `withoutNetwork()` reemplaza `globalThis.fetch`
   por uno que lanza durante la prueba.

### 0.3 Lo que la documentación oficial dice hoy (22-sep-2026)

| Plataforma | Dato | Valor | Fuente |
|---|---|---|---|
| TikTok Display | Límite | 600 req/min por endpoint (`user/info`, `video/list`, `video/query`), ventana deslizante de un minuto; 429 `rate_limit_exceeded` | developers.tiktok.com/doc/tiktok-api-v2-rate-limit (página del 4-ago-2026) |
| TikTok Display | `video/list` | POST, `cursor` (ms UTC), `max_count` 10 por defecto y 20 máximo, `fields` en query | developers.tiktok.com/doc/tiktok-api-v2-video-list |
| TikTok Display | `video/query` | POST, `filters.video_ids` hasta 20 | developers.tiktok.com/doc/tiktok-api-v2-video-query |
| TikTok Display | Video | `id, create_time (s), cover_image_url (TTL 6 h), share_url, video_description, duration, height, width, title, embed_html, embed_link, like_count, comment_count, share_count, view_count, is_aigc` | developers.tiktok.com/doc/tiktok-api-v2-video-object |
| TikTok Display | Errores | `access_token_invalid` 401, `scope_not_authorized` 401, `scope_permission_missed` 400, `invalid_params` 400, `rate_limit_exceeded` 429, `internal_error` 500 | developers.tiktok.com/doc/tiktok-api-v2-error-handling |
| TikTok Accounts | `business/video/list` | campos `item_id, create_time, thumbnail_url, share_url, embed_url, caption, video_views, likes, comments, shares, reach, video_duration, full_video_watched_rate, total_time_watched, average_time_watched, impression_sources, audience_countries`; los de retención sin dato hasta que el video lleve 7 días; los posts dejan de actualizarse a los 365 días; retraso de 24–48 h | business-api.tiktok.com/portal/docs (Accounts API v1.3; el portal es JavaScript y no se pudo leer entero: **ver 0.5**) |
| Instagram (Instagram Login) | Host y versión | `graph.instagram.com`, ejemplos con `v25.0` | developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/get-started |
| Instagram | Usuario | `/me?fields=id,user_id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count` (enteros) | …/reference/ig-user |
| Instagram | Medios | `/me/media`, máximo 10 000 más recientes, cursores `paging.cursors.after`; `media_type` IMAGE/VIDEO/CAROUSEL_ALBUM, `media_product_type` AD/FEED/STORY/REELS; `like_count` se omite si el dueño oculta likes | …/reference/instagram-media |
| Instagram | Insights de medio | reels: `views, reach, saved, shares, likes, comments, total_interactions, ig_reels_avg_watch_time, ig_reels_video_view_total_time, reels_skip_rate, follows, profile_visits, profile_activity, navigation, reposts`; `impressions` fuera para medios posteriores al 2-jul-2024 | …/reference/instagram-media/insights |
| Instagram | Insights de cuenta | `reach, views, accounts_engaged, total_interactions, likes, comments, shares, saves, replies, reposts, follows_and_unfollows, profile_links_taps, follower_demographics, engaged_audience_demographics`; `period=day|lifetime`, `metric_type=total_value|time_series`, `breakdown=age|gender|city|country|follow_type|media_product_type|contact_button_type`, `timeframe` para demografía; demografía exige ≥100 seguidores; retraso hasta 48 h | …/api-reference/instagram-user/insights |
| Instagram | Límite | Plataforma: 200 llamadas por hora × usuarios; BUC: 4800 × impresiones en 24 h por par app-usuario; errores 4, 17, 32, 613, 80002 | developers.facebook.com/docs/graph-api/overview/rate-limiting |
| Instagram | `business_discovery` | `GET /{ig-user-id}?fields=business_discovery.username({u}){followers_count,media_count}`; no devuelve cuentas con restricción de edad; documentado bajo Facebook Login (**ver 0.5**) | …/instagram-api-with-facebook-login/business-discovery |
| YouTube Data | Cuota | 10 000 unidades/día por proyecto; `channels.list`, `playlistItems.list`, `videos.list`, `playlists.list` cuestan 1; `search.list` cuesta 1 en un cubo propio de 100/día; toda petición, aun inválida, cuesta al menos 1 | developers.google.com/youtube/v3/determine_quota_cost (actualizada 15-sep-2026) |
| YouTube Data | `channels.list` | `mine`, `id`, `forHandle` (con o sin @); `contentDetails.relatedPlaylists.uploads`; `statistics.*` como cadenas, `hiddenSubscriberCount` | …/v3/docs/channels/list |
| YouTube Data | `playlistItems.list` | `maxResults` 0–50 (5 por defecto), `pageToken`, `nextPageToken`; 404 `playlistNotFound` | …/v3/docs/playlistItems/list |
| YouTube Data | `videos.list` | `id` separados por coma (nosotros: 50 por llamada), `contentDetails.duration` ISO 8601, `statistics` cadenas que pueden faltar | …/v3/docs/videos/list |
| YouTube Analytics | `reports.query` | `https://youtubeanalytics.googleapis.com/v2/reports`, `ids=channel==MINE`, `startDate`, `endDate`, `metrics`, `dimensions`, `filters=video==ID`; respuesta `columnHeaders[]` + `rows[][]`; cuota aparte; scope `yt-analytics.readonly` | developers.google.com/youtube/analytics/reference/reports/query |
| YouTube Analytics | Dimensiones | `day` YYYY-MM-DD, `video`, `ageGroup` (`age13-17` … `age65-`), `gender` (`female`, `male`, `user_specified`), `country` ISO 3166-1 | developers.google.com/youtube/analytics/dimensions |

### 0.4 Decisiones pendientes de Nicolás (se tomó la opción conservadora)

- **DECISIÓN PENDIENTE DE NICOLÁS · límite por cuenta en TikTok
  Display.** La documentación de hoy dice 600 req/min por endpoint y no
  distingue por cuenta; `docs/arquitectura.md` fija 40/min por cuenta
  y endpoint. Se aplican **las dos**: 40/min por (conexión, endpoint) y
  600/min por (app, endpoint). Si TikTok confirma que 600 es por app,
  la de 40 sobra pero no estorba.
- **DECISIÓN PENDIENTE DE NICOLÁS · Instagram por hora.** Se aplica
  200 llamadas/hora por conexión (la fórmula de plataforma es
  200 × usuarios por app, así que por conexión es el reparto justo). El
  límite BUC (4800 × impresiones) no se puede calcular sin impresiones;
  se respeta reaccionando a sus códigos (`quota`).
- **DECISIÓN PENDIENTE DE NICOLÁS · cuota de YouTube Analytics.** Google
  no publica el número de la cuota de Analytics; se registra con
  `request_units = 1` en un presupuesto de app aparte
  (`youtube-analytics`) sin tope numérico hasta tener el dato del
  proyecto en Google Cloud.

### 0.5 Dudas que no se resolvieron con la documentación pública

- El portal de la **Accounts API de TikTok** se renderiza con
  JavaScript y `WebFetch` no obtiene el cuerpo. Los campos de
  `business/video/list` de 0.3 salen de la búsqueda sobre el mismo
  portal. **`video_view_retention` y `engagement_likes` no aparecen en
  ninguna fuente pública**: el cliente los acepta si vienen (van a
  `raw` y a `retention_curve` / `likes_curve` opcionales) pero no se
  puede prometer que existan hasta que el trámite CON-9 dé acceso al
  portal con el scope `video.insights`. Está marcado en el código.
- `business_discovery` está documentado bajo la variante con Facebook
  Login. Con Instagram Login el host es `graph.instagram.com` y el
  campo debería responder igual; el fixture lo asume. Se confirma con
  la app de prueba de CON-3.

### 0.6 Fuera de alcance (y a qué historia va)

- Guardar `post`, `post_metric_snapshot`, `account_metric_snapshot`,
  `audience_breakdown`: **CON-5** y **CON-7**. Aquí solo se devuelven
  normalizados.
- Renovar tokens al recibir `auth` dentro del cliente: **CON-3** (el
  refresher real) y **CON-5** (quién decide reintentar tras renovar).
- Cambiar `platform.limits` en el seed: **Rasheed** con el JSON de §1.
- Publicar contenido (Content Posting API): fase 2.

---
