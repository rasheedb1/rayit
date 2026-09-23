-- =====================================================================
-- 0038 · Entregabilidad y cumplimiento del correo saliente (VEN-15)
-- ---------------------------------------------------------------------
-- Número: el siguiente libre en rasheed/integracion, que llega a 0037
-- (outreach). main ya aplicó en Supabase sus propias 0034–0039, así que
-- el integrador renumera todas las de integración después de esas; esta
-- no depende de ninguna de main y solo necesita ir después de 0037.
--
-- Qué trae:
--   1. contact.email_invalid: el correo de la ficha rebotó con un error
--      permanente (5.1.x). Con su motivo y su hora. Se borra solo cuando
--      alguien le cambia el correo a la ficha.
--   2. La regla: un correo no se programa a una ficha con el correo
--      inválido (outbound_touch_email_invalid). LinkedIn e Instagram sí:
--      un rebote dice que la dirección no existe, no que la persona pidió
--      no ser contactada. Por eso el rebote NO va a contact_suppression,
--      que corta todos los canales (0037 §4.1).
--   3. outbound_bounce: la bitácora de rebotes que lee el job
--      outbound.bounces del buzón del creador. Única por aviso del
--      buzón: leer dos veces el mismo buzón no cuenta dos rebotes.
--   4. Los dos jobs en job_definition y los cinco avisos nuevos de
--      notification (las alertas diarias del outreach).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · contact.email_invalid
-- ---------------------------------------------------------------------
ALTER TABLE contact
  ADD COLUMN email_invalid        boolean NOT NULL DEFAULT false,
  ADD COLUMN email_invalid_at     timestamptz,
  ADD COLUMN email_invalid_reason text CHECK (email_invalid_reason IS NULL OR length(email_invalid_reason) <= 300),
  ADD CONSTRAINT contact_email_invalid_check
    CHECK (NOT email_invalid OR (email_invalid_at IS NOT NULL AND email_invalid_reason IS NOT NULL));

COMMENT ON COLUMN contact.email_invalid IS
  'El correo de la ficha rebotó con un error permanente (VEN-15, job outbound.bounces). No se le programan correos; '
  'los otros canales siguen. Cambiar el correo de la ficha lo borra.';

-- Otro correo, otra historia: el rebote era de la dirección anterior.
CREATE FUNCTION contact_email_invalid_reset()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email AND NOT (NEW.email_invalid AND NOT OLD.email_invalid) THEN
    NEW.email_invalid := false;
    NEW.email_invalid_at := NULL;
    NEW.email_invalid_reason := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER contact_email_invalid_reset
  BEFORE UPDATE OF email ON contact
  FOR EACH ROW EXECUTE FUNCTION contact_email_invalid_reset();

-- ---------------------------------------------------------------------
-- 2 · Un correo no se programa a un correo inválido
-- ---------------------------------------------------------------------
-- Mira la ENTRADA en 'scheduled' (alta, o draft/held → scheduled al
-- aprobar), no el reclamo: el job de rebotes ya cancela lo programado,
-- y un reclamo que fallara tumbaría el lote entero del despachador. La
-- vuelta de 'processing' a 'scheduled' (un reintento del despachador)
-- tampoco se mira, por lo mismo; el siguiente paso del job la cancela.
-- La dirección que cuenta es la del envío si ya la tiene, y si no la de
-- la ficha: si el toque va a otra dirección, esa no rebotó.
CREATE FUNCTION outbound_touch_email_invalid()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  c record;
BEGIN
  IF NEW.channel <> 'email' OR NEW.status <> 'scheduled' OR NEW.contact_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('scheduled', 'processing') THEN
    RETURN NEW;
  END IF;
  SELECT x.email, x.email_invalid INTO c FROM contact x WHERE x.id = NEW.contact_id;
  IF FOUND AND c.email_invalid
     AND (NEW.recipient_address IS NULL OR NEW.recipient_address = c.email) THEN
    RAISE EXCEPTION 'El correo de la ficha % rebotó: no se le programan correos.', NEW.contact_id
      USING ERRCODE = 'check_violation',
            HINT = 'Corrige el correo de la ficha (eso borra la marca) o escríbele por otro canal.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbound_touch_email_invalid
  BEFORE INSERT OR UPDATE OF status ON outbound_touch
  FOR EACH ROW EXECUTE FUNCTION outbound_touch_email_invalid();

-- ---------------------------------------------------------------------
-- 3 · outbound_bounce: la bitácora de rebotes
-- ---------------------------------------------------------------------
--   provider_message_id  el id del AVISO de rebote en el buzón (Gmail):
--                        la llave de idempotencia por workspace.
--   touch_id             el correo que rebotó, si el aviso trae su
--                        Message-ID (outbound_touch.message_id_rfc) o, si
--                        no, el último enviado a esa dirección.
--   kind                 hard (la dirección no existe), soft (pasajero,
--                        buzón lleno), blocked (política o reputación
--                        del servidor que recibe: habla de quien envía).
-- Es una métrica: se inserta y no se corrige. La escribe el worker.
CREATE TABLE outbound_bounce (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_account_id   uuid REFERENCES outreach_channel_account(id) ON DELETE SET NULL,
  provider_message_id  text NOT NULL CHECK (length(provider_message_id) BETWEEN 1 AND 200),
  touch_id             uuid REFERENCES outbound_touch(id) ON DELETE SET NULL,
  contact_id           uuid REFERENCES contact(id) ON DELETE SET NULL,
  recipient_address    citext,
  kind                 text NOT NULL CHECK (kind IN ('hard', 'soft', 'blocked')),
  status_code          text CHECK (status_code ~ '^[245]\.[0-9]{1,3}\.[0-9]{1,3}$'),
  smtp_code            int CHECK (smtp_code BETWEEN 400 AND 599),
  reason               text NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  received_at          timestamptz,
  detected_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX outbound_bounce_message_idx ON outbound_bounce (workspace_id, provider_message_id);
CREATE INDEX ON outbound_bounce (workspace_id, detected_at);
CREATE INDEX ON outbound_bounce (contact_id);
CREATE INDEX ON outbound_bounce (touch_id);

-- El patrón de 0037 §7.1b: RLS con política SOLO de lectura. Ni un GRANT
-- de más abriría la escritura a la aplicación.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'outbound_bounce' AND column_name = 'workspace_id'
  ) THEN
    RAISE EXCEPTION 'outbound_bounce está en la lista de RLS pero no tiene workspace_id';
  END IF;
END $$;
ALTER TABLE outbound_bounce ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_bounce FORCE ROW LEVEL SECURITY;
CREATE POLICY outbound_bounce_ws_read ON outbound_bounce FOR SELECT
  USING (workspace_id = current_workspace_id());
REVOKE INSERT, UPDATE, DELETE ON outbound_bounce FROM mc_app;

COMMENT ON TABLE outbound_bounce IS
  'Rebotes leídos del buzón del creador (VEN-15, job outbound.bounces). Append-only; la escribe el worker. '
  'Única por (workspace_id, provider_message_id): leer dos veces el mismo aviso no cuenta dos rebotes.';

-- ---------------------------------------------------------------------
-- 4 · Los jobs y los avisos
-- ---------------------------------------------------------------------
-- outbound.alerts corre cada hora y cada workspace se procesa desde su
-- mañana (como sales.follow_ups, 0034): «a diario» en la zona de cada uno.
INSERT INTO job_definition (id, label_es, queue, default_cron, timeout_s, max_attempts, max_concurrency) VALUES
  ('outbound.bounces', 'Leer rebotes del correo saliente', 'sales', '*/30 * * * *', 300, 3, 1),
  ('outbound.alerts',  'Alertas diarias del outreach',     'sales', '25 * * * *',   300, 3, 1)
ON CONFLICT (id) DO NOTHING;

-- 'connection_added' es de main (0038_notification_connection_added,
-- ACC-8, ya aplicada en Supabase). Esta migración corre DESPUÉS de esa
-- al renumerarse, y el CHECK se reescribe entero: sin ese valor aquí,
-- esta lo borraría de la lista.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check CHECK (kind IN
  ('outlier','breakout','signal','deal_due','deal_overdue',
   'payment_received','invoice_overdue','connection_error',
   'analysis_ready','report_sent','trend','quote_accepted','media_kit_locked',
   'connection_added',
   'outreach_bounce_rate','outreach_no_sends','outreach_queue_stuck',
   'outreach_account_down','outreach_llm_budget'));
