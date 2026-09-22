-- =====================================================================
-- 0014 · Privilegios del rol mc_worker (CON-2)
-- ---------------------------------------------------------------------
-- mc_worker existe desde 0010 con NOLOGIN y BYPASSRLS, pero sin ningún
-- privilegio sobre las tablas: no podía ni leer job_definition. El
-- worker lo asume con SET ROLE tras conectar, así que necesita lo mismo
-- que mc_app sobre las filas, y nada sobre el esquema.
--
-- Corre como mc_migrator, dueño de las tablas, por lo que puede
-- conceder estos GRANTs sin CREATEROLE. Lo que NO puede hacer una
-- migración es `GRANT mc_worker TO mc_migrator` (hace falta ADMIN
-- OPTION sobre mc_worker, que solo tiene postgres) ni crear el esquema
-- pgboss: eso va por scripts/supabase-admin.sh (docs/propuestas/CON-2.md).
--
-- El worker aplica esta misma migración en sus pruebas sobre pglite
-- (copia en apps/worker/test/fixtures/) tras las 13 anteriores.
-- =====================================================================

GRANT USAGE ON SCHEMA public TO mc_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mc_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mc_worker;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO mc_worker;

-- Las tablas que cree mc_migrator de aquí en adelante heredan lo mismo.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mc_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO mc_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO mc_worker;
