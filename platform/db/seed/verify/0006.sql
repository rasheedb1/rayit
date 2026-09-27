-- =====================================================================
-- Verificación del seed 0006 (entregabilidad de la demo, VEN-15).
-- ---------------------------------------------------------------------
-- Cómo correrlo:
--   Postgres embebido, sin tocar Supabase:
--     node db/seed/verify/run.mjs 0006
--   Contra una base con entregabilidad y los seeds, como quien migra:
--     node db/sql.mjs --admin -f db/seed/verify/0006.sql
--
-- Cada consulta con columna `ok` es una prueba: un false hace fallar
-- run.mjs. Lo que se cuida es que la demo enseñe la entregabilidad como
-- la dejarían los jobs: un rebote duro con su ficha marcada, uno blando
-- que no marca nada, y la alerta del día de la cuenta caída.
-- =====================================================================

SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);

-- (a) El rebote duro: casado con el correo que Laura envió (verified), y
--     la ficha de Natalia marcada con el diagnóstico del servidor.
SELECT 'a_rebote_duro' AS check_id,
       b.kind, b.status_code, b.verified, c.email_invalid, c.bounced, c.email_invalid_reason,
       b.kind = 'hard' AND b.verified AND b.status_code = '5.1.1'
         AND b.touch_id = '00000006-0000-4000-8000-000000070001'
         AND b.recipient_address = c.email
         AND c.email_invalid AND c.bounced AND c.email_invalid_reason LIKE '%5.1.1%'
         AND c.email_invalid_at IS NOT NULL AS ok
  FROM outbound_bounce b
  JOIN contact c ON c.id = b.contact_id
 WHERE b.id = '00000006-0000-4000-8000-0000000b0001';

-- (b) El blando se anota y no marca: Carolina respondió a ese correo.
SELECT 'b_rebote_blando' AS check_id,
       b.kind, b.status_code, c.email_invalid,
       b.kind = 'soft' AND b.status_code = '4.2.2' AND NOT c.email_invalid AS ok
  FROM outbound_bounce b
  JOIN contact c ON c.id = b.contact_id
 WHERE b.id = '00000006-0000-4000-8000-0000000b0002';

-- (c) «Últimos rebotes» tiene los dos, del más reciente al más viejo, y
--     el correo que rebotó tiene su enlace de baja (como todo correo que
--     sale, 0046 §4.5).
SELECT 'c_ultimos_rebotes' AS check_id,
       (SELECT string_agg(kind, ',' ORDER BY detected_at DESC) FROM outbound_bounce) AS tipos,
       (SELECT string_agg(kind, ',' ORDER BY detected_at DESC) FROM outbound_bounce) = 'hard,soft'
         AND EXISTS (SELECT 1 FROM outbound_optout_link l
                      WHERE l.touch_id = '00000006-0000-4000-8000-000000070001'
                        AND l.recipient_address = 'natalia.velez@nutrive.co' AND l.sent_at IS NOT NULL) AS ok;

-- (d) La alerta del día: de hoy en la zona del workspace, sin leer, con
--     el enlace a /ventas/canales (donde se reconecta), y cuadra con la cuenta que
--     de verdad pide reconectar (seed 0005). No espera ningún correo.
SELECT 'd_alerta_del_dia' AS check_id,
       n.kind, n.action_url, n.read_at, n.emailed_at IS NOT NULL AS sin_correo_pendiente,
       n.kind = 'outreach_account_down' AND n.severity = 'critical'
         AND (n.created_at AT TIME ZONE 'America/Bogota')::date = (now() AT TIME ZONE 'America/Bogota')::date
         AND n.read_at IS NULL AND n.emailed_at IS NOT NULL
         AND n.action_url = '/ventas/canales'
         -- El nombre de la cuenta con su canal delante (channelAccountLabel), sin repetirlo.
         AND n.body_es LIKE 'No sale nada por LinkedIn: Laura Méndez hasta%'
         -- Se lee dentro de la política de envío: no manda a ella (r5).
         AND n.body_es NOT LIKE '%política de envío%'
         AND EXISTS (SELECT 1 FROM outreach_channel_account a
                      WHERE a.channel = 'linkedin' AND a.status = 'needs_reconnect'
                        AND a.display_name = 'Laura Méndez') AS ok
  FROM notification n
 WHERE n.id = '00000006-0000-4000-8000-0000000a1001';

-- (e) Los cuatro correos salieron el último día hábil, dentro de la
--     ventana de envío del espacio y en su zona (pulido r3): ninguno en
--     sábado ni domingo, ninguno fuera de send_window, ninguno en el
--     futuro, y ningún día hábil posterior en el que ya hubieran pasado.
--     Antes salían «hace 3 a 9 horas» del reloj, y sembrada un domingo la
--     demo enviaba en domingo. Si ese día es hoy, «Salud de hoy» los
--     cuenta: cuatro enviados en las últimas 24 horas y el rebote duro de
--     Natalia entre ellos (la cuenta de readAlertSignalCounts).
WITH ws AS (
  SELECT w.timezone AS tz,
         coalesce(p.send_window_start, time '09:00') AS ini,
         coalesce(p.send_window_end, time '17:00') AS fin
    FROM workspace w LEFT JOIN outbound_policy p ON p.workspace_id = w.id
   WHERE w.id = '00000002-0000-4000-8000-000000000001'
),
t AS (
  SELECT x.id, x.sent_at, x.claimed_at, (x.sent_at AT TIME ZONE ws.tz) AS local, ws.*
    FROM outbound_touch x, ws
   WHERE x.id IN ('00000006-0000-4000-8000-000000070001', '00000006-0000-4000-8000-000000070002',
                  '00000006-0000-4000-8000-000000070003', '00000006-0000-4000-8000-000000070004')
),
salud AS (
  SELECT (SELECT count(*) FROM outbound_touch x
           WHERE x.channel = 'email' AND x.status = 'sent'
             AND x.sent_at >= now() - interval '24 hours' AND x.sent_at < now()) AS enviados,
         (SELECT count(DISTINCT x.id) FROM outbound_touch x
            JOIN outbound_bounce b ON b.touch_id = x.id AND b.kind = 'hard'
           WHERE x.channel = 'email' AND x.status = 'sent'
             AND x.sent_at >= now() - interval '24 hours' AND x.sent_at < now()) AS duros
)
SELECT 'e_ultimo_dia_habil' AS check_id,
       min(t.local::date) AS dia, to_char(min(t.local), 'Dy HH24:MI') AS primero, to_char(max(t.local), 'Dy HH24:MI') AS ultimo,
       (SELECT enviados FROM salud) AS enviados_24h, (SELECT duros FROM salud) AS duros_24h,
       count(*) = 4
         AND count(DISTINCT t.local::date) = 1
         AND bool_and(extract(isodow FROM t.local) < 6)
         AND bool_and(t.local::time BETWEEN t.ini AND t.fin)
         AND bool_and((t.claimed_at AT TIME ZONE t.tz)::date = t.local::date)
         AND bool_and(t.sent_at < now())
         -- Ningún día hábil posterior, hasta hoy, en que los cuatro ya hubieran salido.
         AND NOT EXISTS (
           SELECT 1 FROM ws, generate_series(min(t.local::date) + 1, (now() AT TIME ZONE ws.tz)::date, interval '1 day') g
            WHERE extract(isodow FROM g) < 6
              AND ((g::date + max(t.local::time) + interval '30 minutes') AT TIME ZONE ws.tz) <= now())
         -- Si el día es hoy, «Salud de hoy» tiene cifras.
         AND (min(t.local::date) <> (now() AT TIME ZONE min(t.tz))::date
              OR ((SELECT enviados FROM salud) >= 4 AND (SELECT duros FROM salud) = 1)) AS ok
  FROM t;

-- (f) La política de la demo tiene una rampa que pintar (r4): un tope por
--     encima del inicio del calentamiento (20, @mc/core/outreach/warmup) y
--     días de calentamiento. Con 20 al día la pantalla solo decía que no
--     hacía falta calentar.
SELECT 'f_politica_con_rampa' AS check_id, p.max_emails_per_day, p.warmup_days,
       p.max_emails_per_day = 80 AND p.warmup_days = 14 AS ok
  FROM outbound_policy p
 WHERE p.workspace_id = '00000002-0000-4000-8000-000000000001';

-- (g) El Gmail de la demo tiene su buzón de rebotes leído hace poco (r5):
--     «Salud de hoy» no dice «todavía no leemos tus rebotes» encima de una
--     tabla con rebotes. Es la regla de readSendReadiness (BOUNCES_STALE_H
--     = 2 horas).
SELECT 'g_rebotes_leidos' AS check_id, a.bounces_read_at,
       a.bounces_read_at IS NOT NULL AND a.bounces_read_at > now() - interval '2 hours' AS ok
  FROM outreach_channel_account a
 WHERE a.id = '00000005-0000-4000-8000-0000000ac001';

-- (h) El LinkedIn caído guarda un código, no la jerga del proveedor:
--     «Salud de hoy» lo traduce («LinkedIn cerró la sesión.»).
SELECT 'h_motivo_como_codigo' AS check_id, a.last_error,
       a.last_error = 'unipile_status:CREDENTIALS' AS ok
  FROM outreach_channel_account a
 WHERE a.id = '00000005-0000-4000-8000-0000000ac002';
