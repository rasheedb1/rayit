# @mc/web · el dashboard

Next.js 15, React 19, Tailwind 4, Geist. Cada ruta muestra el plan de
construcción de su módulo hasta que llega la pantalla real. Resumen
(RES-1, RES-2), Finanzas (FIN-1), Campañas (CAM-1) y Conexiones (CON-3)
ya son reales: leen la base por `@mc/db`.

## Base de datos en local

Con `DATABASE_URL` en el entorno usa ese Postgres (Supabase por el
pooler, o el Docker de `make up`). Sin ella, en desarrollo, levanta un
Postgres embebido en memoria con las migraciones y los seeds: es el
«modo demo» y no necesita nada instalado. En producción sin
`DATABASE_URL` la app falla a propósito.

`make db.unlock` escribe las credenciales en `platform/.env.local`, que
NO es una de las rutas que `next dev` lee por su cuenta (solo mira
`apps/web/.env*`). Por eso el script `dev` de este paquete arranca Next
con `node --env-file-if-exists=../../.env.local`, igual que el worker:
así `make dev` levanta la web y el worker contra LA MISMA base. Si lo
cambias y quitas esa parte, la web vuelve al modo demo sin decirlo más
que en una línea del log:

```
[db] Sin DATABASE_URL: Postgres embebido en memoria con el seed (modo demo).
```

```bash
cd platform
make db.unlock                   # una vez: escribe ../../.env.local
pnpm install
pnpm --filter @mc/web dev --port 3100   # el puerto lo eliges tú
pnpm --filter @mc/web typecheck
pnpm --filter @mc/web lint
pnpm --filter @mc/web build
pnpm --filter @mc/web test        # vitest
```

Desde CIM-3 el workspace sale de la **sesión**, no de una variable.
`DEMO_WORKSPACE_ID` sigue existiendo como atajo de desarrollo y solo se
lee en una copia **sin** llaves de Supabase Auth; con las llaves, sin
sesión se va a `/login` en cualquier ruta (ver «Falla cerrado» abajo).
En una copia sin llaves, en producción y sin esa variable,
`lib/workspace/current.ts` lanza diciendo qué falta; para servir el
workspace del seed a propósito, `ALLOW_SEED_WORKSPACE=1`.

Desplegar: `make vercel.deploy` (vista previa) o `make vercel.deploy
PROD=1` (producción). El token vive en el vault; ver el CLAUDE.md de la
raíz.

## Dónde está cada cosa

```
app/(app)/<modulo>/page.tsx   La ruta de cada módulo. Mientras no hay pantalla
                              muestra el plan; el dueño la reemplaza por la real.
app/(app)/plan/[modulo]/      El plan de construcción de un módulo que YA tiene
                              pantalla. Se enlaza desde su cabecera.
app/(app)/resumen/            Resumen: KPIs, seguidores por red, visualizaciones
                              por red, frescura por conexión e importación por CSV.
app/(app)/finanzas/           Finanzas: lista, factura nueva y detalle.
                              index.ts exporta facturarCampana() para Campañas.
test/fixtures/csv/            Exportaciones de ejemplo del importador (ver su README).
components/ui/                Kit de interfaz compartido (ver su README).
lib/format.ts                 Dinero, fechas y porcentajes. El locale y la zona
                              llegan del workspace; es-CO solo es el valor por defecto.
lib/auth/                     Sesión de Supabase: configuración, cliente de servidor,
                              sincronización de la persona y sus espacios, server
                              actions (cambiar de espacio, salir) y messages.ts.
middleware.ts                 Refresca la sesión y protege todo (app)/.
app/login/                    La entrada: un campo, el CAPTCHA y un botón.
app/auth/callback/            Donde aterriza el enlace del correo.
app/auth/confirm/             El clic que canjea el enlace con token_hash.
app/auth/comprobar/           «Entraste como x@y»: el enlace no se pidió en este navegador.
app/auth/salir/               Cierra una sesión con la identidad en conflicto.
app/(app)/cuenta/             Nombre, correo, espacios y cerrar sesión.
components/workspace-switcher.tsx  El selector de espacio, montado en el marco.
lib/workspace/current.ts      El único sitio que sabe cuál es el workspace.
lib/workspace/cookie.ts       La cookie firmada `mc.workspace`.
lib/workspace/settings.ts     Su moneda, zona horaria y locale (cacheado por petición).
lib/db/index.ts               withWorkspace(fn): la única forma de abrir una transacción.
app/(app)/page.tsx            El plan completo (inicio).
app/(app)/reglas/page.tsx     Reglas para no pisarse, dependencias, decisiones.
content/backlog.ts            Las historias y SU ESTADO. Es lo que cambia.
content/modules.ts            Los módulos, su dueño y sus carpetas.
content/flags.ts              Qué módulos están encendidos.
content/team.ts               Quién es quién.
components/                   Marco, navegación, tema, tarjetas del plan.
lib/backlog.ts                Cálculos sobre el backlog: avance, días, enlaces.
```

## Marcar avance

Cada uno edita **sus** historias en `content/backlog.ts`:

```ts
status: "en_curso",   // pendiente · en_curso · bloqueada · hecho
note: "Rama abierta, falta el test de RLS.",
```

Va en el mismo PR de la historia. Al mergear a `main`, el despliegue
lo publica: es la forma de ver en la URL lo que cada quien va haciendo.

## Autenticación

Supabase Auth con **enlace mágico**: un correo, sin contraseñas. Todo el
flujo corre en el servidor (`@supabase/ssr`), la sesión vive en cookies
httpOnly y `middleware.ts` la refresca en cada petición y manda a
`/login` lo que no sea público (`lib/auth/rutas.ts`).

**Una sola llamada a Supabase Auth por petición.** El middleware tiene
que llamar a `getUser()` para refrescar la sesión; el usuario que
devuelve ya está verificado, así que lo deja en una cabecera interna
(`x-on-cue-sesion`, `lib/auth/sesion-base.ts`) y `getSesion()` la lee en
vez de volver a preguntar. Antes eran dos idas y vueltas a Supabase por
navegación. La cabecera que traiga el navegador se **borra** en todos
los caminos del middleware (`middleware.test.ts` lo prueba con una
falsificada), y `NextResponse.next({ request: { headers } })` sustituye
las cabeceras que ve la aplicación, así que solo puede venir de él.

Lo de «httpOnly» hay que decírselo a `@supabase/ssr`: por defecto
escribe `sb-…-auth-token` **sin** `HttpOnly` y **sin** `Secure`, y
dentro de esa cookie van el access token y el refresh token. Los dos
clientes que la escriben —`lib/auth/supabase.ts` y `middleware.ts`—
pasan el mismo `cookieOptions` desde `lib/auth/cookies.ts`. Hay un
cliente **de navegador** (`lib/auth/supabase-browser.ts`) pero ninguna
pantalla lo usa y, con la cookie httpOnly, no ve la sesión: es a
propósito. Si algún día hace falta la sesión en el navegador, se decide
con él.

**Falla cerrado.** Con las llaves puestas, `lib/workspace/current.ts`
manda a `/login` a cualquier petición sin sesión que intente leer o
escribir, aunque el middleware no la haya mirado (una server action,
un route handler, una ruta pública). `DEMO_WORKSPACE_ID` solo existe en
una copia **sin** llaves. Y si Supabase no contesta (red, 5xx, 429), no
se convierte en «no hay sesión»: el middleware deja pasar la petición
marcada como «sin verificar» —no la manda a `/login`, donde el POST de
una server action se perdería en un 307— y la pantalla cae en su
`error.tsx` con «Reintentar».

### Quién eres, y en qué espacio estás

Son dos cosas distintas y se resuelven por separado:

- **quién eres** sale SIEMPRE del correo que Supabase verificó —con
  `email_confirmed_at`; un usuario sin él no cuenta como sesión, ni en
  el middleware, ni en `getSesion`, ni en el callback—. La
  transacción fija `app.user_email` y la fila de `app_user` se busca con
  `email = current_user_email()` (migración
  `*_sesion_correo_verificado.sql`). Nada que venga del navegador entra
  en esa respuesta. Además la fila guarda `auth_user_id`, el id de la
  cuenta de Supabase Auth que entró con ella la primera vez: si otra
  cuenta llega con el mismo correo (un buzón de empresa reasignado, un
  dominio que caducó), no hereda la fila ni sus espacios; `/login` dice
  «Ese correo ya está ligado a otra cuenta» —con el correo de soporte
  si hay `SUPPORT_EMAIL`, o «entra con otro correo» si no— y el log del
  servidor lo registra. Si la que cae en conflicto es una sesión que ya
  existía, pasa antes por `/auth/salir`, que la cierra de verdad (un
  Server Component no puede borrar cookies) solo si la base confirma el
  conflicto. Las filas que crea el seed nacen sin cuenta y se ligan en el
  primer inicio de sesión.
- **en qué espacio estás** sale de la cookie firmada `mc.workspace`,
  que es una **preferencia**: solo se respeta si ese espacio está en la
  lista que la base devuelve para tu correo. Una cookie falsificada no
  te mete en el espacio de nadie; lo más que puede hacer es elegir
  entre los tuyos.

Pintar una pantalla **no escribe** en la base: el camino de lectura son
dos `SELECT` en una transacción. Lo único que escribe es
`/auth/callback` (alta de `app_user`, `last_seen_at`, y el primer
espacio si no hay ninguno) y las acciones del selector.

### Variables

Las que hacen falta ya están en el vault (`make db.unlock` las escribe
en `platform/.env.local`) y en Vercel:

| Variable | Para qué |
|---|---|
| `SUPABASE_URL` | el cliente de servidor; `next.config.ts` la copia a `NEXT_PUBLIC_SUPABASE_URL` (el `env:` define el valor; para que además llegue al navegador hay que leerlo con acceso estático, y eso lo hace `lib/auth/config.ts`) |
| `SUPABASE_ANON_KEY` | igual, a `NEXT_PUBLIC_SUPABASE_ANON_KEY`. No es un secreto: viaja al navegador por diseño |
| `TOKEN_ENCRYPTION_KEY` | firma la cookie `mc.workspace` (la misma clave maestra que el OAuth de Conexiones, con otra etiqueta). Sin ella todo funciona, pero el espacio elegido no se recuerda y el selector lo dice |
| `APP_URL` | a qué origen vuelve el enlace del correo. En desarrollo y en las vistas previas, sin ella se deduce de las cabeceras de la petición; en **producción** nunca (las manda el cliente): sin `APP_URL` ni `VERCEL_PROJECT_PRODUCTION_URL`, `/login` no manda el enlace y el log dice por qué (`lib/auth/origen.ts`) |
| `SUPPORT_EMAIL` | el correo de contacto que publican `/legal`, el error «ese correo ya está ligado a otra cuenta» de `/login` y el tope de espacios del selector. Sin él ninguno promete «escríbenos»: `/legal` dice que se publicará y `/login` ofrece entrar con otro correo. En producción, que falte se avisa en el log |
| `DEMO_USER_ID` | **solo sin llaves** (modo demo): a quién se simula para los permisos del marco (ACC-5). Un id de `app_user`; el de la creadora del seed es `00000002-0000-4000-8000-000000000002`. Sin ella, el modo demo es el Dueño. Con llaves no se lee, como `DEMO_WORKSPACE_ID` |
| `TURNSTILE_SITE_KEY` | la clave **de sitio** (pública) de Cloudflare Turnstile para el CAPTCHA de `/login` (CIM-10). La secreta va en el panel de Supabase, no aquí. Sin ella, `/login` funciona sin CAPTCHA: fuera de producción lo dice en una línea, en producción lo avisa el log |

Sin las dos primeras la web **no se cae**: entra en modo demo, `/login`
dice cuáles faltan y el resto sigue sirviendo `DEMO_WORKSPACE_ID`. Eso
es lo que permite que `pnpm verificar` corra sin red y sin llaves.

### Lo que hay que configurar en el panel de Supabase

Una persona, una vez, en **Authentication → URL Configuration**:

- **Site URL**: `https://on-cue-web.vercel.app`
- **Redirect URLs**, una por línea:
  - `https://on-cue-web.vercel.app/**`
  - `http://localhost:*/**` (los agentes trabajan entre el 3100 y el
    3999)

Las entradas son **globs que tienen que casar con la URL entera**, query
incluida, y el enlace siempre vuelve con `?next=…`
(`/auth/callback?next=%2Ffinanzas`). Por eso terminan en `/**`: una
entrada como `http://localhost:3000/auth/callback` NO casa, Supabase cae
en silencio al Site URL, el `?code=` nunca llega a `/auth/callback` y la
persona acaba en producción sin sesión.

**Nunca un comodín sobre un dominio compartido**, como
`https://*.vercel.app/**`. Cualquiera puede publicar `lo-que-sea.vercel.app`,
y con esa entrada un atacante pide un enlace para el correo de la víctima
(la anon key es pública) con `redirect_to` a su subdominio: la víctima
recibe un correo legítimo de On Cue, pulsa, y el código llega al
atacante, que lo canjea. Toma de cuenta y de espacio.

Las **vistas previas** de Vercel no entran por defecto. Para probar una,
añade su URL exacta de rama mientras la pruebas y quítala después:
`https://on-cue-web-git-<rama>-influ3.vercel.app/**`. El patrón de equipo
que sugiere la guía de Supabase (`https://*-influ3.vercel.app/**`)
depende de que nadie más pueda crear un proyecto cuyo dominio acabe en
`-influ3`, y eso lo decide Vercel, no nosotros: no lo usamos.

En **Authentication → Emails → Templates**, en «Magic Link» **y** en
«Confirm signup», el enlace tiene que ser:

```html
<a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=email">Entrar a On Cue</a>
```

Por qué no la de por defecto: manda `?code=` (PKCE), y el verificador de
ese código vive en una cookie del navegador donde se **pidió** el
enlace. Si se pide en el portátil y se abre en el teléfono —o en el
navegador interno de Gmail o de Outlook, que es lo normal—, no hay
verificador y la entrada falla (`/login` lo dice: «Abre el enlace en el
mismo navegador donde lo pediste…»). Con `token_hash` el enlace sirve
en cualquier dispositivo. El `&` va bien porque `{{ .RedirectTo }}`
siempre trae ya su `?next=`.

**El enlace no abre la sesión al cargarse.** Un `token_hash` es de un
solo uso, y los escáneres de enlaces del correo corporativo (Outlook
Safe Links, Mimecast, habituales en agencias) abren con un GET todo
enlace que llega, antes que la persona: si ese GET canjeara el token,
ella vería «Ese enlace ya no sirve» sin haberlo tocado. Por eso
`/auth/callback` con `token_hash` no canjea nada: reenvía a
`/auth/confirm`, una pantalla con un solo botón, «Entrar a On Cue», que
canjea por POST (`app/auth/confirm/acciones.ts`). Es lo que recomienda
Supabase para enlaces de un solo uso. La plantilla de arriba no cambia:
sigue apuntando a `{{ .RedirectTo }}` (que es `/auth/callback?next=…`)
y el reenvío lo hace la aplicación.

Si un enlace caducó o ya se usó, Supabase vuelve con
`?error=access_denied&error_code=otp_expired`; `/login` dice «Ese enlace
ya no sirve. Pide uno nuevo.», no «Se canceló la entrada» (ese texto es
solo para `access_denied` sin `error_code`).

Y en **Authentication → Sign In / Providers → Email**: proveedor de
correo encendido, contraseñas **apagadas** y **Confirm email
encendido**. La aplicación ya rechaza un usuario sin correo verificado;
este ajuste es la segunda barrera, no la única.

### El límite del correo, y por qué hace falta un CAPTCHA

El proveedor de correo que trae Supabase es para desarrollo y tiene un
**límite bajo por hora**, por proyecto y no por persona. Al pasarlo
responde 429 y `/login` lo dice con su propio texto («ya mandamos varios
enlaces a ese correo…»). Para uso real hay que conectar un SMTP propio
en **Project Settings → Auth → SMTP Settings**; hasta entonces, no
probar el login en bucle.

Un SMTP propio también tiene un tope por hora para todo el proyecto, y
el endpoint del enlace (`/auth/v1/otp`) es público: la anon key viaja
al navegador, así que un script puede pedir enlaces sin pasar por esta
aplicación y agotar el cupo, y entonces **nadie** puede entrar. Un
límite por IP en la app no lo para. Lo que lo para es que Supabase exija
un CAPTCHA (historia **CIM-10**, antes del primer cliente que pague):

1. En Cloudflare → Turnstile, un sitio con los dominios de la app
   (`on-cue-web.vercel.app` y `localhost`). Da una clave de sitio y una
   secreta.
2. `TURNSTILE_SITE_KEY` = la clave **de sitio**, en Vercel (production y
   preview) y en `platform/.env.local` si quieres verlo en local.
   Despliega: `/login` ya pinta el widget y manda el token.
3. **Después**, en Supabase → Authentication → Attack Protection →
   *Enable Captcha protection*, proveedor Turnstile y la clave
   **secreta**. En este orden: con el CAPTCHA encendido y sin el widget
   desplegado, cada envío falla («No pudimos comprobar que no eres un
   robot»).

Además Supabase no deja pedir otro enlace para el **mismo correo**
antes de 60 s (también 429). Por eso «Reenviar el enlace» sale
desactivado con su cuenta atrás, como en Linear y Vercel; y si aun así
el reenvío falla, el error aparece debajo de «Revisa tu correo» con el
correo conservado, sin volver al formulario vacío.

### Cómo probarlo sin esperar un correo

**El correo de la creadora demo del seed es `demo@oncue.test`**
(`db/seed/0002`). El seed `0003` escribe `laura@ejemplo.com`, pero con
`ON CONFLICT DO NOTHING`, así que no cambia nada: entrar con ese
otro correo crea un espacio **nuevo y vacío** llamado «Laura». Y un
dominio `.test` nunca recibe correo, así que el de la demo solo se abre
con `generate_link`.

`generate_link` de la API de administración devuelve el enlace sin
mandarlo:

```bash
curl -s -X POST "$SUPABASE_URL/auth/v1/admin/generate_link" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type":"magiclink","email":"demo@oncue.test",
       "options":{"redirect_to":"http://localhost:3100/auth/callback"}}'
```

De la respuesta salen `hashed_token` y `verification_type` —para quien
no existía todavía es `signup`, no `magiclink`— y con los dos se abre
`http://localhost:3100/auth/callback?token_hash=…&type=…`, que lleva a
`/auth/confirm`: se pulsa «Entrar a On Cue». Con el correo de la demo
aparece «Laura · Cocina fácil» con sus facturas; con uno nuevo, un
espacio vacío con el nombre sacado del correo. La clave de
servicio no se usa en el código de la web: solo aquí, a mano.

Lo mismo está cubierto sin red en las pruebas: `middleware.test.ts`
(sin sesión, `/resumen` → `/login?next=%2Fresumen`),
`lib/auth/acciones.test.ts` (el correo del seed entra a la creadora
demo y no crea nada; cambiar de espacio cambia lo que se sirve; otra
cuenta de Auth con el mismo correo no entra), `app/auth/callback/route.test.ts`
y `app/auth/confirm/acciones.test.ts`.

### Si el enlace lo pidió otra persona

Con `token_hash`, el enlace sirve en cualquier navegador (es a lo que
se renunció para que funcione del portátil al teléfono). Eso abre el
*login CSRF*: alguien pide un enlace para **su** correo, se lo manda a
la víctima, y ella entra sin notarlo en la cuenta del atacante, donde
acaba todo lo que registre. Dos defensas:

- `/login` deja una cookie con la huella del correo pedido
  (`lib/auth/pedido.ts`). Si `/auth/confirm` canjea un enlace para OTRO
  correo, o en un navegador que no pidió ninguno, no entra directo: pasa
  por `/auth/comprobar`, «Entraste como x@y», con «No soy yo, cerrar
  sesión».
- El menú del selector de espacio dice siempre con qué correo se entró,
  bajo «Tu cuenta».

### Antes de desplegar a producción

- [ ] `APP_URL` fijada (o `VERCEL_PROJECT_PRODUCTION_URL`, que pone Vercel).
- [ ] `SUPPORT_EMAIL` fijado: es el único contacto de una persona con la
      cuenta bloqueada.
- [ ] `TURNSTILE_SITE_KEY` y, después, el CAPTCHA en Supabase (arriba).
- [ ] SMTP propio en Supabase.
- [ ] Redirect URLs, plantillas y *Confirm email* en el panel (arriba).

### Migraciones de esta pieza

Dos, **sin aplicar en Supabase** hasta que las integre quien integra:
`*_sesion_correo_verificado.sql` (la política «mi fila por el correo
verificado» y `app_user.auth_user_id`) y `*_membership_alta_propia.sql`.
Hoy llevan los números 0027 y 0028 porque van detrás de lo que otras
ramas ya tomaron (la cabecera de la primera lo detalla). El código las
cita por su nombre y no por su número: renumerarlas es mover dos
archivos. Sin la primera, el inicio de sesión falla y el log de Vercel
dice cuál falta.

El orden con `0024_aislamiento_por_defecto` es obligatorio (0024 quita
a `mc_app` el INSERT sobre membership y 0028 se lo devuelve) y lo hacen
cumplir las dos: 0028 se para si 0024 no está en `schema_migrations`, y
0024 se para si 0028 ya lo está. `packages/db/test/identidad.test.ts`
aplica las dos en el orden malo y comprueba el mensaje, y además lee de
la base migrada que `mc_app` tenga INSERT (y no UPDATE ni DELETE) sobre
membership.

## Reglas del marco

- El tema se fija en `<html data-theme>` antes de pintar y se guarda
  en `localStorage`. Los colores son variables en `globals.css`; los
  componentes usan `bg-bg`, `text-fg`, `border-line`, nunca un color
  literal.
- Un módulo apagado en `content/flags.ts` desaparece del menú y su
  ruta no existe.
- **Banderas y permisos (ACC-5).** Una bandera dice si el módulo
  **existe**; un permiso, si **esta persona** entra. Cada módulo declara
  en `content/modules.ts` su permiso mínimo (`permission`, el `.ver`
  principal) y el `layout.tsx` de su carpeta hace
  `await requireModuleAccess("<slug>")` (`lib/permisos/modulo.ts`): se
  evalúa primero la bandera y después el permiso, y en los dos casos la
  ruta responde **404**, nunca 403 (un 403 confirmaría que el módulo
  existe). El menú esconde lo que no se puede abrir: el `Shell` resuelve
  `permisosDeLaSesion()` en servidor y se lo pasa a la navegación. Los
  permisos salen de la membresía en el workspace actual
  (`@mc/db/queries/accesos`), una vez por petición; sin sesión, ninguno;
  sin llaves (modo demo), el Dueño —o la membresía real de
  `DEMO_USER_ID`, que es como se prueba en dev que el marco esconde y
  cierra—. Toda Server Action abre con `await requirePermission("…")`
  (`lib/permisos`). El detalle está en `lib/permisos/README.md`.
- Nada aquí hace aritmética de métricas. Cuando lleguen los datos, los
  números derivados salen de las vistas de la base.
