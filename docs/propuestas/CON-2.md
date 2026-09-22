# Propuesta CON-2 · lo que el worker necesita de Rasheed

Escrito para: Rasheed, dueño de `db/migrations/`, de los roles de
Supabase, de `.github/workflows/` y del despliegue (CIM-7).

Fecha: 21 de septiembre de 2026. Rama `nicolas/CON-2-worker-oauth-refresh`.

El worker está terminado y probado contra Postgres embebido con las
migraciones reales. **Estado al 21 de septiembre (noche):**

| Paso | Estado |
|---|---|
| 3.1 `CREATE SCHEMA pgboss` y `GRANT mc_worker TO mc_migrator` | **Pendiente: necesita el token de administración, que solo está en tu Llavero.** Son dos comandos. |
| 3.2 Migración `0014_worker_grants.sql` | **Aplicada** en Supabase (por indicación de Nicolás; `make db.check` y `make db.migrate` en verde). |
| 3.3 `pnpm --filter @mc/worker install-schema` | Pendiente: depende de 3.1. |
| 3.4 Variables en Railway/Fly | Pendiente de CIM-7; no hace falta ninguna variable nueva. |
| 3.5 CI en Node 22 + `test` | Pendiente, tuyo. |

Cuando corras los dos comandos de 3.1 y luego 3.3, `make worker` arranca
contra Supabase sin cambios de código.

---

## 1. Qué encontré al investigar los roles (y por qué la hipótesis no servía)

La hipótesis de la historia era: «el esquema `pgboss` lo crea
`mc_migrator` con `--install`, y en operación normal el worker usa
`mc_app` + `SET ROLE mc_worker`». Comprobado contra Supabase (solo
lectura, `make db.sql ADMIN=1`), el 21 de septiembre:

| Comprobación | Resultado | Consecuencia |
|---|---|---|
| `has_database_privilege('mc_migrator', db, 'CREATE')` | **false** | `mc_migrator` no puede `CREATE SCHEMA pgboss`. Tampoco `mc_app`. Solo `postgres`. |
| `has_schema_privilege('mc_migrator', 'public', 'CREATE')` | true | Dentro de `public` sí crea tablas: por eso las migraciones funcionan. |
| Miembros de `mc_worker` (`pg_auth_members`) | solo `postgres` | Ni `mc_app` ni `mc_migrator` pueden hacer `SET ROLE mc_worker` hoy. `docs/base-de-datos.md` dice «se asume con SET ROLE desde mc_migrator», pero esa membresía no existe. |
| `has_table_privilege('mc_worker', 'job_run', 'INSERT')` | **false** | `mc_worker` existe (0010) con `BYPASSRLS`, pero sin ningún privilegio sobre las tablas. Aunque pudiera asumirse, no podría leer `job_definition`. |
| `has_schema_privilege('mc_worker', 'public', 'USAGE')` | true | El esquema sí lo ve. |
| Esquema `pgboss` | no existe | Hay que crearlo. |

Y una razón para **no** hacerlo con `mc_app`: si `mc_app` fuera miembro
de `mc_worker`, cualquier inyección SQL en la web podría ejecutar
`SET ROLE mc_worker` y saltarse RLS. La app no debe poder llegar a ese
rol ni por accidente.

## 2. Cómo queda entonces

```
DATABASE_URL_DIRECT (mc_migrator, pooler :5432, modo sesión)
   │
   ├─ pool de pg-boss ──── corre como mc_migrator, dueño del esquema pgboss
   │                       (solo toca pgboss.*; nunca las tablas de negocio)
   │
   └─ pool de los jobs ─── tras conectar: SET ROLE mc_worker (BYPASSRLS)
                           (job_run, social_connection, api_call_log, notification…)
```

- **Modo sesión, no transacción.** `SET ROLE` es estado de sesión y
  pg-boss mantiene conexiones vivas: por el pooler de transacción
  (`:6543`) ambas cosas se rompen en silencio. El worker rechaza una URL
  con `:6543` al arrancar y usa `DATABASE_URL_DIRECT`. Cuando exista un
  rol de login propio, `WORKER_DATABASE_URL` la sustituye sin cambiar
  código.
- **Fallo ruidoso, no degradado.** Si `SET ROLE mc_worker` falla, el
  worker no arranca. La alternativa, correr como `mc_migrator`, sería
  peor de lo que parece: las tablas tienen `FORCE ROW LEVEL SECURITY`,
  así que el dueño también está sujeto a RLS, y sin `app.workspace_id`
  vería **cero filas**: renovaría cero tokens y reportaría `ok`.
- **`SET ROLE`, no `SET LOCAL`.** Se hace una vez por conexión del pool
  de jobs y se marca el cliente; una conexión en la que falle se destruye
  en vez de volver al pool.

## 3. Lo que hace falta, en orden

### 3.1 Con el token de administración (`scripts/supabase-admin.sh`) · una vez

Son operaciones de administración, no de esquema: no pueden ir en una
migración porque `mc_migrator` no tiene `ADMIN OPTION` sobre `mc_worker`
ni `CREATE` sobre la base.

```bash
cd platform
./scripts/supabase-admin.sh sql "CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION mc_migrator"
./scripts/supabase-admin.sh sql "GRANT mc_worker TO mc_migrator"
```

Con `AUTHORIZATION mc_migrator`, pg-boss (que corre como `mc_migrator`)
crea y migra sus tablas dentro del esquema sin más permisos. El worker
arranca con `createSchema: false` y `migrate: false`; la instalación se
hace aparte (3.3).

**Mejor todavía, si tienes cinco minutos más:** un rol de login propio
para el worker, para que ni siquiera lleve el poder de `mc_migrator`
sobre `public`:

```bash
./scripts/supabase-admin.sh sql "CREATE ROLE mc_worker_login LOGIN PASSWORD '<generada>' NOINHERIT"
./scripts/supabase-admin.sh sql "GRANT mc_worker TO mc_worker_login"
./scripts/supabase-admin.sh sql "ALTER SCHEMA pgboss OWNER TO mc_worker_login"
./scripts/supabase-admin.sh sql "GRANT USAGE ON SCHEMA public TO mc_worker_login"
```

y en el vault `WORKER_DATABASE_URL=postgres://mc_worker_login.<ref>:…@aws-0-ca-central-1.pooler.supabase.com:5432/postgres`.
El código ya lo contempla; solo cambia la variable. Recuerda el ref
pegado al usuario, igual que `mc_app.autlbeccerunvetptywe`.

### 3.2 Migración `0014_worker_grants.sql` · YA APLICADA

Privilegios de fila para `mc_worker`, los mismos que tiene `mc_app`.
Los concede `mc_migrator` porque es dueño de las tablas; no necesita
`CREATEROLE`. Está en `db/migrations/0014_worker_grants.sql` y aplicada
en Supabase el 21 de septiembre (14 migraciones en `schema_migrations`).
Las pruebas del worker aplican las 14 migraciones sobre pglite y corren
como `mc_worker`; si faltara un privilegio, fallan. Comprobado después
de aplicarla: `has_table_privilege('mc_worker', 'job_run', 'INSERT')` es
`true`. (El comentario del archivo menciona una copia en
`apps/worker/test/fixtures/`; esa copia ya no existe porque el embebido
aplica la migración real, y el archivo no se edita por ser inmutable.)

Contenido, para que lo revises:

```sql
GRANT USAGE ON SCHEMA public TO mc_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mc_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mc_worker;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO mc_worker;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mc_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO mc_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO mc_worker;
```

Las `DEFAULT PRIVILEGES` sin `FOR ROLE` aplican al rol que corrió la
migración (`mc_migrator`), que es justo quien creará las tablas futuras.

### 3.3 Instalar el esquema de pg-boss · una vez por base

```bash
cd platform
pnpm --filter @mc/worker install-schema     # usa DATABASE_URL_DIRECT de .env.local
```

Crea las tablas de pg-boss 12 (versión de esquema 42) dentro de
`pgboss` y sale. Es idempotente: si pg-boss sube de versión, el mismo
comando migra. En Docker local (`make up`) no hace falta 3.1: el
usuario `mc` es superusuario y el comando crea también el esquema.

### 3.4 Variables en el vault y en Railway/Fly (CIM-7)

El worker no necesita ninguna variable nueva para arrancar: usa
`DATABASE_URL_DIRECT`, que ya está en el vault. Para el despliegue:

| Variable | Valor | Notas |
|---|---|---|
| `DATABASE_URL_DIRECT` | la del vault | modo sesión (:5432). **No** `DATABASE_URL` (:6543). |
| `WORKER_DATABASE_URL` | opcional | si se crea `mc_worker_login` (3.1) |
| `PGSSLROOTCERT` | opcional | por defecto usa `db/certs/supabase-root-2021.crt` del repo; en un contenedor basta con que el repo esté ahí |
| `LOG_LEVEL` | `info` | `LOG_FORMAT` queda en `json` para que Railway/Fly lo indexe |
| `WORKER_STOP_TIMEOUT_S` | `30` | dale al contenedor al menos ese tiempo de gracia en SIGTERM |
| `TOKEN_ENCRYPTION_KEY`, `TIKTOK_*`, `META_*`, `GOOGLE_*` | del vault | las leerán los refreshers reales (CON-3, CON-8); hoy no se usan |

Comando de arranque: `pnpm --filter @mc/worker start` (Node ≥ 22.12,
que exige pg-boss 12; no hay paso de build: Node ejecuta el TypeScript
con type stripping). Un solo proceso alcanza para el MVP; con
`WORKER_GROUPS=collect,connections` se pueden repartir grupos entre
varios procesos más adelante.

### 3.5 CI (`.github/workflows/ci.yml`)

Dos ajustes pequeños, tuyos:

1. El job `lint` usa Node 20. El worker pide `>=22.12.0` (pg-boss 12) y
   `node --experimental-strip-types`, así que `typecheck` pasa pero
   `test` no correría ahí. Propongo `node-version: 22` en ese job (la
   web funciona igual en 22).
2. Agregar `test` al comando: `pnpm turbo run typecheck lint test`. Las
   pruebas del worker (~17 s) y de `@mc/connectors` (<1 s) corren sobre
   pglite, sin servicio de base de datos ni Docker, igual que la
   verificación de migraciones.

## 4. Dependencias agregadas (para el daily)

| Paquete | Dónde | Peso | Para qué |
|---|---|---|---|
| `pg-boss@^12.33.4` | `apps/worker` | 1,0 MB desempaquetado; trae `cron-parser`, `rrule-temporal`, `serialize-error` | la cola. Elegido v12 porque es la que trae `fromPglite`/`backend: 'pglite'` y `createSchema: false` |
| `@types/pg` | `apps/worker` (dev) | pequeño | tipos del driver que ya estaba en la raíz |
| `eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin` | `apps/worker` (dev) | ya estaban en el lockfile por `apps/web` | `lint` del worker con `no-console` y `no-floating-promises` |
| `@electric-sql/pglite@^0.2.17` | `apps/worker` (dev) | ya estaba en la raíz, misma versión | pruebas y `--demo` |

No se agregó `tsx`: Node 24 ejecuta TypeScript directamente y
`packages/core` ya usa `--experimental-strip-types`. Tampoco `dotenv`
(`--env-file-if-exists`) ni `pino` (logger propio de 120 líneas con
redactor, que era el requisito).

## 5. Decisiones que conviene que sepas

- **Una cola de pg-boss por `job_definition.id`**, no por
  `job_definition.queue`. `work()` no puede filtrar por payload: con una
  cola `collect` compartida, `collect.posts` (4 en paralelo, 300 s) y
  `collect.demographics` (2, 300 s) tendrían que compartir concurrencia,
  timeout y reintentos, y un `stately` para uno frenaría al otro.
  `queue` queda como grupo lógico (`WORKER_GROUPS`).
- **Los jobs con cron son colas `stately`** (un tick en cola, uno
  activo): dos corridas de `oauth.refresh` no se solapan ni se apilan.
  `max_concurrency` es la concurrencia por plataforma dentro de la
  corrida, como dice el comentario de 0009, no el número de corridas.
- **Los tokens no pasan por la base ni por pg-boss.** El payload del
  cron es `{ job, source }`; `job_run.metadata` lleva ids; el logger
  redacta por nombre de llave y por forma (`OAuthTokens`). Hay prueba de
  que ni el token viejo ni el renovado aparecen en `job_run`,
  `pgboss.job` ni en los logs.
- **`needs_reauth` genera una fila en `notification`** (`kind =
  'connection_error'`, `severity = 'critical'`, `action_url =
  '/conexiones'`). RES-3 («lo que importa esta semana») la puede leer
  tal cual.
- **Con `TOKEN_REFRESHER=real` (el valor por defecto), `oauth.refresh`
  hoy falla como transitorio** para todas las plataformas: los
  refreshers de TikTok e Instagram son CON-3 y el de YouTube CON-8. Como
  no hay conexiones en la base, no pasa nada; cuando las haya, ya estará
  el real. `fake` es solo para desarrollo y lo avisa en el log.

## 6. Qué no hice y por qué

- La migración `0014` sí entró en `db/migrations/` y se aplicó, por
  indicación expresa de Nicolás para no esperar; es solo `GRANT`, sin
  cambios de esquema. `.github/workflows/` y `Makefile` no se tocaron.
- No pude correr 3.1: el token de administración no está en esta
  máquina (`scripts/supabase-admin.sh` lo dice). Sin él, ni
  `CREATE SCHEMA` ni la membresía de `mc_worker` son posibles desde
  `mc_migrator`.
- No corrí nada de escritura contra Supabase: las comprobaciones de la
  sección 1 son `SELECT` sobre catálogos.
- No hay `packages/db` todavía (CIM-2), así que el worker se conecta con
  `pg` directamente. Queda un `TODO(CIM-2)` en `src/runner/db.ts` para
  migrar al cliente compartido cuando exista.
