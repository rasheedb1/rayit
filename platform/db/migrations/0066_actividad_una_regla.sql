-- =====================================================================
-- 0066 · Actividad del outreach: una sola regla para el número del paso
--        y para «positivo» (VEN-16, ronda 4)
-- ---------------------------------------------------------------------
-- 0065 dejó dos reglas copiadas en varias vistas:
--
--   · el número de un paso dentro de su secuencia (row_number por
--     sequence_id, en el orden day_offset, order_in_day, id) estaba en
--     outbound_queue y en outbound_funnel_by_step. Si alguien cambiaba el
--     orden en una, la cola decía «Paso 3» de un toque que el embudo
--     contaba como paso 2;
--   · «positivo» (un enviado con una respuesta entrante clasificada como
--     interested) estaba escrito dos veces, en outbound_funnel_by_step y
--     en outbound_sequence_health, y ninguna de las dos pedía replied_at.
--     Un toque con una respuesta «me interesa» sin replied_at (una
--     importación, un reproceso, un «fuera de oficina» mal marcado)
--     contaba como positivo sin contar como respondido, y el embudo
--     crecía hacia abajo: más positivos que respondidos.
--
-- Esta migración las deja en un solo sitio y hace que las tres vistas
-- las usen. 0065 no se toca (una migración aplicada es inmutable): aquí
-- las vistas se reemplazan con las mismas columnas, en el mismo orden y
-- con el mismo tipo (CREATE OR REPLACE VIEW lo exige), así que nada de
-- lo que las lee cambia.
--
--   outbound_step_position      el número de cada paso en su secuencia.
--                               outbound_step_order_idx (0037) hace única
--                               la pareja (sequence_id, day_offset,
--                               order_in_day), así que el id solo
--                               desempata en teoría; el orden es el mismo
--                               que el de «un paso posterior» de
--                               outbound_touch_retry_block (0065) y el de
--                               la línea de tiempo de /ventas/cadencias.
--   outbound_touch_is_positive  enviado, respondido (replied_at) y con
--                               una respuesta entrante «interested». Por
--                               construcción, positivo ⊆ respondido ⊆
--                               enviado.
--
-- Reglas: las de 0065 (security_invoker en las vistas, SECURITY INVOKER
-- en la función, sin escritura para mc_app, solo estados que existen en
-- los CHECK).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · outbound_step_position
-- ---------------------------------------------------------------------
CREATE VIEW outbound_step_position WITH (security_invoker = on) AS
SELECT st.id AS step_id,
       st.workspace_id,
       st.sequence_id,
       row_number() OVER (PARTITION BY st.sequence_id ORDER BY st.day_offset, st.order_in_day, st.id)::int AS position
  FROM outbound_step st;

REVOKE INSERT, UPDATE, DELETE ON outbound_step_position FROM mc_app;
COMMENT ON VIEW outbound_step_position IS
  'El número de cada paso dentro de su secuencia (VEN-16, 0066), en el orden de la línea de tiempo: day_offset, '
  'order_in_day, id. Una sola definición: la usan outbound_queue y outbound_funnel_by_step.';

-- ---------------------------------------------------------------------
-- 2 · outbound_touch_is_positive
-- ---------------------------------------------------------------------
-- Positivo = enviado (status 'sent'), respondido (replied_at, que marca
-- la primera respuesta de verdad; un «fuera de oficina» no) y con al
-- menos una respuesta ENTRANTE de ese toque clasificada como interested
-- (outbound_message.intent). Pedir replied_at es lo que garantiza que el
-- embudo no crezca hacia abajo aunque una clasificación llegue sin él.
CREATE FUNCTION outbound_touch_is_positive(t outbound_touch)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT t.status = 'sent'
     AND t.replied_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM outbound_message m
                  WHERE m.touch_id = t.id AND m.direction = 'inbound' AND m.intent = 'interested');
$$;

REVOKE ALL ON FUNCTION outbound_touch_is_positive(outbound_touch) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbound_touch_is_positive(outbound_touch) TO mc_app, mc_worker;
COMMENT ON FUNCTION outbound_touch_is_positive(outbound_touch) IS
  'Un toque positivo (VEN-16, 0066): enviado, respondido (replied_at) y con una respuesta entrante clasificada como '
  'interested. Positivo ⊆ respondido ⊆ enviado. Con la RLS de quien llama.';

-- ---------------------------------------------------------------------
-- 3 · outbound_queue, con el número del paso de outbound_step_position
-- ---------------------------------------------------------------------
-- Las mismas columnas que en 0065, en el mismo orden. Solo cambia de
-- dónde sale step_position.
CREATE OR REPLACE VIEW outbound_queue WITH (security_invoker = on) AS
SELECT t.id AS touch_id,
       t.workspace_id,
       t.status,
       CASE WHEN t.status IN ('sent', 'canceled', 'skipped') THEN 'history' ELSE 'queue' END AS bucket,
       t.channel,
       t.subject,
       t.sequence_id,
       s.name AS sequence_name,
       t.step_id,
       st.step_type,
       sp.position AS step_position,
       st.day_offset AS step_day_offset,
       t.enrollment_id,
       e.status AS enrollment_status,
       t.contact_id,
       c.full_name AS contact_name,
       c.email AS contact_email,
       t.company_id,
       co.name AS company_name,
       t.channel_account_id,
       coalesce(a.display_name, a.provider_account_id) AS account_name,
       a.status AS account_status,
       t.attempt_count,
       t.scheduled_for,
       t.next_retry_at,
       coalesce(t.next_retry_at, t.scheduled_for) AS due_at,
       (t.status = 'scheduled' AND t.next_retry_at IS NOT NULL) AS retrying,
       t.status_changed_at,
       t.sent_at,
       t.opened_at,
       t.replied_at,
       t.created_at,
       CASE t.status
         WHEN 'held' THEN t.held_reason
         WHEN 'failed' THEN t.blocked_reason
         WHEN 'canceled' THEN t.blocked_reason
         WHEN 'skipped' THEN t.blocked_reason
         WHEN 'sent' THEN t.blocked_reason
       END AS reason,
       CASE WHEN t.status = 'failed' THEN outbound_touch_retry_block(t) END AS retry_block
  FROM outbound_touch t
  LEFT JOIN outbound_sequence s ON s.id = t.sequence_id
  LEFT JOIN outbound_step st ON st.id = t.step_id
  LEFT JOIN outbound_step_position sp ON sp.step_id = t.step_id
  LEFT JOIN outbound_enrollment e ON e.id = t.enrollment_id
  LEFT JOIN contact c ON c.id = t.contact_id
  LEFT JOIN company co ON co.id = t.company_id
  LEFT JOIN outreach_channel_account a ON a.id = t.channel_account_id;

-- ---------------------------------------------------------------------
-- 4 · outbound_funnel_by_step, con el paso y el positivo de una sola regla
-- ---------------------------------------------------------------------
--   positive  outbound_touch_is_positive: ahora pide replied_at, así que
--             positive ≤ replied ≤ sent en cada paso, siempre.
-- Lo demás, como en 0065.
CREATE OR REPLACE VIEW outbound_funnel_by_step WITH (security_invoker = on) AS
WITH toques AS (
  SELECT t.step_id,
         count(*)::int AS touches,
         count(*) FILTER (WHERE t.status = 'sent')::int AS sent,
         count(*) FILTER (WHERE t.status = 'sent' AND t.opened_at IS NOT NULL)::int AS opened,
         count(*) FILTER (WHERE t.status = 'sent' AND t.replied_at IS NOT NULL)::int AS replied,
         count(*) FILTER (WHERE outbound_touch_is_positive(t))::int AS positive,
         count(*) FILTER (WHERE t.status IN ('draft', 'scheduled', 'processing', 'held'))::int AS pending,
         count(*) FILTER (WHERE t.status = 'failed')::int AS failed,
         count(*) FILTER (WHERE t.status IN ('canceled', 'skipped'))::int AS stopped
    FROM outbound_touch t
   WHERE t.step_id IS NOT NULL
   GROUP BY t.step_id
)
SELECT st.workspace_id,
       st.sequence_id,
       s.name AS sequence_name,
       st.id AS step_id,
       sp.position AS step_position,
       st.step_type,
       st.channel,
       st.day_offset,
       st.order_in_day,
       (st.channel = 'email') AS opens_tracked,
       coalesce(x.touches, 0) AS touches,
       coalesce(x.sent, 0) AS sent,
       coalesce(x.opened, 0) AS opened,
       coalesce(x.replied, 0) AS replied,
       coalesce(x.positive, 0) AS positive,
       coalesce(x.pending, 0) AS pending,
       coalesce(x.failed, 0) AS failed,
       coalesce(x.stopped, 0) AS stopped,
       CASE WHEN coalesce(x.sent, 0) > 0 THEN round(x.opened::numeric / x.sent, 4) END AS open_rate,
       CASE WHEN coalesce(x.sent, 0) > 0 THEN round(x.replied::numeric / x.sent, 4) END AS reply_rate,
       CASE WHEN coalesce(x.sent, 0) > 0 THEN round(x.positive::numeric / x.sent, 4) END AS positive_rate
  FROM outbound_step st
  JOIN outbound_step_position sp ON sp.step_id = st.id
  JOIN outbound_sequence s ON s.id = st.sequence_id
  LEFT JOIN toques x ON x.step_id = st.id;

COMMENT ON VIEW outbound_funnel_by_step IS
  'El embudo de cada paso de cada secuencia (VEN-16, 0065; 0066): enviados, abiertos, respondidos y positivos (dentro '
  'de lo enviado; positivo = outbound_touch_is_positive, siempre dentro de lo respondido), lo que sigue en cola, lo '
  'fallido y lo detenido, con las tasas sobre lo enviado. El número del paso sale de outbound_step_position. Cuadra con '
  'outbound_touch fila a fila.';

-- ---------------------------------------------------------------------
-- 5 · outbound_sequence_health, con el positivo de una sola regla
-- ---------------------------------------------------------------------
-- Lo mismo que 0065; positive es outbound_touch_is_positive, así que la
-- salud y el embudo cuentan los mismos positivos.
CREATE OR REPLACE VIEW outbound_sequence_health WITH (security_invoker = on) AS
WITH toques AS (
  SELECT t.sequence_id,
         count(*) FILTER (WHERE t.status IN ('draft', 'scheduled', 'processing'))::int AS pending,
         count(*) FILTER (WHERE t.status = 'held')::int AS held,
         count(*) FILTER (WHERE t.status = 'failed')::int AS failed,
         count(*) FILTER (WHERE t.status = 'sent')::int AS sent,
         count(*) FILTER (WHERE t.status = 'sent' AND t.replied_at IS NOT NULL)::int AS replied,
         count(*) FILTER (WHERE outbound_touch_is_positive(t))::int AS positive,
         count(*) FILTER (WHERE t.status = 'sent' AND t.sent_at >= now() - interval '7 days')::int AS sent_7d,
         count(*) FILTER (WHERE t.status = 'failed' AND t.status_changed_at >= now() - interval '7 days')::int AS failed_7d,
         max(t.sent_at) FILTER (WHERE t.status = 'sent') AS last_sent_at,
         min(coalesce(t.next_retry_at, t.scheduled_for)) FILTER (WHERE t.status = 'scheduled') AS next_due_at
    FROM outbound_touch t
   WHERE t.sequence_id IS NOT NULL
   GROUP BY t.sequence_id
),
enrolados AS (
  SELECT e.sequence_id,
         count(*)::int AS enrolled,
         count(*) FILTER (WHERE e.status = 'active')::int AS active,
         count(*) FILTER (WHERE e.status IN ('paused', 'cooldown'))::int AS paused,
         count(*) FILTER (WHERE e.status = 'replied')::int AS replied,
         count(*) FILTER (WHERE e.status = 'completed')::int AS completed,
         count(*) FILTER (WHERE e.status IN ('opted_out', 'bounced'))::int AS stopped
    FROM outbound_enrollment e
   GROUP BY e.sequence_id
),
pasos AS (
  SELECT st.sequence_id, count(*)::int AS steps FROM outbound_step st GROUP BY st.sequence_id
),
todo AS (
  SELECT s.id AS sequence_id, s.workspace_id, s.name, s.status,
         coalesce(p.steps, 0) AS steps,
         coalesce(e.enrolled, 0) AS enrolled,
         coalesce(e.active, 0) AS enrolled_active,
         coalesce(e.paused, 0) AS enrolled_paused,
         coalesce(e.replied, 0) AS enrolled_replied,
         coalesce(e.completed, 0) AS enrolled_completed,
         coalesce(e.stopped, 0) AS enrolled_stopped,
         coalesce(x.pending, 0) AS pending,
         coalesce(x.held, 0) AS held,
         coalesce(x.failed, 0) AS failed,
         coalesce(x.sent, 0) AS sent,
         coalesce(x.replied, 0) AS replied,
         coalesce(x.positive, 0) AS positive,
         coalesce(x.sent_7d, 0) AS sent_7d,
         coalesce(x.failed_7d, 0) AS failed_7d,
         x.last_sent_at,
         x.next_due_at
    FROM outbound_sequence s
    LEFT JOIN pasos p ON p.sequence_id = s.id
    LEFT JOIN enrolados e ON e.sequence_id = s.id
    LEFT JOIN toques x ON x.sequence_id = s.id
)
SELECT t.*,
       CASE WHEN t.sent > 0 THEN round(t.replied::numeric / t.sent, 4) END AS reply_rate,
       CASE WHEN t.sent > 0 THEN round(t.positive::numeric / t.sent, 4) END AS positive_rate,
       CASE WHEN t.sent_7d + t.failed_7d > 0 THEN round(t.failed_7d::numeric / (t.sent_7d + t.failed_7d), 4) END AS failure_rate_7d,
       CASE
         WHEN t.status <> 'active' THEN 'inactive'
         WHEN t.failed_7d >= 3 AND t.failed_7d * 5 >= t.sent_7d + t.failed_7d THEN 'failing'
         WHEN t.failed > 0 OR t.held > 0 THEN 'attention'
         ELSE 'healthy'
       END AS health
  FROM todo t;

COMMENT ON VIEW outbound_sequence_health IS
  'La salud de cada secuencia (VEN-16, 0065; 0066): enrolamientos por estado, la cola viva, lo retenido y lo fallido, '
  'lo enviado y lo fallido en 7 días, las tasas sobre lo enviado (positivo = outbound_touch_is_positive, lo mismo que '
  'el embudo) y un semáforo (health: inactive, failing, attention, healthy).';
