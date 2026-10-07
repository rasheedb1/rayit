-- =====================================================================
-- Seed 11 · «Lo que importa esta semana» en la demo (RES-3)
-- ---------------------------------------------------------------------
-- El bloque de arriba de /resumen lee los avisos que dejan los
-- productores (compute.post_score, los recolectores, finance.reminders,
-- sales.follow_ups). En la demo no corre ningún turno del worker, así que
-- sin este seed quien clona veía siempre «Todo en orden esta semana» y
-- nunca la pieza que encabeza el Resumen.
--
-- Deja UN aviso de cada fuente, con la forma EXACTA de su productor
-- (kind, severity, entity_type, action_url, user_id) y sobre cosas del
-- seed que, de verdad, siguen pidiendo atención:
--
--   1 · Cuenta: la página de Facebook de Laura (c4) pasa a needs_reauth
--       —el portafolio de negocio le quitó el permiso de estadísticas— y
--       lleva el aviso crítico que escribe markNeedsReauth. Es la de
--       business_portfolio: ningún recolector de la demo la lee, así que
--       su estado no cambia ninguna otra cifra. Ni el título ni el detalle
--       prometen «vuelve a conectarla»: en la demo Conexiones no puede
--       reautorizar Facebook («Esta versión no puede reautorizarla desde
--       aquí»), y la fila más urgente no puede mandar a un callejón.
--   2 · Cobro: FV-2026-007 (Hogar Lindo, vencida hace 41 días, seed
--       0003) con el recordatorio del paso 4 (+21 días, «Segundo aviso
--       de mora») como lo deja finance.reminders, YA MANDADO: el seed
--       0003 dice que la factura lleva dos recordatorios y el último hace
--       tres días (reminders_sent, last_reminder_at), y su detalle en
--       Finanzas lo enseña así. El aviso se marca enviado ese mismo día
--       (read_at = last_reminder_at, como markReminderSent), y el bloque
--       lo dice: «… · recordatorio enviado el 4 oct». La factura sigue
--       en el bloque porque mandar el recordatorio no la cobra.
--   3 · Seguimiento: el negocio abierto con la acción vencida más
--       antigua, con el deal_overdue que deja sales.follow_ups el día
--       después del vencimiento, para su responsable.
--   4 · Video destacado: el video con mejor múltiplo de las últimas dos
--       semanas (o el mejor de todos, si no hay), con el aviso de
--       compute.post_score: breakout desde 5×, outlier desde 2×.
--   Y la quinta fuente, la cuenta de envío: el LinkedIn de Laura, que el
--   seed 0005 ya deja por reconectar, con su aviso de canales (3b).
--
-- Las tres últimas cosas se ELIGEN con los datos y no con un id fijo: la
-- demo se vuelve a sembrar semanas después (run.mjs, cuarta pasada) y el
-- negocio vencido o el video de la semana ya no son los mismos. Los
-- avisos sí tienen id fijo: sembrar dos veces no duplica nada.
--
-- Reglas del archivo (las de 0002, 0006 y 0010):
--   * Idempotente. UUID fijos; ON CONFLICT DO UPDATE devuelve el aviso a
--     su cosa y a su fecha relativa, sin leer (como la alerta de 0006).
--     No hay «Entendido» de la demo que limpiar: sin sesión el gesto
--     vive en el navegador de cada visitante y notification_ack no
--     guarda nada sin persona (0078, user_id NOT NULL). Un prospecto
--     que despacha las cinco filas no se las vacía a los demás.
--   * Con emailed_at puesto: son de la demo, el resumen por correo no
--     tiene por qué mandarlos.
--   * Solo el workspace de la demo. Requiere 0078 (migración) y los
--     seeds 0002 y 0003.
--
-- Mapa de identificadores (00000011-…):
--   …-0000000a1101   aviso de la cuenta (connection_error)
--   …-0000000a1102   aviso del cobro (invoice_overdue, paso 4)
--   …-0000000a1103   aviso del seguimiento (deal_overdue)
--   …-0000000a1104   aviso del video (outlier o breakout)
--   …-0000000a1105   aviso de la cuenta de envío (connection_error de canales)
-- =====================================================================

SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);
SELECT set_config('TimeZone', 'UTC', false);

-- ---------------------------------------------------------------------
-- 1 · La página de Facebook pide volver a autorizar
-- ---------------------------------------------------------------------
UPDATE social_connection
   SET status = 'needs_reauth',
       status_detail = 'El portafolio de negocio de Meta le quitó a On Cue el permiso de estadísticas de la página.',
       last_error_at = now() - interval '5 hours'
 WHERE id = '00000002-0000-4000-8000-0000000000c4';

-- El título es el de @mc/core connectionErrorTitle('Facebook', handle, 'reauth')
-- (packages/core/src/cuentas.ts), copiado a mano porque esto es SQL:
-- packages/db/test/resumen-semana.test.ts compara los dos, y
-- verify/0011.sql comprueba la forma.
INSERT INTO notification (id, workspace_id, user_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url,
                          created_at, emailed_at)
SELECT '00000011-0000-4000-8000-0000000a1101', c.workspace_id, NULL, 'connection_error', 'critical',
       'Facebook dejó de darnos las cifras de @' || c.handle, c.status_detail,
       'social_connection', c.id, '/conexiones', now() - interval '5 hours', now()
  FROM social_connection c
 WHERE c.id = '00000002-0000-4000-8000-0000000000c4'
ON CONFLICT (id) DO UPDATE SET title_es = EXCLUDED.title_es, body_es = EXCLUDED.body_es, created_at = EXCLUDED.created_at,
                               emailed_at = EXCLUDED.emailed_at, read_at = NULL, dismissed_at = NULL;

-- ---------------------------------------------------------------------
-- 2 · FV-2026-007: el segundo aviso de mora, ya mandado
-- ---------------------------------------------------------------------
-- El texto sigue a @mc/core redactarRecordatorio (paso 4, tono mora_2):
-- saludo, apertura, cifras, el bloque de pago (Laura no configuró cómo
-- le pagan, FIN-8) y el cierre; el enlace, el de urlRecordatorio. Las
-- cifras van como las formatea en es-CO, el locale de la demo.
WITH f AS (
  SELECT i.*, co.name AS empresa, ca.name AS campana, w.name AS creador,
         'COP ' || replace(to_char(i.total - i.paid_amount, 'FM999G999G999'), ',', '.') AS pendiente_txt,
         'COP ' || replace(to_char(i.total, 'FM999G999G999'), ',', '.') AS total_txt,
         extract(day FROM i.due_on)::int || ' de '
           || (ARRAY['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'])
                [extract(month FROM i.due_on)::int]
           || ' de ' || extract(year FROM i.due_on)::int AS vence_txt
    FROM invoice i
    JOIN company co  ON co.id = i.company_id
    JOIN workspace w ON w.id = i.workspace_id
    LEFT JOIN campaign ca ON ca.id = i.campaign_id
   WHERE i.id = '00000003-0000-4000-8000-0000fac26007'
)
INSERT INTO notification (id, workspace_id, user_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url,
                          created_at, emailed_at, read_at)
SELECT '00000011-0000-4000-8000-0000000a1102', f.workspace_id, NULL, 'invoice_overdue', 'warning',
       'Segundo aviso · factura ' || f.number || ' con 21 días de mora',
       concat_ws(E'\n',
         'Hola, equipo de ' || f.empresa || ':',
         '',
         'Este es el segundo aviso por la factura ' || f.number || ', que acumula 21 días de mora con un saldo de '
           || f.pendiente_txt || '. Si hay algo del lado de ustedes que esté deteniendo el trámite —una orden de compra, '
           || 'un soporte, un radicado— díganme y lo resuelvo hoy mismo.',
         '',
         '  Factura: ' || f.number,
         CASE WHEN f.campana IS NOT NULL THEN '  Campaña: ' || f.campana END,
         '  Venció: ' || f.vence_txt,
         '  Total de la factura: ' || f.total_txt,
         '',
         'Todavía no tienes datos de pago configurados, así que este correo no los incluye: escríbelos a mano antes de '
           || 'enviarlo, o configúralos una sola vez en Finanzas → Configuración → «Cómo te pagan» para que salgan solos.',
         '',
         'Gracias por la gestión,',
         f.creador),
       'invoice', f.id, '/finanzas/facturas/' || f.id || '?recordatorio=4',
       (f.due_on + 21)::timestamp + interval '14 hours', now(),
       -- Enviado cuando Finanzas dice que salió el último recordatorio; nunca
       -- antes de que el aviso exista.
       greatest(f.last_reminder_at, (f.due_on + 21)::timestamp + interval '14 hours')
  FROM f
ON CONFLICT (id) DO UPDATE SET title_es = EXCLUDED.title_es, body_es = EXCLUDED.body_es, created_at = EXCLUDED.created_at,
                               emailed_at = EXCLUDED.emailed_at, read_at = EXCLUDED.read_at, dismissed_at = NULL;

-- ---------------------------------------------------------------------
-- 3 · El seguimiento vencido más antiguo
-- ---------------------------------------------------------------------
-- Vencido como lo cuenta deal_pipeline (0043): next_action_due < now().
-- Se mira la tabla y no la vista porque la vista usa su propio now(), que
-- el reloj de run.mjs no mueve. El aviso nace una hora después del
-- vencimiento (sales.follow_ups corre por turnos), nunca en el futuro; va
-- al responsable de la acción, o al dueño del negocio, como CANDIDATOS de
-- apps/worker/src/jobs/ventas/seguimientos.ts. Textos: SEGUIMIENTOS_TEXTOS.
WITH vencido AS (
  SELECT d.id, d.workspace_id, d.company_id, d.name, btrim(d.next_action) AS accion, d.next_action_due,
         coalesce(d.next_action_user_id, d.owner_user_id) AS user_id, co.name AS marca
    FROM deal d
    JOIN pipeline_stage st ON st.id = d.stage_id
    JOIN company co ON co.id = d.company_id
   WHERE d.workspace_id = '00000002-0000-4000-8000-000000000001'
     AND NOT st.is_won AND NOT st.is_lost
     AND nullif(btrim(d.next_action), '') IS NOT NULL
     AND d.next_action_due < now()
   ORDER BY d.next_action_due, d.id
   LIMIT 1
)
INSERT INTO notification (id, workspace_id, user_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url,
                          created_at, emailed_at)
SELECT '00000011-0000-4000-8000-0000000a1103', v.workspace_id, v.user_id, 'deal_overdue', 'warning',
       format('Seguimiento vencido: %1$s · %2$s', v.accion, v.marca),
       format('Negocio «%1$s». Abre la ficha para registrar lo que pasó o moverle la fecha.', v.name),
       'deal', v.id, '/ventas/empresas/' || v.company_id,
       least(now(), v.next_action_due + interval '1 hour'), now()
  FROM vencido v
ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, title_es = EXCLUDED.title_es, body_es = EXCLUDED.body_es,
                               entity_id = EXCLUDED.entity_id, action_url = EXCLUDED.action_url,
                               created_at = EXCLUDED.created_at, emailed_at = EXCLUDED.emailed_at,
                               read_at = NULL, dismissed_at = NULL;

-- ---------------------------------------------------------------------
-- 3b · La cuenta de envío caída: el LinkedIn de Laura (seed 0005)
-- ---------------------------------------------------------------------
-- La cuenta ya está en needs_reconnect en el seed 0005, y la campana ya
-- tiene la alerta del día (0006, outreach_account_down). Aquí va el
-- aviso que dejan canales.keepalive y el webhook de Unipile al caer
-- (markChannelAccountDown), con el título de @mc/core CANALES_TEXTOS.down:
-- es la quinta fuente del bloque, la que frena las secuencias.
INSERT INTO notification (id, workspace_id, user_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url,
                          created_at, emailed_at)
SELECT '00000011-0000-4000-8000-0000000a1105', a.workspace_id, NULL, 'connection_error', 'critical',
       'Vuelve a conectar tu LinkedIn (' || a.display_name || ')',
       'LinkedIn cerró la sesión. Vuelve a conectar la cuenta desde Canales.',
       'outreach_channel_account', a.id, '/ventas/canales', least(now(), coalesce(a.last_error_at, now())), now()
  FROM outreach_channel_account a
 WHERE a.id = '00000005-0000-4000-8000-0000000ac002' AND a.status IN ('needs_reconnect', 'error')
ON CONFLICT (id) DO UPDATE SET title_es = EXCLUDED.title_es, body_es = EXCLUDED.body_es, created_at = EXCLUDED.created_at,
                               emailed_at = EXCLUDED.emailed_at, read_at = NULL, dismissed_at = NULL;

-- ---------------------------------------------------------------------
-- 4 · El video de la semana
-- ---------------------------------------------------------------------
-- El de mejor múltiplo (post_score.views_vs_median, ≥ 2×) entre los
-- publicados en las últimas dos semanas; si no hay, el mejor de todos.
-- Tramo y textos como compute.post_score (outlierTier y
-- textoNotificacion de apps/worker/src/jobs/conexiones/compute-post-score.ts):
-- breakout desde 5×. El aviso nace cuando el video cumplió el corte al
-- que se midió, y nunca antes de hace dos días: es «de esta semana».
WITH mejor AS (
  SELECT p.id, p.workspace_id, p.platform_id, s.views_vs_median AS x, s.age_hours_cut AS corte, p.published_at,
         coalesce(nullif(btrim(p.title), ''), nullif(btrim(p.caption), '')) AS nombre
    FROM post p
    JOIN post_score s ON s.post_id = p.id
   WHERE p.workspace_id = '00000002-0000-4000-8000-000000000001'
     AND NOT p.deleted_on_platform
     AND s.views_vs_median >= 2
   ORDER BY (p.published_at > now() - interval '14 days') DESC, s.views_vs_median DESC, p.id
   LIMIT 1
)
INSERT INTO notification (id, workspace_id, user_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url,
                          created_at, emailed_at)
SELECT '00000011-0000-4000-8000-0000000a1104', m.workspace_id, NULL,
       CASE WHEN m.x >= 5 THEN 'breakout' ELSE 'outlier' END, 'success',
       CASE WHEN m.x >= 5 THEN 'Se disparó: un video tuyo hizo ' ELSE 'Un video tuyo hizo ' END
         || replace(to_char(round(m.x, 1), 'FM9990.0'), '.', ',') || '× tu mediana',
       coalesce('«' || m.nombre || '»', 'Tu video') || ' va ' || replace(to_char(round(m.x, 1), 'FM9990.0'), '.', ',')
         || '× tu mediana en '
         || CASE m.platform_id WHEN 'tiktok' THEN 'TikTok' WHEN 'instagram' THEN 'Instagram' WHEN 'youtube' THEN 'YouTube' ELSE 'Facebook' END
         || '. Mira qué tuvo distinto para repetirlo.',
       'post', m.id, '/resumen',
       least(now(), greatest(m.published_at + make_interval(hours => m.corte), now() - interval '2 days')), now()
  FROM mejor m
ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, title_es = EXCLUDED.title_es, body_es = EXCLUDED.body_es,
                               entity_id = EXCLUDED.entity_id, created_at = EXCLUDED.created_at,
                               emailed_at = EXCLUDED.emailed_at, read_at = NULL, dismissed_at = NULL;
