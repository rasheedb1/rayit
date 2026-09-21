# TikTok: qué datos por video puede obtener una app cuando un creador hace login

**Fecha de investigación:** 2026-09-20
**Fuentes:** exclusivamente documentación oficial de `developers.tiktok.com` y `business-api.tiktok.com` / `ads.tiktok.com/marketing_api`.
**Nota de método:** los docs de `business-api.tiktok.com/portal/docs?id=NNN` son una SPA. El contenido citado aquí se extrajo del endpoint oficial de contenido que usa esa misma SPA: `https://ads.tiktok.com/gateway/api/doc/client/node/get/?doc_id=NNN&identify_key=...&language=ENGLISH`. Es la misma fuente que renderiza el portal público.

---

## Hallazgo principal (resumen ejecutivo)

Existen **dos familias de API completamente distintas**, con portales, apps, OAuth y scopes separados:

| | **TikTok for Developers (Display API)** | **TikTok API for Business — Accounts API** |
|---|---|---|
| Portal | developers.tiktok.com | business-api.tiktok.com (My Apps de Marketing API) |
| Host | `open.tiktokapis.com` | `business-api.tiktok.com/open_api/v1.3` |
| OAuth | Login Kit, `client_key`/`client_secret` | `client_id`/`client_secret`, `auth_code` |
| Métricas por video | Solo contadores públicos (likes, comments, shares, views) | **Analítica completa, incluida retención segundo a segundo** |

**La respuesta corta a la pregunta clave (#5): SÍ existe retención por segundo vía API oficial**, en el campo `video_view_retention` de `/business/video/list/` de la Accounts API. No está en la Display API.

---

## 1. TikTok Login Kit / OAuth (developers.tiktok.com)

### 1.1 Scopes disponibles hoy

Lista completa publicada en la referencia de scopes (https://developers.tiktok.com/docs/en/tiktok-api-scopes):

**User**
| Scope | Definición oficial |
|---|---|
| `user.info.basic` | "Read a user's profile info (open id, avatar, display name...)" |
| `user.info.profile` | "Read access to profile_web_link, profile_deep_link, bio_description, is_verified." |
| `user.info.stats` | "Read access to a user's statistical data, such as likes count, follower count" |

**Video**
| Scope | Definición oficial |
|---|---|
| `video.list` | "Read a user's public videos on TikTok" |
| `video.publish` | "Directly post content to a user's TikTok profile." |
| `video.upload` | "Share content to creator's account as a draft to further edit and post in TikTok." |

**Research** (no comercial, ver §3)
`research.adlib.basic`, `research.data.basic`, `research.data.u18eu`, `research.data.vra`

**Portability** (ver §9)
`portability.activity.ongoing`, `portability.activity.single`, `portability.all.ongoing`, `portability.all.single`, `portability.directmessages.ongoing`, `portability.directmessages.single`, `portability.postsandprofile.ongoing`, `portability.postsandprofile.single`

**Local Service**
`local.product.manage`, `local.shop.manage`, `local.voucher.manage`

> **No existe ningún scope de analítica/insights en esta familia.** No hay `video.insights` ni equivalente en developers.tiktok.com. (Verificado: la página de scopes no lo lista.)

`user.info.basic` se añade automáticamente a todas las apps de Login Kit (https://developers.tiktok.com/docs/en/scopes-overview).

### 1.2 Duración de tokens

Fuente: https://developers.tiktok.com/doc/oauth-user-access-token-management/

- **access_token:** válido 24 horas (`expires_in` = 86400).
- **refresh_token:** válido 365 días (`refresh_expires_in` = 31536000).
- Endpoint de token: `POST https://open.tiktokapis.com/v2/oauth/token/` (`Content-Type: application/x-www-form-urlencoded`).
- Revocación: `POST https://open.tiktokapis.com/v2/oauth/revoke/`.
- **Rotación:** el refresh puede devolver un refresh_token distinto. Cita: "You must use the newly-returned token if the value is different than the previous one." → hay que persistir el nuevo.

### 1.3 Auditoría / App review

Fuentes: https://developers.tiktok.com/docs/en/app-review-guidelines , https://developers.tiktok.com/docs/en/content-posting-api-get-started , https://developers.tiktok.com/docs/en/content-sharing-guidelines

- **Sandbox** = entorno restringido para probar sin review. **Production** = requiere submit y aprobación.
- Se requiere al menos 1 video demo del flujo end-to-end (máx. 5 videos, 50 MB c/u). Si la app nunca fue aprobada, es obligatorio demostrar con sandbox.
- **Antes de auditoría (Content Posting API):** "All content posted by unaudited clients will be restricted to private viewing mode." Además, clientes no auditados están limitados a **5 usuarios publicando en 24 h**.
- **Después de auditoría:** se levanta la restricción de privacidad; tope de ~**15 posts por creador por día**; el tope de creadores depende de lo declarado en la solicitud de auditoría.
- Tiempo de review: de varios días a ~2 semanas.

---

## 2. Display API — `/v2/video/list/` y `/v2/video/query/`

### 2.1 Lista COMPLETA y exacta de campos del objeto Video

Fuente: https://developers.tiktok.com/docs/en/tiktok-api-v2-video-object

| Campo | Tipo | Descripción oficial |
|---|---|---|
| `id` | string | Identificador único del video (también llamado "item_id") |
| `create_time` | int64 | "UTC Unix epoch (in seconds) of when the TikTok video was posted" |
| `cover_image_url` | string | CDN de la portada estática. **"the link has a TTL of 6 hours"** |
| `share_url` | string | Link compartible; se comporta distinto en móvil vs escritorio |
| `video_description` | string | Descripción del creador, máx. 150 caracteres |
| `duration` | int32 | Duración en segundos |
| `height` | int32 | Alto del video |
| `width` | int32 | Ancho del video |
| `title` | string | Título, máx. 150 caracteres |
| `embed_html` | string | Código HTML del reproductor embebido |
| `embed_link` | string | Link de embed de tiktok.com |
| `like_count` | int32 | Número de likes |
| `comment_count` | int32 | Número de comentarios |
| `share_count` | int32 | Número de shares |
| `view_count` | int64 | Número de vistas |
| `is_aigc` | bool | true si es contenido generado por IA; añade el tag AI-generated |

**Eso es TODO.** Son 16 campos. No hay watch time, no hay retención, no hay demografía, no hay tráfico/fuente, no hay URL del mp4.

### 2.2 `/v2/video/list/`

Fuente: https://developers.tiktok.com/docs/en/tiktok-api-v2-video-list

- **Endpoint:** `POST https://open.tiktokapis.com/v2/video/list/`
- **Scope:** `video.list`
- **Headers:** `Authorization: Bearer {token}`, `Content-Type: application/json`
- **Query param:** `fields` (lista separada por comas de los campos de §2.1)
- **Body:**
  - `cursor` (int64, opcional): "The cursor value is a UTC Unix timestamp in milliseconds. You can pass in a customized timestamp to fetch the user's videos posted before the provided timestamp."
  - `max_count` (int32, opcional): **default 10, máximo 20**
- **Respuesta:** `videos` (lista), `cursor`, `has_more`
- Devuelve "a paginated list for the given user's **public** TikTok video posts, sorted by `create_time` in descending order."
- **Antigüedad máxima:** la documentación **no** declara límite de antigüedad. Paginando con `cursor` se puede retroceder. → **No verificado** que exista un corte temporal duro.
- Solo videos **públicos**. Los privados/friends-only no aparecen (implícito en la definición del scope: "Read a user's **public** videos").

### 2.3 `/v2/video/query/`

Fuente: https://developers.tiktok.com/docs/en/tiktok-api-v2-video-query

- **Endpoint:** `POST https://open.tiktokapis.com/v2/video/query/`
- **Scope:** `video.list`
- **Body:** `filters.video_ids` — **"Up to 20 video IDs can be included per request."**
- Devuelve los mismos campos de §2.1.
- Uso recomendado por TikTok: como `cover_image_url` expira (TTL 6 h), hay que re-consultar `/v2/video/query/` para refrescar metadatos.

### 2.4 Rate limits Display API

Fuente: https://developers.tiktok.com/doc/tiktok-api-v2-rate-limit (última actualización que declara la página: August 4, 2026)

| API | Limit |
|---|---|
| `/v2/user/info/` | 600 |
| `/v2/video/query/` | 600 |
| `/v2/video/list/` | 600 |

- "Request rate calculation is based on a one minute sliding window." → **600 requests/minuto**.
- Al exceder: **HTTP 429** + error code `rate_limit_exceeded`.
- Se puede pedir aumento vía Support Page.
- **No verificado:** la página NO dice si los 600/min son por `client_key` o por `access_token` de usuario. La tabla solo tiene columnas "API" y "Limit".

---

## 3. Research API

Fuentes: https://developers.tiktok.com/docs/en/about-research-api , https://developers.tiktok.com/docs/en/research-api-specs-query-videos , https://developers.tiktok.com/docs/en/research-api-get-started

### 3.1 Elegibilidad — CRÍTICO

La página oficial la limita a "independent and academic researchers who conduct research on a **non-for-profit basis**". Hay una vía adicional para "Vetted Researchers" bajo el **EU Digital Services Act** (scope `research.data.vra`) para investigación de riesgos sistémicos.

> **Conclusión para un producto comercial: NO califica.** La base "non-for-profit" excluye un SaaS de analítica. No intentar esta vía.

### 3.2 Campos que sí da (referencia, aunque no podamos usarla)

Campos de respuesta en `/v2/research/video/query/`:
`id`, `create_time`, `username`, `region_code`, `video_description`, `music_id`, `like_count`, `comment_count`, `share_count`, `view_count`, `effect_ids`, `hashtag_names`, `hashtag_info_list`, `sticker_info_list`, `effect_info_list`, `video_mention_list`, `video_label`, `playlist_id`, `voice_to_text`, `is_stem_verified`, `video_duration`, `favorites_count`, `video_tag`

Campos de filtro: `create_date`, `username`, `region_code`, `video_id`, `hashtag_name`, `keyword`, `music_id`, `effect_id`, `video_length`, `view_count`, `comment_count`

Límites: `max_count` default 20, máximo 100; "end_date must be no more than 30 days after the start_date". Quota declarada en el doc de rate limits: 1000 requests/día, hasta 100.000 registros/día.

También existe `/v2/research/video/comment/list/` (comentarios de cualquier video público) — pero con la misma restricción de elegibilidad.

**Nota:** la Research API tampoco da retención por segundo ni watch time. Da `voice_to_text` (transcripción), que la Display API no da.

---

## 4. TikTok API for Business — Accounts API (business-api.tiktok.com)

**Esta es la API que resuelve el producto.**

### 4.1 Qué es y quién puede usarla

Fuente: https://business-api.tiktok.com/portal/docs?id=1737944384433218

La Accounts API tiene tres módulos: **Accounts Insights**, **Accounts Moderation** (comentarios), **Accounts Video Publishing**. Funciona con **TikTok Business Accounts Y TikTok Personal Accounts** — cita textual: "pulling Reporting / Insights, Comment Moderation, and Video Publishing for a **Business Account or Personal Account**".

> **Corrección a una creencia común: NO se requiere que el creador tenga cuenta Business para usar la Accounts API.** Sí se requiere para *ciertos campos* (ver §4.5).

**Requisito nuevo y bloqueante:** "starting **March 20, 2026** at 00:00 (GMT+0), developers must complete the **Accounts API Access Application Form** before submitting a new developer app or requesting a scope increase that includes the 'TikTok Accounts' permission scope." (formulario Lark enlazado desde el doc oficial).

**Usos autorizados** (cita): gestionar la presencia orgánica de marcas o creadores en cuentas propias — publicar posts, moderar comentarios, **analizar insights de perfil y posts**, autorización de ads.

**Usos PROHIBIDOS** (cita textual, crítico para el diseño del producto):
1. "Extract reports of TikTok profiles and posts from authorized creators' accounts, and use the aggregated data to develop a **self-built affiliate influencer marketing program (such as creator discovery and ranking)**, instead of using the TikTok One platform or API."
2. "**Download TikTok videos and images**, promote third-party solutions to save user data or media from TikTok, or migrate content to another TikTok account or other social media platforms."

### 4.2 Prerrequisitos

Fuente: https://business-api.tiktok.com/portal/docs?id=1738083939371009

- Cuenta TikTok For Business creada.
- Registro como developer.
- Developer app con el scope de permiso **"TikTok Accounts"**.
- Logo de app subido (JPG/JPEG/PNG, ≤ 512×512 px) — sin él, el usuario ve página de error al autorizar.
- Hasta 10 redirect URLs por app. Reglas: absolutas, terminan en `/`, sin query params, sin `#`, `https://` obligatorio, sin puerto, longitud 10–512 chars.
- `auth_code`: **válido 10 minutos, un solo uso**.
- Parámetro `&disable_auto_auth=1` para forzar la pantalla de consentimiento en usuarios que ya autorizaron.

### 4.3 OAuth y tokens (Business)

Fuente: https://business-api.tiktok.com/portal/docs?id=1738084387220481

- Obtener token: `POST https://business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/token/` con `client_id`, `client_secret`, `grant_type=authorization_code`, `auth_code`, `redirect_uri`.
- Renovar: `POST .../tt_user/oauth2/refresh_token/` con `grant_type=refresh_token`.
- Revocar: `.../tt_user/oauth2/revoke/`.
- Inspeccionar scopes concedidos: `/tt_user/token_info/get/` (https://business-api.tiktok.com/portal/docs?id=1765927978092545).
- **access_token: 1 día** (`expires_in: 86400`). **refresh_token: 1 año** (`refresh_token_expires_in: 31536000`).
- Devuelve `open_id` → **este valor es el `business_id` que se pasa a todos los endpoints**.

**Scopes de esta familia** (extraídos del ejemplo oficial de respuesta):
`user.info.basic`, `user.info.profile`, `user.info.stats`, `user.info.username`, `user.account.type`, `user.insights`, `video.list`, `video.insights`, `video.upload`, `video.publish`, `comment.list`, `comment.list.manage`, `message.list.read`, `message.list.send`, `message.list.manage`, `biz.brand.insights`, `biz.spark.auth`, `biz.ads.recommend`, `biz.creator.info`, `biz.creator.insights`, `tcm.order.update`

> **`video.insights` es el scope clave.** No existe en developers.tiktok.com.

### 4.4 `/business/video/list/` — analítica por post

Fuente: https://business-api.tiktok.com/portal/docs?id=1762228421622786

- **Endpoint:** `GET https://business-api.tiktok.com/open_api/v1.3/business/video/list/`
- **Header:** `Access-Token: {token}`
- **Params (URL):**
  - `business_id` (required) = `open_id` del token
  - `fields` (string[]) — **debe incluir siempre `"item_id"`** o da error. Default: `["item_id"]`
  - `filters.video_ids` (string[]) — filtrar por IDs de post
  - `filters.ad_post_only` (bool) — solo válido con `video_ids`; default `false`
  - `cursor` (integer) — timestamp UTC Unix en **milisegundos**; default = ahora. Permite traer videos anteriores a ese timestamp.
  - `max_count` (integer) — **default 10, máximo 20**. Nota: puede devolver menos que `max_count` aunque `has_more` sea true, por políticas de trust & safety.
- **Respuesta:** `data.videos[]`, `data.cursor`, `data.has_more`

Devuelve "all the public video, photo, or text posts", incluidos posts "Only show in ads".

### 4.5 LISTA EXACTA Y COMPLETA de campos de `/business/video/list/`

| Campo | Tipo | Descripción | Scope requerido | Latencia | Fuente del dato |
|---|---|---|---|---|---|
| `item_id` | string | ID único del post | `video.list` | Real-time | — |
| `media_type` | string | `VIDEO` \| `PHOTO` (foto o texto) | `video.list` | Real-time | — |
| `is_ad` | boolean | Si el post se usa en un ad (Spark Ads) | `video.list` | Real-time | — |
| `thumbnail_url` | string | URL **temporal** de thumbnail. Expiración en query param `x-expires` (epoch seg.) | `video.list` | Real-time | — |
| `share_url` | string | URL compartible del post | `video.list` | Real-time | — |
| `embed_url` | string | Link embebible. "If the privacy setting of the post is 'Friends' or 'Only you', the video will not be viewable through this link." | `video.list` | Real-time | — |
| `caption` | string | Descripción del post | `video.list` | Real-time | — |
| `video_duration` | float | Duración en segundos, hasta 3 decimales (ej. 20.001) | `video.list` | T+24-48 h | — |
| `likes` | integer | Total de likes | `video.list` | T+24-48 h | — |
| `comments` | integer | Total de comentarios | `video.list` | T+24-48 h | — |
| `shares` | integer | Total de shares. Incluye shares externos + "Send to friends" internos | `video.list` | T+24-48 h | — |
| `favorites` | integer | Veces guardado en favoritos | `video.list` | T+24-48 h | Business Analytics |
| `create_time` | string | Unix epoch de publicación (UTC) | `video.list` | Real-time | — |
| `reach` | integer | Personas que vieron el contenido al menos una vez | `video.list` | T+24-48 h | TikTok Studio |
| `video_views` | integer | Vistas. Cuenta cuando playback > 0 y es el primer playback de la sesión de impresión. **Incluye orgánico + pagado** | `video.list` | T+24-48 h | — |
| `total_time_watched` | float | Tiempo total de reproducción, en segundos (ej. 587.024) | `video.insights` | T+24-48 h | TikTok Studio |
| `average_time_watched` | float | Tiempo medio de visionado, en segundos (ej. 3.862) | `video.insights` | T+24-48 h | TikTok Studio |
| `full_video_watched_rate` | float | % de viewers que terminan el video (ej. 0.0395) | `video.insights` | T+24-48 h | TikTok Studio |
| `new_followers` | integer | Nuevos seguidores atribuidos al post | `video.insights` | T+24-48 h | TikTok Studio |
| `profile_views` | integer | Visitas al perfil desde el post. **Solo Business Accounts** | `video.insights` | T+24-48 h | Business Analytics |
| `website_clicks` | integer | Clics al link del sitio. **Solo Verified Business Accounts** | `video.insights` | T+24-48 h | Business Analytics |
| `phone_number_clicks` | integer | Clics al teléfono. **Solo Verified Business Accounts** | `video.insights` | T+24-48 h | Business Analytics |
| `lead_submissions` | integer | Leads recogidos. **Solo Verified Business Accounts** | `video.insights` | T+24-48 h | Business Analytics |
| `app_download_clicks` | integer | Clics al link de descarga de app. **Solo Verified Business Accounts** | `video.insights` | T+24-48 h | Business Analytics |
| `email_clicks` | integer | Clics al botón Email. **Solo Verified Business Accounts** | `video.insights` | T+24-48 h | Business Analytics |
| `address_clicks` | integer | Clics al botón Address. **Solo Verified Business Accounts** | `video.insights` | T+24-48 h | Business Analytics |
| **`video_view_retention`** | **object[]** | **"Audience retention. This metric indicates how many of your viewers are still watching after a certain amount of time."** | **`video.insights`** | **T+24-48 h** | **TikTok Studio** |
| ↳ `second` | string | "A specific second in the video's timeline." | | | |
| ↳ `percentage` | float | "The percentage of viewers who are still watching your video at the specific second." | | | |
| `impression_sources` | object[] | Traffic source, ordenado de mayor a menor contribución | `video.insights` | T+24-48 h | TikTok Studio |
| ↳ `impression_source` | string | Enum: `For You`, `Follow`, `Sound`, `Personal Profile`, `Search`, `Others`, `Direct Message` (este último sujeto a disponibilidad en TikTok Studio) | | | |
| ↳ `percentage` | float | % de vistas de esa fuente | | | |
| `audience_genders` | object[] | Distribución por género | `video.insights` | T+24-48 h | TikTok Studio |
| ↳ `gender` | string | Enum: `Female`, `Male`, `Other` | | | |
| ↳ `percentage` | float | | | | |
| `audience_countries` | object[] | Top países/regiones. **Max size: 10** | `video.insights` | T+24-48 h | TikTok Studio |
| ↳ `country` | string | ISO 3166-1 alpha-2 | | | |
| ↳ `percentage` | float | | | | |
| `audience_cities` | object[] | Top ciudades. **Max size: 10**. Ej. `{"city_name": "US Cincinnati", "percentage": 0.597}` | `video.insights` | T+24-48 h | TikTok Studio |
| ↳ `city_name` | string | | | | |
| ↳ `percentage` | float | | | | |
| `audience_types` | object[] | Nuevos vs recurrentes, seguidores vs no-seguidores | `video.insights` | T+24-48 h | TikTok Studio |
| ↳ `type` | string | Enum: `NEW_VIEWER` (primera vez o hace >1 año), `RETURN_VIEWER` (vio posts en el último año), `FOLLOWER_PERCENT`, `NON_FOLLOWER_PERCENT` | | | |
| ↳ `percentage` | float | | | | |
| **`engagement_likes`** | **object[]** | **"The distribution of your viewers who liked your video at specific points in the video's timeline."** | `video.insights` | T+24-48 h | TikTok Studio |
| ↳ `second` | string | Segundo específico del timeline | | | |
| ↳ `percentage` | float | % de viewers que dieron like en ese segundo | | | |

**Notas oficiales importantes:**
- "All video engagement metrics are aggregated over the **lifetime of the video**. Unlike profile-level metrics, the aggregation is **not** limited to a 60-day look-back period."
- "**Post data will stop updating 365 days after the post is published.**"
- "The data you can get from `/business/video/list/` depends on whether you can see the corresponding TikTok Analytics data available in the app and at https://www.tiktok.com/analytics. If the corresponding metric data are missing from TikTok Analytics, you will not be able to get the data."
- "To view insights and analytics data, TikTok account owners need to **first publish at least one video, then tap the 'Turn On' button on the Analytics page** of their mobile TikTok app."
- "If the data for the fields `reach`, `full_video_watched_rate`, `total_time_watched`, `average_time_watched`, `impression_sources`, and `audience_countries` are unavailable, the reason is usually that the video has not been active (viewed/liked/commented/shared) for **more than 7 days**. To retrieve the data for these fields, you can view/like/comment/share the inactive video and retry after 24~48h."
- "If a post is not returned in the response, the reason is likely to be that the post has been **filtered out due to violations**, such as music copyright violation."

### 4.6 `/business/get/` — analítica de cuenta

Fuente: https://business-api.tiktok.com/portal/docs?id=1762228399168514

- **Endpoint:** `GET https://business-api.tiktok.com/open_api/v1.3/business/get/`
- **Params:** `business_id` (required), `start_date`, `end_date`, `fields`
  - `start_date`: default = hoy − 7 días. **"The maximum supported look-back period is 60 days."**
  - `end_date`: default = hoy − 1 día
  - `fields` default: `["display_name", "profile_image"]`

**Campos de perfil (identidad):**
`is_business_account` (requiere scope `user.account.type`), `profile_image`, `username`, `profile_deep_link`, `display_name`, `bio_description`, `is_verified`, `following_count`, `followers_count`, `total_likes`, `videos_count`

**Métricas diarias:**
`video_views` (diarias), `unique_video_views` (audiencia alcanzada diaria), `profile_views`, `likes`, `comments`, `shares`, `phone_number_clicks`, `lead_submissions`, `app_download_clicks`, `bio_link_clicks`, `email_clicks`, `address_clicks`, `daily_total_followers` (crecimiento neto), `daily_new_followers`, `daily_lost_followers`, `engaged_audience`

**Demografía de seguidores** — **requiere mínimo 100 seguidores**:
`audience_activity` (actividad horaria de seguidores), `audience_ages`, `audience_genders`, `audience_countries`, `audience_cities`

> Cita: "The data for this metric is only available for TikTok accounts with **at least 100 followers**."

**Latencia** (https://business-api.tiktok.com/portal/docs?id=1746624508278786):
- Sin latencia: `username`, `display_name`, `profile_image`, `followers_count` (total actual), y en video: `item_id`, `create_time`, `thumbnail_url`, `share_url`, `embed_url`, `caption`
- 24-48 h (UTC): todo lo demás

### 4.7 Otros endpoints de Insights

- `GET /business/video/settings/` (https://business-api.tiktok.com/portal/docs?id=1816387951979521) — equivalente Business de `creator_info/query`: `privacy_level_options`, `comment_disabled`, `duet_disabled`, `stitch_disabled`, `max_video_post_duration_sec`
- Benchmarks por categoría de negocio: https://business-api.tiktok.com/portal/docs?id=1822388944791617

### 4.8 Rate limits de la Accounts API

Fuente: https://business-api.tiktok.com/portal/docs?id=1738084416214017

- **40 QPM por cuenta TikTok autorizada y por endpoint.**
- Límite combinado para todos los endpoints de Accounts API por app, según nivel global:

| Global Rate Limit Level | QPM (todos los endpoints de Accounts API) |
|---|---|
| Basic | 600 |
| Advanced | 1,000 |
| Premium | 1,000 |
| Ultimate | 1,000 |

**Límites globales de la app** (https://business-api.tiktok.com/portal/docs?id=1740029171730433):

| Level | QPS | QPM | QPD |
|---|---|---|---|
| Basic | 10 | 600 | 864,000 |
| Advanced | 20 | 1,200 | 1,728,000 |
| Premium | 30 | 1,800 | 2,592,000 |
| Ultimate | 50 | 3,000 | 4,320,000 |

- Todas las apps arrancan en **Basic**. Se sube **un nivel a la vez**, solicitando en My Apps > App Detail > Authorization.
- Al exceder: `"code": 40100`. Para límite QPM hay que **esperar 5 minutos**. Para QPD, hasta el siguiente día UTC+0 (reset a las 00:00:00 UTC).

---

## 5. Retención segundo a segundo

### 5.1 SÍ existe en API oficial

**`video_view_retention`** en `GET /business/video/list/` (Accounts API), scope `video.insights`.

```json
"video_view_retention": [
  {"second": "0", "percentage": 1.0},
  {"second": "1", "percentage": 0.82},
  ...
]
```

Definición oficial: "Audience retention. This metric indicates how many of your viewers are still watching after a certain amount of time." / `second`: "A specific second in the video's timeline." / `percentage`: "The percentage of viewers who are still watching your video at the specific second."
Fuente del dato declarada por TikTok: **TikTok Studio**. Latencia: T+24-48 h.

Bonus: **`engagement_likes`** da la distribución de likes por segundo del timeline — señal de "momento de impacto" que ni siquiera YouTube expone.

### 5.2 NO existe en la Display API

La Display API (developers.tiktok.com) **no tiene ningún campo de retención, watch time ni percentiles**. Los 16 campos de §2.1 son la totalidad. Tampoco hay `video_views_p25/p50/p75/p100` en ninguna API orgánica de TikTok — eso son métricas de la **Reporting API de ads** (campañas pagadas), no de posts orgánicos.

### 5.3 Qué muestra la app / web (para saber qué NO automatizamos)

TikTok Studio (móvil y web, tiktok.com/analytics) muestra el gráfico de retención de audiencia por segundo, drop-offs y replays. La API entrega el **mismo dato base** (`video_view_retention`), pero **no** entrega replays/rewatch por segundo como serie separada — **no verificado** que exista ese campo en API.

**Exportación CSV:** TikTok Studio en escritorio permite descargar analytics en CSV. **No verificado en fuente oficial de TikTok**: no encontré una página oficial de developers.tiktok.com ni de business-api.tiktok.com que documente las columnas exactas del CSV ni el límite de rango. Las descripciones de columnas (watched full video rate, audience retention, total/average time watched, traffic source, territorios, género, top países/ciudades) y el límite de "60 días por descarga" provienen de fuentes de terceros, **no** de documentación oficial. **No usar como especificación.** En todo caso es irrelevante para el producto: el CSV requiere acción manual del creador y la API ya entrega estos datos.

---

## 6. Content Posting API

### 6.1 developers.tiktok.com (Login Kit)

**Direct Post** — https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post
- `POST https://open.tiktokapis.com/v2/post/publish/video/init/`
- Scope: `video.publish`
- **Rate limit: 6 requests/minuto por user access_token**
- `post_info`: `privacy_level` (required; enum `PUBLIC_TO_EVERYONE`, `MUTUAL_FOLLOW_FRIENDS`, `FOLLOWER_OF_CREATOR`, `SELF_ONLY`), `title` (máx. 2200 chars UTF-16), `disable_duet`, `disable_stitch`, `disable_comment`, `video_cover_timestamp_ms`, `brand_content_toggle`, `brand_organic_toggle`, `is_aigc`
- `source_info`: `source` (`PULL_FROM_URL` | `FILE_UPLOAD`), `video_url`, `video_size`, `chunk_size`, `total_chunk_count`
- Respuesta: `publish_id` (máx. 64 chars), `upload_url` (válido **1 hora**)

**Upload a borradores (inbox)** — https://developers.tiktok.com/docs/en/content-posting-api-reference-upload-video
- `POST https://open.tiktokapis.com/v2/post/publish/inbox/video/init/`
- Scope: `video.upload`
- **Rate limit: 6 requests/minuto por user access_token**
- El video va al **inbox del creador como borrador**: "You should inform users that they must click on inbox notifications to continue the editing flow in TikTok and complete the post."
- **"There may be at most 5 pending shares within any 24-hour period."**

**`creator_info/query`** — https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info
- `POST /v2/post/publish/creator_info/query/`, scope `video.publish`
- **Rate limit: 20 requests/minuto por user access_token**
- Devuelve:
  - `creator_avatar_url` (string) — **TTL de 2 horas**
  - `creator_username` (string)
  - `creator_nickname` (string)
  - `privacy_level_options` (list) — cuenta pública: `PUBLIC_TO_EVERYONE`, `MUTUAL_FOLLOW_FRIENDS`, `SELF_ONLY`; cuenta privada: `FOLLOWER_OF_CREATOR`, `MUTUAL_FOLLOW_FRIENDS`, `SELF_ONLY`
  - `comment_disabled` (bool)
  - `duet_disabled` (bool)
  - `stitch_disabled` (bool)
  - `max_video_post_duration_sec` (int32)

**Estado de publicación** — https://developers.tiktok.com/docs/en/content-posting-api-reference-get-video-status
- `POST /v2/post/publish/status/fetch/`, scopes `video.upload` / `video.publish`
- **Rate limit: 30 requests/minuto por user access_token**
- Body: `publish_id`
- Respuesta: `status` (`PROCESSING_UPLOAD`, `SEND_TO_USER_INBOX`, `PUBLISH_COMPLETE`, `FAILED`), `fail_reason`, `publicaly_available_post_id` (sic, con el typo oficial; solo tras moderación), `uploaded_bytes` / `downloaded_bytes`

**Specs de video** — https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide
- Formatos: MP4 (recomendado), WebM, MOV
- Codecs: H.264 (recomendado), H.265, VP8, VP9
- Tamaño máximo: **4 GB**
- Duración: "All TikTok creators can post 3-minute videos, while some have access to post 5-minute or 10-minute videos." Vía Upload Video endpoint se pueden enviar hasta **10 minutos**.
- Chunks: mínimo 5 MB, máximo 64 MB (último chunk hasta 128 MB), **mínimo 1 y máximo 1000 chunks**, subida **secuencial**. Videos <5 MB en un solo chunk; >64 MB requieren múltiples.
- Imágenes: WebP, JPEG; máx. 20 MB c/u; máx. 1080p

**Límites diarios** (https://developers.tiktok.com/docs/en/content-sharing-guidelines):
- No auditado: 5 usuarios publicando en 24 h
- Auditado: ~15 posts por creador por día; el tope de creadores depende de la solicitud de auditoría

### 6.2 business-api.tiktok.com (Accounts API)

**Publicar** — https://business-api.tiktok.com/portal/docs?id=1762228496095234
- `POST https://business-api.tiktok.com/open_api/v1.3/business/video/publish/`
- **Límite: 6 video posts por minuto por cuenta TikTok, con tope de 15 por día.**
- `post_info`: `caption`, `is_brand_organic`, `is_branded_content`, `disable_comment`, `disable_duet`, `disable_stitch`, `thumbnail_offset`, `is_ai_generated`, `upload_to_draft`, `tto_invite_link`, `location_id`, `location_name`, `is_ads_only`. Nuevos en v1.3: `custom_thumbnail_url`, `music_sound_info` (`music_sound_id`, `music_sound_volume`, `music_sound_start`, `music_sound_end`), `video_original_sound_volume`
- Constraints: `.mp4`, `.mov` o `.webm`; máx. **1 GB**; duración mín. 3 s, máx. **600 s**; mín. 360 px de alto y ancho; frame rate mín. 23 FPS, máx. 60 FPS
- **Desde 16-nov-2023 no se puede publicar con URLs de video no verificadas** — hay que verificar propiedad de la URL property (`/business/url_property/...`). TTL recomendado del archivo: ≥ 30 minutos.
- Advertencia oficial: tras publicar, la resolución y bitrate bajan por transcodificación.

**Estado** — https://business-api.tiktok.com/portal/docs?id=1816387106635778
- `GET /open_api/v1.3/business/publish/status/` con `business_id` + `publish_id` (= `share_id` de la respuesta de publish)
- `status` enum: `PROCESSING_DOWNLOAD`, `PUBLISH_COMPLETE`, `FAILED`

**Fotos:** `/business/photo/publish/` (https://business-api.tiktok.com/portal/docs?id=1803630424390658)
**Hashtags recomendados:** https://business-api.tiktok.com/portal/docs?id=1762228503821314
**Location tags:** https://business-api.tiktok.com/portal/docs?id=1870580030749698

---

## 7. Webhooks

### 7.1 developers.tiktok.com

Fuentes: https://developers.tiktok.com/doc/webhooks-overview/ , https://developers.tiktok.com/docs/en/webhooks-events

Eventos y payloads:

| Evento | Campos de `content` |
|---|---|
| `authorization.removed` | `reason` |
| `video.upload.failed` | `share_id` |
| `video.publish.completed` | `share_id` |
| `portability.download.ready` | `request_id` |

Campos top-level en todos: `client_key` (string), `event` (string), `create_time` (int64), `content` (string). `user_openid` está en todos menos `portability.download.ready`.

Mecánica: HTTPS POST en JSON a la callback URL registrada en el Developer Portal. Debe responder **200 inmediatamente**. TikTok **reintenta hasta 72 horas**. **El sistema debe ser idempotente** — el mismo evento puede llegar varias veces.

### 7.2 business-api.tiktok.com (más ricos)

Fuentes: https://business-api.tiktok.com/portal/docs?id=1759978319341570 , ?id=1810515090228226 , ?id=1810515104773122

**Post publishing events** (solo para posts publicados vía `/business/video/publish/` o `/business/photo/publish/`):

| Evento | Descripción | Latencia esperada |
|---|---|---|
| `post.publish.failed` | Falló por violación de formato o URL bloqueada antes de completar descarga | No determinista; ~30 min bastan para 1 GB |
| `post.publish.complete` | Publicación completada; formato OK y descarga sin problemas | ídem |
| `post.publish.publicly_available` | Pasó moderación y se distribuye públicamente | Normalmente ≤ 2 minutos; más si hay moderación manual |
| `post.publish.no_longer_publicly_available` | Ya no es público (moderación posterior o el usuario lo puso friends-only/privado) | Puede ocurrir en cualquier momento |

Payload de `post.publish.failed`: `publish_id`, `reason`, `publish_type` (enum `DIRECT_PUBLISH`).

`reason` enum: `file_format_check_failed`, `duration_check_failed` (mín. 3 s, máx. 60 s — nota: este límite del webhook difiere de los 600 s del endpoint de publish), `frame_rate_check_failed` (mín. 23, máx. 60 FPS), `picture_size_check_failed` (mín. 360p), `internal` (reintentable), `video_pull_failed` (timeout de 1 hora), `photo_pull_failed`.

**`comment.update`** — se dispara **dentro de 5 minutos** de crear/borrar/cambiar visibilidad de un comentario o reply en cualquier post público de una cuenta propia. Aplica tanto a posts publicados por API **como a posts publicados manualmente desde la app de TikTok**.
- **Prerrequisito: scope `comment.list` autorizado y vigente.**
- Payload: `comment_id`, `video_id`, `parent_comment_id` (solo replies), `comment_type` (`comment`|`reply`), `comment_action` (`insert`, `delete`, `set_to_hidden`, `set_to_friends_only`, `set_to_public`), `timestamp`, `unique_identifier`, `text`

**Configuración:** vía API, no en un portal — `/business/webhook/update/` (https://business-api.tiktok.com/portal/docs?id=1810521279479810), `/business/webhook/get/` (?id=1810521289122818), `/business/webhook/delete/` (?id=1810521297052673). Guía: https://business-api.tiktok.com/portal/docs?id=1810521730276354. Verificación de firma: https://business-api.tiktok.com/portal/docs?id=1759978341579777

---

## 8. Comentarios

### 8.1 developers.tiktok.com: NO

**No existe API de comentarios en la familia Login Kit / Display API.** No hay scope de comentarios en la lista oficial de scopes, ni endpoint. (La única vía de comentarios ahí es la Research API, no comercial.)

### 8.2 business-api.tiktok.com: SÍ, completa

Suite completa (scopes `comment.list` para lectura, `comment.list.manage` para escritura):

| Endpoint | Doc |
|---|---|
| `GET /open_api/v1.3/business/comment/list/` | https://business-api.tiktok.com/portal/docs?id=1760232109619202 |
| `GET /business/comment/reply/list/` (todas las replies de un comentario) | ?id=1762228430145538 |
| `POST /business/comment/create/` | ?id=1762228442072066 |
| `POST /business/comment/reply/create/` | ?id=1762228448779266 |
| `POST /business/comment/image/upload/` | ?id=1856212334897154 |
| `POST /business/comment/like/` (like/unlike) | ?id=1762228456608770 |
| `POST /business/comment/hide/` (hide/unhide) | ?id=1762228474532865 |
| `POST /business/comment/delete/` | ?id=1762228483080193 |

**`/business/comment/list/` — params:**
`business_id` (req), `video_id` (req), `comment_ids` (máx. 30), `include_replies` (bool; máx. 3 replies por comentario), `status` (`PUBLIC` | `ALL`; default `ALL`), `sort_field` (`likes` | `replies` | `create_time`), `sort_order` (`asc` | `desc` | `smart`; default `smart`), `cursor` (default 0), `max_count` (default 20, mín. 1, **máx. 30**)

> Nota oficial: "If the number of comments on the owned video exceeds **500**, the first 500 comments will be returned according to the specified sorting, and the remaining comments will be returned in reverse order based on the number of likes. Also, the comments beyond the first 500 and the first 500 comments themselves are **not deduplicated and may contain duplicates**."

**Campos de respuesta por comentario:**
`comment_id`, `video_id`, `user_id` (a deprecar), `unique_identifier` (ID global estable entre APIs), `create_time`, `text`, `likes`, `replies`, `owner` (bool — si lo escribió el dueño del video), `liked` (bool — si el dueño le dio like), `pinned` (bool), `status` (`HIDDEN` | `PUBLIC`), `username`, `display_name`, `profile_image` (URL temporal, expiración en `x-expires`), `parent_comment_id` (solo replies), `reply_list` (object[]), `image_url`

Devuelve **tanto comentarios públicos como ocultos** — incluidos los ocultos por el dueño y los ocultos por moderación, privacidad del usuario u otros filtros del sistema.

---

## 9. Descarga del archivo de video (mp4)

**Respuesta directa: NO. Ninguna API de analítica de TikTok entrega la URL del archivo mp4 del video.**

### 9.1 Qué URLs SÍ se entregan

**Display API** (`/v2/video/list/`, `/v2/video/query/`):
| URL | Qué es | Expiración |
|---|---|---|
| `cover_image_url` | Imagen estática de portada (CDN) | **TTL de 6 horas** (declarado explícitamente) |
| `share_url` | Página de TikTok del video | Permanente |
| `embed_link` | Link de reproductor embebido de tiktok.com | Permanente |
| `embed_html` | `<blockquote>`/iframe del reproductor | Permanente |

**Accounts API** (`/business/video/list/`):
| URL | Qué es | Expiración |
|---|---|---|
| `thumbnail_url` | Thumbnail del post | **"Temporary URL... Expiration date-time included in `x-expires` query param as Epoch/Unix time in seconds"** — la expiración viene firmada en la propia URL |
| `share_url` | Página del post | Permanente |
| `embed_url` | Reproductor embebido (`tiktok.com/player/v1/{id}?...`) | Permanente; **no funciona si la privacidad es "Friends" u "Only you"** |

**`creator_avatar_url`** en `creator_info/query`: TTL de **2 horas**.
**`profile_image`** en comentarios: URL temporal con `x-expires`.

### 9.2 Prohibición explícita

La Accounts API lo prohíbe por escrito (https://business-api.tiktok.com/portal/docs?id=1737944384433218), en "Prohibited Uses":

> "**Download TikTok videos and images**, promote third-party solutions to save user data or media from TikTok, or migrate content to another TikTok account or other social media platforms."

Consecuencia: "TikTok reserves the right to revoke a developer's Accounts API access at any time without prior notice."

### 9.3 La única vía oficial: Data Portability API

Fuentes: https://developers.tiktok.com/docs/en/data-portability-data-types , https://developers.tiktok.com/docs/en/data-portability-api-download , https://developers.tiktok.com/docs/en/data-portability-api-get-started

- Scopes: `portability.postsandprofile.single` / `.ongoing` (o `portability.all.*`)
- Flujo: `/v2/user/data/request/` (add data request) → `/v2/user/data/check/` (status) → `POST https://open.tiktokapis.com/v2/user/data/download/`
- La descarga es un **stream HTTP que debe convertirse a zip**: "The response is streamed as HTTP zip file, and must be converted to a zip file to get the correct data."
- Sobre los videos, cita textual: "For Posts, we offer a **URL that your app can access to download .mp4 or .jpg files**, depending on the format of the post." El campo se llama **"Posted Video Download Link"**.
- Webhook `portability.download.ready` avisa cuando el export está listo.
- **Aprobación: "typically... 3-4 weeks"**, requiere app registrada (al menos en Draft), screenshots de mockups UX, añadir el producto Data Portability API junto con Login Kit.
- **No verificado:** la documentación **no** declara la expiración de esas URLs de descarga de mp4, ni restricciones geográficas explícitas (DSA/DMA) en la página de get-started. Tampoco declara SLA de generación del export.

> **Implicación de arquitectura:** si el producto necesita el mp4 para análisis (transcripción, detección de cortes, hooks visuales), la vía limpia NO es la API de analítica. Es (a) que el creador suba el archivo original a nuestra plataforma antes/al publicar, o (b) la Data Portability API con su flujo asíncrono de semanas de aprobación y export bajo demanda. La opción (a) es la única que da el máster sin transcodificar.

---

## 10. Límites de uso y cuotas — tabla consolidada

| API | Endpoint | Límite | Alcance | Al exceder |
|---|---|---|---|---|
| Display | `/v2/user/info/` | 600 / min (ventana deslizante) | **No verificado** si por client_key o por token | HTTP 429, `rate_limit_exceeded` |
| Display | `/v2/video/list/` | 600 / min | ídem | ídem |
| Display | `/v2/video/query/` | 600 / min | ídem | ídem |
| Content Posting | `/v2/post/publish/video/init/` | 6 / min | por user access_token | — |
| Content Posting | `/v2/post/publish/inbox/video/init/` | 6 / min + **máx. 5 pending shares / 24 h** | por user access_token | — |
| Content Posting | `/v2/post/publish/creator_info/query/` | 20 / min | por user access_token | — |
| Content Posting | `/v2/post/publish/status/fetch/` | 30 / min | por user access_token | — |
| Content Posting | publicación | 5 usuarios/24 h (no auditado); ~15 posts/creador/día (auditado) | por app / por creador | — |
| Research | todas | 1000 requests/día, 100.000 registros/día | por research client | — |
| Accounts API | cualquier endpoint | **40 QPM** | por cuenta TikTok autorizada **y** por endpoint | `code: 40100` |
| Accounts API | todos combinados | 600 (Basic) / 1.000 (Adv/Prem/Ult) QPM | por developer app | `code: 40100`, esperar 5 min |
| Business (global) | todos | Basic 10 QPS / 600 QPM / 864.000 QPD | por developer app | QPM → esperar 5 min; QPD → hasta 00:00 UTC |
| Accounts API | `/business/video/publish/` | 6 posts/min, **máx. 15/día** | por cuenta TikTok | — |
| Webhooks (dev) | callback | reintentos hasta **72 h** | — | requiere idempotencia |

---

## Tabla resumen: qué SÍ / qué NO podemos obtener por API

| Dato | Display API | Accounts API (Business) | Veredicto |
|---|---|---|---|
| ID, fecha, duración, dimensiones | ✅ | ✅ | **SÍ** |
| Descripción / caption | ✅ | ✅ | **SÍ** |
| Likes, comments, shares, views | ✅ | ✅ | **SÍ** |
| Favoritos (saves) | ❌ | ✅ `favorites` | **SÍ** (solo Accounts) |
| Reach (alcance único) | ❌ | ✅ `reach` | **SÍ** (solo Accounts) |
| Tiempo total / medio de visionado | ❌ | ✅ `total_time_watched`, `average_time_watched` | **SÍ** (solo Accounts) |
| % que termina el video | ❌ | ✅ `full_video_watched_rate` | **SÍ** (solo Accounts) |
| **Retención segundo a segundo** | ❌ | ✅ **`video_view_retention`** | **SÍ** (solo Accounts) |
| **Likes por segundo del timeline** | ❌ | ✅ **`engagement_likes`** | **SÍ** (solo Accounts) |
| Fuente de tráfico (For You / Search / Sound / Follow / Profile / DM) | ❌ | ✅ `impression_sources` | **SÍ** (solo Accounts) |
| Demografía por video (país, ciudad, género) | ❌ | ✅ `audience_countries`, `audience_cities`, `audience_genders` | **SÍ** (solo Accounts) |
| Nuevos vs recurrentes, seguidores vs no | ❌ | ✅ `audience_types` | **SÍ** (solo Accounts) |
| Nuevos seguidores atribuidos al post | ❌ | ✅ `new_followers` | **SÍ** (solo Accounts) |
| Visitas a perfil desde el post | ❌ | ✅ `profile_views` | **SÍ, solo cuentas Business** |
| Clics a web/teléfono/email/dirección/app | ❌ | ✅ | **SÍ, solo Verified Business Accounts** |
| Demografía de seguidores (edad, género, país, ciudad, actividad horaria) | ❌ | ✅ `/business/get/` | **SÍ, mín. 100 seguidores** |
| Comentarios del creador (leer, responder, ocultar, borrar) | ❌ | ✅ suite completa | **SÍ** (solo Accounts) |
| Webhook de comentario nuevo (<5 min) | ❌ | ✅ `comment.update` | **SÍ** (solo Accounts) |
| Webhook de publicación | ✅ (2 eventos) | ✅ (4 eventos + razones de fallo) | **SÍ** |
| Publicar directo / borrador | ✅ | ✅ (`upload_to_draft`) | **SÍ** |
| Transcripción / voice-to-text | ❌ | ❌ | **NO** (solo Research API, no comercial) |
| Percentiles p25/p50/p75/p100 | ❌ | ❌ (pero `video_view_retention` es superior) | **NO** como tal |
| Métricas de "six second view rate" | ❌ | ❌ | **NO** (es métrica de Ads Reporting, no orgánica) |
| Replays / rewatch por segundo | ❌ | ❌ **no verificado** | **NO** |
| **URL del archivo mp4** | ❌ (solo cover TTL 6 h, share, embed) | ❌ **y explícitamente prohibido descargar** | **NO** |
| Datos > 365 días desde publicación | ❌ | ❌ (dejan de actualizarse) | **NO** |
| Métricas de video inactivo >7 días sin interacción | — | ⚠️ pueden venir vacías | **PARCIAL** |
| Videos privados / friends-only | ❌ | ❌ (embed no funciona) | **NO** |

---

## Decisiones de arquitectura que esto obliga

1. **Construir sobre la Accounts API de business-api.tiktok.com, no sobre Login Kit.** Login Kit + Display API solo da 4 contadores vanidosos. Toda la analítica accionable (retención, watch time, tráfico, demografía) vive únicamente en la Accounts API con scope `video.insights`. Login Kit puede seguir usándose para onboarding ligero o para publicar, pero no es el backbone del producto.

2. **Dos apps, dos OAuth, dos ciclos de aprobación.** Si queremos también Login Kit, son dos registros de developer distintos, dos pares de credenciales, dos flujos de consentimiento y dos modelos de token. Diseñar la capa de identidad para que un mismo creador pueda tener ambos `open_id` vinculados a una sola cuenta interna.

3. **Empezar YA el trámite de acceso.** Desde el 20-mar-2026 el "Accounts API Access Application Form" es obligatorio antes de siquiera enviar la app a review para el scope "TikTok Accounts". Sumado a 2-3 días hábiles de review de scopes y hasta 2 semanas de app review, esto es el camino crítico del proyecto, no un detalle de implementación.

4. **El producto NO puede ser "descubrimiento y ranking de creadores".** Está prohibido por escrito usar los datos agregados de cuentas autorizadas para construir un programa propio de influencer marketing con creator discovery/ranking (TikTok exige usar TikTok One para eso). El posicionamiento debe ser inequívocamente "herramienta de analítica para el creador dueño de la cuenta", y los datos de un creador no deben alimentar rankings visibles a terceros.

5. **No construir nada que dependa de descargar el mp4 desde TikTok.** Está explícitamente prohibido y técnicamente no hay URL. Si queremos análisis de contenido (hooks visuales, cortes, transcripción), el archivo tiene que entrar por nuestro lado: el creador sube el máster a nuestra plataforma **antes** de publicar. Esto encaja bien con un flujo "publica desde nosotros": subimos a TikTok vía `/business/video/publish/` y nos quedamos con el original sin transcodificar.

6. **Pipeline de ingesta en batch diario, no en tiempo real.** Todas las métricas útiles tienen latencia T+24-48 h. El dashboard debe mostrar explícitamente "datos hasta [fecha]" y nunca prometer tiempo real. Lo único real-time es metadata (`item_id`, `create_time`, `thumbnail_url`, `share_url`, `embed_url`, `caption`).

7. **Presupuesto de rate limit por cuenta, no por app.** El cuello de botella son **40 QPM por cuenta autorizada por endpoint**. Con `max_count` máximo de 20 videos por página, un creador con 500 videos son 25 llamadas. El límite real de escala es el combinado de 600 QPM (Basic) por app → planificar la subida a Advanced/Premium desde el día uno y encolar por cuenta con backoff ante `code: 40100` (espera obligatoria de 5 minutos).

8. **Ventana de retención de datos propia de 365 días.** "Post data will stop updating 365 days after the post is published". Nuestra base de datos es la única memoria a largo plazo del creador → snapshots diarios inmutables, nunca depender de re-consultar TikTok para histórico.

9. **Reintentar los campos vacíos, no tratarlos como cero.** Si un video lleva >7 días sin interacción, `reach`, `full_video_watched_rate`, `total_time_watched`, `average_time_watched`, `impression_sources` y `audience_countries` vienen vacíos. Distinguir en el esquema `null` (no disponible) de `0` (medido como cero) y reintentar periódicamente.

10. **Gating de features por tipo de cuenta.** Tres niveles: (a) cualquier cuenta con Analytics activado → retención, watch time, tráfico, demografía de video; (b) Business Account → `profile_views`; (c) Verified Business Account → clics de web/teléfono/email/dirección/app; (d) ≥100 seguidores → demografía de seguidores en `/business/get/`. La UI debe explicar por qué falta cada cosa en vez de mostrar huecos.

11. **Onboarding con un paso manual ineludible.** El creador tiene que abrir la app de TikTok y pulsar "Turn On" en la página de Analytics. Sin eso no hay datos, por mucho OAuth que tengamos. Debe ser un paso explícito y verificado del wizard de alta.

12. **Webhooks de la Accounts API como fuente de eventos, con idempotencia.** `comment.update` llega en <5 min incluso para posts publicados manualmente desde la app — es la base para un módulo de community management en casi-tiempo-real. Los reintentos llegan hasta 72 h, así que cada handler debe ser idempotente por `(comment_id, comment_action, timestamp)`. La configuración del webhook es vía API (`/business/webhook/update/`), no en un portal.

13. **Rotación de refresh tokens obligatoria.** En Login Kit el refresh token puede cambiar en cada renovación y hay que persistir el nuevo. Los tokens de ambas familias duran 1 día (access) y 1 año (refresh) → job de renovación diario + alerta de re-autorización a los ~11 meses.

14. **No cachear URLs firmadas.** `cover_image_url` (6 h), `thumbnail_url` (`x-expires`), `creator_avatar_url` (2 h) y `profile_image` de comentarios expiran. Hay que re-descargar y re-hospedar las imágenes en nuestro CDN en el momento de la ingesta, no guardar la URL de TikTok.
