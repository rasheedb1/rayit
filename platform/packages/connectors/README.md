# @mc/connectors · la capa que habla con las plataformas

Clientes tipados para TikTok (Display API y Accounts API), Instagram
(Instagram Login) y YouTube (Data v3 y Analytics), con reintentos,
cuota y bitácora, más la renovación de tokens y el almacén de secretos
que llegaron con CON-2. **No escribe posts ni snapshots**: devuelve
datos normalizados con los nombres de columna de la migración 0003 y
CON-5 los guarda. Lo único que escribe en la base es `api_call_log`
(una fila por intento) y `api_quota_usage` (acumulado por día).

## Mapa del paquete

```
src/types.ts                 PlatformId, OAuthTokens (CON-2)
src/secret-store.ts          SecretStore: InMemory y Env (CON-2, desarrollo)
src/encrypted-secret-store.ts   EncryptedSecretStore: el real (CON-3), connection_secret cifrado; newSecretRef('tiktok') → 'enc:tiktok:<uuid>'
src/crypto/master-key.ts     TOKEN_ENCRYPTION_KEY (32 bytes en base64 o hex) y llavero por versión (_V2, _CURRENT)
src/crypto/token-cipher.ts   AES-256-GCM con HKDF (info on-cue/token/<versión>), IV por escritura, AAD = secret_ref, rotación
src/crypto/sealed-cookie.ts  sello HMAC-SHA256 con TTL para la cookie del flujo OAuth
src/oauth/                   OAUTH_PROVIDERS: tiktok (Login Kit), tiktok-business (Accounts API), instagram (Instagram Login):
                             authorizationUrl, exchangeCode, identity, refresh; loadOAuthApps(env) solo con nombres de variables
src/token-refresher.ts       TokenRefresher, TokenRefreshError, kindFromHttp (CON-2)
src/redact.ts                redactSecrets: lo usan el logger del worker y este paquete
src/platforms/tiktok.ts      createTikTokRefresher(core, { login, business }): elige la app por el prefijo del secret_ref
src/platforms/instagram.ts   createInstagramRefresher(core, app)
src/platforms/youtube.ts     refresher sin implementar hasta CON-8
src/testing/dump-text.ts     dumpTextColumns / findSecretInDump: todas las columnas de texto por pg_catalog (la prueba R4)
src/public/                  Cuentas por @ (CON-10): PublicProfileSource por plataforma. tiktok = oEmbed (identidad), instagram = business_discovery con INSTAGRAM_HOUSE_TOKEN, youtube = Data API con GOOGLE_API_KEY (YouTubeClient acepta apiKey)

src/http/errors.ts           PlatformApiError { kind: transient | permanent | auth | quota } y el clasificador único
src/http/retry.ts            backoff exponencial con jitter, Retry-After, sleep cancelable
src/http/client.ts           HttpCore: fetch/now/sleep/random inyectables, Bearer o Access-Token, log por intento
src/quota/limits.ts          tabla de límites con fuente y fecha; override desde platform.limits
src/quota/manager.ts         QuotaManager: ventanas deslizantes que esperan, presupuesto diario que corta
src/quota/postgres.ts        UPSERT de api_quota_usage sobre los dos índices únicos parciales
src/log/sink.ts              CallLogSink y CallLogEntry (las columnas de api_call_log)
src/log/postgres.ts          PostgresCallLogSink({ query })     src/log/memory.ts  InMemoryCallLogSink
src/normalize/types.ts       NormalizedPost, NormalizedPostMetrics, NormalizedAccountMetrics, NormalizedDemographics…
src/normalize/values.ts      intOrNull, numOrNull, …: nunca inventan un cero
src/platforms/base.ts        ConnectionAuth, CallOptions, PageOptions
src/platforms/tiktok-display.ts    userInfo, listVideos, iterateVideos, queryVideos
src/platforms/tiktok-accounts.ts   accountInfo, listVideos, iterateVideos, videoInsights
src/platforms/instagram-api.ts     me, media, iterateMedia, mediaInsights, accountInsights, followerCountSeries, audienceDemographics, businessDiscovery
src/platforms/youtube-api.ts       channelMine, channelByHandle, uploadsPlaylistItems, iterateUploads, videosById, analyticsReport, videoDailyMetrics, videoDemographics, channelDemographics, countryBreakdown
src/factory.ts               createConnectors(): lo que el worker cuelga en ctx.connectors; loadPlatformLimits()
src/testing/fixture-fetch.ts FixtureFetch, loadFixture(s), withoutNetwork()
fixtures/<plataforma>/<endpoint>[.<caso>].json
scripts/record.ts            regraba fixtures con un token real, anonimizando
```

## Usarlo desde un job

```ts
export const collectPosts = defineJob('collect.posts', async (payload, ctx) => {
  const tokens = await ctx.secrets.get(conn.secret_ref);
  const tiktok = ctx.connectors.tiktokDisplay({ connectionId: conn.id, tokens });
  for await (const page of tiktok.iterateVideos({ maxPages: 5 })) {
    for (const { post, metrics, raw } of page.data.items) { /* INSERT post / post_metric_snapshot */ }
  }
  return { processed, failed: 0 };
});
```

Cada método devuelve `{ data, raw }`: `data` es el tipo normalizado y
`raw` el cuerpo tal cual, para `post_metric_snapshot.raw`. Cada llamada
acepta `{ signal }`; sin él, va la señal del job. Los listados paginan
como `AsyncIterable` con `maxPages` (10 por defecto).

Fuera del worker (la web, un script):

```ts
const core = new HttpCore({ callLog: new PostgresCallLogSink(tx), quota: new QuotaManager({ store: new PostgresQuotaUsageStore(tx) }) });
const brand = await new InstagramClient(core, { connectionId: conn.id, tokens }).businessDiscovery('cafealma');
```

## OAuth y el token en reposo (CON-3)

```
POST /conexiones/oauth/<proveedor>/start   →  state (32 bytes) + cookie sellada  →  authorizationUrl(cfg, { state })
GET  …/callback?code&state                 →  exchangeCode → identity → set() cifrado + social_connection + data_consent
oauth.refresh (worker)                     →  ctx.secrets.get(ref) → refresher.refresh(tokens, { secretRef, connectionId }) → set()
```

- **Proveedor ≠ plataforma.** TikTok son dos apps sobre `platform_id
  'tiktok'`: `tiktok` (Login Kit, la del sandbox) y `tiktok-business`
  (Accounts API, tras CON-9). La ref lo dice: `enc:tiktok:<uuid>` o
  `enc:tiktok-business:<uuid>`; `createTikTokRefresher` elige por ella.
- **Instagram Login** no tiene refresh token: se guarda el de larga
  duración (60 días) como `accessToken`, `refreshToken` vacío, y
  `instagramRefresh` pide otro mientras queden más de 24 h; vencido es
  definitivo (`refresh_expired`).
- **Sin PKCE en web**: ninguna de las tres plataformas lo documenta para
  web; la cookie deja el campo `verifier` para cuando alguna lo admita.
- **`EncryptedSecretStore`** recibe `{ query(text, params) }`: en la web
  el `WorkspaceTx` (RLS pone el workspace en el INSERT con
  `current_workspace_id()`); en el worker `ctx.db` (`mc_worker`, la fila
  ya existe y solo se reemplaza). `get()` devuelve `null` solo si la fila
  no existe; un fallo de descifrado lanza `TokenCipherError` y el job lo
  trata como problema nuestro sin tocar la cuenta.
- **Rotación de clave**: `TOKEN_ENCRYPTION_KEY_V2` + `TOKEN_ENCRYPTION_KEY_CURRENT=v2`;
  `store.rotate(ref)` reescribe lo que esté en v1. Lo viejo se sigue
  leyendo mientras la v1 esté en el llavero.
- **Errores**: `oauth/errors.ts` convierte el `PlatformApiError` del
  núcleo en `TokenRefreshError` (`auth`/`permanent` → definitivo;
  `transient`/`quota` → transitorio, `quota` con code `rate_limit`).
- Los endpoints de token aceptan cuerpo en formulario (`form`) y pasan
  `secrets` extra (client_secret, code, refresh_token) para que
  `safeErrorMessage` los borre de cualquier mensaje. Meta exige
  `client_secret` en la query de `ig_exchange_token`; nuestro
  `api_call_log` no guarda URLs y `FixtureFetch` la tapa al grabar.

Fixtures: `fixtures/<plataforma>/oauth.*.json` (`ok`, `invalid`/`invalid_grant`,
`rate_limit`, `server_error_then_ok`), con `meta.source = 'docs'`; los de
`tiktok-accounts` se confirman con CON-9.

## La regla: el token nunca sale de OAuthTokens

- El núcleo pone la credencial en una cabecera (`Authorization: Bearer`
  en TikTok Display, Instagram y Google; `Access-Token` en TikTok
  Accounts). **Nunca en la URL**, aunque Meta acepte `access_token=`.
- Ningún error lleva el token: los mensajes de la plataforma pasan por
  `safeErrorMessage` (borra el valor literal del token) antes de entrar
  a `api_call_log` y a `PlatformApiError`.
- Lo que se loguea pasa por `redactSecrets`. `FixtureFetch` tapa las
  cabeceras de autenticación en `calls`; `scripts/record.ts` no guarda
  cabeceras de petición.
- Pruebas: `test/http-core.test.ts` («401 → … el token no aparece en el
  error ni en el log»), `apps/worker/test/connectors.test.ts` (ni en
  `job_run`, ni en `api_call_log`, ni en los logs del worker),
  `test/encrypted-secret-store.test.ts` (lo guardado no contiene el token;
  otro workspace no lo lee), y las pruebas R4 de CON-3
  (`apps/web/app/(app)/conexiones/_lib/oauth-handlers.test.ts` y
  `apps/worker/test/oauth-refresh-real.test.ts`): tras un callback y una
  renovación, `dumpTextColumns` recorre TODAS las columnas de texto, jsonb,
  arreglo y bytea de `public` (y `pgboss`) y ningún token, code ni secreto
  aparece.

## Taxonomía de errores y qué hace cada consumidor

Todo sale como `PlatformApiError { platformId, endpoint, httpStatus, code, kind, messageEs, retryAfterS, requestId }`.

| kind | Qué es | Ejemplos | Núcleo | CON-5 (recolector) | CON-3 / oauth.refresh | CAM-3 (marca) |
|---|---|---|---|---|---|---|
| `transient` | red, timeout, 5xx, 429, señal abortada | TikTok `rate_limit_exceeded` (429), Google `rateLimitExceeded`, `backendError`, TikTok Accounts `5xxxx` | reintenta hasta `maxRetries` (3) con backoff y `Retry-After` | cuenta el elemento como `failed`; pg-boss reintenta | igual que hoy: transitorio | vuelve a intentar en el siguiente tick |
| `auth` | la plataforma no acepta el token | HTTP 401, TikTok `access_token_invalid` / `scope_not_authorized`, Meta `190`, TikTok Accounts `40100–40199`, Google `authError` | no reintenta | la conexión pasa a `needs_reauth` con notificación | pide renovar; si el refresh falla, `needs_reauth` | no aplica (llamadas con el token del creador) |
| `quota` | presupuesto agotado por horas o por el día | Google `quotaExceeded` / `dailyLimitExceeded`, Meta `4` `17` `32` `613` `80002`, y el `QuotaManager` antes de llamar (`quota_exhausted`, `rate_window_full`) | no reintenta; no llama si lo detecta antes | devuelve `retry: false`: el siguiente tick del cron es el reintento | igual | igual |
| `permanent` | parámetro, permiso o recurso | 400/403/404, TikTok `invalid_params`, `scope_permission_missed`, Meta `100`, `110`, Google `playlistNotFound` | no reintenta | el elemento falla y se anota; la conexión no se toca | definitivo (`invalid_grant`) → `needs_reauth` | «sin datos» para esa marca |

El clasificador es uno solo (`http/errors.ts`, `kindFor`) y reutiliza
`kindFromHttp` y `PERMANENT_CODES` del refresher. Un 429 manda sobre
cualquier código del cuerpo.

## Límites (quota/limits.ts), con fuente y fecha

| Familia | Regla | Fuente | Fecha |
|---|---|---|---|
| `tiktok` (Display) | 40/min por (conexión, endpoint) · **DECISIÓN PENDIENTE DE NICOLÁS**: la documentación de hoy no distingue por cuenta | docs/arquitectura.md | 22-sep-2026 |
| `tiktok` (Display) | 600/min por (app, endpoint): `user/info`, `video/list`, `video/query`; ventana deslizante de un minuto; 429 `rate_limit_exceeded` | developers.tiktok.com/doc/tiktok-api-v2-rate-limit | página del 4-ago-2026 |
| `tiktok-accounts` | 40/min por (conexión, endpoint) | docs/arquitectura.md (el portal de la Accounts API es JavaScript y no se pudo leer; se confirma con CON-9) | 22-sep-2026 |
| `instagram` | 200 llamadas/hora por conexión (fórmula de plataforma: 200 × usuarios). El BUC (4800 × impresiones en 24 h) no se puede calcular: se respeta por sus códigos (`quota`) · **DECISIÓN PENDIENTE DE NICOLÁS** | developers.facebook.com/docs/graph-api/overview/rate-limiting | 22-sep-2026 |
| `youtube` (Data) | 10 000 unidades/día por proyecto (scope app); `channels.list`, `playlistItems.list`, `videos.list` = 1 unidad; toda petición, aun inválida, cuesta ≥ 1 | developers.google.com/youtube/v3/determine_quota_cost | actualizada 15-sep-2026 |
| `youtube-search` | `search.list` = 1 unidad en un cubo propio de 100/día (cambió en jun-2026; antes 100 unidades del cubo general). No se usa en el MVP | misma página | 15-sep-2026 |
| `youtube-analytics` | cuota aparte; Google no publica el número · **DECISIÓN PENDIENTE DE NICOLÁS**: leerlo del proyecto en Google Cloud | developers.google.com/youtube/analytics/reference/reports/query | 22-sep-2026 |

Cómo se aplica: `acquire()` **espera** (con el `sleep` inyectado)
cuando la siguiente llamada superaría una ventana, y **lanza `quota`
sin llamar** cuando el presupuesto del día no alcanza o la espera
superaría `maxWaitMs` (120 s). El día es UTC; YouTube reinicia a
medianoche del Pacífico, así que el corte es conservador.
`api_quota_usage` no distingue familias, así que solo la principal de
cada plataforma persiste (`daily.persist`: hoy YouTube Data, con
`connection_id` nulo = cuota de app); las demás cuentan en memoria. Un
`Retry-After` mayor que 120 s tampoco se espera dentro del job: el error
sale con `retryAfterS` y el job programa el siguiente intento. `platform.limits` sobreescribe la
tabla por familia (`loadPlatformLimits`); el JSON propuesto está en
`docs/propuestas/CON-1.md` §1.

Campos y endpoints, con su fuente, en la cabecera de cada
`src/platforms/*.ts` y en `docs/propuestas/CON-1.md` §0.3.

## Cómo agregar un endpoint (cinco pasos)

1. **Léelo en la documentación oficial** y anota en la cabecera del
   archivo de la plataforma la URL, los parámetros, los campos y la
   fecha de lectura. Si trae un límite nuevo, va a `quota/limits.ts`
   con fuente y fecha; si cuesta unidades, a `unitCost`.
2. **Agrega el método** en la clase de la plataforma: construye un
   `ApiRequest` con `endpoint` lógico (`'plataforma.recurso.accion'`),
   `family`, `authStyle`, `parseError` de esa plataforma y `signal`
   opcional, y llama a `core.call<T>()`. Nada de `fetch` directo.
3. **Normaliza** con `normalize/values.ts`: `intOrNull`, `numOrNull`,
   `strOrNull`. Lo que la API no da es `null`; un cero explícito se
   conserva. Los nombres son los de las columnas de 0003. Si hace
   falta una conversión de unidad (ms → s, porcentaje → fracción), va
   aquí con un comentario, nunca en CON-5.
4. **Fixtures**: al menos `ok`, `empty` y `nulls`; `paginated` si
   pagina. Los casos de transporte (`rate_limited`,
   `server_error_then_ok`, `invalid_token`) existen una vez por
   plataforma sobre el endpoint de lista, porque el transporte es el
   mismo. `meta.source = 'docs'` hasta regrabarlo.
5. **Una prueba por caso** en `test/<plataforma>.test.ts`, con
   `withoutNetwork()` en `before` y una afirmación de que el
   normalizador respeta los nulos. `pnpm --filter @mc/connectors
   typecheck lint test`.

## Cómo agregar y regrabar un fixture

Formato: `fixtures/<plataforma>/<endpoint>[.<caso>].json`

```json
{ "meta": { "source": "docs" | "recorded", "recordedAt": "2026-09-22", "notes": "de dónde salió" },
  "request": { "method": "POST", "urlPattern": "^https://open\\.tiktokapis\\.com/v2/video/list/\\?fields=", "body": { "max_count": 20 } },
  "response": { "status": 200, "headers": { "retry-after": "7" }, "body": { … } } }
```

`response` puede ser una **lista** que se consume en orden (para
`server_error_then_ok`, `paginated`); `networkError: "fetch failed"`
simula un fallo de red. `request.body` se compara como subconjunto.
`FixtureFetch` falla con la lista de lo que esperaba ante una llamada no
prevista, y `withoutNetwork()` reemplaza `globalThis.fetch` por uno que
lanza: «sin red» es demostrable (`guard.attempts === 0`).

Regrabar con un token real (cuando exista una cuenta de prueba, CON-3):

```bash
# La variable trae el JSON de OAuthTokens; nunca se imprime ni se guarda.
pnpm --filter @mc/connectors record -- --platform tiktok --ref env:TIKTOK_DEMO
pnpm --filter @mc/connectors record -- --platform youtube --ref env:YOUTUBE_DEMO --handle NutriveOficial
```

El script sobrescribe los casos `ok`/`paginated` con
`meta.source = 'recorded'`, anonimiza ids numéricos largos, ids de
canal, handles y nombres, y quita las firmas de las URLs de CDN. Los
casos de error siguen saliendo de la documentación.

## Pruebas

```bash
pnpm --filter @mc/connectors test        # 180 pruebas, < 4 s, sin red (guard en cada archivo); pglite para api_quota_usage y connection_secret
pnpm --filter @mc/connectors typecheck lint
```

`test/quota-postgres.test.ts` corre sobre pglite con las migraciones
reales: UPSERT de `api_quota_usage` con y sin `connection_id`, corrido
dos veces → una fila con `units_used` sumado.
