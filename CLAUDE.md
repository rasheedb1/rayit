# MultiCampaign

Plataforma para que creadores y agencias midan, creen, vendan y cobren.
Red de cuentas propias en TikTok, Instagram, Facebook y YouTube, con
video corto generado por IA.

---

## Máquina nueva — un solo comando

```bash
git clone https://github.com/rasheedb1/rayit.git
cd rayit/platform
make arranque
```

`make arranque` comprueba las herramientas, descifra las credenciales,
configura el remoto de git y verifica que la base de datos y GitHub
responden. Es idempotente: se puede volver a correr cuando algo se
rompa, y dice exactamente qué falta.

Lo único que no puede hacer solo es conseguir la **frase de paso** del
vault. Es una sola frase, abre la base de datos y los tokens de GitHub y
Vercel, y se comparte a mano por un canal aparte. Pídesela a Rasheed
(rasheed@y.uno). **Nunca la pegues en un chat de IA ni en un ticket.**

Después de eso, `claude` dentro del repositorio ya lee este archivo y
los permisos de `.claude/settings.json` solos.

El paso a paso completo para dar acceso a alguien nuevo —invitación,
frase de paso, credenciales propias, y qué hacer cuando alguien se va—
está en [docs/acceso-al-repositorio.md](docs/acceso-al-repositorio.md).

---

## ⚠️ BASE DE DATOS — empieza por aquí

**La base de datos está en Supabase y ya tiene el esquema completo
aplicado (13 migraciones, 88 tablas, 10 vistas).**

Las credenciales **están en este repositorio**, cifradas. No hace falta
pedirle nada a nadie salvo una frase de paso.

```bash
cd platform
make db.unlock      # descifra las credenciales -> .env.local
make db.info        # comprueba que conecta
```

`db.unlock` pide la frase de paso **una sola vez** y la guarda en el
Llavero de macOS. Si no la tienes, pídesela a Rasheed (rasheed@y.uno):
no está en el repositorio, y ese es justamente el punto.

### Lo que vas a usar

| Comando | Qué hace |
|---|---|
| `make db.unlock` | Descifra las credenciales. **Todo lo demás lo necesita.** |
| `make db.info` | Migraciones aplicadas, tablas, vistas |
| `make db.sql Q="select ..."` | Una consulta. Entra como `mc_app`: solo filas |
| `make db.sql ADMIN=1 Q="alter table ..."` | Igual, pero como `mc_migrator`: puede tocar el esquema |
| `make db.migrate` | Aplica las migraciones pendientes en Supabase |
| `make db.check` | Verifica el esquema en Postgres embebido, **sin tocar Supabase** |
| `make db.status` | Qué hay en el vault, sin revelar valores |

### Cómo cambiar el esquema

Las migraciones aplicadas son **inmutables**: el runner guarda un
checksum y se niega a correr si un archivo ya aplicado cambió. Para
cambiar algo, crea un archivo nuevo:

```bash
cd platform
$EDITOR db/migrations/0014_lo_que_sea.sql
make db.check       # pruébala en Postgres embebido primero
make db.migrate     # y entonces contra Supabase
```

### Los tres roles de Postgres, y por qué

El esquema NO se toca con el usuario `postgres`. Hay separación a
propósito, para que un error en el código de la app no pueda borrar
tablas:

| Rol | Puede | Dónde está |
|---|---|---|
| `mc_app` | `SELECT/INSERT/UPDATE/DELETE`. **No** puede alterar el esquema | `DATABASE_URL` (pooler :6543, modo transacción) |
| `mc_migrator` | Lo anterior + `CREATE/ALTER/DROP` en `public`. **No** puede crear roles | `DATABASE_URL_DIRECT` (pooler :5432, modo sesión) |
| `mc_worker` | `NOLOGIN`, `BYPASSRLS`. El worker lo asume con `SET ROLE` | — |

Crear roles nuevos o rotar llaves de Supabase necesita el token de
administración, que **no está en el repositorio** (ver abajo).

### Cosas que rompen si no las sabes

- **La conexión directa `db.<ref>.supabase.co` no funciona**: es solo
  IPv6. Todo pasa por el pooler `aws-0-ca-central-1.pooler.supabase.com`.
- **El usuario del pooler lleva el ref pegado**: `mc_app.autlbeccerunvetptywe`,
  no `mc_app`.
- **TLS verifica contra la CA de Supabase**, que está versionada en
  `platform/db/certs/`. No la desactives con `rejectUnauthorized: false`;
  si falla, corre `make db.cert`.
- **Las migraciones no pueden crear roles.** `mc_migrator` no tiene
  `CREATEROLE`. Si una migración nueva lo necesita, crea el rol antes
  con `./scripts/supabase-admin.sh sql "CREATE ROLE ..."` y deja la
  migración con su guardia `IF NOT EXISTS`.

---

## GitHub — empujar al repositorio

El remoto es `https://github.com/rasheedb1/rayit.git`. El token para
empujar está **cifrado dentro del repositorio**, con la misma frase de
paso que la base de datos. No hay un secreto nuevo que pedir.

```bash
cd platform
make arranque         # lo hace todo: frase, credenciales, remoto, helper
git push
```

O paso a paso, si prefieres ver qué hace cada cosa:

```bash
make db.unlock        # la frase, una sola vez (queda en el gestor de secretos)
make github.install   # remoto + credential helper, en tu clon
```

| Comando | Qué hace |
|---|---|
| `make github.install` | Configura el remoto y el helper. **Uno por clon.** |
| `make github.status` | Qué hay guardado y cómo está tu clon, sin revelar el token |
| `make github.check` | Pregunta a GitHub: qué usuario, qué permisos, cuándo expira |
| `make github.set` | Guarda o rota el token (lo pide sin mostrarlo) |

### Cosas que rompen si no las sabes

- **`github.install` es por clon.** La configuración vive en `.git/config`,
  que no se versiona. Al clonar en otra máquina hay que correrlo otra vez.
- **Nunca pongas el token en la URL del remoto.** `https://TOKEN@github.com/…`
  lo deja en claro en `.git/config` y sale en cualquier `git remote -v`.
  Para eso está el helper.
- **El token es de cuenta, no de repositorio.** Los tokens clásicos
  (`ghp_…`) valen para todo GitHub; solo los *fine-grained*
  (`github_pat_…`) se limitan a un repo. Como GitHub no pone ese límite,
  lo pone `scripts/github.sh`: solo entrega el token para el host y la
  ruta que tiene guardados, y calla para cualquier otro.
- **Si el token se escribe fuera del vault, rótalo.** Un chat o un correo
  no se limpian de verdad. `make github.set` y a GitHub a revocar el viejo.
- **La frase de paso se guarda donde el sistema la sepa guardar.** Llavero
  en macOS, libsecret en Linux (`apt install libsecret-tools`). En
  cualquier otro sitio hay que exportar `MC_VAULT_PASSPHRASE` a mano.
  Lo resuelve `scripts/lib/frase.sh`; `make arranque` te dice cuál toca.

---

## Vercel — desplegar el dashboard

Mismo trato que GitHub: el token vive **cifrado dentro del repositorio**,
con la misma frase de paso. Quien ya corrió `make db.unlock` puede
desplegar sin pedirle nada a nadie.

```bash
cd platform
make vercel.check     # qué cuenta, qué equipo, cuándo expira el token
make vercel.link      # crea o adopta el proyecto y lo enlaza en TU clon
make vercel.deploy    # vista previa
make vercel.deploy PROD=1   # producción
```

| Comando | Qué hace |
|---|---|
| `make vercel.link` | Adopta el proyecto (`NOMBRE=on-cue-web`) y escribe el enlace local con sus settings. **Uno por clon.** |
| `make vercel.dir DIR=.` | Qué directorio se sube. Es `.` (platform entero) porque el proyecto tiene Root Directory `apps/web` |
| `make vercel.status` | Qué hay guardado y cómo está tu clon, sin revelar el token |
| `make vercel.check` | Pregunta a Vercel: qué cuenta, qué equipo, cuándo expira |
| `make vercel.deploy` | Despliega `apps/web`. `PROD=1` para producción |
| `make vercel.run ARGS="..."` | Cualquier comando de la CLI con el token compartido |
| `make vercel.set` | Guarda o rota el token (lo pide sin mostrarlo) |

La cuenta es `influ0909@gmail.com`, equipo `influ3`. El token expira el
**21 de septiembre de 2027**; `make vercel.check` dice cuántos días
quedan.

### Cosas que rompen si no las sabes

- **`vercel.link` es por clon.** Escribe `apps/web/.vercel/project.json`,
  que no se versiona. Al clonar en otra máquina hay que correrlo otra vez.
  Lo que sí viaja es el id del proyecto, dentro del vault.
- **El token es de cuenta, no de proyecto.** Vercel no sabe limitar un
  token a un proyecto, igual que GitHub con los tokens clásicos. El
  límite lo pone `scripts/vercel.sh`: siempre despliega al equipo y al
  proyecto que tiene guardados.
- **Nunca uses `--token` ni `vercel login` con este token.** `--token`
  deja el secreto visible en `ps` y en el historial del shell; `vercel
  login` lo escribiría en claro y para siempre en
  `~/Library/Application Support/com.vercel.cli/auth.json`. El script lo
  deja en un directorio temporal de permisos 700 y lo borra al terminar.
- **Si el token se escribe fuera del vault, rótalo.** `make vercel.set`,
  y revoca el viejo en vercel.com → Account Settings → Tokens.
- **`apps/web` ya es la app real** (Next.js 15, Tailwind 4, Geist) y está
  publicada en https://multicampaign-web.vercel.app. Hoy muestra el plan
  de construcción de cada módulo y el estado de sus historias
  (`apps/web/content/backlog.ts`); cada módulo se reemplaza por su
  pantalla real cuando llega. No hay integración con GitHub todavía: se
  publica con `make vercel.deploy PROD=1` después de mergear a `main`.

---

## Dónde viven los secretos

| Qué | Dónde | Viaja con el repo |
|---|---|---|
| Credenciales de Supabase y Postgres | `platform/secrets/supabase.env.enc` (AES-256) | **Sí**, cifrado |
| Token de GitHub del repositorio | `platform/secrets/github.env.enc` (AES-256) | **Sí**, cifrado |
| Token de Vercel del equipo | `platform/secrets/vercel.env.enc` (AES-256) | **Sí**, cifrado |
| Frase de paso de ese archivo | Llavero de macOS · se comparte a mano | No |
| Token de administración de Supabase (`sbp_…`) | Llavero de macOS, solo en la máquina de Rasheed | **No, nunca** |
| Copia de emergencia de las dos llaves irrecuperables | Esquema `recuperacion` en la propia base (solo `postgres`) | — |

La regla: **lo que solo afecta a este proyecto viaja cifrado en el
repo; lo que afecta a la cuenta entera de Supabase no viaja.** Ese
token puede borrar el proyecto y rotar todas las llaves, así que quien
lo necesite lo pide, o saca el suyo con `supabase login`.

### Si pierdes el Llavero

Hay una copia de las llaves irrecuperables **dentro de la propia base**,
en el esquema `recuperacion`, al que solo llega el rol `postgres`:

```bash
./scripts/supabase-admin.sh recover      # con el token de administración
```

o desde el panel de Supabase → SQL Editor:

```sql
select nombre, valor, para_que from recuperacion.llaves;
```

Ese esquema **no** es accesible para `mc_app`, `mc_migrator`, ni
`service_role`, ni está expuesto en la API REST — está verificado. No
le des permisos: es lo único que lo mantiene útil.

Detalle completo en [platform/secrets/README.md](platform/secrets/README.md)
y [docs/base-de-datos.md](docs/base-de-datos.md).

**Nunca** escribas una credencial en claro en un archivo versionado. El
`.gitignore` de la raíz bloquea `.env`, `*.env` y `secrets/*.env`, pero
deja pasar `*.env.enc` a propósito. Si agregas una ruta que pueda tener
secretos, métela al `.gitignore` **antes** de crear el archivo.

---

## Mapa del repositorio

```
platform/              El código real
  db/migrations/       El esquema. Inmutable, en orden.
  db/migrate.mjs       Runner: Supabase, Postgres local o embebido
  db/sql.mjs           Consola SQL (no hay psql en esta máquina)
  db/certs/            CA raíz de Supabase (pública, versionada)
  secrets/             El vault cifrado y su manual
  scripts/vault.sh     Cifrar y descifrar credenciales
  scripts/github.sh    El token de GitHub + credential helper de git
  scripts/vercel.sh    El token de Vercel + despliegue del dashboard
  scripts/arranque.sh  Deja una máquina nueva lista, de cero
  scripts/lib/frase.sh Dónde guarda cada sistema la frase de paso
  scripts/supabase-admin.sh   Operaciones que piden el token de admin
  apps/web/            Dashboard (Next.js)
  apps/worker/         Trabajos en segundo plano (Node + pg-boss)
  apps/media/          Analizador de video (Python: ffmpeg, ASR, OCR)
  packages/            Lógica compartida: db, core, connectors

dashboard/             Mocks en HTML. La referencia visual manda.
docs/                  Arquitectura, esquema, investigación de APIs
.claude/settings.json  Permisos de Claude Code para el equipo. Se versiona.
```

## Convenciones

- **Idioma**: comentarios, documentación y nombres de rama en español.
  Identificadores de código y de base de datos en inglés.
- **Fechas**: siempre `timestamptz`. La app trabaja en UTC.
- **Enumerados**: `text` + `CHECK`, no tipos `ENUM` de Postgres.
- **Dinero**: `numeric(14,2)` + moneda ISO-4217 aparte. Nunca `float`.
- **Métricas**: tablas append-only. No se actualizan, se insertan.
