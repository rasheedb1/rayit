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

-- (c) Los contadores de las cuentas de Laura son lo que el reclamo sumó
--     por los toques que la demo enseña: cada día, en la cuenta de su
--     canal, tantas acciones como toques reclamados (enviados o
--     fallidos) ese día local; en el correo, la fila del espacio igual a
--     la de la cuenta; cada semana, la suma de sus días; ningún día de
--     fin de semana. Ni una acción que no esté en el historial.
WITH reclamados AS (
  SELECT CASE t.channel WHEN 'email' THEN '00000005-0000-4000-8000-0000000ac001'::uuid
                        ELSE '00000005-0000-4000-8000-0000000ac002'::uuid END AS cuenta,
         (t.claimed_at AT TIME ZONE w.timezone)::date AS dia, count(*)::int AS n
    FROM outbound_touch t JOIN workspace w ON w.id = t.workspace_id
   WHERE t.workspace_id = '00000002-0000-4000-8000-000000000001'
     AND t.status IN ('sent', 'failed') AND t.claimed_at IS NOT NULL AND t.channel IN ('email', 'linkedin')
   GROUP BY 1, 2
),
dias AS (
  SELECT c.channel_account_id AS cuenta, c.period_start AS dia, c.count
    FROM outbound_counter c
   WHERE c.channel_account_id IN ('00000005-0000-4000-8000-0000000ac001', '00000005-0000-4000-8000-0000000ac002')
     AND c.period = 'day'
)
SELECT 'c_contadores_de_los_toques' AS check_id,
       (SELECT count(*) FROM dias) AS dias_con_uso,
       (SELECT sum(count) FROM dias) AS acciones,
       (SELECT count(*) FROM dias) > 0
         -- Los mismos días con las mismas cifras, en los dos sentidos.
         AND NOT EXISTS (SELECT cuenta, dia, count FROM dias EXCEPT SELECT cuenta, dia, n FROM reclamados)
         AND NOT EXISTS (SELECT cuenta, dia, n FROM reclamados EXCEPT SELECT cuenta, dia, count FROM dias)
         AND (SELECT bool_and(extract(isodow FROM dia) < 6) FROM dias)
         AND (SELECT bool_and(d.count = (SELECT w.count FROM outbound_counter w
                                          WHERE w.channel_account_id IS NULL
                                            AND w.workspace_id = '00000002-0000-4000-8000-000000000001'
                                            AND w.period = 'day' AND w.period_start = d.dia AND w.action_type = 'email'))
                FROM dias d WHERE d.cuenta = '00000005-0000-4000-8000-0000000ac001')
         AND (SELECT bool_and(c.count = (SELECT sum(d.count) FROM dias d
                                          WHERE d.cuenta = c.channel_account_id
                                            AND d.dia BETWEEN c.period_start AND c.period_start + 6))
                FROM outbound_counter c
               WHERE c.channel_account_id IN ('00000005-0000-4000-8000-0000000ac001', '00000005-0000-4000-8000-0000000ac002')
                 AND c.period = 'week') AS ok;

-- (d) El widget de uso casa con el historial: lo de hoy y lo de los 14
--     días de outbound_usage_daily es exactamente lo que el historial
--     enseña como reclamado esos días (hoy, los correos de 0006, que
--     salieron antes de que se apagara el envío), y las cuentas dicen que
--     el envío está apagado (outreach_enabled = false: «Sin envío»).
WITH reclamados AS (
  SELECT (t.claimed_at AT TIME ZONE w.timezone)::date AS dia
    FROM outbound_touch t JOIN workspace w ON w.id = t.workspace_id
   WHERE t.workspace_id = '00000002-0000-4000-8000-000000000001'
     AND t.status IN ('sent', 'failed') AND t.claimed_at IS NOT NULL AND t.channel IN ('email', 'linkedin')
),
uso AS (
  SELECT u.day, u.is_today, u.used, u.outreach_enabled
    FROM outbound_usage_daily u
   WHERE u.channel_account_id IN ('00000005-0000-4000-8000-0000000ac001', '00000005-0000-4000-8000-0000000ac002')
)
SELECT 'd_uso_casa_con_el_historial' AS check_id,
       (SELECT sum(used) FROM uso WHERE is_today) AS hoy,
       (SELECT sum(used) FROM uso) AS usado_14_dias,
       (SELECT sum(used) FROM uso WHERE is_today)
           = (SELECT count(*) FROM reclamados WHERE dia = (SELECT day FROM uso WHERE is_today LIMIT 1))
         AND (SELECT sum(used) FROM uso)
           = (SELECT count(*) FROM reclamados WHERE dia BETWEEN (SELECT min(day) FROM uso) AND (SELECT max(day) FROM uso))
         AND (SELECT sum(used) FROM uso) > 0
         AND (SELECT bool_and(NOT outreach_enabled) FROM uso) AS ok;
