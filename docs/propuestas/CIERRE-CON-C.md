# Cierre CON-C · Fuentes que esperan una credencial

Escrito para: Nicolás (encender cada fuente el día que llegue su
credencial, y las decisiones pendientes) y Rasheed (trámites de CON-9 y
entorno del worker).
Fecha: 23 de septiembre de 2026. Rama `nicolas/CON-C-fuentes`, worktree
`rayit-cierre-con-c`, desde `origin/main` `2a388d6`.

Lo que cierra este documento: todo el código de fuentes en `main` y
**apagado** hasta que llegue su credencial —CON-8 (OAuth de YouTube),
CON-12 (proveedor de TikTok) y la lectura real de CON-5/CON-10 por @—,
la guía exacta para encender cada una (§2) y el ensayo de CON-7 para el
día que haya una cuenta con permiso de insights (§3).

---

## 0. Inventario (F0)

### 0.1 La foto al empezar (23-sep, 17:14)

| Cosa | Estado |
|---|---|
| `origin/main` | `2a388d6` (cierre de FIN). La foto del prompt decía `cf90d57`: desde entonces entraron P0, CAM, CON-A y FIN |
| Producción | FIN-cierre (`0bd7107` o posterior, según CIERRE-FIN.md) |
| Supabase | 38 migraciones aplicadas: 0001–0039 (0023 es hueco). La **0041** de CAM está en main y **sin aplicar** (su PARADA 1), así que `make db.guardia` sale roja por ella y no por CON-C. CON-C **no trae migración** |
| CON-B (`nicolas/CON-B-pantalla`) | **No estaba en main**: su worktree estaba a mitad del merge de CON-4 (5 archivos `UU`). Es el requisito de este prompt; ver §0.3 |
| `nicolas/CON-8-oauth-youtube` | Solo local, 2 commits y 11 cambios sin commitear en `rayit-con8`, 267 detrás de main |
| `nicolas/CON-12-proveedor-tiktok` | En GitHub, 9 commits, 45 detrás de main (antes de CON-6) |
| Variables en Vercel | Faltan `INSTAGRAM_HOUSE_TOKEN`, `GOOGLE_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` y `ENSEMBLEDATA_TOKEN` |
| Worker en producción | No corre (lo cierra WRK). Ningún `collect.*` ha escrito en Supabase: `metric_gap` y `api_quota_usage` están vacías |

### 0.2 Rescate de CON-8 (F0)

En `rayit-con8`, rama `nicolas/CON-8-oauth-youtube`: los 11 cambios se
commitearon tal cual, por rutas, como `ff6b02f` «CON-8: trabajo en curso
rescatado para el cierre». Estado en ese momento, corriendo allí mismo:

| Pruebas | Resultado |
|---|---|
| `pnpm --filter @mc/connectors test` | 195/195 |
| web `app/(app)/conexiones` (vitest) | 18/18 (`oauth-handlers` 13, `cuentas-service` 5) |
| worker `test/oauth-refresh-real.test.ts` | 4/4 (incluida la R4 de tokens) |

Es decir: el trabajo sin commitear estaba terminado y verde; solo le
faltaba el commit y la integración. `git push origin
nicolas/CON-8-oauth-youtube` hecho. Nada más se tocó en ese worktree.

### 0.3 Qué falta de cada historia según su «terminado cuando» (backlog-mvp §5)

| Historia | Terminado cuando | Antes del cierre | Después del cierre |
|---|---|---|---|
| CON-8 | «Igual que CON-3 para un canal de prueba» | Código completo, fuera de main | En main, **apagado** sin `GOOGLE_CLIENT_*`, con el callback completo probado sobre respuestas grabadas. Lo único que falta es la prueba en vivo con un canal: **bloqueada** por la credencial (Nicolás) y, para creadores reales, por la verificación de Google (CON-9, Rasheed) |
| CON-12 | «Agregar un @ de TikTok deja seguidores y vistas sin subir nada» | Código completo, fuera de main, y con la costura del recolector rota (§1.3) | En main, **apagado** sin `ENSEMBLEDATA_TOKEN`, probado de punta a punta en el arnés. **Hecho**; la decisión de contratar sigue pendiente (§4) |
| CON-5 / CON-10 | Lectura real de Instagram y YouTube por @ | En main, sin credenciales en Vercel | Igual: el código no cambia. La tabla de encendido dice qué poner y cómo comprobarlo |
| CON-7 | «Con la respuesta grabada, la tabla coincide con el fixture; una cuenta personal de TikTok explica por qué no hay demografía» | En main; bloqueada solo por la prueba en vivo | Igual, con el ensayo escrito (§3) y probado en el arnés |

### 0.4 El plan que se siguió

1. F0: rescatar CON-8 y publicarla (hecho, §0.2).
2. F1: `git merge --no-ff` de CON-8 y luego de CON-12, `pnpm verificar`
   en verde después de cada uno (§1).
3. Costuras: la cuenta de TikTok leída por oEmbed y por el proveedor sin
   duplicar (§1.3); las rutas de una red apagada sin 500 (§1.4); la
   pantalla sin botones de fuentes apagadas, **después de traer CON-B**
   (§1.5).
4. Tabla de encendido (§2), ensayo de CON-7 (§3), decisiones (§4).
5. Verificación, revisión y producción (§6 y §7).

---

## 1. Integración (F1) y costuras

### 1.1 Merge de CON-8 (`e8a60fb`)

Cinco conflictos, todos de convivencia, resueltos a favor de main con lo
de la rama encima: los mensajes de error del callback (`sin_permiso` de
ACC-8 + `sin_canal` de CON-8), la preparación de la prueba de handlers
(la de main, con el rol a medida de ACC-8), el import del worker
(`ConnectorHttpOverrides` de CON-5 + `createYouTubeRefresher`), la tabla
de variables del README del worker y la nota del tablero.

`pnpm verificar` después: raíz 8, core 267, connectors 218, db 814,
worker 121, web 1170 + 1 todo. 15/15 tareas.

### 1.2 Merge de CON-12 (`f29ebef`)

Dos conflictos: `conexiones/page.tsx` (el `Autorizar()` genérico de CON-8
absorbe lo de CON-12: una fila `aggregator` dice «Por proveedor de datos»
y sigue ofreciendo autorizar) y `quota/limits.ts` (conviven las familias
`ensembledata` y `google-oauth`).

`pnpm verificar` después: raíz 8, core 267, connectors 234, db 818,
worker 122, web 1174 + 1 todo. 15/15 tareas.

### 1.3 Costura CON-12 ↔ CON-5: la cuenta por proveedor también lista sus videos (`205b5bd`)

Al juntar las dos ramas apareció un fallo que ninguna de las dos veía
sola: `collect.account_metrics` convierte la fila de TikTok a
`access_mode = 'aggregator'` en cuanto hay `ENSEMBLEDATA_TOKEN`, pero
`selectCollectableAccounts` (CON-5) solo elegía `public_profile` y
`direct_oauth`. Desde la primera conversión, esa cuenta **nunca más**
habría listado un video. Arreglo: `'aggregator'` entra al `SELECT`.

Prueba, `apps/worker/test/fuentes-tiktok-proveedor.test.ts`: la misma
cuenta leída por oEmbed → por el proveedor → otra vez por el proveedor →
sin él → de nuevo con él, sobre la misma base. En todo el ciclo: una sola
fila de conexión, tres posts, ninguno de otra conexión, y un solo
snapshot de cuenta por día y fuente. Sin el arreglo fallan dos de sus
tres casos (comprobado).

La demografía no tenía el mismo fallo: `collect.demographics` elige
cualquier conexión viva, y una `aggregator` no está autorizada, así que
queda con el hueco `tt.audience.auth` (`owner_authorization`), que es lo
correcto.

### 1.4 Una red apagada no tiene rutas OAuth vivas (`b22c3a5`)

Sin `GOOGLE_CLIENT_ID` o `GOOGLE_CLIENT_SECRET`, `/conexiones/oauth/
youtube/start` respondía 503, y el callback, 400 hablando de «el inicio
de la conexión» (o, con cookie válida, una redirección a
`?error=no_configurada`). Ahora, para **cualquier** proveedor sin app en
el entorno, `start` y `callback` responden **404** con «YouTube no está
configurado en este entorno: faltan GOOGLE_CLIENT_ID,
GOOGLE_CLIENT_SECRET. Vuelve a /conexiones.», antes de leer la cookie,
llamar a Google o tocar la base; el callback borra la cookie igual.
Nombra las variables, nunca sus valores.

Prueba: `oauth-handlers.test.ts`, bloque «CON-8 apagado» (start y tres
formas de callback: 404, la frase, cero llamadas, cero filas; TikTok
sigue arrancando), y el caso de `tiktok-business` pasa de 503 a 404.

No hay ruta `/api/oauth/*`: las de OAuth viven en
`/conexiones/oauth/[platform]/{start,callback}` desde CON-3. El
`.env.example` sigue diciendo `/api/oauth/google/callback`, que no
existe (§5).

### 1.5 La pantalla no ofrece fuentes apagadas (merge de CON-B)

CON-B (CON-4) entró a main a mitad de este cierre y reescribió
`/conexiones` en `tabla.tsx`, `conectar.tsx` y `_lib/estado.ts`. El merge
de `origin/main` se quedó con su `page.tsx` entero y reaplicó encima lo
de CON-8 y CON-12:

- **«Conectar»**: YouTube entra a `REDES_CONECTABLES`. Una red **sin sus
  variables ya no tiene botón**, ni deshabilitado: en su lugar, una frase
  («YouTube todavía no se puede conectar desde aquí: faltan
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.»). Antes CON-4 mostraba el
  botón deshabilitado con el motivo.
- **En la fila**: «Autorizar cifras» (TikTok) se generaliza a
  `Autorizar()`, que en YouTube dice «Autorizar analítica»; aparece solo
  con la app configurada, también en filas por proveedor.
- **`aggregator`** se relee con «Actualizar» (`relectura: true`), porque
  `cuentas-service.actualizar` lo lee con su fuente.
- **`proveedorDe('youtube')`** es `'youtube'`: un canal autorizado cuyo
  permiso vence ofrece «Reautorizar».

Pruebas: `pagina.test.tsx` (sin `GOOGLE_CLIENT_*`, ni «Conectar YouTube»
ni la ruta en el HTML, y sí la frase), `tabla.test.tsx` (YouTube con y
sin app, fila por proveedor) y `_lib/estado.test.ts`.

### 1.6 Lo que encontró la revisión, y cómo quedó (`862aefd`)

`/code-review` en nivel alto sobre `origin/main...nicolas/CON-C-fuentes`
dio diez hallazgos. Todos se comprobaron contra el código antes de
tocarlo; siete se arreglaron con su prueba y tres se justifican (§6.2).
Los que cambian cómo se enciende una fuente:

- **Las vistas de cuenta son las del día.** `account_metric_snapshot.
  views` se llena así en la semilla y Resumen la suma día por día
  (`resumen.ts`, CTE `vistas`). YouTube por @ (CON-10, ya en main),
  YouTube autorizado y el proveedor de TikTok guardaban el **acumulado**:
  el día que se encendiera cualquiera de las tres, Resumen contaría el
  total de la cuenta una vez por cada día de la ventana. Ahora las tres
  guardan `null` (el acumulado de YouTube sigue en `raw`) y las vistas
  llegan video por video. Guardar el acumulado aparte es **D20** (§4).
- **Autorizar un canal de YouTube ya no le congela los suscriptores.**
  El worker y «Actualizar» leen `channels.list?mine=true` con su token.
- **El proveedor cuesta mucho menos.** La lectura de cuenta ya no
  recorre el catálogo (1 unidad en vez de hasta 21) y la lista de posts
  pide solo los bloques que faltan para el `max` de quien pregunta.
- **Una cuenta autorizada a mitad de una corrida no se degrada** a
  `aggregator`, y un 401 del proveedor no le pide al creador que
  reautorice algo que nunca autorizó.

---

## 2. Tabla de ENCENDIDO (F2)

Cada fila es una fuente. **La variable es el interruptor**: no hay
bandera que encender en `content/flags.ts`, ni migración, ni despliegue
de código nuevo. Sí hace falta **redesplegar** (o `vercel redeploy`)
para que la web lea una variable nueva, y ponerla **también en el
entorno del worker** para que los jobs la usen.

Todas se guardan sin pegarlas a mano (con la credencial copiada):

```bash
pbpaste | tr -d '\r\n' | ./scripts/vercel.sh run env add <VARIABLE> production --sensitive --force
```

desde `rayit-deploy/platform`, y lo mismo con `preview` si se quieren
probar en vistas previas.

**Las consultas de comprobación** son de solo lectura y entran como
`mc_app`, así que fijan el workspace para pasar RLS. En producción hay
uno solo, el de la demo (`00000002-0000-4000-8000-000000000001`, slug
`laura-cocina-facil`), que tiene @selvathegolden y cuatro filas
**sembradas** (instagram, tiktok, youtube y facebook de «Laura»): esas
cuatro no son cuentas reales y no sirven para comprobar nada. Plantilla:

```bash
cd /Users/nicolasduarte/Documents/influ/rayit-deploy/platform
make db.sql Q="with ws as (select set_config('app.workspace_id','00000002-0000-4000-8000-000000000001',true)) <SELECT> "
```

| | **Instagram por @** (CON-10, CON-5) | **YouTube por @** (CON-10, CON-5) | **YouTube autorizado** (CON-8) | **TikTok por proveedor** (CON-12, opcional) |
|---|---|---|---|---|
| **Variable(s)** | `INSTAGRAM_HOUSE_TOKEN` | `GOOGLE_API_KEY` | `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` (las dos). Opcional `GOOGLE_REDIRECT_URI` (si no, `APP_URL` + `/conexiones/oauth/youtube/callback`); opcional en el worker `OAUTH_REFRESH_MARGIN_MINUTES_YOUTUBE` (30) | `ENSEMBLEDATA_TOKEN`. Opcionales: `ENSEMBLEDATA_MAX_POSTS` (200), `ENSEMBLEDATA_DAILY_UNITS` (sin tope; poner 1500 con Wood) |
| **Dónde se obtiene** | `docs/propuestas/CON-10.md` §3: app de Meta tipo Negocios → producto Instagram → «API setup with Instagram business login» → Generate access tokens → Add account (la cuenta profesional de On Cue) → Generate token. Vale 60 días; se repite | `CON-10.md` §3: Google Cloud → proyecto «On Cue» → Biblioteca → YouTube Data API v3 → Habilitar → Credenciales → Clave de API, restringida a esa API | `CON-8.md` §2: el mismo proyecto → habilitar también **YouTube Analytics API** → pantalla de consentimiento *External* → scopes `youtube.readonly` y `yt-analytics.readonly` → usuarios de prueba → Credenciales → ID de cliente OAuth «Aplicación web» con la URI `https://on-cue-web.vercel.app/conexiones/oauth/youtube/callback` exacta | `CON-12.md` §0.2: contratar el plan en ensembledata.com/pricing (recomendado Wood) → el token sale del panel |
| **Trámite de plataforma (CON-9, Rasheed)** | Ninguno | Ninguno | **Verificación de la pantalla de consentimiento de Google** (los dos scopes son *sensibles*). Sin ella la app queda en «Testing»: solo autorizan los correos de la lista de usuarios de prueba (máx. 100) y su refresh token vence a los **7 días** | Ninguno (es un contrato con el proveedor) |
| **Qué se enciende en la pantalla** | `/conexiones`: la tarjeta de Instagram deja de decir que falta la variable; «Agregar cuenta» de un @ profesional deja seguidores, publicaciones y «datos hasta»; «Actualizar» en su fila lee de inmediato | Igual para YouTube: suscriptores, videos y vistas del canal | En la fila de un canal de YouTube, columna «Cifras»: aparece **«Autorizar analítica»** (ya está `OAUTH_CONNECT=1` en producción). Sin las variables, la fila no ofrece el botón y dice qué falta (§1.5) | La tarjeta de TikTok pasa a «Seguidores, vistas acumuladas y número de videos, por el proveedor de datos contratado»; la fila de @selvathegolden no cambia porque ya está autorizada (§2.1) |
| **Qué job empieza a leer** | `collect.account_metrics` (05:10 UTC), `collect.posts` (cada 6 h), `collect.post_metrics` (05:00) y `brand.snapshot` (07:00, seguidores de las marcas en campaña, CAM-3). **Solo cuando el worker corra (WRK)**; hasta entonces, lo que la web lee al agregar o con «Actualizar» | Los mismos cuatro | `oauth.refresh` (cada 15 min: renueva el access token de una hora) y `collect.demographics` (05:20) para ese canal. Con el worker apagado, el token caduca a la hora y la analítica no se lee | `collect.account_metrics` (convierte la fila a `aggregator` conservando id e historia), `collect.posts` y `collect.post_metrics` para TikTok |
| **Cómo compruebo que funcionó** (solo lectura) | `select c.handle, c.status, c.status_detail, s.day::text, s.followers, s.source from ws, social_connection c left join account_metric_snapshot s on s.connection_id = c.id where c.platform_id = 'instagram' and c.access_mode = 'public_profile' order by s.day desc nulls last` → una fila con `followers` y `source = 'public_profile'`, `status = 'active'`. Y `select l.endpoint, l.ok, l.http_status from ws, api_call_log l join social_connection c on c.id = l.connection_id where l.endpoint = 'instagram.business_discovery' order by l.called_at desc limit 3` → `ok = true` | La misma con `platform_id = 'youtube'` y `l.endpoint = 'youtube.channels.list'` | `select c.handle, c.access_mode, c.status, c.scopes, c.secret_ref like 'enc:youtube:%' as cifrada, to_char(c.access_expires_at at time zone 'UTC','YYYY-MM-DD HH24:MI') as vence, c.refresh_expires_at from ws, social_connection c where c.platform_id = 'youtube' and c.handle <> 'LauraCocinaFacil'` → `direct_oauth`, `active`, los dos scopes, `cifrada = true`, vence en ~1 h, `refresh_expires_at` nulo. Consentimiento: `select d.purpose, d.policy_version from ws, data_consent d join social_connection c on c.id = d.connection_id where c.platform_id = 'youtube' and d.revoked_at is null` → `analytics` y `audience_demographics` | `select c.handle, c.access_mode, s.day::text, s.followers, s.views, s.source from ws, social_connection c join account_metric_snapshot s on s.connection_id = c.id where c.platform_id = 'tiktok' and s.source = 'aggregator'` → seguidores y vistas. Consumo: `select day::text, units_used, calls from api_quota_usage where platform_id = 'tiktok' order by day desc limit 7` |
| **Costo** | Gratis. Límite de Meta: 200 llamadas/hora por usuario de la app; con **un** token casa, todo `business_discovery` comparte ese cupo (§4, D3) | Gratis. **10 000 unidades/día** por proyecto; `channels.list` y `videos.list` cuestan 1; `collect.post_metrics` guarda 500 de reserva (`COLLECT_YOUTUBE_UNITS_RESERVE`) | Gratis. El endpoint de token no gasta unidades de la Data API (familia propia `google-oauth`); la Analytics API tiene cuota aparte que Google no publica | **Wood, 100 USD/mes = 1 500 unidades/día.** Por cuenta y día, tras la revisión: 1 (perfil) + 4 × 3 (`collect.posts` cada 6 h, 25 posts = 3 bloques, aunque no haya nada nuevo) + ≥ 5 (`collect.post_metrics`, primer tramo de 50) ≈ **18 unidades** → unas **80 cuentas** en Wood, ~1,20 USD/cuenta/mes. Con `collect.posts` una vez al día serían ~9 (D21). Bronze 200 USD = 5 000/día. Cada «Agregar» o «Actualizar» en la pantalla gasta 1 más |

### 2.1 Cosas que pasan al encender y conviene saber

- **La variable llega a la web con el siguiente despliegue.** Vercel
  congela el entorno en cada build. `./scripts/vercel.sh run redeploy
  <url de producción> --prod` (o el próximo despliegue desde main)
  basta.
- **El worker tiene su propio entorno.** WRK eligió `--once` desde
  GitHub Actions (`docs/propuestas/WRK.md` §3 y §5,
  `.github/workflows/worker-once.yml`): cada variable de esta tabla va
  **también** como secreto del repositorio (Settings → Secrets →
  Actions) con el mismo nombre. El workflow ya las pasa todas desde este
  cierre —faltaban `GOOGLE_CLIENT_*` y `ENSEMBLEDATA_TOKEN`— y
  `apps/worker/test/workflow-fuentes.test.ts` falla si alguna se cae.
  Una variable solo en Vercel enciende lo que hace la web (agregar,
  «Actualizar», autorizar) y nada de lo diario.
- **`INSTAGRAM_HOUSE_TOKEN` caduca a los 60 días.** El día que vence, la
  fila de cada cuenta de Instagram por @ dice «La credencial de Instagram
  de On Cue venció» y ninguna cifra nueva entra. La renovación automática
  del token casa es una historia aparte (CON-10 §4).
- **YouTube en «Testing»: el refresh token dura 7 días.** A los siete
  días Google responde `invalid_grant` y `oauth.refresh` pasa la
  conexión a `needs_reauth`, con su aviso. No es un fallo del código:
  termina cuando CON-9 consiga la verificación.
- **La fila sembrada `LauraCocinaFacil` (YouTube) ya es `direct_oauth`
  con un token de mentira.** Cuando el worker corra con `GOOGLE_CLIENT_*`,
  `oauth.refresh` intentará renovarla y la dejará en `needs_reauth`. Es
  la conducta correcta con una credencial inválida; si molesta en la
  demo, hay que quitar esa fila del seed de producción (WRK).
- **TikTok de @selvathegolden no cambia con el proveedor**: está
  `direct_oauth` (autorizada con «Autorizar cifras» el 23-sep) y el
  proveedor solo lee cuentas por @. Para ver el proveedor en producción
  hay que agregar el @ de otra cuenta de TikTok.

---

## 3. CON-7 en vivo: el ensayo (F3)

**Por qué hoy no se puede.** Con los permisos de hoy ninguna conexión
real tiene insights: @selvathegolden (TikTok) se autorizó con Login Kit
(`user.info.*`, sin `user.insights`, que es de la Accounts API de
negocio, CON-9); Instagram Login está fuera del MVP; y YouTube autorizado
espera a CON-8. En Supabase, `metric_gap` está vacía porque el worker
nunca corrió.

**El camino más corto a una prueba real es YouTube con CON-8**, porque
no necesita trámite para una cuenta de prueba: Google deja autorizar a
los correos de la lista de usuarios de prueba aunque la app esté en
«Testing».

### 3.1 El ensayo, paso a paso

| Paso | Qué | Quién |
|---|---|---|
| 1 | `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` en Vercel (production) y en el worker; YouTube Analytics API habilitada en el proyecto; el correo del canal de prueba en «Usuarios de prueba» (§2, columna CON-8) | Nicolás |
| 2 | El worker corriendo en producción con `TOKEN_REFRESHER=real` (WRK) | Rasheed / WRK |
| 3 | **Cuenta**: un canal de YouTube cuyo correo esté en la lista de prueba (el de Nicolás, p. ej. @nicolasduartea si tiene canal). En `/conexiones` → «Agregar cuenta» → YouTube → el @ del canal. Si `GOOGLE_API_KEY` ya está, la fila nace con suscriptores; si no, igual nace | Nicolás |
| 4 | **Antes de autorizar**, correr `collect.demographics` una vez (o esperar a las 05:20 UTC). Debe aparecer la fila de hueco:<br>`select g.requirement_id, r.message_es from ws, metric_gap g join metric_requirement r on r.id = g.requirement_id join social_connection c on c.id = g.connection_id where c.platform_id = 'youtube' and c.handle = '<HANDLE>'`<br>→ `yt.demographics.auth` · «La audiencia de un canal solo sale de YouTube Analytics, y eso exige el permiso del dueño…» | Worker |
| 5 | **Permiso**: en la fila del canal, «Autorizar analítica» → aceptar el consentimiento → Google pide la cuenta y muestra `youtube.readonly` y `yt-analytics.readonly` → vuelve a `/conexiones?conectada=<id>`. La **misma** fila pasa a `direct_oauth` con los dos scopes (consulta de la columna CON-8 del §2) | Nicolás |
| 6 | **Job**: `collect.demographics` otra vez. Hace dos llamadas (`youtube.analytics.query`: edad×género y país, ventana de los 28 días que terminan ayer) | Worker |
| 7 | **Fila que tiene que aparecer** en `audience_breakdown`:<br>`select a.day::text, a.population, a.dimension, count(*) from ws, audience_breakdown a join social_connection c on c.id = a.connection_id where a.scope = 'account' and c.platform_id = 'youtube' and c.handle = '<HANDLE>' group by 1, 2, 3`<br>→ `population = 'viewers'`, dimensiones `age_gender` y `country`, `share` como vino de Google (puede no sumar 1) y `absolute` nulo | — |
| 8 | **Fila que tiene que desaparecer**: la consulta del paso 4 devuelve **cero filas** | — |
| 9 | Una segunda corrida el mismo día no escribe nada ni llama (`job_run.metadata->'alreadyToday'` trae el id) | — |

Si el canal es nuevo o tiene muy poco tráfico, Analytics devuelve la
tabla vacía: el job lo anota en `job_run.metadata->'empty'`, no guarda
nada y el hueco **no** se borra. En ese caso hay que usar un canal con vistas en los últimos 28
días.

### 3.2 La prueba en el arnés

`apps/worker/test/con7-ensayo-en-vivo.test.ts` hace exactamente los
pasos 4 a 9 sobre la misma conexión con respuestas grabadas: hueco
`yt.demographics.auth` con su frase y cero llamadas; la fila pasa a
`direct_oauth` con el mismo `UPDATE` de `upgradePublicAccountToOAuth`;
dos llamadas a `/v2/reports`; 11 filas (8 de edad×género y 3 de país);
el hueco desaparece; la tercera corrida no llama. Que el callback de
Google deja la fila así lo prueba `oauth-handlers.test.ts` (callback
completo de YouTube, CON-8).

---

## 4. Decisiones pendientes de Nicolás (F4)

En todas quedó en el código la opción conservadora. «Si dices lo
contrario» dice qué archivo cambia y cuánto.

| # | Dónde | La pregunta | Lo que quedó | Recomiendo | Si dices lo contrario |
|---|---|---|---|---|---|
| D1 | `docs/propuestas/CON-1.md:161` | Límite por cuenta en TikTok Display (40/min por conexión y endpoint, de `arquitectura.md`) además del de la app (600/min) | Los dos | Dejarlo: no estorba y protege si TikTok cuenta por usuario | `packages/connectors/src/quota/limits.ts`, borrar una línea de la familia `tiktok` |
| D2 | `CON-1.md:167` | Instagram: 200 llamadas/hora por conexión | 200/hora por conexión, BUC por código de error | Cambiar a **por token casa** cuando entre `INSTAGRAM_HOUSE_TOKEN` (ver D3) | `limits.ts`, una línea (`scope: 'app'`) |
| D3 | `CON-1.md:167` (riesgo nuevo, del cierre) | Con un solo token casa, todas las lecturas por @ de Instagram comparten el cupo de 200/hora de **un** usuario, pero el freno cuenta 200 por cada conexión | Freno por conexión: con muchas cuentas por @ en una misma corrida, el cupo real de Meta se acaba antes que el nuestro; Meta responde `code 4`/`17`/`32`, que `http/errors.ts` clasifica como cuota y se reintenta más tarde (no se pierde nada, pero se atrasa) | Añadir un freno de app de 180/hora a las llamadas `business_discovery*` | `limits.ts` + su prueba en `limits.test.ts`, ~20 líneas |
| D4 | `CON-1.md:172` | Cuota de YouTube Analytics sin número | Sin tope, registrada en `youtube-analytics` | Leer el número en Google Cloud cuando esté el proyecto y ponerlo | `limits.ts`, un número |
| D5 | `CON-3.md:206` | Margen de renovación de Instagram (7 días antes de vencer) | 7 días | Dejarlo | Variable `OAUTH_REFRESH_MARGIN_MINUTES_INSTAGRAM` en el worker, sin código |
| D6 | `CON-3.md:241` | Borrar el ciphertext al desconectar | Sí | Dejarlo | `packages/db/src/queries/conexiones.ts` `disconnectConnection`, quitar un `DELETE` |
| D7 | `CON-3.md:244` | Una fila de `api_call_log` por intento HTTP del refresher, o una por job | Una por job | Dejarlo | `apps/worker/src/index.ts`, cambiar el sink nulo por `PostgresCallLogSink(db)` y quitar `logApiCall` del job, ~10 líneas |
| D8 | `CON-5.md:123` y `:240` | Fusionar posts entre una conexión de CSV y una por @ | No se fusiona entre conexiones | Dejarlo hasta que el CSV sirva para Instagram o YouTube | Historia aparte: unificar la conexión, no el post |
| D9 | `CON-7.md:160` | `metric_gap` como tabla (0039) en vez de `status_detail` | Tabla, ya aplicada | Dejarlo | — (ya en Supabase) |
| D10 | `CON-7.md:190` | Una cuenta personal de TikTok queda con `tt.audience.account_type` / `tt.audience.scope` y no con `tt.insights.scope` / `tt.audience_age` del enunciado | Las dos filas propias | Dejarlo: la del enunciado manda a una puerta que no abre | `apps/worker/src/jobs/conexiones/prerrequisitos-demografia.ts`, dos `return` |
| D11 | `CON-10.md:56` | Fuente de TikTok por @: proveedor de pago, CSV o esperar la autorización | CSV de TikTok Studio (RES-2) y autorización; el proveedor, integrado y apagado | Ver D12 | — |
| D12 | `CON-12.md:94` | **Contratar EnsembleData** | Apagado sin `ENSEMBLEDATA_TOKEN` | **No contratar todavía**: @selvathegolden ya da cifras autorizando gratis y el CSV cubre el resto. Contratar Wood (100 USD/mes) el día que haya más de ~5 cuentas de TikTok que no puedan autorizar | Solo la variable (§2) |
| D13 | `CON-12.md:153` | Tope de 200 videos por cuenta. Tras la revisión ya no se recorre en cada lectura de cuenta: solo acota cuánto relee `collect.post_metrics` para emparejar | 200 | Dejarlo; revisar con el consumo real de `api_quota_usage` | Variable `ENSEMBLEDATA_MAX_POSTS` |
| D14 | `CON-12.md:185` | Ventana de 60 llamadas/min al proveedor (nuestra, no suya) | 60/min | Dejarlo | `limits.ts`, un número |
| D15 | `CON-8.md:142` (§0.4) | `prompt=consent` en cada autorización de Google | Siempre | Dejarlo: sin él reconectar da una conexión que muere en una hora | `packages/connectors/src/oauth/google.ts`, una constante + mirar la base antes de construir la URL, ~30 líneas |
| D16 | `CON-8.md` §0.4 | Sin `yt-analytics-monetary.readonly` | Fuera | Dejarlo: más auditoría de Google por datos que no mostramos | `google.ts`, un scope, y otra vuelta de verificación (CON-9) |
| D17 | `CON-8.md` §0.4 | `refresh_expires_at` vacío en YouTube (en «Testing» vence a los 7 días) | Vacío; se aprende por `invalid_grant` | Dejarlo | `google.ts` + una variable, ~10 líneas |
| D18 | `connectors/src/quota/limits.ts` (familia `google-oauth`) | Freno de 600/min al endpoint de token de Google | 600/min | Dejarlo | `limits.ts`, un número |
| D19 | Este cierre, §1.4 | Una red apagada responde 404 (antes 503) | 404 con la frase | Dejarlo (lo pide el prompt: nada de 5xx en rutas vivas) | `oauth-handlers.ts`, dos líneas |
| D20 | Este cierre, §1.6 | ¿Dónde vive el acumulado de vistas de una cuenta (YouTube lo publica; TikTok por proveedor se podría sumar)? `account_metric_snapshot.views` es la vista del día | En ninguna columna: `views` = null para esas fuentes; el de YouTube queda en `raw` | Una migración que añada `account_metric_snapshot.views_total` (acumulado) y que las vistas del día salgan de la diferencia entre dos días en una vista SQL. Es de Rasheed (esquema y Resumen) | `db/migrations/00xx` (~15 líneas) + `recordAccountSnapshot` y el INSERT del worker (~10) + la CTE `vistas` de `resumen.ts` si se quiere mostrar |
| D21 | Este cierre, §2 | `collect.posts` corre cada 6 h también para las cuentas por proveedor, y cada corrida paga al menos 3 unidades aunque no haya nada nuevo | Cada 6 h, como las demás | Dejarlo mientras no se contrate; si se contrata, una vez al día para `aggregator` (de ~18 a ~9 unidades por cuenta) | `apps/worker/src/jobs/conexiones/collect-posts.ts`, saltar las `aggregator` fuera de la corrida de las 00:00, ~10 líneas y su prueba |

Las decisiones de CON-6 (mediana por red, a quién avisar, videos viejos)
están en `CIERRE-CON-A.md` §6 y no se repiten.

---

## 5. Lo que necesita Rasheed

1. **CON-9 · verificación de Google** para `youtube.readonly` y
   `yt-analytics.readonly` (sensibles). Sin ella, CON-8 funciona solo
   para los usuarios de prueba y 7 días. Número de caso a
   `docs/tramites.md`.
2. **Entorno del worker (CIM-7 / WRK)**: las mismas variables de §2
   como secretos del workflow `worker-once` cuando Nicolás las meta en
   Vercel: `INSTAGRAM_HOUSE_TOKEN`, `GOOGLE_API_KEY`, `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET` y, si se contrata, `ENSEMBLEDATA_TOKEN`. El
   workflow ya las lee.
3. **`.env.example`** (compartido): faltan `INSTAGRAM_HOUSE_TOKEN`,
   `GOOGLE_API_KEY`, `ENSEMBLEDATA_TOKEN`, `ENSEMBLEDATA_MAX_POSTS` y
   `ENSEMBLEDATA_DAILY_UNITS`, y las `*_REDIRECT_URI` apuntan a
   `/api/oauth/<red>/callback`, que no existe: la ruta real es
   `/conexiones/oauth/<red>/callback`.
4. Nada en `db/migrations/`, `lib/auth/`, `lib/workspace/` ni
   `packages/db/src/{client,schema}`.

---

## 6. Verificación

PENDIENTE.

## 7. Producción y guion de humo

PENDIENTE.
