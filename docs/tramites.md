# Trámites de plataforma (CON-9)

Los tres trámites que On Cue necesita para leer las cuentas de
creadores reales, con los permisos **exactos que el código pide** (cada
uno con su archivo y línea; si alguien cambia una constante, cambia esta
tabla). Los inicia Rasheed, que tiene las cuentas de empresa; los
números de caso los escribe él en la columna correspondiente.

Estado el 9-oct-2026: **ninguno iniciado**. Los tres comparten el mismo
bloque de preparación (§0), que es lo que hay que tener listo antes de
mandar el primero.

| Trámite | Quién lo inicia | Fecha de inicio | Número de caso | Estado |
|---|---|---|---|---|
| TikTok · Accounts API Access Application (§1) | Rasheed | — | — | pendiente |
| TikTok · App Review del Login Kit (§1.3) | Rasheed | — | — | pendiente |
| Meta · App Review + Business Verification (§2) | Rasheed | — | — | pendiente |
| Google · verificación de la pantalla de consentimiento, cliente de YouTube (§3.1) | Rasheed | — | — | pendiente |
| Google · verificación con alcance restringido, cliente del outreach (§3.2) | Rasheed | — | — | pendiente |

Cuando un trámite cambie de estado, la fila cambia aquí y la nota de
CON-9 en `platform/apps/web/content/backlog.ts` dice la fecha.

---

## 0. Lo que hay que preparar antes de enviar cualquiera

Lo piden los tres con pequeñas variantes. Una vez, y sirve para todos.

| Qué | Dónde está hoy | Qué falta |
|---|---|---|
| **Política de privacidad y términos** en una URL pública | `https://on-cue-web.vercel.app/legal` (CIM-9: borrador con fecha de versión y aviso «borrador pendiente de revisión legal») | Que un abogado la revise y Rasheed quite el aviso (lista de confirmaciones en `docs/propuestas/CIERRE-CIM-R.md` §2). Meta y Google leen la página: con el aviso visible **pueden rechazar** el trámite por «política provisional». Enviar después de quitarlo |
| **Correo de contacto de datos personales** | `SUPPORT_EMAIL` en Vercel (lo pone Rasheed, guion en `CIERRE-CIM-R.md` §4). Hasta entonces `/legal` dice que se publicará | Fijarlo, y que sea un buzón que alguien lea: los tres portales escriben ahí |
| **URL de la app y del inicio de sesión** | `https://on-cue-web.vercel.app` · `/login` | Nada. **Ojo con Google** (§3.1, riesgo 1): exige que la página de inicio esté en un dominio **propio y verificado** en Search Console; `vercel.app` es un dominio de Vercel, no nuestro. Hace falta decidir el dominio antes de enviar el trámite de Google |
| **Nombre, logo e icono** | «On Cue», la inicial en un cuadrito (`components/marca.tsx`) | Un PNG de 1024×1024 para Meta (icono de la app) y de 120×120 para Google (logo de la pantalla de consentimiento). No existen todavía |
| **Datos de la empresa** | — | Razón social, NIT, certificado de existencia y representación legal (Cámara de Comercio, menos de 30 días para Meta), dirección, teléfono, dominio con correo de empresa. Los pide Business Verification de Meta y la verificación de marca de Google |
| **Cuenta de prueba por red** con instrucciones de acceso | TikTok: @selvathegolden (autorizada el 23-sep), @pataspeludascc por @. Instagram: @nicolasduartea (Instagram Login funcionando en producción desde el 5-oct), @oncue__ como cuenta casa. YouTube: ninguna real | Un canal de YouTube de prueba en la lista de usuarios de prueba del proyecto de Google; y las instrucciones escritas: «Entrar en /login con el correo X, ir a Conexiones, pulsar…» |
| **Video de demostración** (§0.1) | No existe | Grabarlo |
| **Variables en producción** | `OAUTH_CONNECT=1`, `TIKTOK_LOGIN_CLIENT_KEY/SECRET`, `META_APP_ID/SECRET`, `INSTAGRAM_HOUSE_TOKEN`, `GOOGLE_API_KEY`, `GOOGLE_OUTREACH_CLIENT_ID/SECRET` | `GOOGLE_CLIENT_ID/SECRET` (CON-8, Nicolás) y `TIKTOK_BUSINESS_APP_ID/SECRET` (salen del trámite §1). Sin ellas el revisor de Google no puede probar «Conectar YouTube»: la pantalla dice que falta la variable |

### 0.1 Qué grabar (un video por red, 2–4 minutos, sin cortes, con la URL visible)

Los tres portales piden lo mismo: ver el permiso **usarse** de punta a
punta, desde la pantalla donde la persona lo concede hasta la pantalla
donde se ve el dato que ese permiso trae. Un video por red; el de
Google en YouTube como «no listado» (lo exige así); los de Meta y TikTok
se suben al formulario.

1. `https://on-cue-web.vercel.app/login` → correo → «Revisa tu correo»
   → abrir el enlace → `/auth/confirm` → «Entrar a On Cue».
2. Conexiones → «Conectar <red>». Dejar a la vista el texto del
   consentimiento de On Cue (el diálogo de `consentText`,
   `app/(app)/conexiones/_lib/consent.ts`) **y** la pantalla de permisos
   de la plataforma con cada permiso visible. No acelerar ese tramo:
   es lo que el revisor comprueba.
3. Volver a `/conexiones` con la fila `active`, y abrir Resumen: las
   cifras que ese permiso trae (seguidores, publicaciones, vistas; con
   `*_insights`, alcance y demografía).
4. «Desconectar» en la fila: el revisor de Meta quiere ver cómo se
   revoca desde la app.
5. Solo para Google (§3.2): en Ventas → Canales, «Conectar correo»,
   la pantalla de permisos de Google con `gmail.send` y `gmail.modify`,
   y después un envío y una respuesta leída en la bandeja.

Para el camino **por @** de Instagram (`business_discovery`, §2.2) se
graba aparte: Conexiones → «Agregar cuenta» → un @ profesional público →
la fila con seguidores y «datos hasta».

---

## 1. TikTok

Dos apps distintas en dos portales; el código ya distingue las dos
(`packages/connectors/src/oauth/config.ts:21-22`).

### 1.1 Lo que el código pide

| App | Portal | Scopes exactos (en el código) | Variables | Redirect URI a registrar |
|---|---|---|---|---|
| Login Kit (la que hoy está en producción) | developers.tiktok.com | `user.info.basic`, `user.info.profile`, `user.info.stats`, `video.list` — `packages/connectors/src/oauth/tiktok-login.ts:33` | `TIKTOK_LOGIN_CLIENT_KEY`, `TIKTOK_LOGIN_CLIENT_SECRET` (en Vercel) | `https://on-cue-web.vercel.app/conexiones/oauth/tiktok/callback` (https obligatorio; `localhost` no vale) |
| Accounts API (business-api.tiktok.com; la que trae alcance, retención y demografía) | business-api.tiktok.com → TikTok for Business | `user.info.basic`, `user.info.username`, `user.info.stats`, `user.insights`, `video.list`, `video.insights` — `packages/connectors/src/oauth/tiktok-business.ts:34` | `TIKTOK_BUSINESS_APP_ID`, `TIKTOK_BUSINESS_APP_SECRET` (NO están en Vercel: salen de este trámite) | `https://on-cue-web.vercel.app/conexiones/oauth/tiktok-business/callback` |

Qué se hace con cada scope (para el formulario, en sus palabras):
`user.info.*` → el @, el nombre y las cifras de la cuenta en la fila de
Conexiones y en Resumen; `video.list` → la lista de publicaciones y sus
métricas públicas (`collect.posts`, `collect.post_metrics`);
`user.insights` y `video.insights` → alcance, retención y demografía
de la audiencia (CON-7, `collect.demographics`), que es la finalidad
`audience_demographics` del consentimiento
(`app/(app)/conexiones/_lib/consent.ts:113-120`). On Cue **no publica**
en nombre del creador: no se pide `video.publish` ni `video.upload`.

### 1.2 Accounts API Access Application Form

- **Qué pide TikTok**: desde el 20-mar-2026 el scope «TikTok Accounts»
  solo se concede llenando el *Accounts API Access Application Form*
  (cabecera de `packages/connectors/src/platforms/tiktok-accounts.ts`).
  Cuenta de TikTok for Business de la empresa, descripción del producto
  y del uso de cada campo, URL de la app, política de privacidad,
  video de demostración. El portal es JavaScript puro y no se pudo leer
  desde aquí: **la lista exacta de campos la confirma Rasheed al abrir
  el formulario** y la copia a esta sección.
- **Qué tenemos**: el cliente completo con respuestas grabadas
  (`tiktok-accounts.ts`, 62 fixtures de CON-1), el callback
  `/conexiones/oauth/tiktok-business/callback` y el refresher.
- **Qué hay que confirmar al tener acceso al portal** (quedó abierto en
  CON-1 §3 y en la cabecera de `tiktok-accounts.ts`): si existen
  `video_view_retention` y `engagement_likes` (la curva de retención y
  los me gusta por segundo) bajo `video.insights`, y los límites por
  segundo para `platform.limits` (`docs/propuestas/CON-1.md` §1).
- **Quién**: Rasheed. **Fecha / caso / estado**: ver la tabla de arriba.

### 1.3 App Review del Login Kit

- **Qué pide TikTok**: la app del 23-sep está en **sandbox** con la
  cuenta de Nicolás como usuario de prueba (hasta 10 por sandbox); para
  que cualquier creador pueda «Autorizar cifras» hay que pasar la app a
  producción con *Submit for review*: nombre, icono, descripción, URL
  de términos y de privacidad, dominio verificado (ya está: archivo de
  firma en `apps/web/public/tiktok*.txt`), y el video que muestre cada
  scope en uso.
- **Qué tenemos**: todo lo anterior salvo el video y el icono.
- **Dueño de la app**: hoy es la cuenta de desarrollador de Nicolás.
  Antes de enviar, decidir si se transfiere a la cuenta de empresa de
  On Cue (si no, la empresa queda sin acceso al portal el día que esa
  cuenta falte).

---

## 2. Meta (Instagram)

Una sola app, **id 2147514119182598**, tipo *Negocios* (Business), en
developers.facebook.com, con dos caminos de acceso que piden permisos
distintos.

### 2.1 Lo que el código pide

| Camino | Permisos exactos (en el código) | Quién los concede | Variables |
|---|---|---|---|
| **Instagram Login** (la creadora autoriza su propia cuenta; producto «Instagram» → *API setup with Instagram business login*) | `instagram_business_basic`, `instagram_business_manage_insights` — `packages/connectors/src/oauth/instagram-login.ts:45` | La creadora, en `instagram.com/oauth/authorize` | `META_APP_ID`, `META_APP_SECRET` (en Vercel). Redirect `https://on-cue-web.vercel.app/conexiones/oauth/instagram/callback` |
| **Cuenta casa por @** (`business_discovery`: seguidores y publicaciones públicas de un @ profesional sin que su dueño autorice; CON-10) | `instagram_basic`, `pages_show_list`, `pages_read_engagement`, `business_management` — token de usuario generado en el Explorador de la API Graph por un **administrador de la app** (`docs/propuestas/CON-10.md` §3, paso 2) | Nadie externo: es un token de la cuenta casa @oncue__, vinculada a una página de Facebook | `INSTAGRAM_HOUSE_TOKEN`, `INSTAGRAM_HOUSE_IG_USER_ID` (en Vercel). Vence cada 60 días |

Qué se hace con cada permiso: `instagram_business_basic` → el @, el
tipo de cuenta, seguidores y la lista de publicaciones con sus métricas
(`instagram.me`, `instagram.media`); `instagram_business_manage_insights`
→ alcance y demografía de la audiencia (`me/insights`, CON-7:
`collect.demographics`). Los cuatro del camino por @ son los que Meta
exige para que `business_discovery` exista (solo está en «Instagram API
with Facebook Login»). On Cue **no publica, no responde comentarios ni
mensajes**: no se piden `instagram_business_content_publish`,
`instagram_business_manage_comments` ni `instagram_business_manage_messages`.

> El enunciado de CON-9 cita `instagram_basic`, `instagram_manage_insights`
> y `business_management`. `instagram_manage_insights` **no aparece en el
> código**: el permiso de insights que pide la app es
> `instagram_business_manage_insights` (Instagram Login), y
> `instagram_basic` y `business_management` solo los usa el token casa.
> Se pide lo que el código pide.

### 2.2 App Review (Advanced Access) y Business Verification

- **Qué pide Meta**. Mientras la app esté en modo desarrollo, los dos
  permisos de Instagram Login solo funcionan para personas con rol en
  la app (administradores, desarrolladores, *Instagram Testers*: así
  entró @nicolasduartea el 5-oct). Para cualquier creadora hace falta
  **Advanced Access** de cada permiso vía App Review, y para eso
  **Business Verification** de la empresa (Meta Business Suite →
  Centro de seguridad → Verificación de la empresa). Por permiso: una
  descripción de para qué se usa, el video (§0.1), instrucciones para
  que el revisor lo reproduzca con una cuenta de prueba, y en la app:
  icono 1024×1024, categoría, URL de la política de privacidad, URL de
  los términos, **Data Deletion Instructions URL** (puede ser una página
  que explique cómo pedir el borrado) y **Deauthorize callback URL**.
- **Qué tenemos**: Instagram Login probado en producción (5-oct,
  commit 90f76503); los dos permisos añadidos a la app; @nicolasduartea
  como Instagram Tester; el texto del consentimiento con la revocación
  explicada; «Desconectar» borra el token (CON-4: `disconnectConnection`
  hace `DELETE` del ciphertext).
- **Qué falta**: la URL de borrado de datos y la de desautorización.
  Hoy no existe un endpoint que reciba la señal de Meta: lo que hay es
  «Desconectar» en la pantalla y el correo de `SUPPORT_EMAIL` para
  pedir el borrado. Para el formulario, la **Data Deletion Instructions
  URL** puede apuntar a `https://on-cue-web.vercel.app/legal#derechos`
  (CIM-9 describe ahí cómo pedir el borrado) y la **Deauthorize callback
  URL** a `https://on-cue-web.vercel.app/conexiones` (lo que CON-3 §2
  dejó dicho). Si Meta exige un endpoint que procese la petición
  firmada (`signed_request`), es una historia nueva en la carpeta de
  Nicolás (Conexiones); se anota en `CIERRE-CIM-R.md` §5.
- **El token casa no necesita App Review** mientras lo genere un
  administrador de la app (es *Standard Access* sobre activos propios).
  Sí se renueva cada 60 días a mano (CON-10 §3, paso 5).
- **Quién**: Rasheed (Business Verification pide documentos de la
  empresa). **Fecha / caso / estado**: tabla de arriba.

---

## 3. Google

Dos clientes OAuth **distintos** en el mismo proyecto de Google Cloud
«On Cue», a propósito (`packages/connectors/src/gmail.ts:29-38`): con un
solo cliente, revocar el correo del outreach mataría la conexión de
YouTube, y la verificación del alcance restringido de Gmail frenaría la
de YouTube. Son **dos trámites**.

### 3.1 Cliente de YouTube (CON-8): verificación de la pantalla de consentimiento

- **Scopes exactos**: `https://www.googleapis.com/auth/youtube.readonly`
  y `https://www.googleapis.com/auth/yt-analytics.readonly` —
  `packages/connectors/src/oauth/google.ts:56-59`. Los dos son
  **sensibles** (no restringidos). No se piden `youtube`,
  `youtube.force-ssl`, `youtubepartner` ni el de ingresos: On Cue solo
  lee.
- **Qué pide Google**: pantalla de consentimiento tipo *External* con
  nombre, logo, correo de soporte, **página de inicio en un dominio
  propio verificado** en Search Console, enlaces a la política de
  privacidad y a los términos **en ese mismo dominio**, dominios
  autorizados; justificación escrita de cada scope; video (no listado
  en YouTube) con el flujo completo. Mientras no esté verificada, el
  proyecto queda en *Testing*: solo los correos de la lista de usuarios
  de prueba (hasta 100) pueden autorizar y su refresh token caduca a
  los **7 días** (`docs/propuestas/CIERRE-CON-C.md` §2). Sin
  verificación no hay YouTube para creadores reales.
- **Qué tenemos**: el flujo completo contra respuestas grabadas y
  apagado en producción (falta `GOOGLE_CLIENT_ID/SECRET`, Nicolás;
  `docs/propuestas/CON-8.md` §2 y §3).
- **Riesgo 1 (decidir antes de enviar)**: la página de inicio hoy es
  `on-cue-web.vercel.app`. Google exige que el dominio de la página de
  inicio sea **propiedad del desarrollador** y verificado como tal; un
  subdominio de `vercel.app` no se puede reclamar como propio. Hace
  falta un dominio de On Cue (p. ej. `oncue.co`) apuntando al proyecto
  de Vercel, con `/legal` servido ahí, **antes** de este trámite. Es
  una decisión de Rasheed (dominio y registrador); el código no cambia
  (`APP_URL` y las redirect URIs de las tres plataformas sí).
- **Y también** habilitar *YouTube Analytics API* en el proyecto (hoy
  solo la Data API, por `GOOGLE_API_KEY`; CON-8 §2, paso 1).
- **Quién**: Rasheed. **Fecha / caso / estado**: tabla de arriba.

### 3.2 Cliente del outreach (VEN-9): alcance restringido de Gmail

- **Scopes exactos**: `https://www.googleapis.com/auth/gmail.send`
  (sensible), `https://www.googleapis.com/auth/gmail.modify`
  (**restringido**) y `https://www.googleapis.com/auth/userinfo.email` —
  `packages/connectors/src/gmail.ts:54-58`. `gmail.modify` se usa para
  leer respuestas y rebotes y marcarlos leídos (`outbound.replies`,
  `outbound.bounces`); no se pide `gmail.readonly` aparte porque
  `modify` lo incluye.
- **Qué pide Google**: todo lo de §3.1 **más**, por el alcance
  restringido, la **evaluación de seguridad CASA** (Tier 2) por un
  laboratorio autorizado, con coste y renovación anual, y una
  declaración de uso limitado (*Limited Use*) en la política de
  privacidad (el borrador de CIM-9 ya trae ese párrafo, a confirmar por
  el abogado). Sin verificación, el cliente queda en *Testing*: solo
  los buzones de prueba pueden conectar su correo, y con el aviso de
  «app no verificada».
- **Qué tenemos**: variables `GOOGLE_OUTREACH_CLIENT_ID/SECRET` en
  Vercel; el canal probado con la sesión real (`docs/ventas-outreach.md`
  §9.3).
- **Decisión previa (Rasheed)**: si el outreach por correo va a abrirse
  a creadores fuera del equipo antes de pagar la CASA, o si se queda en
  *Testing* con los buzones del equipo hasta tener clientes que lo
  justifiquen. En el segundo caso este trámite se pospone y la fila de
  la tabla lo dice.
- **Quién**: Rasheed. **Fecha / caso / estado**: tabla de arriba.

### 3.3 YouTube API Services: cuota (más adelante, no bloquea)

La clave `GOOGLE_API_KEY` (CON-10, canales por @) tiene 10 000 unidades
al día; `channels.list` y `videos.list` cuestan 1 (`CIERRE-CON-C.md` §2,
fila «Costo»). Alcanza para cientos de canales. Cuando no alcance, la
ampliación de cuota pasa por la *YouTube API Services – Audit and Quota
Extension Form*, que pide lo mismo que §3.1 más el cumplimiento de las
políticas de YouTube API Services (entre ellas, no guardar datos de la
API más de 30 días salvo los que el usuario autorizó: CIM-9 lo tiene en
la lista del abogado). No se inicia todavía.

---

## 4. Después de cada respuesta

- **Aprobado**: la fila de la tabla pasa a «aprobado» con la fecha; la
  variable que salga del trámite (`TIKTOK_BUSINESS_APP_ID/SECRET`) la
  mete Rasheed en Vercel y en el vault; redesplegar.
- **Rechazado**: la fila guarda el motivo literal de la plataforma y
  qué se cambió antes de reenviar. Los motivos que más se repiten son
  política de privacidad incompleta (CIM-9), video que no muestra el
  permiso en uso, y dominio de la página de inicio.
- Lo que cada trámite desbloquea en el producto: TikTok Accounts →
  demografía y retención de TikTok (CON-7); Meta → «Conectar Instagram»
  para cualquier creadora (CON-3); Google §3.1 → «Conectar YouTube»
  (CON-8) con demografía (CON-7); Google §3.2 → el correo del outreach
  para creadores fuera del equipo (VEN-9).
