-- =====================================================================
-- 0038 · El motor de cadencias (VEN-10)
-- ---------------------------------------------------------------------
-- Lo que el despachador necesita y 0037 no traía:
--
--   1. La ventana laboral del workspace (outbound_policy.send_window_*):
--      la hora local entre la que sale un toque. Por defecto 09:00–17:00,
--      que es lo que Chief tenía, pero en la zona de la cadencia y no en
--      UTC (docs/ventas-outreach.md §9).
--   2. outbound_touch.channel_account_id: la cuenta que envió (o enviará)
--      el toque. El despachador la fija al reclamar, cuenta el tope de
--      ESA cuenta, y el lector de respuestas sabe en qué buzón buscar el
--      hilo. Tiene que ser del mismo workspace y del mismo canal que el
--      toque, también para el worker, que no pasa por la RLS.
--   3. Los dos jobs: outbound.dispatch pasa de cada diez a cada dos
--      minutos, y outbound.replies (el respaldo del webhook) cada cinco.
--   4. Dos avisos nuevos: un toque que falló para siempre (rebote, cuenta
--      caída) y una respuesta que llegó.
--
-- Idempotente donde se puede (IF NOT EXISTS, ON CONFLICT), como las
-- anteriores.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · La ventana laboral
-- ---------------------------------------------------------------------
ALTER TABLE outbound_policy
  ADD COLUMN IF NOT EXISTS send_window_start time NOT NULL DEFAULT '09:00',
  ADD COLUMN IF NOT EXISTS send_window_end   time NOT NULL DEFAULT '17:00';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outbound_policy_send_window_check') THEN
    ALTER TABLE outbound_policy
      ADD CONSTRAINT outbound_policy_send_window_check CHECK (send_window_end > send_window_start);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2 · La cuenta de cada toque
-- ---------------------------------------------------------------------
ALTER TABLE outbound_touch
  ADD COLUMN IF NOT EXISTS channel_account_id uuid REFERENCES outreach_channel_account(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS outbound_touch_channel_account_idx ON outbound_touch (channel_account_id)
  WHERE channel_account_id IS NOT NULL;

-- La web puede elegir la cuenta de un toque suyo; la clave ajena lleva
-- la guardia de 0025 como todas las de una tabla que mc_app escribe.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ref_visible_channel_account_id'
                   AND tgrelid = 'public.outbound_touch'::regclass) THEN
    CREATE TRIGGER ref_visible_channel_account_id
      BEFORE INSERT OR UPDATE OF channel_account_id ON outbound_touch
      FOR EACH ROW WHEN (NEW.channel_account_id IS NOT NULL)
      EXECUTE FUNCTION assert_reference_visible('channel_account_id', 'outreach_channel_account', 'id');
  END IF;
END $$;

-- Y la coherencia, para todos (también el worker): la cuenta es del
-- workspace del toque y de su canal. Un correo no sale por un LinkedIn,
-- y un toque no gasta el tope de la cuenta de otro workspace.
CREATE OR REPLACE FUNCTION outbound_touch_account_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  a record;
BEGIN
  IF NEW.channel_account_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT x.workspace_id, x.channel INTO a FROM outreach_channel_account x WHERE x.id = NEW.channel_account_id;
  IF NOT FOUND THEN
    RETURN NEW;  -- eso es de la clave ajena y de assert_reference_visible
  END IF;
  IF a.workspace_id IS DISTINCT FROM NEW.workspace_id OR a.channel IS DISTINCT FROM NEW.channel THEN
    RAISE EXCEPTION 'La cuenta % no es del workspace o del canal del toque % (%).', NEW.channel_account_id, NEW.id, NEW.channel
      USING ERRCODE = 'check_violation',
            HINT = 'Un toque sale por una cuenta de su mismo workspace y de su mismo canal.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS outbound_touch_account_check ON outbound_touch;
CREATE TRIGGER outbound_touch_account_check
  BEFORE INSERT OR UPDATE OF channel_account_id, channel, workspace_id ON outbound_touch
  FOR EACH ROW EXECUTE FUNCTION outbound_touch_account_check();

-- ---------------------------------------------------------------------
-- 3 · Los jobs del motor
-- ---------------------------------------------------------------------
-- El despachador toma hasta cincuenta toques vencidos cada dos minutos;
-- 110 s de tiempo máximo para que una corrida no pise a la siguiente
-- (la cola es 'stately' de todos modos). Las respuestas se leen cada
-- cinco minutos como respaldo del webhook de Unipile y de Gmail.
UPDATE job_definition
   SET default_cron = '*/2 * * * *', timeout_s = 110, max_attempts = 1, max_concurrency = 4
 WHERE id = 'outbound.dispatch';

INSERT INTO job_definition (id, label_es, queue, default_cron, timeout_s, max_attempts, max_concurrency)
VALUES ('outbound.replies', 'Leer respuestas de los hilos abiertos', 'sales', '*/5 * * * *', 240, 1, 4)
ON CONFLICT (id) DO UPDATE
  SET label_es = EXCLUDED.label_es, queue = EXCLUDED.queue, default_cron = EXCLUDED.default_cron,
      timeout_s = EXCLUDED.timeout_s, max_attempts = EXCLUDED.max_attempts,
      max_concurrency = EXCLUDED.max_concurrency;

-- ---------------------------------------------------------------------
-- 4 · Los avisos del motor
-- ---------------------------------------------------------------------
--   outreach_failed  un toque no salió y no se va a reintentar: rebote,
--                    destinatario inválido, cuenta caída, cinco fallos.
--   outreach_reply   la marca respondió; lo pendiente se canceló.
-- Los demás valores quedan como los dejó 0030.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check CHECK (kind IN
  ('outlier','breakout','signal','deal_due','deal_overdue',
   'payment_received','invoice_overdue','connection_error',
   'analysis_ready','report_sent','trend','quote_accepted','media_kit_locked',
   'outreach_failed','outreach_reply'));
