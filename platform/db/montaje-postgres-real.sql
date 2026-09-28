-- =====================================================================
-- El montaje de Supabase en un Postgres 16 cualquiera
-- ---------------------------------------------------------------------
-- Se corre UNA vez, como superusuario, sobre una base vacía y ANTES de
-- `node db/migrate.mjs`: lo hacen el job contra-postgres-real del CI,
-- `make up` con Docker y la receta de embedded-postgres del README de
-- @mc/db. No es una migración: en Supabase esto ya está hecho (los roles
-- los crea scripts/supabase-admin.sh y las DEFAULT PRIVILEGES son de
-- mc_migrator), y en PGlite lo hace src/embedded.ts.
--
-- Por qué hace falta. En Supabase las tablas las crea mc_migrator, y sus
-- DEFAULT PRIVILEGES le dan a mc_app los cuatro privilegios de fila al
-- nacer cada tabla; las migraciones solo QUITAN lo que no le toca
-- (0024, 0026, 0030, 0046 §7.4). Sin este archivo, en un Postgres
-- local las crea el superusuario y mc_app nace sin ningún privilegio:
-- la guardia (src/esquema.ts) no ve ninguna política abierta ni ningún
-- único global que mc_app pueda alcanzar, da por cerradas las
-- excepciones declaradas («sobran excepciones declaradas») y las
-- pruebas de esquema.test.ts fallan. No era la guardia: era la base.
--
-- Al final crea el rol de conexión de las pruebas, mc_app_ci (CIM-2c).
--
-- Idempotente: se puede volver a correr.
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mc_app') THEN
    CREATE ROLE mc_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mc_worker') THEN
    CREATE ROLE mc_worker NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mc_public_share') THEN
    CREATE ROLE mc_public_share NOLOGIN NOINHERIT;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO mc_app;

-- Lo mismo que src/embedded.ts: sin FOR ROLE, valen para lo que cree el
-- rol que corre este archivo, que es el que corre las migraciones.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO mc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO mc_app;

-- ---------------------------------------------------------------------
-- El rol de conexión de las pruebas (CIM-2c, pulido r6)
-- ---------------------------------------------------------------------
-- `mc_app_ci` es con quien se conectan las pruebas de @mc/db contra un
-- Postgres real (TEST_DATABASE_URL). Tiene que medir los privilegios de
-- mc_app y NADA más: hereda de mc_app y de nadie más.
--
-- Pero `asWorker` (src/client.ts) hace `SET LOCAL ROLE mc_worker` sobre
-- la misma conexión, así que el rol tiene que poder ASUMIR mc_worker.
-- Postgres 16 separa las dos cosas: `WITH INHERIT FALSE, SET TRUE` deja
-- asumirlo con SET ROLE sin heredar sus privilegios. Antes era un
-- `GRANT mc_worker TO mc_app_ci` a secas, que heredaba todo lo de
-- mc_worker (INSERT en todas las tablas, 0014): las pruebas de GRANT y
-- de RLS medían un rol que no existe en producción y 97 salían rojas.
--
-- Y cada sesión arranca COMO mc_app (`ALTER ROLE … SET role`), igual
-- que la web, que en Supabase entra con el usuario mc_app: current_user
-- es 'mc_app', que es lo que miran has_table_privilege, los candados
-- que nombran el rol (contact_optout_no_delete de 0055,
-- outbound_touch_guard_operator de 0072, recordWorkspaceOptOut) y la
-- guardia. Al terminar la transacción de asWorker, SET LOCAL vuelve a
-- mc_app.
--
-- Sin BYPASSRLS y sin ser dueño de nada: RLS aplica igual que a la web.
-- La contraseña es de una base de pruebas desechable (el CI, `make up`);
-- NUNCA se corre este archivo contra Supabase.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mc_app_ci') THEN
    CREATE ROLE mc_app_ci LOGIN PASSWORD 'ci' NOBYPASSRLS;
  END IF;
END $$;
GRANT mc_app TO mc_app_ci WITH INHERIT TRUE, SET TRUE;
GRANT mc_worker TO mc_app_ci WITH INHERIT FALSE, SET TRUE;
ALTER ROLE mc_app_ci SET role TO 'mc_app';
