# CON-8 · OAuth de YouTube — plan y lo que necesita Rasheed

Escrito para: Rasheed (dueño de `db/migrations/`, `lib/auth/`,
`lib/workspace/`, del despliegue y de los trámites de CON-9) y quien
revise el PR de CON-8.
Fecha: 23 de septiembre de 2026. Rama `nicolas/CON-8-oauth-youtube`,
worktree `rayit-con8`, creada desde `origin/main` (`29460e3`).

CON-8 es CON-3 para la tercera plataforma. No inventa nada: mete un
cuarto proveedor (`youtube`) en la maquinaria que ya existe —
`OAuthProvider`, `EncryptedSecretStore`, cookie sellada, rutas genéricas
`/conexiones/oauth/[platform]/{start,callback}`, `oauth.refresh` — y
convierte `youtubeRefresher`, que hasta hoy era un stub que lanzaba
`not_implemented`, en el refresher real.

---

## 0. Plan (fase 1)

### 0.1 Qué se construye y dónde

```
packages/connectors/
  src/oauth/google.ts              NUEVO. googleAuthorizationUrl, googleExchangeCode,
                                   googleRefresh, youtubeIdentity, youtubeOAuthProvider
  src/oauth/types.ts               + 'youtube' en OAuthProviderId y OAUTH_PROVIDER_IDS
  src/oauth/config.ts              + GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI
  src/oauth/index.ts               + youtubeOAuthProvider en OAUTH_PROVIDERS
  src/platforms/youtube.ts         createYouTubeRefresher(core, app) — deja de ser stub
  src/quota/limits.ts              + familia 'google-oauth' (§0.2 · 6)
  src/index.ts                     exporta platforms/youtube.ts entero
  fixtures/youtube/oauth.token.*   seis fixtures nuevos + channels.list.mine.empty.json
  test/oauth-google.test.ts        NUEVO, espejo de oauth-tiktok.test.ts

apps/web/app/(app)/conexiones/
  _lib/consent.ts                  PLATFORM_LABEL y DEMOGRAPHICS_SCOPES para youtube
  _lib/oauth-handlers.ts           + código de error 'sin_canal' (§0.2 · 5)
  _lib/oauth-handlers.test.ts      + el callback completo de YouTube (el «terminado cuando»)
  page.tsx                         el botón «Autorizar» deja de ser solo de TikTok

apps/worker/
  src/index.ts                     createYouTubeRefresher en vez del stub
  test/oauth-refresh-real.test.ts  + un canal de YouTube que se renueva con el reloj falso
```

**Sin migración.** `platform` ya trae la fila `youtube` (0002) y
`social_connection`, `connection_secret`, `data_consent` y `api_call_log`
son genéricas por `platform_id`. `packages/db/src/queries/conexiones.ts`
tampoco cambia: `ConnectionPlatformId` ya incluye `'youtube'` y
`upsertConnection`, `findPublicAccountByHandle` y
`upgradePublicAccountToOAuth` no miran la plataforma.

### 0.2 Decisiones

1. **Scopes: `youtube.readonly` y `yt-analytics.readonly`, nada más.**
   `https://www.googleapis.com/auth/youtube.readonly` es lo que necesitan
   `channels.list` (identidad y contadores), `playlistItems.list` y
   `videos.list` de CON-1; `https://www.googleapis.com/auth/yt-analytics.readonly`
   es lo que exige `reports.query` de la Analytics API, que es la razón
   entera de pedirle OAuth al dueño de un canal: retención, duración
   media y demografía no salen por API key. Descartados:
   `yt-analytics-monetary.readonly` (trae ingresos estimados y RPM; no
   los pedimos, no los guardamos y encarece la auditoría de Google),
   `youtube` y `youtube.force-ssl` (permiten escribir en el canal;
   prometemos en el consentimiento que no publicamos nada) y
   `youtubepartner` (es de MCN). Los dos que quedan son **de solo
   lectura y sensibles**: obligan a la verificación de la pantalla de
   consentimiento, no a la auditoría de seguridad anual de los
   *restricted*. Ver §0.2 · 7.
2. **`access_type=offline` y `prompt=consent`.** Google entrega el
   `refresh_token` **solo** con `access_type=offline` y **solo la primera
   vez** que esa cuenta autoriza esa app. Si el creador ya había
   autorizado antes (por ejemplo, se desconectó y vuelve), el
   intercambio devolvería tokens sin `refresh_token` y la conexión
   nacería muerta: se renovaría una vez y en una hora quedaría
   `needs_reauth`. `prompt=consent` fuerza la pantalla de consentimiento
   y con ella un `refresh_token` nuevo en cada autorización. El costo es
   que el creador ve la pantalla siempre, aunque ya haya dicho que sí;
   es el precio correcto para que reconectar funcione. No se usa
   `include_granted_scopes` (autorización incremental): pedimos los dos
   scopes de una vez.
3. **Renovación: Google no rota el refresh token.** La respuesta de
   `grant_type=refresh_token` trae `access_token`, `expires_in` (3600),
   `scope` y `token_type`, y **no** trae `refresh_token`. El refresher
   conserva el que ya tenía (`previous.refreshToken`), igual que hace
   `tokensFromTikTok` cuando la respuesta no lo repite. Si alguna vez
   Google lo devolviera, se usa el nuevo.
4. **`refreshExpiresAt` queda vacío.** Google no publica fecha de
   vencimiento del refresh token; lo revoca el usuario, seis meses de
   inactividad, o —esto sí nos toca— **siete días si el proyecto está en
   estado «Testing»**. Poner siete días a mano haría que `oauth.refresh`
   marcara `needs_reauth` por reloj a una conexión que en producción
   estaría sana. Se deja vacío y el vencimiento se aprende por donde hay
   que aprenderlo: cuando Google responde `invalid_grant`, que es
   definitivo y sí pasa la conexión a `needs_reauth` con su
   notificación. Conservador en el sentido que importa: nunca rompemos
   una conexión buena por una suposición nuestra.
5. **Una cuenta de Google sin canal de YouTube.** `channels.list?mine=true`
   devuelve `items: []`. Hoy eso caería en «la plataforma no nos dijo
   qué cuenta autorizaste», que es falso y no ayuda. `youtubeIdentity`
   lanza un `PlatformApiError` definitivo con código `no_channel` y el
   callback lo traduce a un código nuevo, `sin_canal`, con la frase que
   explica qué pasó y qué hacer. Es una ausencia explicada con una
   frase, no un guion mudo.
6. **Familia de cuota propia: `google-oauth`.** `oauth2.googleapis.com`
   no es la Data API y no gasta unidades del cupo diario de 10 000. Si
   las llamadas de OAuth se contaran en la familia `youtube` —que
   persiste su acumulado en `api_quota_usage`— la aritmética mentiría:
   un access token de YouTube dura **una hora**, así que con el margen
   de 30 minutos cada canal conectado se renueva unas 40 veces al día;
   cien canales serían 4 000 unidades diarias fantasma sobre un
   presupuesto de 10 000. Con TikTok e Instagram no se planteó porque
   sus endpoints de OAuth sí viven bajo el mismo límite de la
   plataforma. `google-oauth` queda sin presupuesto diario (Google no
   publica uno para el endpoint de token) y con una ventana de
   seguridad de 600 llamadas por minuto de aplicación, que es nuestra,
   no de Google, y está marcada como tal.
7. **Producción necesita CON-9.** Los dos scopes son sensibles: hasta
   que Google verifique la pantalla de consentimiento, la app queda en
   «Testing» y **solo los correos que estén en la lista de usuarios de
   prueba del proyecto** pueden autorizar (máximo 100), con refresh
   token de siete días. Eso alcanza de sobra para el «terminado cuando»
   de esta historia; no alcanza para un creador de verdad. El trámite es
   CON-9 y es de Rasheed (§2).

### 0.3 Lo que la documentación oficial dice hoy (23-sep-2026)

| Dato | Valor | Fuente |
|---|---|---|
| Autorización | `https://accounts.google.com/o/oauth2/v2/auth` con `client_id`, `redirect_uri`, `response_type=code`, `scope` **separado por espacios**, `state`, `access_type`, `prompt` | developers.google.com/identity/protocols/oauth2/web-server |
| Redirect URI | tiene que coincidir **exactamente** con la registrada; mayúsculas y barra final cuentan. Google sí acepta `http://localhost` | misma página |
| Token | `POST https://oauth2.googleapis.com/token`, `application/x-www-form-urlencoded`, `client_id`, `client_secret`, `code`, `grant_type=authorization_code`, `redirect_uri` → `{ access_token, expires_in, refresh_token, scope, token_type: 'Bearer' }` | misma página |
| `refresh_token` | solo con `access_type=offline` y solo la primera vez que esa cuenta autoriza la app | misma página |
| Renovación | `POST` al mismo endpoint con `client_id`, `client_secret`, `grant_type=refresh_token`, `refresh_token` → sin `refresh_token` en la respuesta | misma página |
| Revocación | `https://oauth2.googleapis.com/revoke` (no se usa en CON-8; ver §0.6) | misma página |
| Vencimiento del refresh token | lo revoca el usuario; 6 meses de inactividad; **7 días si el proyecto está en «Testing»**; tope de 100 refresh tokens por cuenta y cliente | misma página |
| Error | `{ error, error_description }`; `invalid_grant` = code o refresh token inválido, vencido, ya usado o revocado → hay que volver a autorizar | misma página |
| Scope de Analytics | `https://www.googleapis.com/auth/yt-analytics.readonly` — «View YouTube Analytics reports for your YouTube content» | developers.google.com/youtube/analytics/reference/reports/query |
| Scope de Data API | `https://www.googleapis.com/auth/youtube.readonly` | developers.google.com/identity/protocols/oauth2/scopes |
| `channels.list` | cuesta 1 unidad; con `mine=true` devuelve el canal del token | developers.google.com/youtube/v3/docs/channels/list |

### 0.4 Decisiones pendientes de Nicolás (se tomó la opción conservadora)

- **`prompt=consent` siempre** (§0.2 · 2). La alternativa es pedirlo solo
  cuando no tengamos refresh token para esa cuenta, lo que obliga a
  mirar la base antes de construir la URL de autorización. Es una
  constante en `oauth/google.ts`.
- **Sin `yt-analytics-monetary.readonly`** (§0.2 · 1). Si algún día se
  quiere mostrar ingresos estimados, es un scope más en la misma
  constante — y una vuelta más de verificación con Google.
- **`refreshExpiresAt` vacío** (§0.2 · 4). Si se prefiere que el modo
  «Testing» se note en la pantalla, se puede fijar a siete días con una
  variable de entorno; no lo hice porque el valor correcto depende del
  estado del proyecto en Google, que no es algo que el código sepa.

### 0.5 Dudas que no se resolvieron con la documentación pública

- **Cuántas veces al día se puede renovar.** Google documenta el tope de
  100 refresh tokens por cuenta y cliente (emisión), pero no un límite
  de renovaciones. Con un access token de una hora y el margen de 30
  minutos, cada canal renueva unas 40 veces al día. Si en la prueba en
  vivo aparecen 429 o `rate_limit_exceeded`, la palanca ya existe:
  `OAUTH_REFRESH_MARGIN_MINUTES_YOUTUBE`.
- **Si la respuesta de renovación trae `scope`.** La documentación lo
  lista para el intercambio del code; para la renovación no lo repite.
  `tokensFromGoogle` conserva los scopes anteriores cuando la respuesta
  no los trae, así que las dos formas funcionan.

### 0.6 Fuera de alcance (y a qué historia va)

| Qué | Por qué | Historia |
|---|---|---|
| Revocar el token en Google al desconectar (`/revoke`) | «Desconectar» ya borra el ciphertext y marca la fila; revocar contra la plataforma es una decisión de producto que vale para las tres redes, no solo para YouTube | CON-4 |
| Pantalla de conexiones con estado, horas desde la última sincronización y botón de reautorizar | es la historia entera | CON-4 |
| Recolección de videos y métricas del canal con el token del dueño | el token queda guardado y renovándose; usarlo es otra historia | CON-5 |
| Demografía y retención con la Analytics API | el scope queda concedido; leerlo es otra historia | CON-7 |
| Trámite de verificación de la pantalla de consentimiento de Google | es de Rasheed | CON-9 |
