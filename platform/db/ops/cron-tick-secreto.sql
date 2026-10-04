-- =====================================================================
-- El secreto del disparador del worker por turnos (CIM-7), en Supabase
-- Vault. El mismo valor que CRON_SECRET en Vercel.
--
-- PLANTILLA: el marcador del secreto lo rellena db/ops/render.mjs desde
-- el entorno, y scripts/cron-tick.sh la manda en una llamada PROPIA a la
-- API de administración, sin nada más en el mismo mensaje:
--
--   · Solo dos SELECT de nivel superior. pg_stat_statements (activo en
--     Supabase, visible en Query Performance) normaliza sus literales a
--     $1, $2…; el cuerpo de un bloque DO, en cambio, se guarda tal cual,
--     con el secreto dentro. Por eso aquí no hay DO.
--   · Si una sentencia falla, Postgres registra el mensaje ENTERO en su
--     log (log_min_error_statement), también visible desde el panel. Con
--     el secreto aparte, un fallo de pg_cron o de pg_net (cron-tick.sql)
--     no puede arrastrarlo al log; y cron-tick.sql comprueba antes que
--     Vault está, para que estas dos no tengan de qué fallar.
--
-- Después, `make cron.status` mira en pg_stat_statements que no haya
-- quedado ningún literal (cron-tick-huellas.sql).
--
-- Idempotente: si el secreto existe se actualiza; si no, se crea. Rotar
-- es volver a correr `make cron.install` con el nuevo valor.
-- =====================================================================

SELECT vault.update_secret(id, '{{CRON_SECRET}}') FROM vault.secrets WHERE name = 'on_cue_cron_secret';

SELECT vault.create_secret('{{CRON_SECRET}}', 'on_cue_cron_secret',
         'Clave de la firma de /api/cron/tick (CIM-7). El mismo valor que CRON_SECRET en Vercel.')
 WHERE NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'on_cue_cron_secret');
