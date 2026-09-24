-- =====================================================================
-- 0051 · El motor de cadencias (VEN-10)
-- ---------------------------------------------------------------------
-- Número: la regla, no un número fijo. Esta va DETRÁS de todas las de
-- outreach (0037_outreach, las de VEN-9-canales y la de VEN-15), porque
-- redefine notification_kind_check con la UNIÓN de todos los avisos
-- (§9): la que se aplica última gana, y así no se pierde ninguno.
-- Depende de 0037 (tablas del outreach) y de nada más: 0038-0040 de
-- VEN-9-canales y la entregabilidad no le aportan columnas.
--
-- Por qué 0051 (24-sep-2026, schema_migrations de Supabase): main ya
-- aplicó su serie 0034-0042. Las de integración que chocan con ella
-- (0034_seguimientos … 0037_outreach, y 0038-0040 de VEN-9-canales)
-- pasan a 0043-0049 al mezclar con main, en su mismo orden; la
-- entregabilidad de VEN-15 ya es 0050 y esta, 0051. Si al integrar
-- aparece otra migración de main o de otra rama, esta se renumera para
-- seguir siendo la última de outreach, y su unión de avisos se revisa
-- contra el CHECK de todas las que la preceden (la prueba de
-- NOTIFICATION_KINDS lo compara). Lo comprobó VEN-10 r3 con main +
-- integración + VEN-9-canales-r2 + VEN-15-r2 renumeradas así, en
-- Postgres embebido (docs/ventas-outreach.md §9.3).
--
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
--   5. (r2) El contacto de un enrolamiento o de un toque es uno que su
--      workspace puede ver, también para el worker (BYPASSRLS).
--   6. (r2) send_started_at y unconfirmed_attempt: qué llegó de verdad al
--      proveedor y qué intento quedó sin confirmar (duplicados y zombis).
--   7. (r2) outbound_enrollment.status 'bounced': la dirección rebotó.
--   8. (r2) outbound_counter_release: devolver la plaza de un tope que se
--      reservó al reclamar y no se gastó.
--   9. (r2) notification_kind_check con la unión de todos los avisos.
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
-- La lista entera va en §9, con la de las otras ramas.

-- ---------------------------------------------------------------------
-- 5 · El contacto es del workspace que le escribe (r2)
-- ---------------------------------------------------------------------
-- La RLS de contact (0029 §4) deja ver a un workspace sus fichas y las
-- públicas. Pero el worker corre con BYPASSRLS, y 0037 §3.4 y §4.4 solo
-- atan el enrolamiento a su secuencia y el toque a su enrolamiento: una
-- secuencia de A podía enrolar la ficha privada de B, y el despachador
-- le escribía desde el Gmail de A con el nombre y la empresa de B. Aquí
-- se exige, a cualquiera que escriba (también al worker):
--   · la ficha es del workspace (owner_workspace_id), o
--   · es pública (sin dueño, de fuente pública) y su empresa está en el
--     embudo del workspace (company_link).
-- contact_visible_to es la única definición: la usa enrollContacts para
-- decir not_found y la usan los dos disparadores.
CREATE OR REPLACE FUNCTION contact_visible_to(p_contact uuid, p_workspace uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM contact c
     WHERE c.id = p_contact
       AND (c.owner_workspace_id = p_workspace
            OR (c.owner_workspace_id IS NULL
                AND c.source IN ('public_website', 'public_profile', 'press')
                AND EXISTS (SELECT 1 FROM company_link l
                             WHERE l.workspace_id = p_workspace AND l.company_id = c.company_id))));
$$;
REVOKE ALL ON FUNCTION contact_visible_to(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION contact_visible_to(uuid, uuid) TO mc_app, mc_worker;
COMMENT ON FUNCTION contact_visible_to(uuid, uuid) IS
  'La ficha es del workspace, o es pública y su empresa está en el embudo del workspace (0051 §5). '
  'La usan enrollContacts y los disparadores de outbound_enrollment y outbound_touch.';

CREATE OR REPLACE FUNCTION outreach_contact_of_workspace()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.contact_id IS NULL OR NOT EXISTS (SELECT 1 FROM contact c WHERE c.id = NEW.contact_id) THEN
    RETURN NEW;  -- sin ficha, o una que no se ve o no existe: eso es de la clave ajena y de 0025
  END IF;
  IF NOT contact_visible_to(NEW.contact_id, NEW.workspace_id) THEN
    RAISE EXCEPTION 'El contacto % no es del workspace % (%).', NEW.contact_id, NEW.workspace_id, TG_TABLE_NAME
      USING ERRCODE = 'check_violation',
            HINT = 'Solo se le escribe a una ficha propia, o a una pública cuya empresa está en el embudo del workspace.';
  END IF;
  RETURN NEW;
END;
$$;

-- Los nombres empiezan por «workspace_contact» para dispararse DESPUÉS de
-- las coherencias de 0037 (Postgres los ordena por nombre): si el toque
-- ya es incoherente con su enrolamiento, ese es el error que se dice.
DROP TRIGGER IF EXISTS outbound_enrollment_workspace_contact ON outbound_enrollment;
CREATE TRIGGER outbound_enrollment_workspace_contact
  BEFORE INSERT OR UPDATE OF contact_id, workspace_id ON outbound_enrollment
  FOR EACH ROW EXECUTE FUNCTION outreach_contact_of_workspace();
DROP TRIGGER IF EXISTS outbound_touch_workspace_contact ON outbound_touch;
CREATE TRIGGER outbound_touch_workspace_contact
  BEFORE INSERT OR UPDATE OF contact_id, workspace_id ON outbound_touch
  FOR EACH ROW WHEN (NEW.contact_id IS NOT NULL)
  EXECUTE FUNCTION outreach_contact_of_workspace();

-- ---------------------------------------------------------------------
-- 6 · Qué llegó al proveedor (r2)
-- ---------------------------------------------------------------------
--   send_started_at      el despachador lo confirma JUSTO antes de
--                        llamar al proveedor. Un reclamo que se cae sin
--                        él nunca salió: rescueZombies lo devuelve a la
--                        cola. Con él, pudo salir: failed, sin reenviar.
--   unconfirmed_attempt  el intento cuyo resultado no se sabe (un timeout
--                        DESPUÉS de enviar la petición). Antes de
--                        reenviar, el despachador pregunta al proveedor si
--                        ese intento salió (Gmail: rfc822msgid); si no lo
--                        puede saber, lo retiene para una persona.
-- Los dos son del despachador, como las pruebas de envío (0037 §4.2).
ALTER TABLE outbound_touch
  ADD COLUMN IF NOT EXISTS send_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS unconfirmed_attempt int CHECK (unconfirmed_attempt BETWEEN 1 AND 20);

CREATE OR REPLACE FUNCTION outbound_touch_dispatch_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF outreach_is_dispatcher() THEN
    RETURN NEW;
  END IF;
  IF (TG_OP = 'INSERT' AND (NEW.send_started_at IS NOT NULL OR NEW.unconfirmed_attempt IS NOT NULL))
     OR (TG_OP = 'UPDATE' AND (NEW.send_started_at IS DISTINCT FROM OLD.send_started_at
                               OR NEW.unconfirmed_attempt IS DISTINCT FROM OLD.unconfirmed_attempt)) THEN
    RAISE EXCEPTION 'send_started_at y unconfirmed_attempt los escribe solo el despachador (rol %).', current_user
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Dicen qué llegó al proveedor: la aplicación no los escribe.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS outbound_touch_dispatch_columns ON outbound_touch;
CREATE TRIGGER outbound_touch_dispatch_columns
  BEFORE INSERT OR UPDATE OF send_started_at, unconfirmed_attempt ON outbound_touch
  FOR EACH ROW EXECUTE FUNCTION outbound_touch_dispatch_columns();

-- ---------------------------------------------------------------------
-- 7 · Un enrolamiento cuya dirección rebotó (r2)
-- ---------------------------------------------------------------------
-- Un rebote o un destinatario inválido al enviar cancela lo pendiente de
-- ese canal; si no le queda nada vivo, el enrolamiento termina en
-- 'bounced' (terminal, como completed, replied y opted_out). No es una
-- baja: la dirección no existe, la persona no pidió nada (VEN-15 lo
-- anota en contact.email_invalid, no en contact_suppression).
ALTER TABLE outbound_enrollment DROP CONSTRAINT IF EXISTS outbound_enrollment_status_check;
ALTER TABLE outbound_enrollment ADD CONSTRAINT outbound_enrollment_status_check
  CHECK (status IN ('active','paused','completed','replied','opted_out','cooldown','bounced'));

-- ---------------------------------------------------------------------
-- 8 · Devolver una plaza de un tope (r2)
-- ---------------------------------------------------------------------
-- El despachador reserva la plaza al reclamar (increment_if_under_cap e
-- increment_weekly, 0037 §8.3): así dos despachadores no pasan del tope.
-- Si el toque no sale (se cancela, se pospone, se retiene, falla en
-- transitorio o se devuelve a la cola sin intentarlo), la plaza vuelve.
-- Nunca baja de cero, y solo toca el día y la semana de HOY en la zona
-- del workspace (lo que se reservó otro día ya no cuenta).
CREATE OR REPLACE FUNCTION outbound_counter_release(p_workspace uuid, p_account uuid, p_action_type text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  hoy date := outreach_local_date(p_workspace, now());
  lunes date := hoy - (extract(isodow FROM hoy)::int - 1);
BEGIN
  UPDATE outbound_counter c
     SET count = c.count - 1, updated_at = now()
   WHERE c.workspace_id = p_workspace
     AND c.channel_account_id IS NOT DISTINCT FROM p_account
     AND c.action_type = p_action_type
     AND ((c.period = 'day' AND c.period_start = hoy) OR (c.period = 'week' AND c.period_start = lunes))
     AND c.count > 0;
END;
$$;
REVOKE ALL ON FUNCTION outbound_counter_release(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbound_counter_release(uuid, uuid, text) TO mc_worker;
COMMENT ON FUNCTION outbound_counter_release(uuid, uuid, text) IS
  'Devuelve la plaza de hoy y de esta semana de un tope (cuenta, o workspace con p_account NULL) que el '
  'despachador reservó al reclamar y no gastó (0051 §8).';

-- ---------------------------------------------------------------------
-- 9 · Todos los avisos (r2)
-- ---------------------------------------------------------------------
-- La unión de lo que declaran las ramas que se aplican juntas, para que
-- ninguna borre los avisos de otra: 0030 (base), main 0038
-- (connection_added), VEN-15 (las alertas diarias) y este motor. La lista
-- de packages/db (NOTIFICATION_KINDS) es la misma, y una prueba la
-- compara con este CHECK.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check CHECK (kind IN
  ('outlier','breakout','signal','deal_due','deal_overdue',
   'payment_received','invoice_overdue','connection_error',
   'analysis_ready','report_sent','trend','quote_accepted','media_kit_locked',
   'connection_added',
   'outreach_bounce_rate','outreach_no_sends','outreach_queue_stuck',
   'outreach_account_down','outreach_llm_budget',
   'outreach_failed','outreach_reply'));
