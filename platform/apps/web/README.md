# @mc/web · el dashboard

Next.js 15, React 19, Tailwind 4, Geist. Cada ruta muestra el plan de
construcción de su módulo hasta que llega la pantalla real. Finanzas ya
es real (FIN-1): lee la base por `@mc/db`.

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
mira cuando **no hay sesión** (modo demo, o una ruta pública). En
producción sin sesión y sin esa variable, `lib/workspace/current.ts`
lanza diciendo qué falta; para servir el workspace del seed a
propósito, `ALLOW_SEED_WORKSPACE=1`.

Desplegar: `make vercel.deploy` (vista previa) o `make vercel.deploy
PROD=1` (producción). El token vive en el vault; ver el CLAUDE.md de la
raíz.

## Dónde está cada cosa

```
app/(app)/<modulo>/page.tsx   La ruta de cada módulo. Hoy muestra el plan;
                              el dueño la reemplaza por la pantalla real.
app/(app)/finanzas/           Finanzas: lista, factura nueva y detalle.
                              index.ts exporta facturarCampana() para Campañas.
components/ui/                Kit de interfaz compartido (ver su README).
lib/format.ts                 Dinero, fechas y porcentajes. El locale y la zona
                              llegan del workspace; es-CO solo es el valor por defecto.
lib/auth/                     Sesión de Supabase: configuración, cliente de servidor,
                              sincronización de la persona y sus espacios, server
                              actions (cambiar de espacio, salir) y messages.ts.
middleware.ts                 Refresca la sesión y protege todo (app)/.
app/login/                    La entrada: un campo y un botón.
app/auth/callback/            Donde aterriza el enlace del correo.
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
se convierte en «no hay sesión»: la pantalla cae en su `error.tsx` con
«Reintentar».

### Quién eres, y en qué espacio estás

Son dos cosas distintas y se resuelven por separado:

- **quién eres** sale SIEMPRE del correo que Supabase verificó —con
  `email_confirmed_at`; un usuario sin él no cuenta como sesión, ni en
  el middleware, ni en `getSesion`, ni en el callback—. La
  transacción fija `app.user_email` y la fila de `app_user` se busca con
  `email = current_user_email()` (migración 0022). Nada que venga del
  navegador entra en esa respuesta.
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
| `APP_URL` | a qué origen vuelve el enlace del correo. Sin ella se deduce de las cabeceras de la petición |

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

La plantilla por defecto manda `?code=` (PKCE), y el verificador de ese
código vive en una cookie del navegador donde se **pidió** el enlace. Si
se pide en el portátil y se abre en el teléfono —o en el navegador
interno de Gmail o de Outlook, que es lo normal—, no hay verificador y
la entrada falla (`/login` lo dice: «Abre el enlace en el mismo
navegador donde lo pediste…»). Con `token_hash` el enlace sirve en
cualquier dispositivo; `/auth/callback` ya sabe canjearlo. El `&` va
bien porque `{{ .RedirectTo }}` siempre trae ya su `?next=`.

Y en **Authentication → Sign In / Providers → Email**: proveedor de
correo encendido, contraseñas **apagadas** y **Confirm email
encendido**. La aplicación ya rechaza un usuario sin correo verificado;
este ajuste es la segunda barrera, no la única.

### El límite del correo integrado

El proveedor de correo que trae Supabase es para desarrollo y tiene un
**límite bajo por hora**, por proyecto y no por persona. Al pasarlo
responde 429 y `/login` lo dice con su propio texto («ya mandamos varios
enlaces a ese correo…»). Para uso real hay que conectar un SMTP propio
en **Project Settings → Auth → SMTP Settings**; hasta entonces, no
probar el login en bucle.

### Cómo probarlo sin esperar un correo

**El correo de la creadora demo del seed es `demo@multicampaign.test`**
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
  -d '{"type":"magiclink","email":"demo@multicampaign.test",
       "options":{"redirect_to":"http://localhost:3100/auth/callback"}}'
```

De la respuesta salen `hashed_token` y `verification_type` —para quien
no existía todavía es `signup`, no `magiclink`— y con los dos se abre
`http://localhost:3100/auth/callback?token_hash=…&type=…`. Con el correo
de la demo aparece «Laura · Cocina fácil» con sus facturas; con uno
nuevo, un espacio vacío con el nombre sacado del correo. La clave de
servicio no se usa en el código de la web: solo aquí, a mano.

Lo mismo está cubierto sin red en las pruebas: `middleware.test.ts`
(sin sesión, `/resumen` → `/login?next=%2Fresumen`),
`lib/auth/acciones.test.ts` (el correo del seed entra a la creadora
demo y no crea nada; cambiar de espacio cambia lo que se sirve) y
`app/auth/callback/route.test.ts`.

## Reglas del marco

- El tema se fija en `<html data-theme>` antes de pintar y se guarda
  en `localStorage`. Los colores son variables en `globals.css`; los
  componentes usan `bg-bg`, `text-fg`, `border-line`, nunca un color
  literal.
- Un módulo apagado en `content/flags.ts` desaparece del menú y su
  ruta no existe.
- Nada aquí hace aritmética de métricas. Cuando lleguen los datos, los
  números derivados salen de las vistas de la base.
