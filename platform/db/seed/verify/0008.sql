-- =====================================================================
-- Verificación del seed 0008 (la actividad del outreach en la demo, VEN-16).
-- ---------------------------------------------------------------------
-- Cómo correrlo:
--   Postgres embebido, sin tocar Supabase:
--     node db/seed/verify/run.mjs 0008
--   Contra una base con 0065 y los seeds, como quien migra:
--     node db/sql.mjs --admin -f db/seed/verify/0008.sql
--
-- Cada consulta con columna `ok` es una prueba: un false hace fallar
-- run.mjs. Lo que se cuida es que /ventas/actividad y el widget de uso de
-- /ventas/canales tengan algo que enseñar en la demo, escrito como lo
-- dejarían el despachador y sus contadores.
-- =====================================================================

SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);

-- (a) La cola de la demo enseña dos fallidos: el LinkedIn de Camilo, que
--     no se ofrece para reintentar porque la cuenta está caída
--     (account_down), y el correo de Laura Quintero, que sí.
SELECT 'a_fallidos_de_la_demo' AS check_id,
       string_agg(q.contact_name || '=' || coalesce(q.retry_block, 'reintentable'), ', ' ORDER BY q.contact_name) AS fallidos,
       count(*) = 2
         AND bool_and(q.bucket = 'queue')
         AND count(*) FILTER (WHERE q.channel = 'linkedin' AND q.reason = 'account_auth' AND q.retry_block = 'account_down'
                                AND q.account_status = 'needs_reconnect') = 1
         AND count(*) FILTER (WHERE q.channel = 'email' AND q.reason = 'rejected' AND q.retry_block IS NULL
                                AND q.step_type = 'email') = 1 AS ok
  FROM outbound_queue q
 WHERE q.touch_id::text LIKE '00000008-%' AND q.status = 'failed';

-- (b) Los dos enrolamientos quedaron como los deja el motor cuando falla
--     su único toque vivo: completados, con su hora de fin.
SELECT 'b_enrolamientos_terminados' AS check_id,
       string_agg(e.status, ',' ORDER BY e.id) AS estados,
       bool_and(e.status = 'completed' AND e.finished_at IS NOT NULL)
         AND count(*) = 2 AS ok
  FROM outbound_enrollment e
 WHERE e.id::text LIKE '00000008-%';

-- (c) Los contadores del Gmail cuadran como los suma el reclamo: cada día
--     dentro del tope de la cuenta, la fila del espacio igual a la de la
--     cuenta (una sola cuenta de correo) y cada semana igual a la suma de
--     sus días. Y ningún día de fin de semana.
SELECT 'c_contadores_del_gmail' AS check_id,
       count(*) FILTER (WHERE c.period = 'day') AS dias,
       count(*) FILTER (WHERE c.period = 'day') >= 5
         AND bool_and(c.count BETWEEN 0 AND 20) FILTER (WHERE c.period = 'day')
         AND bool_and(extract(isodow FROM c.period_start) < 6) FILTER (WHERE c.period = 'day')
         AND bool_and(c.count = (SELECT w.count FROM outbound_counter w
                                  WHERE w.channel_account_id IS NULL AND w.workspace_id = c.workspace_id
                                    AND w.period = 'day' AND w.period_start = c.period_start AND w.action_type = 'email'))
               FILTER (WHERE c.period = 'day')
         AND bool_and(c.count = (SELECT sum(d.count) FROM outbound_counter d
                                  WHERE d.channel_account_id = c.channel_account_id AND d.period = 'day'
                                    AND d.period_start BETWEEN c.period_start AND c.period_start + 6))
               FILTER (WHERE c.period = 'week') AS ok
  FROM outbound_counter c
 WHERE c.channel_account_id = '00000005-0000-4000-8000-0000000ac001';

-- (d) El widget de uso tiene historia: en los 14 días de
--     outbound_usage_daily del Gmail hay uso, y un día llegó al tope.
SELECT 'd_uso_con_historia' AS check_id,
       sum(u.used) AS usado_14_dias, max(u.used) AS maximo,
       sum(u.used) > 0 AND max(u.used) = 20 AS ok
  FROM outbound_usage_daily u
 WHERE u.channel_account_id = '00000005-0000-4000-8000-0000000ac001';
