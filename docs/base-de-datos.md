# La base de datos

Escrito el 20 de septiembre de 2026, al conectar Supabase.

## Qué hay conectado

| | |
|---|---|
| Proveedor | Supabase |
| Proyecto | `autlbeccerunvetptywe` · región `ca-central-1` |
| Postgres | 17.6 |
| Estado | 13 migraciones aplicadas · 88 tablas · 10 vistas · 212 índices |
| Panel | https://supabase.com/dashboard/project/autlbeccerunvetptywe |

`docs/arquitectura.md` decía Neon, y la fila decía que cambiaríamos a
Supabase "si terminamos usando su autenticación y su vault". Eso pasó
antes de lo previsto. Lo que perdemos es la rama de base por pull
request de Neon; lo que ganamos es no montar autenticación ni
almacenamiento de secretos por nuestra cuenta. Si las ramas por PR se
vuelven necesarias, Supabase tiene `supabase branches`, que cubre el
mismo caso con otro nombre.

## Cómo se conecta uno

```bash
cd platform
make db.unlock      # una vez por máquina: pide la frase de paso
make db.info
```

Eso es todo. Las credenciales viajan cifradas dentro del repositorio
(`platform/secrets/supabase.env.enc`); la frase de paso se pide una vez
y se guarda en el Llavero. El razonamiento completo está en
[platform/secrets/README.md](../platform/secrets/README.md).

## La conexión, en concreto

Todo va por el **pooler**. La conexión directa `db.<ref>.supabase.co`
es solo IPv6 y no resuelve desde una red IPv4 normal; no es un problema
que se pueda arreglar del lado del cliente.

| | Puerto | Modo | Para qué |
|---|---|---|---|
| `DATABASE_URL` | 6543 | transacción | La app. Aguanta muchas conexiones cortas |
| `DATABASE_URL_DIRECT` | 5432 | sesión | Migraciones: sentencias preparadas y transacciones largas |

Dos detalles que cuestan una tarde si no se saben:

- El **usuario lleva el ref pegado**: `mc_app.autlbeccerunvetptywe`.
  Con solo `mc_app` el pooler rechaza la conexión.
- **TLS**: Supabase firma con su propia autoridad, que no está en el
  almacén del sistema. El certificado raíz está versionado en
  `platform/db/certs/supabase-root-2021.crt` (es público, caduca en
  2031) y `migrate.mjs` verifica contra él. La salida fácil sería
  `rejectUnauthorized: false`, que apaga la verificación y deja la
  conexión abierta a un intermediario. No lo hagas. Si el certificado
  caduca o cambia, `make db.cert` lo vuelve a bajar.

## Los roles, y por qué son tres

Supabase no deja alterar su rol `postgres` desde la API: es
privilegiado. Eso, que parecía un estorbo, empujó a la separación
correcta.

```
mc_migrator   dueño del esquema      CREATE / ALTER / DROP en public
   │                                 NO puede crear roles
   └─ crea las tablas, y todo lo que crea queda automáticamente
      accesible para mc_app y service_role (DEFAULT PRIVILEGES)

mc_app        la aplicación          SELECT / INSERT / UPDATE / DELETE
                                     NO puede tocar el esquema

mc_worker     el worker              NOLOGIN, BYPASSRLS
                                     se asume con SET ROLE desde mc_migrator
```

La app corre como `mc_app`. Un error en el código de la aplicación —un
`DROP TABLE` mal construido, una inyección que se cuele— no puede
borrar el esquema, porque ese rol simplemente no tiene el permiso.

`mc_migrator` tampoco puede crear roles, a propósito. Crear un rol es
una operación de administración, no de esquema, y pasa por el token que
no está en el repositorio:

```bash
cd platform
./scripts/supabase-admin.sh sql "CREATE ROLE lo_que_sea NOLOGIN"
```

## Romper el cristal

Las dos llaves que no se pueden regenerar —la frase de paso del vault y
`TOKEN_ENCRYPTION_KEY`— tienen una copia dentro de la propia base, en el
esquema `recuperacion`. Es para el día en que se pierda el Llavero de
macOS.

```bash
cd platform
./scripts/supabase-admin.sh recover
```

Sin el token de administración, el mismo dato sale del panel de
Supabase → SQL Editor, que corre como `postgres`:

```sql
select nombre, valor, para_que from recuperacion.llaves;
```

Ese esquema está cerrado a todo lo demás y así debe quedarse:
`mc_app` y `mc_migrator` reciben `permission denied` y no ven ni que
existe; `service_role` no llega por la API REST (`PGRST106`: el esquema
no está expuesto). Si alguna vez algo necesita leer de ahí, la respuesta
correcta casi siempre es que no debería.

No usamos `vault.decrypted_secrets`, el Vault propio de Supabase, por
una razón concreta: `service_role` tiene permiso de lectura sobre él y
ese permiso lo concedió `supabase_admin`, de modo que el rol `postgres`
—el más alto al que llegamos— no puede revocarlo. Como la llave
`service_role` vive en el servidor de producción, dejar ahí la frase de
paso habría encadenado dos fugas en una.

Esta copia no sustituye a un gestor de contraseñas: cubre perder el
Llavero, no perder el acceso a Supabase.

## Operaciones

```bash
make db.info                                 # estado
make db.sql Q="select * from platform"       # consulta (como mc_app)
make db.sql ADMIN=1 Q="alter table ..."      # como mc_migrator
make db.check                                # prueba el esquema sin tocar Supabase
make db.migrate                              # aplica lo pendiente
make db.seed                                 # catálogo base
make db.status                               # qué hay en el vault
```

### Una migración nueva

```bash
$EDITOR platform/db/migrations/0014_.....sql
make db.check      # Postgres embebido: rápido y sin consecuencias
make db.migrate
```

Las migraciones aplicadas son **inmutables**. El runner guarda un
checksum sha256 y aborta si un archivo ya aplicado cambió, con el
mensaje "ya aplicada pero el archivo CAMBIÓ". No es un obstáculo que
haya que rodear: significa que el esquema de tu máquina y el de la nube
divergieron, y la salida es una migración nueva, nunca editar la vieja.

## Cuando algo falla

| Síntoma | Qué pasa |
|---|---|
| `No hay credenciales descifradas` | Falta `make db.unlock` |
| `la frase de paso es incorrecta` | Pídesela a Rasheed; no está en el repo |
| `self-signed certificate in certificate chain` | Falta el CA: `make db.cert` |
| `getaddrinfo ENOTFOUND db.<ref>.supabase.co` | Estás usando la conexión directa. Usa el pooler |
| `Tenant or user not found` | Al usuario le falta `.<ref>`: `mc_app.autlbeccerunvetptywe` |
| `permission denied for schema public` | Estás como `mc_app` e intentas DDL. Usa `ADMIN=1` |
| `permission denied to create role` | Ni `mc_app` ni `mc_migrator` crean roles. Usa `supabase-admin.sh` |
| `ya aplicada pero el archivo CAMBIÓ` | Editaste una migración aplicada. Crea una nueva |

## Lo que falta

- **RLS está definido pero no probado con usuarios reales.** La
  migración 0010 crea las políticas y la función
  `current_setting('app.workspace_id')`. Nadie ha verificado todavía que
  un workspace no pueda leer los datos de otro. Es la primera prueba de
  integración que hay que escribir, antes de que entren datos de
  clientes.
- **Backups**: Supabase hace backup diario en el plan gratuito, con
  siete días de retención y sin point-in-time recovery. Para datos de
  clientes reales eso es poco.
- **El plan gratuito pausa el proyecto tras una semana sin actividad.**
  Si el equipo se va de vacaciones, la base se duerme y hay que
  despertarla desde el panel.
