-- =====================================================================
-- 0058 · La nota del borrador elegido, los reintentos con espera y la
--        baja del espacio en la redacción (VEN-12, ronda 3)
-- ---------------------------------------------------------------------
-- Número: va detrás de 0057_generacion_pedida_y_a_mano, en la misma rama.
-- Si otra pieza llega con su propio 0058, el integrador renumera: nada
-- aquí depende del número, solo de ir detrás de 0057.
--
-- Lo que la ronda 2 dejaba mal:
--
--   · El editor enseñaba la nota del ÚLTIMO intento de outbound_review,
--     aunque el texto que abría fuera otro (con «enviar el mejor» o con
--     una retención, el elegido es un intento anterior) o aunque ese
--     último fuera un rechazo del pre-vuelo, sin nota.
--   · outbound_review.attempt va de 1 a 10 (0037) y los intentos de un
--     toque se numeraban detrás de los que ya tenía: tras dos o tres
--     «Otra versión», los intentos 11 y siguientes se descartaban sin
--     avisar, y con ellos sus tokens y su costo.
--   · Sin tope de reintentos ni espera: un toque cuyo modelo devolvía
--     siempre algo ilegible se volvía a intentar (y a pagar) cada dos
--     minutos hasta agotar el tope diario del espacio.
--   · La redacción no miraba outbound_workspace_optout (la baja de ESTE
--     espacio, 0050): savePitch sí, la función con nombre no.
--
-- Lo nuevo:
--
-- 1 · outbound_review.run: una corrida de la puerta de calidad por cada
--     vez que un job toma el toque. Los intentos se numeran de 1 a 10
--     DENTRO de su corrida y la clave única pasa a ser (touch_id, run,
--     attempt): ningún intento se queda sin fila.
--
-- 2 · outbound_generation
--     · review_run, chosen_attempt, judge_note, total_score: la corrida,
--       el intento cuyo texto quedó en el toque y SU nota. El editor lee
--       la nota de aquí, no «la última fila».
--     · failures y next_attempt_at: cada fallo suma uno y fija la espera
--       antes del siguiente intento (2, 8, 30 minutos…). Los reclamos de
--       los dos jobs no toman una fila antes de su hora.
--     · stage 'failed': la IA se rindió (el modelo devolvió algo ilegible
--       tres veces). Ningún job la vuelve a tomar; el toque de cadencia
--       queda retenido ('llm_error') y el editor lo dice. Una persona la
--       saca de ahí pidiendo otra versión o escribiéndolo.
--     · attempts deja de tener techo (era 20, y se recortaba a mano).
--
-- 3 · outbound_generation_request y outbound_generation_save_manual,
--     rehechas (misma firma): la primera mira también la baja de este
--     espacio, y las dos ponen a cero los fallos y la nota vieja.
--
-- Idempotente donde se puede (IF NOT EXISTS, DROP … IF EXISTS, CREATE OR
-- REPLACE).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · outbound_review.run
-- ---------------------------------------------------------------------
ALTER TABLE outbound_review
  ADD COLUMN IF NOT EXISTS run int NOT NULL DEFAULT 1 CHECK (run >= 1);

-- La UNIQUE (touch_id, attempt) de 0037 se busca por lo que dice, no por
-- el nombre que le puso Postgres.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.outbound_review'::regclass AND contype = 'u'
       AND pg_get_constraintdef(oid) = 'UNIQUE (touch_id, attempt)'
  LOOP
    EXECUTE format('ALTER TABLE outbound_review DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE outbound_review DROP CONSTRAINT IF EXISTS outbound_review_touch_run_attempt;
ALTER TABLE outbound_review
  ADD CONSTRAINT outbound_review_touch_run_attempt UNIQUE (touch_id, run, attempt);

COMMENT ON COLUMN outbound_review.run IS
  'La corrida de la puerta de calidad sobre el toque (una por cada vez que un job lo toma): attempt va de 1 a 10 '
  'dentro de su corrida y la clave es (touch_id, run, attempt) (0058).';

-- ---------------------------------------------------------------------
-- 2 · outbound_generation
-- ---------------------------------------------------------------------
ALTER TABLE outbound_generation
  ADD COLUMN IF NOT EXISTS review_run int CHECK (review_run >= 1),
  ADD COLUMN IF NOT EXISTS chosen_attempt int CHECK (chosen_attempt BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS judge_note text CHECK (length(judge_note) BETWEEN 1 AND 500),
  ADD COLUMN IF NOT EXISTS total_score numeric(4,2) CHECK (total_score BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS failures int NOT NULL DEFAULT 0 CHECK (failures >= 0),
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

-- El techo de attempts (0056) y las CHECK de stage y de cuerpo (0057) se
-- rehacen: se buscan por lo que dicen.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.outbound_generation'::regclass AND contype = 'c'
       AND (pg_get_constraintdef(oid) LIKE '%attempts%<=%20%' OR pg_get_constraintdef(oid) LIKE '%attempts >= 0%AND%attempts <= 20%')
  LOOP
    EXECUTE format('ALTER TABLE outbound_generation DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE outbound_generation
  DROP CONSTRAINT IF EXISTS outbound_generation_v2_stage,
  DROP CONSTRAINT IF EXISTS outbound_generation_v2_body,
  DROP CONSTRAINT IF EXISTS outbound_generation_v3_stage,
  DROP CONSTRAINT IF EXISTS outbound_generation_v3_body,
  DROP CONSTRAINT IF EXISTS outbound_generation_v3_attempts;
ALTER TABLE outbound_generation
  ADD CONSTRAINT outbound_generation_v3_stage
    CHECK (stage IN ('requested','generating','generated','reviewing','reviewed','failed')),
  -- Sin texto solo mientras se pide o se escribe, o si la IA se rindió antes de escribir nada.
  ADD CONSTRAINT outbound_generation_v3_body
    CHECK (stage IN ('requested','generating','failed') OR body_marked IS NOT NULL),
  ADD CONSTRAINT outbound_generation_v3_attempts CHECK (attempts >= 0);

COMMENT ON COLUMN outbound_generation.chosen_attempt IS
  'El intento de la corrida review_run cuyo texto quedó en el toque (el que pasó, el mejor o el que se retuvo) (0058).';
COMMENT ON COLUMN outbound_generation.judge_note IS
  'La nota del juez sobre el intento elegido, la que enseña el editor del pitch (0058).';
COMMENT ON COLUMN outbound_generation.failures IS
  'Fallos seguidos de la redacción o la revisión; cada uno fija next_attempt_at con una espera creciente (0058).';
COMMENT ON COLUMN outbound_generation.next_attempt_at IS
  'Antes de esta hora ningún job vuelve a tomar la fila (la espera tras un fallo o sin presupuesto) (0058).';

-- ---------------------------------------------------------------------
-- 3.1 · outbound_generation_request, con la baja del espacio
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION outbound_generation_request(p_touch uuid, p_hint text, p_instructions text, p_user uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ws uuid := current_workspace_id();
  t outbound_touch%ROWTYPE;
  g outbound_generation%ROWTYPE;
  fuera boolean;
BEGIN
  IF ws IS NULL THEN
    RAISE EXCEPTION 'outbound_generation_request necesita un workspace fijado en la transacción.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_hint IS NOT NULL AND p_hint NOT IN ('shorter','more_specific','other_angle','other_signal','soften','add_proof') THEN
    RAISE EXCEPTION 'Pista desconocida: %.', p_hint USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO t FROM outbound_touch WHERE id = p_touch AND workspace_id = ws FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF t.channel <> 'email' OR t.status NOT IN ('draft','held') OR t.unconfirmed_attempt IS NOT NULL
     OR (t.step_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM outbound_step st WHERE st.id = t.step_id AND st.step_type = 'email')) THEN
    RETURN 'not_editable';
  END IF;
  -- La misma regla que savePitch y que el reclamo del worker: la baja
  -- global, el rebote, la lista de supresión y la baja de ESTE espacio.
  SELECT c.opted_out OR coalesce(c.email_invalid, false) OR address_is_suppressed(c.email)
         OR EXISTS (SELECT 1 FROM outbound_workspace_optout wo WHERE wo.workspace_id = ws AND wo.email = c.email)
    INTO fuera
    FROM contact c WHERE c.id = t.contact_id;
  IF coalesce(fuera, true) THEN
    RETURN 'opted_out';
  END IF;

  SELECT * INTO g FROM outbound_generation WHERE touch_id = t.id FOR UPDATE;
  IF FOUND AND g.stage IN ('generating','reviewing') AND g.lease_until > now() THEN
    RETURN 'busy';
  END IF;

  INSERT INTO outbound_generation (touch_id, workspace_id, stage, requested_hint, requested_instructions, requested_by, requested_at)
  VALUES (t.id, ws, 'requested', p_hint, nullif(btrim(coalesce(p_instructions, '')), ''), p_user, now())
  ON CONFLICT (touch_id) DO UPDATE
     SET stage = 'requested', outcome = NULL, requested_hint = EXCLUDED.requested_hint,
         requested_instructions = EXCLUDED.requested_instructions, requested_by = EXCLUDED.requested_by,
         requested_at = EXCLUDED.requested_at, lease_token = NULL, lease_until = NULL, last_error = NULL,
         base_body_md5 = NULL, failures = 0, next_attempt_at = NULL,
         review_run = NULL, chosen_attempt = NULL, judge_note = NULL, total_score = NULL;

  IF t.status = 'held' THEN
    UPDATE outbound_touch SET status = 'draft', held_reason = NULL WHERE id = t.id;
  END IF;
  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION outbound_generation_request(uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbound_generation_request(uuid, text, text, uuid) TO mc_app;
COMMENT ON FUNCTION outbound_generation_request(uuid, text, text, uuid) IS
  'Una persona pide desde el editor del pitch que la IA redacte (o regenere con una pista cerrada) un correo nuevo '
  'en draft o held de su workspace, si la persona que lo recibiría no pidió la baja (global o de este espacio): la '
  'fila de outbound_generation queda en ''requested'' para outbound.generate, sin fallos ni nota vieja (0057, 0058).';

-- ---------------------------------------------------------------------
-- 3.2 · outbound_generation_save_manual, sin fallos ni nota vieja
-- ---------------------------------------------------------------------
-- Guarda el marcado TAL CUAL lo escribió la persona: con sus {{variables}}
-- y sus [claim:id] (savePitch rellena el texto que sale en outbound_touch).
CREATE OR REPLACE FUNCTION outbound_generation_save_manual(p_touch uuid, p_subject text, p_body_marked text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ws uuid := current_workspace_id();
BEGIN
  IF ws IS NULL THEN
    RAISE EXCEPTION 'outbound_generation_save_manual necesita un workspace fijado en la transacción.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM outbound_touch WHERE id = p_touch AND workspace_id = ws) THEN
    RETURN 'not_found';
  END IF;
  IF nullif(btrim(coalesce(p_body_marked, '')), '') IS NULL THEN
    DELETE FROM outbound_generation WHERE touch_id = p_touch;
    RETURN 'ok';
  END IF;
  INSERT INTO outbound_generation (touch_id, workspace_id, stage, outcome, subject, body_marked, reviewed_at)
  VALUES (p_touch, ws, 'reviewed', 'manual', left(nullif(btrim(coalesce(p_subject, '')), ''), 300), left(p_body_marked, 20000), now())
  ON CONFLICT (touch_id) DO UPDATE
     SET stage = 'reviewed', outcome = 'manual', subject = EXCLUDED.subject, body_marked = EXCLUDED.body_marked,
         reviewed_at = EXCLUDED.reviewed_at, lease_token = NULL, lease_until = NULL, last_error = NULL,
         failures = 0, next_attempt_at = NULL, review_run = NULL, chosen_attempt = NULL, judge_note = NULL, total_score = NULL;
  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION outbound_generation_save_manual(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbound_generation_save_manual(uuid, text, text) TO mc_app;
COMMENT ON FUNCTION outbound_generation_save_manual(uuid, text, text) IS
  'El pitch que escribe o edita una persona: guarda su marcado ({{variables}} y [claim:id]) en outbound_generation '
  '(outcome ''manual'') y cancela cualquier redacción pendiente de ese toque, en su workspace (0057, 0058).';
