-- =====================================================================
-- 0067 · Actividad del outreach: la cola dice si la cadencia está en
--        pausa (VEN-16, ronda 5)
-- ---------------------------------------------------------------------
-- La fila de /ventas/actividad promete «Sale mañana 8:12» a lo
-- programado. El despachador no lo manda si la cadencia no está activa
-- (outbound_sequence.status 'paused' o 'draft') o si la inscripción de
-- esa persona está en 'paused' o 'cooldown' (tras un «ahora no»):
-- decideBeforeSend (packages/db/src/queries/outreach/send.ts) lo aplaza
-- cada día con sequence_paused o enrollment_*, y la fecha de la fila
-- avanzaba día tras día sin que saliera nada.
--
-- La vista ya traía el estado de la inscripción (enrollment_status); le
-- faltaba el de la secuencia. Aquí se añade sequence_status AL FINAL:
-- CREATE OR REPLACE VIEW solo deja añadir columnas detrás de las que ya
-- tiene, con los mismos nombres, orden y tipos (0065 y 0066 no se tocan:
-- una migración aplicada es inmutable). Lo demás es la definición de
-- 0066, sin cambios.
--
-- Reglas: las de 0065 (security_invoker, sin escritura para mc_app, solo
-- estados que existen en los CHECK).
-- =====================================================================

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
       CASE WHEN t.status = 'failed' THEN outbound_touch_retry_block(t) END AS retry_block,
       -- 0067: el estado de la secuencia (draft, active, paused, archived); NULL si el toque no tiene.
       s.status AS sequence_status
  FROM outbound_touch t
  LEFT JOIN outbound_sequence s ON s.id = t.sequence_id
  LEFT JOIN outbound_step st ON st.id = t.step_id
  LEFT JOIN outbound_step_position sp ON sp.step_id = t.step_id
  LEFT JOIN outbound_enrollment e ON e.id = t.enrollment_id
  LEFT JOIN contact c ON c.id = t.contact_id
  LEFT JOIN company co ON co.id = t.company_id
  LEFT JOIN outreach_channel_account a ON a.id = t.channel_account_id;

-- CREATE OR REPLACE conserva los permisos; se repite la revocación de
-- 0065 para que la vista no dependa de haberla heredado.
REVOKE INSERT, UPDATE, DELETE ON outbound_queue FROM mc_app;
COMMENT ON VIEW outbound_queue IS
  'La cola y el historial del outreach (VEN-16, 0065; 0066; 0067): un toque por fila con su estado, su paso, su '
  'contacto, su cuenta (y el estado de esa cuenta), el estado de su secuencia (sequence_status) y de su inscripción '
  '(enrollment_status), el código de su motivo (reason) y, en lo fallido, por qué no se puede reintentar (retry_block, '
  'NULL si se puede). bucket = queue (draft, scheduled, processing, held, failed) o history (sent, canceled, skipped). '
  'La pantalla /ventas/actividad lee de aquí; nadie recalcula.';
