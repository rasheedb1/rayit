-- =====================================================================
-- Verificación del seed 0011 («Lo que importa esta semana», RES-3).
-- ---------------------------------------------------------------------
-- Cómo correrlo:
--   Postgres embebido, sin tocar Supabase:
--     node db/seed/verify/run.mjs 0011
--
-- Cada consulta con columna `ok` es una prueba: un false hace fallar
-- run.mjs. Lo que se cuida es que la demo enseñe las CUATRO fuentes del
-- bloque de arriba de /resumen: un aviso de cada una, con la forma de su
-- productor, sobre una cosa que todavía cumple la regla de lectura de
-- packages/db/src/queries/resumen-semana.ts (la cuenta sigue caída, la
-- factura sigue vencida, el negocio sigue vencido y el aviso es de ese
-- compromiso, el video se avisó esta semana). Que la consulta de verdad
-- devuelva esas cuatro filas lo prueba, sobre el mismo seed,
-- packages/db/test/resumen-semana.test.ts («el seed de la demo…»).
--
-- Mira las tablas y no deal_pipeline: la vista usa su propio now(), que
-- el reloj de run.mjs (--dias) no mueve; con la tabla, el seed y la
-- verificación cuentan con el mismo reloj.
-- =====================================================================

SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);

-- (a) Un aviso de cada fuente, ni más ni menos, sin leer ni descartar.
SELECT 'a_un_aviso_por_fuente' AS check_id,
       count(*) FILTER (WHERE n.kind = 'connection_error' AND n.entity_type = 'social_connection') AS cuenta,
       count(*) FILTER (WHERE n.kind = 'invoice_overdue' AND n.entity_type = 'invoice')            AS cobro,
       count(*) FILTER (WHERE n.kind = 'deal_overdue' AND n.entity_type = 'deal')                  AS seguimiento,
       count(*) FILTER (WHERE n.kind IN ('outlier', 'breakout') AND n.entity_type = 'post')        AS video,
       count(*) = 4
         AND count(*) FILTER (WHERE n.kind = 'connection_error' AND n.entity_type = 'social_connection') = 1
         AND count(*) FILTER (WHERE n.kind = 'invoice_overdue' AND n.entity_type = 'invoice') = 1
         AND count(*) FILTER (WHERE n.kind = 'deal_overdue' AND n.entity_type = 'deal') = 1
         AND count(*) FILTER (WHERE n.kind IN ('outlier', 'breakout') AND n.entity_type = 'post') = 1
         AND bool_and(n.read_at IS NULL AND n.dismissed_at IS NULL AND n.created_at <= now()) AS ok
  FROM notification n
 WHERE n.id IN ('00000011-0000-4000-8000-0000000a1101', '00000011-0000-4000-8000-0000000a1102',
                '00000011-0000-4000-8000-0000000a1103', '00000011-0000-4000-8000-0000000a1104');

-- (b) La cuenta sigue caída y el aviso es el crítico de needs_reauth, con su enlace.
SELECT 'b_cuenta_caida' AS check_id, c.platform_id, c.status, n.severity, n.title_es,
       c.status = 'needs_reauth' AND c.deleted_at IS NULL AND n.severity = 'critical' AND n.action_url = '/conexiones'
         AND n.title_es = 'Vuelve a conectar tu cuenta de Facebook @' || c.handle AS ok
  FROM notification n
  JOIN social_connection c ON c.id = n.entity_id
 WHERE n.id = '00000011-0000-4000-8000-0000000a1101';

-- (c) La factura sigue abierta y vencida, y el aviso es el paso 4 de FIN-4.
SELECT 'c_cobro_vencido' AS check_id, i.number, i.status, CURRENT_DATE - i.due_on AS dias_de_mora, n.action_url,
       i.status IN ('sent', 'partial') AND i.due_on < CURRENT_DATE AND n.severity = 'warning'
         AND n.action_url = '/finanzas/facturas/' || i.id || '?recordatorio=4' AS ok
  FROM notification n
  JOIN invoice i ON i.id = n.entity_id
 WHERE n.id = '00000011-0000-4000-8000-0000000a1102';

-- (d) El negocio sigue abierto, con la acción vencida, y el aviso nació
--     después del vencimiento (es de ESE compromiso) y va a una persona.
SELECT 'd_seguimiento_vencido' AS check_id, d.name, d.next_action_due, n.created_at,
       NOT st.is_won AND NOT st.is_lost AND nullif(btrim(d.next_action), '') IS NOT NULL
         AND d.next_action_due < now() AND n.created_at >= d.next_action_due AND n.user_id IS NOT NULL
         AND n.action_url = '/ventas/empresas/' || d.company_id AS ok
  FROM notification n
  JOIN deal d ON d.id = n.entity_id
  JOIN pipeline_stage st ON st.id = d.stage_id
 WHERE n.id = '00000011-0000-4000-8000-0000000a1103';

-- (e) El video se avisó esta semana, en su tramo, y sigue publicado.
SELECT 'e_video_de_la_semana' AS check_id, n.kind, s.views_vs_median, n.created_at,
       NOT p.deleted_on_platform AND n.created_at >= now() - interval '7 days' AND n.severity = 'success'
         AND n.kind = CASE WHEN s.views_vs_median >= 5 THEN 'breakout' ELSE 'outlier' END
         AND s.views_vs_median >= 2 AS ok
  FROM notification n
  JOIN post p ON p.id = n.entity_id
  JOIN post_score s ON s.post_id = p.id
 WHERE n.id = '00000011-0000-4000-8000-0000000a1104';
