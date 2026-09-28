-- ¿Quedó el secreto del turno en claro en pg_stat_statements? (CIM-7)
--
-- Lo corren `make cron.install` (después de guardar el secreto) y
-- `make cron.status`, con el token de administración, solo si
-- extensions.pg_stat_statements existe (así lo trae Supabase).
--
-- Una llamada a vault.create_secret / update_secret de nivel superior
-- queda normalizada ($1, $2…); un bloque DO o cualquier otra forma
-- guarda el texto tal cual, con el valor dentro. Esta consulta cuenta las
-- que NO están normalizadas (sin mostrar su texto, que es justo lo que no
-- debe salir). Si da más de 0:
--
--   ./scripts/supabase-admin.sh sql "SELECT extensions.pg_stat_statements_reset()"
--
-- y rota el secreto (openssl rand -hex 32; `make cron.install` y el mismo
-- valor en Vercel): lo que ya estuvo en claro se da por visto.
SELECT count(*)::int AS literales
  FROM extensions.pg_stat_statements
 WHERE query ~* '(create|update)_secret\s*\('
   AND query !~ '\$[0-9]'
   AND query !~* 'pg_stat_statements';
