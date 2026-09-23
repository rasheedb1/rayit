# CON-10 · Cuentas por @ con datos públicos — plan y lo que necesita Rasheed

Escrito para: Nicolás (decisión de producto del 22 de septiembre) y
Rasheed (dueño de `db/migrations/`, del despliegue y de los trámites).
Fecha: 22 de septiembre de 2026. Rama `nicolas/CON-3-oauth-sandbox`
(continúa sobre lo de CON-3), worktree `rayit-con3`.

**Decisión que origina esta historia.** La conexión OAuth de cada
creador (CON-3, CON-4, CON-8) pasa a una versión posterior. En el MVP
una cuenta se agrega escribiendo su **@** y el producto la analiza con
lo que la plataforma publica. Aplica a todas las redes.

---

## 0. Plan (fase 1)

### 0.1 Lo que se comprobó antes de diseñar (22-sep, desde servidor)

| Camino | Resultado | Consecuencia |
|---|---|---|
| `GET https://www.tiktok.com/@selvathegolden` | 200 con 1,4 KB: página de reto anti-bot (SlardarWAF), sin datos | El HTML público de TikTok no sirve desde un servidor. |
| `GET https://www.tiktok.com/oembed?url=…/@selvathegolden` (oficial) | 200: `author_name`, `author_url`, `embed_product_id`, `embed_type: profile`; handle inexistente → 400 | Confirma identidad y nombre. **No trae seguidores ni videos.** |
| `GET https://www.instagram.com/nicolasduartea/` | 200 con el muro de inicio de sesión (título «Instagram»), sin `og:description` | El HTML público de Instagram no sirve desde un servidor. |
| `i.instagram.com/api/v1/users/web_profile_info` (no oficial) | 401 `require_login` | Descartado. |
| `business_discovery` de la API oficial (CON-1) | Funciona con el token de **una** cuenta profesional nuestra | Es el camino de Instagram: un token de la cuenta casa, no un OAuth por creador. |
| YouTube Data API `channels?forHandle=` sin credencial | 403 «use API Key» | Con una API key (sin OAuth ni trámite) funciona; CON-1 ya lo tiene. |

Conclusión: **no existe un camino gratuito y oficial para las métricas
de TikTok por @.** Las opciones son un proveedor de datos de pago
(`access_mode = 'aggregator'` ya existe en 0002), el CSV de TikTok
Studio que sube el creador (RES-2) o la autorización del dueño (CON-3,
pospuesta). Instagram y YouTube sí tienen camino oficial con una
credencial de la casa.

### 0.2 Qué se construye

```
db/migrations/0022_public_profile_access.sql   'public_profile' en el CHECK de social_connection.access_mode
packages/connectors/src/public/
  types.ts            PublicProfile, PublicProfileSource, PublicLookupError (not_found | not_configured | transient)
  tiktok-public.ts    identidad por oEmbed (oficial); métricas: null con la razón
  instagram-public.ts businessDiscovery de CON-1 con INSTAGRAM_HOUSE_TOKEN
  youtube-public.ts   channelByHandle de CON-1 con GOOGLE_API_KEY (apiKey nuevo en YouTubeClient)
  index.ts            createPublicProfileSources(env, core): por plataforma, o la variable que falta
packages/db/src/queries/conexiones.ts   addPublicAccount, recordAccountSnapshot, listAccounts (con último snapshot y Δ7d), refresh
apps/web/app/(app)/conexiones/          «Agregar cuenta» (red + @), tabla con seguidores y «datos hasta», Actualizar, Quitar
apps/web/content/flags.ts               oauth_connect: false (los botones y rutas de CON-3 quedan detrás)
apps/worker/src/jobs/conexiones/collect-account-metrics.ts   collect.account_metrics para access_mode = 'public_profile'
```

### 0.3 Decisiones

1. **Fuentes oficiales o nada.** No se raspa HTML: falla desde servidor
   (0.1) y va contra los términos de TikTok e Instagram. TikTok queda
   con identidad por oEmbed y métricas «pendientes de fuente»; la
   pantalla lo dice con esas palabras. **DECISIÓN PENDIENTE DE NICOLÁS**:
   proveedor de pago (Apify, EnsembleData, Phyllo…), CSV de TikTok
   Studio o esperar la autorización.
2. **Instagram con la cuenta casa.** El token de larga duración (60
   días) de una cuenta profesional de On Cue (`INSTAGRAM_HOUSE_TOKEN`)
   se genera en el App Dashboard de Meta sin pasar por nuestro OAuth
   (§3). Con él `business_discovery` lee cualquier cuenta **profesional
   y pública** por @: seguidores y número de publicaciones. Cuentas
   personales no son descubribles: la pantalla lo explica. El token
   vence a los 60 días; el worker lo renueva con el refresher de CON-3
   si está en el almacén, y si no, el error 190 sale en la pantalla con
   la instrucción de regenerarlo. **Conservador:** variable de entorno y
   aviso; la renovación automática de la cuenta casa es una historia
   aparte.
3. **YouTube con API key** (`GOOGLE_API_KEY`, proyecto de Google Cloud,
   sin verificación): canal, suscriptores, videos, vistas. Cuota 10 000
   unidades/día que el `QuotaManager` de CON-1 ya contabiliza.
4. **Modelo.** La cuenta es una `social_connection` con
   `access_mode = 'public_profile'`, `secret_ref = 'public:<red>:<handle>'`
   (la columna es NOT NULL; no hay secreto), `status 'active'` y un
   `data_consent` `analytics` cuya evidencia dice que el usuario declaró
   la cuenta como propia (`declaredOwner: true`), con IP, agente y texto
   mostrado. Cada lectura deja una fila en `account_metric_snapshot`
   con `source = 'public_profile'` (UNIQUE por conexión, día y fuente:
   «Actualizar» dos veces el mismo día reemplaza, no duplica). Sin dato
   → `null`, nunca cero.
5. **Alcance de uso.** Solo cuentas que el usuario declara suyas o que
   gestiona. No hay búsqueda ni ranking de terceros (límite de
   `docs/arquitectura.md`). Las marcas por @ siguen en CAM-3.
6. **Lo de CON-3 no se borra.** Queda detrás de la bandera
   `oauth_connect` (apagada): botones ocultos y rutas en 404. El
   almacén cifrado y los refreshers siguen sirviendo para la cuenta casa.

### 0.4 Fuera de alcance

- Lista de publicaciones y métricas por video (`collect.posts`,
  `collect.post_metrics`): **CON-5**, sobre estas mismas fuentes.
- Proveedor de datos de TikTok: historia nueva cuando se decida.
- Renovación automática del token de la cuenta casa: historia nueva.

---

## 1. Cómo se ve en el MVP

`/conexiones` («Cuentas»): un formulario con la red, el @ (o el enlace
del perfil) y la casilla de declaración de propiedad; debajo, qué
ofrece cada red por @ y si está configurada en el entorno. La tabla
lista cada cuenta con seguidores, variación en siete días,
publicaciones, vistas, «datos hasta el …» de su último snapshot, estado
y dos acciones: «Actualizar» (vuelve a leer hoy) y «Quitar» (conserva
la historia). Sin dato es «Sin dato», nunca cero. El worker repite la
lectura cada día a las 05:10 UTC (`collect.account_metrics`).

## 2. La migración `0022_public_profile_access.sql` (para revisar y aplicar)

```sql
ALTER TABLE social_connection DROP CONSTRAINT social_connection_access_mode_check;
ALTER TABLE social_connection ADD CONSTRAINT social_connection_access_mode_check
  CHECK (access_mode IN ('direct_oauth','business_portfolio','aggregator','manual_csv','public_profile'));
```

Pasa `make db.check` (17 migraciones con las del repositorio). **Ojo con
la numeración:** en Supabase están aplicadas 0017–0021 (políticas RLS)
que no están en ninguna rama del repositorio; quien las creó debe
subirlas. 0022 no choca con ellas. La aplica Nicolás con
`make db.migrate` antes del deploy: sin ella, «Agregar cuenta» falla con
un error de CHECK.

## 3. Las dos credenciales de la casa (las consigue Nicolás, 15 minutos)

Ninguna requiere trámite ni revisión, ni redirect URIs, ni OAuth en
nuestra web.

**`INSTAGRAM_HOUSE_TOKEN` (Instagram por @).**

1. Tu cuenta de Instagram tiene que ser **profesional** (Creador o
   Empresa) y pública.
2. En https://developers.facebook.com → Mis apps → Crear app → tipo
   **Negocios** → nombre «On Cue».
3. Agregar producto **Instagram** → **«API setup with Instagram business
   login»**.
4. En el paso **«Generate access tokens»** → **Add account** → inicia
   sesión con tu Instagram y autoriza. Aparece tu cuenta con un botón
   **Generate token**: cópialo. Es un token de larga duración (60 días).
5. Guárdalo en Vercel sin pegarlo a mano (con el token copiado, en la
   terminal):
   ```bash
   pbpaste | tr -d '\r\n' | /Users/nicolasduarte/Documents/influ/rayit-con3/platform/scripts/vercel.sh run env add INSTAGRAM_HOUSE_TOKEN production --sensitive --force
   ```
6. Cada 60 días se repite el paso 4. Cuando venza, la pantalla lo dice:
   «La credencial de Instagram de On Cue venció». La renovación
   automática es una historia aparte.

**`GOOGLE_API_KEY` (YouTube por @).**

1. https://console.cloud.google.com → proyecto nuevo «On Cue» → APIs y
   servicios → Biblioteca → **YouTube Data API v3** → Habilitar.
2. Credenciales → Crear credencial → **Clave de API**. Restringirla a
   «YouTube Data API v3».
3. Copiarla y guardarla:
   ```bash
   pbpaste | tr -d '\r\n' | /Users/nicolasduarte/Documents/influ/rayit-con3/platform/scripts/vercel.sh run env add GOOGLE_API_KEY production --sensitive --force
   ```

Las mismas dos variables van al entorno del worker (Railway/Fly, CIM-7)
para el snapshot diario.

## 4. Lo que queda decidido, pendiente y fuera

- **Fuente de TikTok, DECIDIDA el 22-sep (noche):** las métricas entran
  por el **CSV de TikTok Studio**, gratuito y sin credenciales (RES-2:
  hoy en el backlog de Rasheed; si no la toma en el sprint 2, la asume
  Nicolás). El proveedor de pago queda como opción futura, historia
  CON-12 (pendiente, no bloquea nada). La autorización del dueño (CON-3)
  sigue detrás de la bandera. Para construir el importador hace falta un
  **export real de TikTok Studio** (Analíticas → Descargar datos, CSV):
  el formato de columnas no está documentado públicamente y no se puede
  adivinar.
- Publicaciones y métricas por video (`collect.posts`,
  `collect.post_metrics`) sobre estas fuentes: **CON-5**.
- Renovación automática del token casa: historia nueva.
- `.env.example`: falta `INSTAGRAM_HOUSE_TOKEN`; `GOOGLE_API_KEY` no
  existe todavía como nombre (sí `GOOGLE_CLIENT_ID`). Archivo
  compartido: lo propongo, no lo toco.

## 5. Verificación (22 de septiembre, noche)

- `pnpm --filter @mc/connectors test`: 180 (4 nuevas: identidad por
  oEmbed y not_found; business_discovery ok / sin token / cuenta
  personal; YouTube con key, key tapada en URL y log).
- `pnpm --filter @mc/db test`: 46 (4 nuevas: alta sin duplicar y con
  RLS; consentimiento con declaración; snapshot que reemplaza el mismo
  día y Δ7d; fallo permanente → error, quitar conserva la historia).
- `pnpm --filter @mc/worker test`: 31 (2 nuevas: snapshots de Instagram
  y YouTube, TikTok anotada, cuenta inexistente en error, volcado sin
  credenciales; sin credenciales se salta y avisa).
- `pnpm --filter @mc/web test`: 119 (5 nuevas del servicio contra pglite
  con el seed, incluido el volcado R4) y `next build`.
- En dev: `/conexiones` muestra el formulario con la declaración, la
  disponibilidad por red y las tres cuentas del seed; las rutas OAuth
  responden 404 con la bandera apagada.

## 6. Prueba con las cuentas de Nicolás (después del deploy)

1. `@selvathegolden` en TikTok: se agrega ya, sin credenciales. Debe
   aparecer con nombre «Selva 🤪», estado Activa y el aviso «TikTok no
   publica seguidores…».
2. `@nicolasduartea` en Instagram: necesita `INSTAGRAM_HOUSE_TOKEN` (§3)
   y que la cuenta sea profesional y pública. Debe aparecer con
   seguidores y publicaciones y «datos hasta el» de hoy.
3. Comprobación (solo lectura):
   ```bash
   make -C /Users/nicolasduarte/Documents/influ/rayit-con3/platform db.sql Q="select c.platform_id, c.handle, c.status, c.status_detail, s.day, s.followers, s.media_count from social_connection c left join account_metric_snapshot s on s.connection_id = c.id and s.source = 'public_profile' where c.access_mode = 'public_profile' and c.deleted_at is null order by c.connected_at desc, s.day desc"
   ```
