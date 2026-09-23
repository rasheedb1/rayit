# WRK · El worker en producción

Módulo de cierre de Nicolás (`nicolas/WRK-worker-produccion`), 23-sep-2026.
El despliegue continuo es CIM-7 (Rasheed): lo que aquí es hosting es
**propuesta** y se acuerda con él. `apps/worker/` es de Nicolás.

## 0. Estado en una tabla

| Qué | Estado | Prueba o evidencia |
|---|---|---|
| El worker corrió un ciclo contra Supabase | **No: bloqueado por un comando de administración** (§1). Falla en `SET ROLE mc_worker`, con el error exacto en §2. | `make db.sql` (solo lectura) y los dos arranques de §2 |
| Qué comando falta y quién lo corre | Escrito en §1. Lo corre Rasheed (o Nicolás con un token propio de `supabase login`). | — |
| Recomendación de hosting con costos | §3: **(b) `--once` cada hora desde GitHub Actions**, 0–5 USD/mes | — |
| Modo `--once` | **Hecho y probado**: corre lo vencido, no repite lo corrido, reintenta hasta `max_attempts`, encadena, no pisa una corrida viva, no necesita el esquema `pgboss` | `apps/worker/test/once.test.ts` (10) y `test/cron.test.ts` (6) |
| Salud del worker (última corrida por job) | **Hecho**: `getWorkerHealth` y `workerDataAsOf` en `@mc/db/queries/worker`; `pnpm --filter @mc/worker salud`; `--once` la imprime al terminar | `once.test.ts` caso 10 |
| Workflow del camino recomendado | **Escrito y apagado dos veces** (sin `schedule` y con la guardia `vars.WORKER_ONCE == 'on'`) | `.github/workflows/worker-once.yml` |
| Variables del entorno del worker | Tabla en §5 | — |
| El worker desplegado | **No**: PARADA 2 (§7), espera el visto bueno de Nicolás a este documento y el acuerdo con Rasheed | — |

## 1. Lo que falta en Supabase y quién lo corre

Comprobado el 23-sep a las 23:10 UTC, solo lectura (`make db.sql`, como `mc_app`):

```
pgboss  grant_worker  job_runs  defs  enabled
0       false         0         21    21
```

Ni el esquema `pgboss` ni la membresía de `mc_worker` existen, y
`job_run` está vacía: el worker no ha corrido nunca en producción.

Ambos comandos piden el **token de administración de Supabase**
(`scripts/supabase-admin.sh`), que según CLAUDE.md solo tiene Rasheed.
Esta sesión no los corrió. Los corre **Rasheed**, o **Nicolás** con un
token propio sacado con `supabase login` (docs/cierre-modulos-nicolas-prompts.md §0.2).

### 1.1 Si se elige (b), el recomendado: un solo paso, con rol propio

`--once` no usa pg-boss, así que **el esquema `pgboss` no hace falta**.
Solo hace falta un rol que pueda hacer `SET ROLE mc_worker`. Como la
contraseña va a vivir en un secreto de GitHub, conviene que NO sea
`mc_migrator` (que puede hacer DDL en `public`): la variante de
`mc_worker_login` de CON-2 §3.1 aquí es la buena.

```bash
cd platform
PASS="$(openssl rand -base64 32 | tr -d '/+=')"      # no la escribas en ningún archivo
./scripts/supabase-admin.sh sql "CREATE ROLE mc_worker_login LOGIN PASSWORD '$PASS' NOINHERIT"
./scripts/supabase-admin.sh sql "GRANT mc_worker TO mc_worker_login"
./scripts/supabase-admin.sh sql "GRANT USAGE ON SCHEMA public TO mc_worker_login"
```

Y la cadena, **modo sesión (:5432)** y con el ref pegado al usuario:
`postgres://mc_worker_login.autlbeccerunvetptywe:<PASS>@aws-0-ca-central-1.pooler.supabase.com:5432/postgres`,
como `WORKER_DATABASE_URL` en el vault (`make db.lock` tras añadirla) y
en los secretos del repositorio de GitHub. `unset PASS` al terminar.

Comprobación, en solo lectura:

```bash
make db.sql Q="select pg_has_role('mc_worker_login','mc_worker','member') as grant_worker"
```

### 1.2 Si se elige (a): los dos comandos de CON-2 §3.1, tal cual

```bash
cd platform
./scripts/supabase-admin.sh sql "CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION mc_migrator"
./scripts/supabase-admin.sh sql "GRANT mc_worker TO mc_migrator"
pnpm --filter @mc/worker install-schema          # crea las tablas de pg-boss (Nicolás, con el vault)
```

o, mejor, la variante con rol propio: los tres comandos de §1.1 más
`CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION mc_worker_login` (en
vez de `ALTER SCHEMA … OWNER`, porque el esquema aún no existe) y
`install-schema` con `WORKER_DATABASE_URL`.

## 2. F1 · El arranque contra Supabase (sin desplegar)

Con las variables del vault (`platform/.env.local` del clon principal,
cargado con `--env-file`, sin leerlo ni imprimirlo), el 23-sep:

**`pnpm --filter @mc/worker start`** (proceso largo), salida con 1 al segundo:

```
warn  app OAuth sin configurar: sus tokens no se podrán renovar  provider=tiktok  missing=[TIKTOK_LOGIN_CLIENT_KEY, TIKTOK_LOGIN_CLIENT_SECRET, TIKTOK_LOGIN_REDIRECT_URI (o APP_URL)]
warn  … provider=tiktok-business … provider=instagram …
error el worker no pudo arrancar
      No se pudo hacer SET ROLE mc_worker: permission denied to set role "mc_worker".
      El rol con el que se conecta el worker tiene que ser miembro de mc_worker (ver docs/propuestas/CON-2.md).
```

**`… src/index.ts --once`**, el mismo error, en el mismo punto
(`assertRole`, antes de tocar ninguna tabla). **`… src/salud.ts`**: «No
se pudo leer la salud del worker: No se pudo hacer SET ROLE mc_worker…».

Conteos: `job_run` sigue en **0**, `pgboss` en **0**. Nada se escribió
en Supabase. En ninguno de los dos logs aparece una cadena de conexión,
una contraseña ni la clave de cifrado (grep en la salida: 0 coincidencias).

Lo que sí prueba este arranque: la configuración carga, el TLS contra
el pooler y las credenciales de `mc_migrator` funcionan (la conexión
se abre; lo que Postgres rechaza es el cambio de rol), y el aviso de
las apps OAuth sin configurar sale sin valores. Falta el paso de §1.

El ciclo completo (registrar jobs, correr un `oauth.refresh` sin nada
que renovar, dejar su `job_run`) está probado en Postgres embebido con
las 39 migraciones reales y el rol `mc_worker`: `once.test.ts` caso 8
(`oauth.refresh ok processed 0`, sin esquema `pgboss`) y
`runner.test.ts` para el proceso largo.

## 3. F2 · Tres caminos

Precios públicos consultados el 23-sep-2026 (GitHub Actions desde el
1-ene-2026; Fly sube la RAM el 1-oct-2026). Carga del MVP: diez jobs con
handler, todos diarios salvo `oauth.refresh` (cada 15 min) y
`collect.posts` (cada 6 h); una pasada real dura segundos.

| | (a) Proceso largo en Railway o Fly | (b) `--once` desde GitHub Actions cada hora | (c) Supabase `pg_cron` |
|---|---|---|---|
| Qué es | Dockerfile + `pnpm --filter @mc/worker start` siempre encendido; pg-boss programa los crons | Un workflow programado corre `--once`: lo vencido según `job_definition` + `job_run`, y sale | `cron.schedule` dentro de Postgres |
| Costo mensual | Railway: plan Hobby 5 USD (incluye 5 USD de uso; ~0,25 GB y poca CPU caben). Fly: shared-cpu-1x 512 MB ≈ 3,3 USD, sin plan gratis | **0 USD** si cabe en los 2 000 min/mes del plan gratis (repo privado; CI también gasta de ahí). 24 pasadas/día × ~2 min redondeados ≈ 1 440 min/mes. Si no cabe: 0,006 USD/min, ~3–5 USD | 0 USD (incluido en el plan) |
| Esfuerzo | M: Dockerfile para un monorepo pnpm, cuenta y facturación nuevas, secretos allí, health check, despliegue desde `main` (CIM-7) | **S: hecho en esta rama** (modo `--once`, prueba, workflow). Falta: el rol de §1.1, cinco secretos y encenderlo | L y mal encaje: `pg_cron` solo corre SQL. Los jobs llaman a TikTok, Instagram y YouTube y descifran tokens en Node: haría falta `pg_net` llamando a una ruta HTTP que corra la pasada, o sea (b) sobre Vercel |
| Qué pide a Supabase | GRANT **y** `CREATE SCHEMA pgboss` (§1.2) + `install-schema` | **Solo el GRANT** (§1.1) | Activar `pg_cron` y `pg_net` (admin) + el GRANT |
| Riesgo | Un proceso más que vigilar. Tiene abiertas hasta 12 conexiones en modo sesión (:5432) todo el día, del mismo pool de sesión que usa `make db.migrate`. Mejor latencia (cada 15 min de verdad) | GitHub retrasa o descarta a veces los disparos en punto (por eso el minuto 17). Resolución de una hora: `oauth.refresh` corre con margen de 120 min. Conexiones solo durante la pasada (`WORKER_JOB_POOL_MAX=4`). Credenciales `BYPASSRLS` en los secretos de GitHub: por eso el rol propio | Si la ruta vive en la web, las credenciales de `mc_worker` (`BYPASSRLS`) acaban en el entorno de Vercel, justo lo que CON-2 §1 descarta; y una pasada puede pasar del límite de duración de una función. Vercel Cron en Hobby solo dispara una vez al día |

**Recomendación: (b).** Es lo único que se puede encender esta semana
con un solo comando de administración, cuesta 0 o casi 0, y no deja
otro servidor que vigilar. La latencia de una hora no le importa a
ningún job con handler hoy: todos son diarios salvo `oauth.refresh`,
cubierto por el margen.

**Cuándo pasar a (a):** cuando llegue un job que no aguanta una hora
(`outbound.dispatch` cada 10 min, o los `video.*` bajo demanda desde la
web), cuando una pasada tarde más de ~20 min, o cuando los minutos de
Actions pasen de 5 USD. El código de (a) ya existe (es el runner de
CON-2); solo faltaría el Dockerfile y §1.2. Las dos cosas no deben
correr a la vez: con un proceso largo encendido, el workflow se apaga.

## 4. Lo implementado (lo que es de Nicolás y no depende de la elección)

- **`--once`** (`apps/worker/src/runner/once.ts`, entrada en `src/index.ts`,
  script `pnpm --filter @mc/worker once`). Por cada definición habilitada,
  con cron y handler: calcula su último tick (`runner/cron.ts`, UTC, sin
  dependencias nuevas) y mira las corridas **globales** (`workspace_id`
  NULL) desde ese tick: alguna `ok/partial/skipped` → al día; una
  `running` dentro de `timeout_s + 30 s` → otra pasada la tiene; fallidas
  ≥ `max_attempts` → espera al próximo tick y lo avisa; si no, corre con
  `attempt = fallidas + 1`. Corre lo de arriba antes que lo encadenado, y
  el encadenado enseguida si hubo datos, igual que el proceso largo. Sale
  con **1** si alguna corrida terminó `failed`, para que el workflow se
  ponga en rojo. Respeta SIGTERM (la corrida en curso recibe la señal;
  no empieza otra). `job_run.metadata.bossJobId` es `once:<uuid>`.
- **Salud** (`packages/db/src/queries/worker.ts`): `getWorkerHealth(q)`
  devuelve, por cada `job_definition`, última corrida, su estado y error,
  última corrida buena y fallos desde entonces; `workerDataAsOf(salud)`
  es «Datos al <fecha>»: el último `ok` más viejo entre
  `collect.account_metrics` y `collect.post_metrics`, o null si alguno
  no ha terminado bien nunca. La imprime `--once` al terminar y
  `pnpm --filter @mc/worker salud`.
- **Por qué no está en una pantalla.** Las corridas de cron son globales
  y `job_run` tiene RLS por workspace (0010): como `mc_app`, la web no ve
  ninguna. Enseñarla en Resumen pediría una función `SECURITY DEFINER`
  (migración nueva y un permiso). Lo que la persona necesita ya está:
  Resumen dice «Datos hasta el…» por conexión (`getFreshnessByConnection`),
  que es lo que el worker mueve cuando corre, y las pantallas que
  dependen de un job dicen que se actualizan cada mañana (CAM, FIN). Por
  eso **este prompt no cambia nada de la web** y no hay nada que
  desplegar en Vercel.
- **Workflow** `.github/workflows/worker-once.yml`, apagado (ver §7).

## 5. F3 · Variables del entorno del worker (nombres, nunca valores)

Salen de `grep process.env / env[…]` en `apps/worker/src` y
`packages/connectors/src`. «Vault» es `secrets/supabase.env.enc`
(`make db.status`); «Vercel» es production de `on-cue-web`
(`vercel env ls production`), ambos consultados el 23-sep.

| Variable | La lee | Vault | Vercel prod | Para (b) |
|---|---|---|---|---|
| `WORKER_DATABASE_URL` | config (gana a la de abajo) | **falta** | no (y no debe) | **obligatoria**: `mc_worker_login`, :5432 (§1.1) |
| `DATABASE_URL_DIRECT` | config si no hay la anterior | sí (`mc_migrator`) | no | no: la sustituye la anterior |
| `TOKEN_ENCRYPTION_KEY` | `EncryptedSecretStore`; sin ella no arranca | sí | sí | **obligatoria** |
| `TOKEN_ENCRYPTION_KEY_V2`, `_CURRENT` | rotación de la clave | no | no | solo al rotar |
| `APP_URL` | redirect de las apps OAuth al renovar | no | sí | obligatoria para renovar TikTok |
| `TIKTOK_LOGIN_CLIENT_KEY`, `TIKTOK_LOGIN_CLIENT_SECRET` | `oauth.refresh` de TikTok (@selvathegolden) | **falta** | sí | obligatoria: sin ellas el token caduca |
| `INSTAGRAM_HOUSE_TOKEN` | `collect.*`, `brand.snapshot` | **falta** | **falta** | sin ella Instagram se salta y se avisa |
| `GOOGLE_API_KEY` | `collect.*`, `brand.snapshot` | **falta** | **falta** | sin ella YouTube se salta y se avisa |
| `TIKTOK_BUSINESS_APP_ID/SECRET/REDIRECT_URI`, `META_APP_ID/SECRET/REDIRECT_URI`, `TIKTOK_LOGIN_REDIRECT_URI` | refreshers de TikTok Business e Instagram | no | no | no hay conexiones de esas apps hoy |
| `PGSSLROOTCERT` | TLS | sí | no | no: por defecto usa el CA versionado |
| `OAUTH_REFRESH_MARGIN_MINUTES` (y `_<PLATAFORMA>`) | `oauth.refresh` | no | no | `120` en el workflow |
| `WORKER_JOB_POOL_MAX` | pool | no | no | `4` en el workflow |
| `LOG_LEVEL`, `LOG_FORMAT` | logger | no | no | `info`, `json` |
| `WORKER_SET_ROLE`, `WORKER_GROUPS`, `WORKER_BOSS_SCHEMA`, `WORKER_BOSS_POOL_MAX`, `WORKER_POLL_S`, `WORKER_RETRY_DELAY_S`, `WORKER_RETRY_DELAY_MAX_S`, `WORKER_STOP_TIMEOUT_S`, `WORKER_APPLICATION_NAME`, `SECRET_STORE`, `TOKEN_REFRESHER` | runner | no | no | valores por defecto |
| `COLLECT_POSTS_MAX`, `COLLECT_MAX_AGE_HOURS`, `COLLECT_YOUTUBE_UNITS_RESERVE` | CON-5 | no | no | valores por defecto |
| `ENSEMBLEDATA_TOKEN` | CON-12, que **no está en main** | falta | falta | no aplica todavía |

## 6. F4 · Seguridad

- **El arranque no imprime secretos.** El aviso de apps sin configurar
  lista nombres de variables; el error de conexión dice rol y motivo. En
  los logs de §2 no hay cadena de conexión ni clave (comprobado). Todo lo
  que imprime el worker pasa por el redactor del logger (`logger.test.ts`).
- **`job_run` sin PII ni secretos.** `--once` pasa por el mismo
  `executeRun` y el mismo `redactSecrets` que el proceso largo: el caso 1
  de `once.test.ts` devuelve un `accessToken` en la metadata y comprueba
  que no llega a la base. `bossJobId` es un uuid, `metadata` lleva ids y
  conteos.
- **Sin ruta HTTP.** El camino recomendado no abre ningún endpoint: no
  hay secreto en cabecera que comparar. Si algún día se usa Vercel Cron o
  `pg_net` contra una ruta, esa ruta tiene que exigir un secreto en
  cabecera y compararlo con `timingSafeEqual`; queda escrito aquí para
  quien la haga.
- **Credenciales en GitHub.** Solo en *secrets* del repositorio (nunca en
  el YAML, que solo los nombra), con `permissions: contents: read`, y con
  el rol `mc_worker_login` (sin DDL) en vez de `mc_migrator`.

## 7. PARADA 2 · Encenderlo (cuando des el visto bueno y lo acuerdes con Rasheed)

1. §1.1 (Rasheed o tú con tu token): crear `mc_worker_login`, y la
   comprobación de solo lectura.
2. `WORKER_DATABASE_URL` al vault: `make db.unlock`, añadirla a
   `.env.local`, `make db.lock`.
3. Prueba local, **antes** de GitHub:
   ```bash
   cd platform && pnpm --filter @mc/worker once      # corre lo vencido contra Supabase
   pnpm --filter @mc/worker salud
   make db.sql Q="select job_id, status, attempt, items_processed, error from job_run order by id desc limit 20"
   ```
   Se espera `oauth.refresh ok`, los `collect.*` en `ok` (Instagram y
   YouTube saltados con aviso mientras falten sus credenciales),
   `compute.*` encadenados, `finance.reminders ok`, y las definiciones
   sin handler en `skipped / sin handler`, una fila cada una.
4. Secretos del repositorio en GitHub (Settings → Secrets and variables
   → Actions): `WORKER_DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `APP_URL`,
   `TIKTOK_LOGIN_CLIENT_KEY`, `TIKTOK_LOGIN_CLIENT_SECRET` (y cuando
   existan, `INSTAGRAM_HOUSE_TOKEN`, `GOOGLE_API_KEY`). Las de TikTok y
   `APP_URL` hoy solo están en Vercel: `./scripts/vercel.sh run env pull`
   a un archivo temporal fuera del repo, copiarlas y borrarlo.
5. Variable de repositorio `WORKER_ONCE=on` y una corrida a mano
   (Actions → «Worker · una pasada» → Run workflow). En verde:
   descomentar `schedule` en `.github/workflows/worker-once.yml`, commit
   `WRK: enciende el worker cada hora` y push a `main`.
6. Al día siguiente: `pnpm --filter @mc/worker salud` debe decir
   «Datos al <hoy>» y Resumen, «Datos hasta el <ayer>».

Para apagarlo: `WORKER_ONCE` a cualquier otro valor (efecto inmediato).

## 8. Decisiones pendientes de Nicolás

| Archivo:línea | Pregunta | Lo que quedó | Recomendación | Si dices lo contrario |
|---|---|---|---|---|
| WRK.md §3 | ¿(a), (b) o (c)? | (b) implementado y apagado | (b) | (a): un Dockerfile (~40 líneas) y §1.2; `--once` queda para pruebas |
| `.github/workflows/worker-once.yml` | ¿Cada hora o cada 30 min? | cada hora, margen 120 min | cada hora (cabe en los minutos gratis) | cada 30 min: `cron: '17,47 * * * *'`, ~2 880 min/mes, ~5 USD |
| `apps/worker/src/runner/once.ts` | ¿Un reintento fallido espera a la pasada siguiente (1 h) o se reintenta dentro de la misma? | la siguiente | la siguiente: no alarga la pasada y el cron no se apila | reintento dentro: un bucle de `maxAttempts` alrededor de `executeRun` (~15 líneas) |
| `packages/db/src/queries/worker.ts` | ¿Enseñar la salud del worker en la web? | no; Resumen ya dice «Datos hasta el…» | no por ahora | migración con una función `SECURITY DEFINER` que devuelva solo `job_id, last_ok_at`, un permiso y un componente en Resumen (M) |

## 9. Fuera de alcance

SMTP y el envío de correos (CIM-10); jobs nuevos (`trait_lift`,
`report.generate`, `video.*`, `outbound.dispatch`, `radar.scan`,
`watch.*` siguen sin handler y quedan `skipped / sin handler`); la CI en
Node 22 y conectar GitHub con Vercel (CIM-7, Rasheed); las credenciales
de Instagram y YouTube (§0.2 punto 2 del plan, Nicolás).
