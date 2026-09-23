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
-- (0024, 0026, 0030, 0037 §7.4). Sin este archivo, en un Postgres
-- local las crea el superusuario y mc_app nace sin ningún privilegio:
-- la guardia (src/esquema.ts) no ve ninguna política abierta ni ningún
-- único global que mc_app pueda alcanzar, da por cerradas las
-- excepciones declaradas («sobran excepciones declaradas») y las
-- pruebas de esquema.test.ts fallan. No era la guardia: era la base.
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
