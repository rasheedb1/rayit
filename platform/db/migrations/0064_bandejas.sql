-- =====================================================================
-- 0064 · Las bandejas: aprobación, conversación y la intención de cada
--        respuesta (VEN-14)
-- ---------------------------------------------------------------------
-- Número: 0063 es la última de rasheed/integracion (fase 5). Si otra
-- pieza de la fase 6 eligió también 0064, el integrador renumera: esta
-- no depende de nada que venga después.
--
-- 1 · outbound_touch.reply_to_message_id
--
--   Responder desde la bandeja unificada no es otra cadencia: es UN
--   mensaje que sale por el mismo motor (el reclamo, los topes, el pie de
--   baja, la cuenta y el hilo) para no duplicar envíos. El toque nace en
--   'scheduled', sin enrolamiento ni paso (el enrolamiento de quien ya
--   respondió está en 'replied' y el despachador cancelaría lo suyo), y
--   dice a qué mensaje entrante responde. De ahí el despachador saca el
--   hilo (thread_ref y Message-ID para In-Reply-To) y la cuenta que lo
--   recibió, que es la única que tiene ese hilo.
--
--   Un disparador exige que el mensaje sea ENTRANTE, del mismo workspace,
--   de la misma ficha y del mismo canal que el toque. Corre con los
--   permisos (y la RLS) de quien escribe: desde la web, un mensaje de
--   otro workspace no existe y la fila se rechaza.
--
-- 2 · outbound_message: quién clasificó, y el referido
--
--   intent_source   'detector' (la regla de bajas de VEN-10, sin tokens),
--                   'model' (claude-haiku-4-5), 'fake' (el clasificador
--                   determinista de las pruebas y la demo) o 'person'
--                   (una persona la corrigió en la bandeja).
--   referral        lo que el clasificador leyó de un «escríbele a …»:
--                   {"name", "email", "role"}. La bandeja lo propone como
--                   contacto nuevo; nada se crea sin una persona.
--   referral_contact_id  la ficha que se creó desde esa propuesta.
--
-- 3 · El job outbound.intent, cada tres minutos (clasifica, aplica los
--     efectos y reanuda lo que tenía fecha de vuelta).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · La respuesta desde la bandeja
-- ---------------------------------------------------------------------
ALTER TABLE outbound_touch
  ADD COLUMN reply_to_message_id uuid REFERENCES outbound_message(id) ON DELETE SET NULL;

ALTER TABLE outbound_touch
  ADD CONSTRAINT outbound_touch_reply_outside_cadence
  CHECK (reply_to_message_id IS NULL OR (enrollment_id IS NULL AND step_id IS NULL));

CREATE INDEX outbound_touch_reply_to_idx ON outbound_touch (reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;

COMMENT ON COLUMN outbound_touch.reply_to_message_id IS
  'El mensaje entrante al que responde este toque, escrito desde la bandeja unificada (0064, VEN-14). Sin '
  'enrolamiento ni paso: el despachador lo envía en el hilo de ese mensaje y por la cuenta que lo recibió.';

CREATE FUNCTION outbound_touch_reply_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  m record;
BEGIN
  IF NEW.reply_to_message_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.reply_to_message_id IS NOT DISTINCT FROM OLD.reply_to_message_id
     AND NEW.contact_id IS NOT DISTINCT FROM OLD.contact_id AND NEW.channel IS NOT DISTINCT FROM OLD.channel THEN
    RETURN NEW;
  END IF;
  SELECT workspace_id, contact_id, channel, direction INTO m FROM outbound_message WHERE id = NEW.reply_to_message_id;
  IF NOT FOUND OR m.direction <> 'inbound' OR m.workspace_id <> NEW.workspace_id
     OR m.contact_id IS DISTINCT FROM NEW.contact_id OR m.channel <> NEW.channel THEN
    RAISE EXCEPTION 'Una respuesta de la bandeja va al hilo de un mensaje entrante de la misma ficha, canal y espacio (toque %).',
                    NEW.id
      USING ERRCODE = 'check_violation',
            HINT = 'reply_to_message_id nombra un outbound_message con direction = inbound de este workspace, '
                   'con el mismo contact_id y el mismo channel que el toque.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbound_touch_reply_check
  BEFORE INSERT OR UPDATE OF reply_to_message_id, contact_id, channel ON outbound_touch
  FOR EACH ROW EXECUTE FUNCTION outbound_touch_reply_check();

-- ---------------------------------------------------------------------
-- 2 · La intención: quién la puso, y el referido
-- ---------------------------------------------------------------------
ALTER TABLE outbound_message
  ADD COLUMN intent_source text CHECK (intent_source IN ('detector', 'model', 'fake', 'person')),
  ADD COLUMN referral jsonb CHECK (referral IS NULL OR jsonb_typeof(referral) = 'object'),
  ADD COLUMN referral_contact_id uuid REFERENCES contact(id) ON DELETE SET NULL,
  ADD CONSTRAINT outbound_message_intent_classified_check CHECK (intent IS NULL OR classified_at IS NOT NULL);

COMMENT ON COLUMN outbound_message.intent_source IS
  'Quién puso la intención (0064): detector (la regla de bajas, sin tokens), model (claude-haiku-4-5), fake '
  '(el clasificador determinista de pruebas y demo) o person (corregida en la bandeja).';
COMMENT ON COLUMN outbound_message.referral IS
  'El contacto que la respuesta propone («escríbele a …»): {"name", "email", "role"}. La bandeja lo propone; '
  'nada se crea sin una persona (0064).';

-- Sin relleno: lo clasificado antes de 0064 (las bajas del detector y la
-- demo) queda con intent_source NULL, que la bandeja lee como «sin fuente».

-- La bandeja: los hilos por ficha y canal, del más reciente al más viejo.
CREATE INDEX outbound_message_thread_idx ON outbound_message (workspace_id, contact_id, channel, occurred_at DESC);
-- Lo que falta clasificar: lo entrante sin classified_at, del más viejo al más nuevo.
CREATE INDEX outbound_message_unclassified_idx ON outbound_message (created_at)
  WHERE direction = 'inbound' AND classified_at IS NULL;
CREATE INDEX outbound_message_referral_contact_idx ON outbound_message (referral_contact_id)
  WHERE referral_contact_id IS NOT NULL;

-- Las dos claves nuevas hacia tablas con RLS solo nombran filas que quien
-- escribe puede leer (0025 §3): ni la web apunta a un mensaje o a una
-- ficha de otro workspace sabiendo su id.
CREATE TRIGGER ref_visible_reply_to_message_id
  BEFORE INSERT OR UPDATE OF reply_to_message_id ON outbound_touch
  FOR EACH ROW WHEN (NEW.reply_to_message_id IS NOT NULL)
  EXECUTE FUNCTION assert_reference_visible('reply_to_message_id', 'outbound_message', 'id');
CREATE TRIGGER ref_visible_referral_contact_id
  BEFORE INSERT OR UPDATE OF referral_contact_id ON outbound_message
  FOR EACH ROW WHEN (NEW.referral_contact_id IS NOT NULL)
  EXECUTE FUNCTION assert_reference_visible('referral_contact_id', 'contact', 'id');

-- ---------------------------------------------------------------------
-- 3 · El job
-- ---------------------------------------------------------------------
-- Cada tres minutos: una respuesta clasificada mueve el negocio antes de
-- que la persona abra la bandeja. max_concurrency 1: dos corridas a la
-- vez clasificarían (y pagarían) el mismo mensaje dos veces.
INSERT INTO job_definition (id, label_es, queue, default_cron, timeout_s, max_attempts, max_concurrency) VALUES
  ('outbound.intent', 'Clasificar las respuestas de las marcas', 'sales', '*/3 * * * *', 170, 1, 1)
ON CONFLICT (id) DO NOTHING;
