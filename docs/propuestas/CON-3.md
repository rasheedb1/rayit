# CON-3 · OAuth de TikTok e Instagram en sandbox — plan y lo que necesita Rasheed

Escrito para: Rasheed (dueño de `db/migrations/`, `lib/auth/`,
`lib/workspace/`, del despliegue y del acceso a las apps de TikTok y
Meta) y quien revise el PR de CON-3.
Fecha: 22 de septiembre de 2026. Rama `nicolas/CON-3-oauth-sandbox`,
worktree `rayit-con3`, creada desde `origin/nicolas/CON-1-conectores-grabados`
(`33e26a0`), porque CON-1 todavía no está en `main` y CON-3 se apoya en
su cliente HTTP. El PR va apilado sobre el de CON-1.

---

## 0. Plan (fase 1)

### 0.1 Qué se construye y dónde

```
packages/connectors/
  src/crypto/token-cipher.ts        AES-256-GCM + HKDF; keyring por versión; rotación
  src/crypto/master-key.ts          parseo de TOKEN_ENCRYPTION_KEY (32 bytes en base64 o hex)
  src/crypto/sealed-cookie.ts       sello HMAC-SHA256 con TTL para la cookie del flujo OAuth
  src/encrypted-secret-store.ts     EncryptedSecretStore implements SecretStore sobre connection_secret
  src/oauth/types.ts                OAuthProviderId, OAuthAppConfig, CodeExchange, identidad
  src/oauth/config.ts               loadOAuthApps(env): solo nombres de variables; qué app está configurada
  src/oauth/errors.ts               PlatformApiError → TokenRefreshError (misma taxonomía)
  src/oauth/tiktok-login.ts         Login Kit: authorizationUrl, exchangeCode, refresh, identity
  src/oauth/tiktok-business.ts      Accounts API: idem (fixtures de la documentación; CON-9)
  src/oauth/instagram-login.ts      Instagram Login: authorizationUrl, exchangeCode, exchangeLongLived, refresh, identity
  src/platforms/tiktok.ts           createTikTokRefresher(core, cfg)  (reemplaza el stub)
  src/platforms/instagram.ts        createInstagramRefresher(core, cfg) (reemplaza el stub)
  src/platforms/youtube.ts          sigue como stub (CON-8)
  src/http/client.ts                + body en formulario (form) y secretos extra a tapar (secrets)
  src/testing/fixture-fetch.ts      + casa cuerpos application/x-www-form-urlencoded
  fixtures/{tiktok,tiktok-accounts,instagram}/oauth.*.json
  test/token-cipher.test.ts, sealed-cookie.test.ts, encrypted-secret-store.test.ts (pglite),
  test/oauth-tiktok.test.ts, oauth-tiktok-business.test.ts, oauth-instagram.test.ts

db/migrations/0015_connection_secret.sql   tabla connection_secret con RLS (precedente 0014; NO se aplica)

packages/db/
  src/queries/conexiones.ts         listConnections, findConnectionByAccount, upsertConnection,
                                    recordConsent, disconnectConnection, getDefaultCreatorId
  test/conexiones.test.ts           pglite con seed 0003; aislamiento con otro workspace

apps/web/app/(app)/conexiones/
  page.tsx                          pantalla mínima sobre connection_health (deja de mostrar ModulePlan)
  actions.ts                        Server Action desconectarConexion (zod)
  connect-dialog.tsx                diálogo de consentimiento (cliente) → POST a …/start
  _lib/workspace.ts, _lib/db.ts     provisional (TODO(CIM-3), TODO(CIM-2)), mismo patrón que FIN-1
  _lib/consent.ts                   versión de la política y textos mostrados
  _lib/oauth-handlers.ts            createOAuthHandlers(deps): start(req) y callback(req), probables como funciones
  _lib/oauth-handlers.test.ts       PRUEBA CLAVE (R4): callback completo en pglite + volcado de todas las columnas
  oauth/[platform]/start/route.ts   POST → handlers.start
  oauth/[platform]/callback/route.ts GET → handlers.callback

apps/worker/
  src/index.ts                      SECRET_STORE=encrypted (por defecto) y refreshers reales con su config
  src/runner/config.ts              secretStore: 'encrypted' | 'env' | 'memory'
  src/jobs/conexiones/oauth-refresh.ts   margen por plataforma (Instagram: 7 días)
  test/helpers/harness.ts           acepta un SecretStore externo
  test/oauth-refresh-real.test.ts   TikTok rota el refresh token; Instagram < 24 h se renueva; vencido → needs_reauth; volcado sin tokens
```

### 0.2 Decisiones

1. **Dónde vive el token cifrado: (a) tabla `connection_secret`,
   migración `0015_connection_secret.sql`.** Comprobado el 22-sep con
   `make db.sql` (solo lectura): el esquema `vault` existe
   (`supabase_vault 0.3.1`), pero `has_schema_privilege(rol, 'vault',
   'USAGE')` es **false** para `mc_app`, `mc_worker` y `mc_migrator`;
   conceder ese USAGE pide el token de administración y, además, pglite
   no trae `supabase_vault`, así que (b) no se prueba sin Supabase ni
   sin Rasheed. (c) guardar el cifrado dentro de
   `social_connection.secret_ref` rompe el contrato del `SecretStore`:
   `oauth.refresh` hace `set(ref, tokens)` **antes** del `UPDATE` de
   `social_connection` y confía en que la ref no cambia; con (c) cada
   `set()` cambiaría la ref y habría que reescribir el job y su prueba
   de solapamiento. (a) mantiene la ref estable (`enc:<plataforma>:<uuid>`),
   hereda RLS en `FORCE` como las demás tablas, se prueba en pglite con
   las migraciones reales y no necesita privilegios que no tenemos. La
   migración pasa `make db.check`, queda en `db/migrations/` con el
   precedente de 0014 y **no se aplica**: la aplica Rasheed (§1).
2. **Cifrado.** AES-256-GCM de `node:crypto`; clave derivada de
   `TOKEN_ENCRYPTION_KEY` con HKDF-SHA256, `info = 'on-cue/token/v1'`,
   salt vacío (la clave maestra ya es aleatoria; el `info` separa usos);
   IV de 12 bytes aleatorio por escritura; AAD = `secret_ref` (un
   ciphertext copiado a otra ref no descifra); `key_version` `'v1'`.
   Rotación: el `TokenCipher` recibe un llavero `{ current, keys:
   { v1, v2… } }`; `decrypt` elige la clave por `key_version` y
   `EncryptedSecretStore.rotate(ref)` descifra con la vieja y reescribe
   con `current`. Cuando toque rotar, `TOKEN_ENCRYPTION_KEY_V2` entra al
   vault, `TOKEN_ENCRYPTION_KEY_CURRENT=v2`, se corre `rotate` sobre
   todas las refs y se retira la v1. Formato de la clave (medido sin
   imprimirla: un script que solo cuenta longitud y alfabeto): 44
   caracteres en base64 = 32 bytes. Se acepta también hex de 64.
3. **`EncryptedSecretStore`** recibe `{ query(text, params) }` (el
   `SqlExecutor` que ya usan `PostgresCallLogSink` y el store de cuota)
   y un `TokenCipher`. `set()` es un `INSERT … ON CONFLICT (secret_ref)
   DO UPDATE` con `workspace_id = COALESCE($ws, current_workspace_id())`:
   en la web lo pone la transacción de workspace; en el worker
   (`mc_worker`, BYPASSRLS) la fila ya existe y solo se actualiza. `get()`
   de una ref inexistente devuelve `null`; dos `set()` dejan una fila;
   lo guardado no contiene el token en claro (prueba). Un fallo de
   descifrado (clave equivocada, manipulación) lanza
   `TokenCipherError` y **no** devuelve `null`: `null` significa «no
   existe» y el job lo trata como problema nuestro sin tocar la cuenta.
4. **Flujo web.** `POST /conexiones/oauth/[platform]/start` (el diálogo
   de consentimiento envía el formulario, así hay evidencia): valida con
   zod, genera `state` de 32 bytes, guarda `{ state, verifier, platform,
   creatorId, policyVersion, textShown, at }` en la cookie `oc_oauth`
   (httpOnly, `Secure` fuera de desarrollo, `SameSite=Lax`, `Path=/conexiones/oauth`,
   `Max-Age=600`) sellada con HMAC-SHA256 de una clave HKDF de la misma
   maestra con `info = 'on-cue/oauth-state/v1'`, y responde 303 a la
   URL de autorización. `GET …/callback`: la cookie se borra siempre
   (un solo uso); `error` de la plataforma → 303 a
   `/conexiones?error=cancelada`; sin cookie, sello inválido, `state`
   distinto o más de 10 minutos → **400** con mensaje en español y sin
   tocar la base; con `code` → intercambio → identidad (`userInfo` /
   `me` de CON-1) → **una** transacción de workspace: `set()` en el
   store, `upsertConnection` (`ON CONFLICT` por el UNIQUE: reactiva,
   actualiza scopes, fechas, handle, avatar, `status 'active'`,
   `status_detail` y `deleted_at` a null) y una fila de `data_consent`
   por finalidad (`analytics` siempre; `audience_demographics` si el
   scope lo permite) con `policy_version` y `evidence { ip, userAgent,
   textShown, scopesRequested, scopesGranted, at }` → 303 a
   `/conexiones?conectada=<id>`. La ref se **reutiliza** si la cuenta
   ya tenía fila (`findConnectionByAccount`): así reconectar no deja
   ciphertexts huérfanos. Las llamadas HTTP del callback se registran
   en `api_call_log` (`oauth.token`, `oauth.long_lived`, y
   `tiktok.user.info` / `instagram.me` de CON-1) acumulándolas en
   memoria durante la fase HTTP y escribiéndolas dentro de la misma
   transacción. Ni el `code` ni los tokens tocan logs, errores, URLs
   nuestras ni la cookie. Los handlers se construyen con
   `createOAuthHandlers({ fetch, now, random, withWorkspace, env })` y
   se prueban llamándolos con un `Request`.
5. **TikTok son dos apps.** Login Kit (Display) es lo que se conecta en
   sandbox: `https://www.tiktok.com/v2/auth/authorize/` con `client_key`,
   `scope` separado por comas, `response_type=code`, `redirect_uri`,
   `state`; intercambio `POST https://open.tiktokapis.com/v2/oauth/token/`
   en formulario; respuesta `access_token` (24 h), `refresh_token`
   (365 días, **rota** en cada renovación), `open_id`, `scope`. **Sin
   PKCE en web**: la documentación de hoy solo pide `code_verifier` en
   móvil y escritorio y no menciona `code_challenge` para web; enviar un
   parámetro no documentado puede romper la autorización. El sello de la
   cookie deja el campo `verifier` para cuando alguna plataforma lo
   admita. La Accounts API (`business-api.tiktok.com`) queda
   implementada sobre fixtures de la documentación (`tt_user/oauth2/token/`
   y `tt_user/oauth2/refresh_token/`, JSON, `client_id`/`client_secret`)
   y expuesta solo si existe `TIKTOK_BUSINESS_APP_ID` («Activar analítica
   avanzada»); su `platform_id` sigue siendo `tiktok` y la distingue el
   `secret_ref` (`enc:tiktok-business:…`) y `external_account_id`, con
   dos `social_connection`, como dice `docs/arquitectura.md`. El portal
   de la Accounts API es JavaScript y no se pudo leer (mismo bloqueo de
   CON-1): **ver 0.5**.
6. **Instagram.** Variante Instagram Login: autorización en
   `https://www.instagram.com/oauth/authorize` (`client_id`,
   `redirect_uri`, `response_type=code`, `scope` separado por comas,
   `state`), scopes `instagram_business_basic` e
   `instagram_business_manage_insights` (**ver 0.5** sobre el nombre del
   segundo), intercambio `POST https://api.instagram.com/oauth/access_token`
   (formulario) → token corto + `user_id` + `permissions`; cambio
   inmediato a larga duración `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=…`
   → 60 días. Se guarda `accessToken` con `accessExpiresAt = now +
   expires_in`, `refreshToken` vacío. Al volver del consentimiento
   Instagram añade `#_` al redirect: el navegador no lo manda al
   servidor, pero el handler lo tolera. El refresher real llama a
   `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token`
   con el token en la cabecera `Authorization: Bearer` (igual que todos
   los endpoints de CON-1, para no poner el token en la URL; si en la
   prueba en vivo Meta lo rechaza, pasa a query como dice su
   documentación: **ver 0.5**) mientras queden más de 24 h; si ya
   venció, falla como definitivo (`refresh_expired`) sin llamar.
7. **Refreshers reales.** `createTikTokRefresher(core, cfg)` y
   `createInstagramRefresher(core, cfg)` reemplazan los stubs; corren
   sobre `HttpCore` (reintentos con `Retry-After`, `api_call_log` por
   intento con endpoint `oauth.refresh`) y convierten el
   `PlatformApiError` en `TokenRefreshError`: `auth` y `permanent` →
   definitivo (`invalid_grant`, 190, `refresh_expired`), `transient` y
   `quota` → transitorio con `retryAfterS`. Fixtures `ok`,
   `invalid_grant`, `rate_limit` y `server_error_then_ok` por plataforma.
   `youtube.ts` sigue como stub (CON-8). El job `oauth.refresh` sigue
   escribiendo su propia fila `oauth.refresh` (vale para el fake y para
   la demo), así que en el worker los refreshers reciben un sink nulo
   para no duplicar filas; en las pruebas reciben el sink en memoria.
8. **Pantalla mínima de `/conexiones`.** Lista sobre `connection_health`
   (plataforma, cuenta, estado en `Pill`, conectada el, «datos hasta»
   con `DataAsOf` o «Sin sincronizar todavía» cuando no hay dato,
   scopes) con `DataTable` y `EmptyState`; dos botones «Conectar
   TikTok» y «Conectar Instagram» que abren un `<dialog>` con el texto
   de la política, su versión y una casilla obligatoria; «Desconectar»
   (Server Action + zod) marca `deleted_at` y `status 'disabled'`,
   revoca el consentimiento (`revoked_at`) y borra el ciphertext de
   `connection_secret` (menos material secreto en reposo; reconectar
   vuelve a escribirlo en la misma ref). Sin CON-4: nada de horas en
   rojo ni de reautorizar. Un botón cuya app no está configurada se
   muestra deshabilitado con el nombre de la variable que falta.
9. **Margen de renovación por plataforma.** El cron de `oauth.refresh`
   renueva lo que vence dentro de `OAUTH_REFRESH_MARGIN_MINUTES` (30).
   Para un token de Instagram de 60 días eso significaría renovar a
   media hora del vencimiento; se añade un margen por plataforma
   (`OAUTH_REFRESH_MARGIN_MINUTES_INSTAGRAM`, 7 días por defecto) que
   respeta la condición de Meta (más de 24 h de vida y al menos 24 h de
   antigüedad). **DECISIÓN PENDIENTE DE NICOLÁS**: el valor (7 días) es
   la opción conservadora; cualquier valor entre 1 y 30 días funciona.
10. **`SECRET_STORE=encrypted` es el valor por defecto del worker.** Sin
    `TOKEN_ENCRYPTION_KEY` el worker no arranca y dice qué variable
    falta; `env` y `memory` siguen para desarrollo y `--demo`.
    `TOKEN_REFRESHER=real` sin las variables de una app deja para esa
    plataforma un refresher que falla como transitorio
    (`not_configured`, sin reintento inmediato) nombrando la variable.
11. **Creadora provisional (CIM-3).** El `creator_id` de la conexión y
    del consentimiento es el `creator_profile` del workspace actual
    (`getDefaultCreatorId(tx)`, filtrado por RLS), marcado `TODO(CIM-3)`
    junto con `getCurrentWorkspaceId()`.

### 0.3 Lo que la documentación oficial dice hoy (22-sep-2026)

| Plataforma | Dato | Valor | Fuente |
|---|---|---|---|
| TikTok Login Kit (web) | Autorización | `https://www.tiktok.com/v2/auth/authorize/` con `client_key`, `scope` (comas), `response_type=code`, `redirect_uri`, `state`; vuelve con `code`, `scopes`, `state` o `error` + `error_description` | developers.tiktok.com/doc/login-kit-web |
| TikTok Login Kit | Redirect URI | solo HTTPS, absoluta y estática, sin query ni `#`, ≤ 512 caracteres, hasta 10 por app, debe coincidir con la registrada | misma página |
| TikTok Login Kit | PKCE | `code_verifier` «required for mobile and desktop app only»; web no lo menciona | developers.tiktok.com/doc/oauth-user-access-token-management |
| TikTok | Token | `POST https://open.tiktokapis.com/v2/oauth/token/`, `application/x-www-form-urlencoded`, `client_key`, `client_secret`, `code`, `grant_type=authorization_code`, `redirect_uri`; respuesta `access_token` (86 400 s), `refresh_token` (31 536 000 s), `open_id`, `scope` (comas), `token_type=Bearer` | misma página |
| TikTok | Renovación | `grant_type=refresh_token`; «the returned refresh_token may be different… you must use the newly-returned token» | misma página |
| TikTok | Revocar | `POST https://open.tiktokapis.com/v2/oauth/revoke/` con `client_key`, `client_secret`, `token` (no se usa en CON-3) | misma página |
| TikTok | Errores | `{ error, error_description, log_id }`; la página solo ejemplifica `invalid_request`; `invalid_grant` y `rate_limit_exceeded` se tratan por la tabla general de errores de CON-1 | misma página |
| TikTok | Sandbox | hasta 5 sandboxes por app y 10 «target users» por sandbox; solo esas cuentas pueden autorizar; los usuarios tardan hasta una hora en aparecer | developers.tiktok.com/docs/en/add-a-sandbox · blog «Introducing Sandbox» |
| Instagram (Instagram Login) | Autorización | `https://www.instagram.com/oauth/authorize` con `client_id`, `redirect_uri`, `response_type=code`, `scope` (comas), `state`; cancelación: `error=access_denied`, `error_reason=user_denied`, `error_description`; el redirect exitoso lleva `#_` al final | developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login |
| Instagram | Token corto | `POST https://api.instagram.com/oauth/access_token` (formulario) con `client_id`, `client_secret`, `grant_type=authorization_code`, `redirect_uri`, `code` (válido 1 h, un solo uso) → `{ access_token, user_id, permissions }` | misma página |
| Instagram | Larga duración | `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=…&access_token=…` → 60 días, `expires_in` en segundos | misma página |
| Instagram | Renovación | `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=…`; el token debe tener ≥ 24 h de antigüedad, no estar vencido y el usuario debe haber concedido `instagram_business_basic` | misma página |
| Instagram | Scopes | `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_comments`, `instagram_business_manage_messages` listados; los insights se anuncian disponibles pero su scope no aparece en esa página | developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login |
| Instagram | Cuenta | profesional (business o creator); no requiere página de Facebook | misma página |

### 0.4 Decisiones pendientes de Nicolás (se tomó la opción conservadora)

- **Margen de Instagram** (0.2 · 9): 7 días.
- **Borrar el ciphertext al desconectar** (0.2 · 8): sí. Si se prefiere
  conservarlo hasta que el creador pida el borrado completo, es quitar
  un `DELETE` en `disconnectConnection`.
- **Registro de los refreshers en el worker** (0.2 · 7): la fila la
  escribe el job, como hasta hoy. Si se prefiere una fila por intento
  HTTP, es cambiar el sink nulo por `PostgresCallLogSink(db)` y quitar
  `logApiCall` del job.

### 0.5 Dudas que no se resolvieron con la documentación pública

- **Nombre del scope de insights de Instagram.** Las páginas leídas hoy
  listan cuatro scopes y anuncian los insights sin nombrar el suyo; los
  endpoints de CON-1 lo necesitan. Se usa `instagram_business_manage_insights`
  (el nombre con el que Meta lo introdujo en 2024) y se confirma en el
  App Dashboard al pedir el permiso. Si el nombre difiere, es una
  constante en `oauth/instagram-login.ts`.
- **Token de Instagram en cabecera o en query.** Meta documenta
  `access_token=` en la URL para `access_token` (larga duración) y
  `refresh_access_token`. Igual que CON-1, se envía como `Authorization:
  Bearer` para no ponerlo en la URL. Si la prueba en vivo devuelve
  `code 190`/`104` en esas dos llamadas, se pasa a query en esas dos
  (una opción del cliente, `tokenInQuery`), aceptando que nuestro
  `api_call_log` nunca guarda URLs.
- **Accounts API de TikTok.** Autorización y `tt_user/oauth2/token/`
  salen de la cabecera de CON-2 y de la búsqueda sobre el portal
  (JavaScript, no legible con WebFetch). Se confirma cuando CON-9 dé
  acceso; hasta entonces el botón «Activar analítica avanzada» está
  detrás de `TIKTOK_BUSINESS_APP_ID` y no aparece.
- **Acceso a las apps.** Al empezar no hay `TIKTOK_LOGIN_CLIENT_KEY`,
  `TIKTOK_LOGIN_CLIENT_SECRET`, `META_APP_ID` ni `META_APP_SECRET` en
  el vault (comprobado por nombre, sin leer valores). Todo se construye
  y prueba con respuestas grabadas; la prueba en vivo queda como lista
  de pasos (§5) y la historia queda «bloqueada» solo por ella.

### 0.6 Fuera de alcance (y a qué historia va)

- Horas en rojo, «reautorizar» y el paso manual de Analytics: **CON-4**.
- OAuth de YouTube y su refresher: **CON-8**.
- Revocar el token en la plataforma al desconectar (`oauth/revoke/`):
  **CON-4** (hoy se borra el ciphertext y se desactiva la fila).
- `deauthorize callback` y `data deletion request` de Meta: **CON-4**
  (URLs a registrar en la app; la lógica es la misma que desconectar).
- Cliente Drizzle, sesión y workspace real: **CIM-2**, **CIM-3**.

---

## 1. La migración `0015_connection_secret.sql` (para revisar y aplicar)

Está en `db/migrations/0015_connection_secret.sql`, pasa `make db.check`
(15 migraciones, 89 tablas) y **no se aplicó** en Supabase. Contenido:

```sql
CREATE TABLE connection_secret (
  secret_ref    text PRIMARY KEY CHECK (secret_ref LIKE 'enc:%'),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  ciphertext    bytea NOT NULL,
  iv            bytea NOT NULL CHECK (octet_length(iv) = 12),
  tag           bytea NOT NULL CHECK (octet_length(tag) = 16),
  key_version   text NOT NULL DEFAULT 'v1' CHECK (key_version ~ '^v[0-9]+$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON connection_secret (workspace_id);
CREATE TRIGGER connection_secret_updated BEFORE UPDATE ON connection_secret
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE connection_secret ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_secret FORCE ROW LEVEL SECURITY;
CREATE POLICY connection_secret_ws_isolation ON connection_secret
  USING (workspace_id = current_workspace_id());
```

- Privilegios: comprobado en Supabase (solo lectura) que `mc_migrator`
  tiene `DEFAULT PRIVILEGES` para `mc_app` (`arwd`) y para `mc_worker`
  (0014), así que la tabla nace con los mismos permisos de fila que las
  demás; no hace falta `GRANT`.
- La clave no está en la base: sin `TOKEN_ENCRYPTION_KEY` la tabla es
  ruido. AAD = `secret_ref`: un ciphertext copiado a otra fila no descifra.
- Cuando la apliques: `make db.migrate`. Nada más; la web y el worker ya
  la usan.

## 2. Lo que hay que registrar en cada app (redirect URIs y scopes)

La ruta del callback es `/conexiones/oauth/<proveedor>/callback`. Si no
se fija la variable `*_REDIRECT_URI`, la web la deriva de `APP_URL`.
**Ojo:** `.env.example` trae `…/api/oauth/tiktok/callback`; esa ruta no
existe. Propongo actualizar `.env.example` (no lo toqué: es archivo
compartido) con estos valores.

| App | Redirect URIs a registrar (exactas) | Scopes |
|---|---|---|
| TikTok Login Kit (`developers.tiktok.com`) | `https://on-cue-web.vercel.app/conexiones/oauth/tiktok/callback` · `https://<vista-previa>.vercel.app/conexiones/oauth/tiktok/callback` (una por vista previa que se quiera probar; TikTok solo admite https, absolutas, sin query ni `#`, hasta 10) · **local no es posible** (`http://localhost` no es https): en desarrollo se prueba con un túnel https o directamente en la vista previa | `user.info.basic`, `user.info.profile`, `user.info.stats`, `video.list` |
| TikTok Accounts API (`business-api.tiktok.com`, tras CON-9) | `…/conexiones/oauth/tiktok-business/callback` (mismos hosts) | `user.info.basic`, `user.info.username`, `user.info.stats`, `user.insights`, `video.list`, `video.insights` |
| Meta · Instagram Login (`developers.facebook.com`, app tipo Business, producto «Instagram» → «API setup with Instagram login» → Business login) | `https://on-cue-web.vercel.app/conexiones/oauth/instagram/callback` · vistas previas · `http://localhost:3000/conexiones/oauth/instagram/callback` (Meta sí acepta localhost en desarrollo) | `instagram_business_basic`, `instagram_business_manage_insights` |

Meta pide además una **Deauthorize callback URL** y una **Data deletion
request URL**; hoy pueden apuntar a `https://on-cue-web.vercel.app/conexiones`
(la lógica real es CON-4, §0.6).

## 3. Variables que necesito en el vault y en Vercel (solo nombres)

| Variable | Dónde | Notas |
|---|---|---|
| `TOKEN_ENCRYPTION_KEY` | Vercel (producción y vista previa) · Railway/Fly | Ya está en el vault (44 caracteres, base64). La web la necesita para cifrar el primer token y sellar la cookie; el worker, para descifrar. **Sin ella la web responde 503 en `/conexiones/oauth/*` y el worker no arranca.** |
| `TIKTOK_LOGIN_CLIENT_KEY`, `TIKTOK_LOGIN_CLIENT_SECRET` | vault → Vercel y worker | De la app de Login Kit, cuando me des acceso (§8.3 fila 8 del backlog). |
| `TIKTOK_LOGIN_REDIRECT_URI` | Vercel | Opcional si `APP_URL` está; en vista previa conviene fijarla porque `APP_URL` cambia. |
| `TIKTOK_BUSINESS_APP_ID`, `TIKTOK_BUSINESS_APP_SECRET`, `TIKTOK_BUSINESS_REDIRECT_URI` | vault → Vercel y worker | Tras CON-9. Sin `TIKTOK_BUSINESS_APP_ID` el botón «Activar analítica avanzada» no aparece. |
| `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI` | vault → Vercel y worker | De la app de Meta con Instagram Login. |
| `APP_URL` | Vercel | `https://on-cue-web.vercel.app` en producción. |
| `OAUTH_REFRESH_MARGIN_MINUTES_INSTAGRAM` | worker, opcional | 7 días por defecto (§0.2 · 9). |

Ninguna dependencia nueva: `zod` ya estaba en la web; `node:crypto` es
de Node. `apps/web` ahora depende de `@mc/connectors` (workspace) y el
lockfile solo suma ese enlace en el importer de `apps/web`.

## 4. Lo provisional y qué lo reemplaza

| Qué | Dónde | Cuándo se va |
|---|---|---|
| `getCurrentWorkspaceId()` (workspace del seed o `MC_WORKSPACE_ID`) | `apps/web/app/(app)/conexiones/_lib/workspace.ts` | **CIM-3**: `lib/workspace/` de la sesión. Se borra junto con el de Finanzas. |
| `getDefaultCreatorId(tx)` (el `creator_profile` del workspace, filtrado por RLS) | `packages/db/src/queries/conexiones.ts` | **CIM-3**: el creador de la sesión. Es una función; cambia quién la llama. |
| `getDb()` compartido con Finanzas por `globalThis.__mcFinanzasDb` | `apps/web/app/(app)/conexiones/_lib/db.ts` | **CIM-2**: `packages/db/src/client.ts`. Las consultas solo dependen de `WorkspaceTx`. |
| `EncryptedSecretStore` y `PostgresCallLogSink` reciben `{ query(text, params) }` | `packages/connectors` | **CIM-2**: el ejecutor será `tx.execute` o equivalente. |
| Redirect URIs en `.env.example` con `/api/oauth/...` | `platform/.env.example` | Cambiar a `/conexiones/oauth/<proveedor>/callback` (§2). |

## 5. Prueba en vivo con una cuenta sandbox (paso a paso)

Lo que falta para dar CON-3 por «hecha» es solo esto. Con los accesos de
la fila 8 de §8.3:

**TikTok (Login Kit, sandbox).**

1. En `developers.tiktok.com`, en la app: crear un **Sandbox**, añadir
   mi cuenta de TikTok como *target user* (tarda hasta una hora en
   aparecer), activar Login Kit con los cuatro scopes de §2 y registrar
   la redirect URI de producción o de la vista previa que vaya a usar.
2. Meter al vault `TIKTOK_LOGIN_CLIENT_KEY` y `TIKTOK_LOGIN_CLIENT_SECRET`
   del sandbox; ponerlas en Vercel junto con `TOKEN_ENCRYPTION_KEY` y
   `APP_URL`; desplegar (`./scripts/vercel.sh run deploy --cwd "$PWD" --yes`
   desde `platform/`, o vista previa sin `--prod`). Aplicar `0015`.
3. Abrir `/conexiones`, pulsar «Conectar TikTok», leer el diálogo,
   marcar la casilla, «Continuar a TikTok». Debo ver la pantalla de
   autorización de TikTok con la app del sandbox y los cuatro permisos.
4. Autorizar. Debo volver a `/conexiones?conectada=<uuid>` con el aviso
   verde «Cuenta de TikTok (@mi_handle) conectada» y la fila en la tabla:
   Activa, conectada hoy, «Sin sincronizar todavía», permisos listados.
5. Confirmar en la base (solo lectura):
   ```bash
   make db.sql Q="select id, platform_id, external_account_id, handle, status, scopes, access_expires_at, refresh_expires_at, secret_ref, connected_at from social_connection where platform_id = 'tiktok' and deleted_at is null order by connected_at desc limit 3"
   make db.sql Q="select secret_ref, key_version, octet_length(ciphertext) as bytes, workspace_id, created_at from connection_secret order by created_at desc limit 3"
   make db.sql Q="select purpose, granted, policy_version, evidence - 'textShown' as evidence, granted_at from data_consent order by granted_at desc limit 3"
   make db.sql Q="select endpoint, http_status, ok, error_code, called_at from api_call_log order by id desc limit 5"
   ```
   Lo esperado: `scopes = {user.info.basic,user.info.profile,user.info.stats,video.list}`,
   `access_expires_at` a 24 h, `refresh_expires_at` a 365 días,
   `secret_ref` con la forma `enc:tiktok:<uuid>`, una fila en
   `connection_secret` con `key_version = 'v1'`, un `data_consent`
   `analytics` con `ip`, `userAgent`, `scopesGranted` y `at`, y en
   `api_call_log` `oauth.token` y `tiktok.user.info` en 200. **Ningún
   `select` muestra un token**: `social_connection` solo tiene la ref y
   `connection_secret` bytes.
6. Cancelar en TikTok en otro intento → `/conexiones?error=cancelada`.
7. Renovación: `make worker` con `TOKEN_ENCRYPTION_KEY` y las variables
   de TikTok en el entorno; encolar `oauth.refresh` para esa conexión
   (`boss.send('oauth.refresh', { connectionId })` desde `--demo` no
   sirve: usa el `select` de arriba y espera el tick de 15 min o baja
   `access_expires_at` a mano con `ADMIN=1` en una base de prueba, nunca
   en producción). Lo esperado: `job_run` `ok` con `renewed = [id]`,
   `access_expires_at` movido 24 h y `connection_secret.updated_at`
   nuevo. Después, `pnpm --filter @mc/connectors record -- --platform
   tiktok --ref enc:…` no aplica todavía (el script lee `env:`; queda
   para cuando se regraben fixtures).

**Instagram (app en modo desarrollo).**

1. En el App Dashboard: app tipo Business → producto Instagram → «API
   setup with Instagram login» → Business login: redirect URIs de §2,
   deauthorize y data deletion URLs, y añadir mi cuenta profesional
   (business o creator) como **Instagram Tester** en App Roles; aceptar
   la invitación en Instagram → Configuración → Apps y sitios web.
2. Vault y Vercel: `META_APP_ID`, `META_APP_SECRET` (y `META_REDIRECT_URI`
   si no hay `APP_URL`).
3. «Conectar Instagram» → autorización de Instagram con los dos permisos
   → vuelta a `/conexiones?conectada=<uuid>`. Confirmar con los mismos
   `select`: `scopes = {instagram_business_basic,instagram_business_manage_insights}`,
   `access_expires_at` a ~60 días, `refresh_expires_at` nulo, `secret_ref`
   `enc:instagram:<uuid>`, dos `data_consent` (`analytics`,
   `audience_demographics`), `api_call_log` con `oauth.token`,
   `oauth.long_lived` e `instagram.me`.
4. Si la llamada `oauth.long_lived` o la renovación fallan con `190`
   pese a un token recién emitido, es el punto abierto de §0.5 (token en
   cabecera vs. query): avísame y lo paso a query en esas dos llamadas.

## 6. Verificación (22 de septiembre de 2026)

- `pnpm --filter @mc/connectors typecheck lint test`: **115 pruebas**
  (20 de OAuth, 8 del cifrado, 3 del sello, 7 del almacén en pglite),
  < 3 s, `withoutNetwork()` en cada archivo.
- `pnpm --filter @mc/db typecheck test`: **20 pruebas** en Postgres
  embebido con el seed 0003 (6 de conexiones, con otro workspace en cada
  operación).
- `pnpm --filter @mc/worker typecheck lint test`: **27 pruebas** (~26 s),
  incluida `oauth-refresh-real.test.ts` con el almacén cifrado y los
  refreshers reales sobre fixtures, más el volcado de `public` y `pgboss`.
- `pnpm --filter @mc/web typecheck lint test build`: **94 pruebas** (9 de
  los handlers OAuth contra pglite con el seed, incluida la prueba clave)
  y `next build` en verde con las tres rutas nuevas dinámicas.
- `make db.check`: 15 migraciones, 89 tablas, 10 vistas.
- En dev (`next dev` con una clave aleatoria y una app de TikTok ficticia):
  `/conexiones` lista las tres conexiones del seed con «datos hasta el»
  por red; `POST …/tiktok/start` sin casilla → 303 `?error=consentimiento`;
  con casilla → 303 a `www.tiktok.com/v2/auth/authorize/` con `state` y
  `Set-Cookie: oc_oauth=…; Path=/conexiones/oauth; HttpOnly; SameSite=Lax; Max-Age=600`;
  `GET …/start` → 405; callback con `state` distinto → 400 sin tocar la
  base; sin cookie → 400; `?error=access_denied` → 303 `?error=cancelada`
  y la página muestra «Cancelaste la autorización…»; `…/instagram/start`
  sin app → 503 «faltan META_APP_ID, META_APP_SECRET».
- Worker en pglite con `TOKEN_ENCRYPTION_KEY`: arranca como `mc_worker`
  con el almacén cifrado y avisa por cada app OAuth sin configurar; sin
  la clave, sale con código 1 y «Falta TOKEN_ENCRYPTION_KEY…».

## 7. Pendiente de ti

- [ ] Aplicar `0015_connection_secret.sql` (`make db.migrate`).
- [ ] Acceso de desarrollador a la app de TikTok (Login Kit, con sandbox)
      y a la app de Meta (Instagram Login), o las credenciales al vault
      con los nombres de §3.
- [ ] Registrar las redirect URIs y los scopes de §2 en cada app.
- [ ] `TOKEN_ENCRYPTION_KEY` y `APP_URL` en Vercel (producción y vista
      previa) y en el entorno del worker (CIM-7).
- [ ] Actualizar `.env.example` con las rutas de §2 (o darme el visto
      bueno para hacerlo yo).
- [ ] CIM-2 y CIM-3 como en FIN-1 (§4).
