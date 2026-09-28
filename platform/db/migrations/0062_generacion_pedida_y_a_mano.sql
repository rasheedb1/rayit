-- =====================================================================
-- 0062 · La redacción que pide una persona y el pitch a mano (VEN-12, ronda 2)
-- ---------------------------------------------------------------------
-- Número: 0062. La serie de integración va de 0043 a 0075, detrás de
-- la 0042 de main (0034–0042, ya aplicadas en Supabase); ninguna de la
-- serie está aplicada aún. Hasta el pulido r2 de ventas esta fue la
-- 0057. Va detrás de 0061_generacion_trazable, de la misma historia.
--
-- Lo que la ronda 1 dejaba mal:
--
--   · outbound.review pisaba lo que una persona escribía a mano. Mientras
--     un toque esperaba al juez (stage 'generated'), su cuerpo estaba
--     vacío; si la persona escribía en el editor y lo guardaba como
--     borrador, el job lo reclamaba y escribía su texto encima. La
--     compuerta C solo miraba el estado y el turno.
--   · El pitch a mano perdía las marcas [claim:id] al guardarlo: al
--     reabrirlo, cada cifra salía «sin origen».
--   · El editor no podía pedir un borrador ni regenerarlo con una pista.
--   · La web leía ANTHROPIC_API_KEY de su propio entorno, pero la llave va
--     en el worker.
--   · outbound_review solo guardaba lo que costó el juez.
--
-- Lo nuevo:
--
-- 1 · outbound_generation
--     · stage 'requested': una persona pidió un borrador (o regenerarlo)
--       desde el editor, con una pista cerrada (requested_hint, las de
--       outbound_review.regenerate_hint) y, si quiere, sus instrucciones.
--       outbound.generate la toma igual que un borrador de cadencia.
--     · outcome 'manual': una persona escribió o editó el texto. La fila
--       guarda su marcado (body_marked, con las [claim:id]) y ningún job
--       la vuelve a tomar.
--     · base_body_md5: el md5 del cuerpo del toque cuando un job lo tomó.
--       El resultado se escribe solo si el cuerpo sigue siendo ese
--       (compuerta C, código 'edited_by_person').
--     · gen_input_tokens, gen_output_tokens, gen_cost: lo que costó el
--       borrador de outbound.generate, para que la fila de outbound_review
--       del intento 1 diga cuánto costó escribirlo y juzgarlo.
--
-- 2 · Tres operaciones con nombre, SECURITY DEFINER del rol que migra,
--     como las de 0058: la web es mc_app y no escribe outbound_generation
--     (0061). Cada una hace UNA cosa en el workspace de la transacción:
--       outbound_generation_request(touch, hint, instructions, user)
--       outbound_generation_save_manual(touch, subject, body_marked)
--       outreach_writer_status()   ¿el worker redacta con IA?
--
-- Idempotente donde se puede (CREATE OR REPLACE, IF NOT EXISTS).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · outbound_generation
-- ---------------------------------------------------------------------
ALTER TABLE outbound_generation
  ADD COLUMN IF NOT EXISTS requested_hint text
    CHECK (requested_hint IN ('shorter','more_specific','other_angle','other_signal','soften','add_proof')),
  ADD COLUMN IF NOT EXISTS requested_instructions text CHECK (length(requested_instructions) BETWEEN 1 AND 500),
  ADD COLUMN IF NOT EXISTS requested_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS base_body_md5 text CHECK (base_body_md5 ~ '^[0-9a-f]{32}$'),
  ADD COLUMN IF NOT EXISTS gen_input_tokens int NOT NULL DEFAULT 0 CHECK (gen_input_tokens >= 0),
  ADD COLUMN IF NOT EXISTS gen_output_tokens int NOT NULL DEFAULT 0 CHECK (gen_output_tokens >= 0),
  ADD COLUMN IF NOT EXISTS gen_cost numeric(14,6) NOT NULL DEFAULT 0 CHECK (gen_cost >= 0);

-- Las CHECK de 0061 que hablan de stage u outcome se rehacen con nombre:
-- el nombre que Postgres les puso depende del orden de la tabla, así que
-- se buscan por lo que dicen, no por cómo se llaman.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.outbound_generation'::regclass AND contype = 'c'
       AND conname NOT LIKE 'outbound_generation_v2_%'
       AND (pg_get_constraintdef(oid) LIKE '%stage%' OR pg_get_constraintdef(oid) LIKE '%outcome%')
  LOOP
    EXECUTE format('ALTER TABLE outbound_generation DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE outbound_generation
  DROP CONSTRAINT IF EXISTS outbound_generation_v2_stage,
  DROP CONSTRAINT IF EXISTS outbound_generation_v2_outcome,
  DROP CONSTRAINT IF EXISTS outbound_generation_v2_body,
  DROP CONSTRAINT IF EXISTS outbound_generation_v2_reviewed,
  DROP CONSTRAINT IF EXISTS outbound_generation_v2_requested;
ALTER TABLE outbound_generation
  ADD CONSTRAINT outbound_generation_v2_stage
    CHECK (stage IN ('requested','generating','generated','reviewing','reviewed')),
  ADD CONSTRAINT outbound_generation_v2_outcome
    CHECK (outcome IN ('approved','held','manual')),
  -- Sin texto solo mientras se pide o se escribe.
  ADD CONSTRAINT outbound_generation_v2_body
    CHECK (stage IN ('requested','generating') OR body_marked IS NOT NULL),
  ADD CONSTRAINT outbound_generation_v2_reviewed
    CHECK ((stage = 'reviewed') = (outcome IS NOT NULL)),
  ADD CONSTRAINT outbound_generation_v2_requested
    CHECK (stage <> 'requested' OR (requested_at IS NOT NULL AND lease_token IS NULL));

COMMENT ON COLUMN outbound_generation.requested_hint IS
  'La pista cerrada con la que una persona pidió regenerar desde el editor del pitch (0062). NULL = un borrador nuevo.';
COMMENT ON COLUMN outbound_generation.base_body_md5 IS
  'md5 del cuerpo del toque cuando un job lo tomó: el resultado solo se escribe si sigue siendo ese (compuerta C, 0062).';
COMMENT ON COLUMN outbound_generation.gen_cost IS
  'Lo que costó el borrador de outbound.generate (USD); outbound.review lo suma a la fila del intento 1 (0062).';

-- La función de abajo corre como su dueño, y la tabla lleva FORCE ROW
-- LEVEL SECURITY con una sola política de lectura: esta le alcanza a
-- quien migra (TO CURRENT_USER) y solo en el workspace fijado; a mc_app
-- no le alcanza.
DROP POLICY IF EXISTS outbound_generation_owner_write ON outbound_generation;
CREATE POLICY outbound_generation_owner_write ON outbound_generation FOR ALL TO CURRENT_USER
  USING (current_workspace_id() IS NOT NULL AND workspace_id = current_workspace_id())
  WITH CHECK (current_workspace_id() IS NOT NULL AND workspace_id = current_workspace_id());

-- ---------------------------------------------------------------------
-- 2.1 · outbound_generation_request: una persona pide un borrador
-- ---------------------------------------------------------------------
-- Desde el editor del pitch («Redactar con IA», «Más corto», «Más
-- específico», «Otro ángulo»). Solo un correo nuevo en draft o held del
-- workspace de la transacción, que no esté retenido por un intento sin
-- confirmar (ese tiene su propio flujo, 0058). Un toque retenido vuelve a
-- draft: lo que salga lo revisa quien lo pidió, en el editor.
--
-- Devuelve 'ok', 'not_found', 'not_editable' (ya salió, se aprobó, es
-- otro canal o una respuesta en el hilo), 'opted_out' (la persona pidió
-- la baja o su correo rebotó: no se gasta en ella) o 'busy' (un job lo
-- está escribiendo o revisando ahora mismo).
CREATE OR REPLACE FUNCTION outbound_generation_request(p_touch uuid, p_hint text, p_instructions text, p_user uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
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
  SELECT c.opted_out OR coalesce(c.email_invalid, false) OR address_is_suppressed(c.email) INTO fuera
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
         base_body_md5 = NULL;

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
  'en draft o held de su workspace: la fila de outbound_generation queda en ''requested'' para outbound.generate (0062).';

-- ---------------------------------------------------------------------
-- 2.2 · outbound_generation_save_manual: una persona escribió el texto
-- ---------------------------------------------------------------------
-- La llama savePitch en la misma transacción en que guarda el toque. Con
-- texto, la fila queda en 'reviewed' con outcome 'manual' y el marcado de
-- la persona: el editor lo vuelve a abrir con sus [claim:id] y ningún job
-- lo toma (outbound.review solo toma 'generated'; un job que ya lo tenía
-- pierde el turno y no escribe). Sin texto, la fila se borra: no queda
-- nada de la persona que proteger.
CREATE OR REPLACE FUNCTION outbound_generation_save_manual(p_touch uuid, p_subject text, p_body_marked text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
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
         reviewed_at = EXCLUDED.reviewed_at, lease_token = NULL, lease_until = NULL, last_error = NULL;
  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION outbound_generation_save_manual(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbound_generation_save_manual(uuid, text, text) TO mc_app;
COMMENT ON FUNCTION outbound_generation_save_manual(uuid, text, text) IS
  'El pitch que escribe o edita una persona: guarda su marcado [claim:id] en outbound_generation (outcome ''manual'') '
  'y cancela cualquier redacción pendiente de ese toque, en su workspace (0062).';

-- ---------------------------------------------------------------------
-- 2.3 · outreach_writer_status: ¿el worker redacta con IA?
-- ---------------------------------------------------------------------
-- La llave de Anthropic vive en el worker, no en la web. La web lo sabe
-- por la última corrida de outbound.generate (job_run.metadata.writer, que
-- escribe el job): 'anthropic' o 'fake' si redacta, 'off' si le falta la
-- llave, 'unknown' si no corrió en el último día. job_run de un cron no
-- tiene workspace (la RLS se lo esconde a mc_app): la función lee solo
-- esas filas y devuelve una palabra, nada del workspace de nadie.
DROP POLICY IF EXISTS job_run_writer_status_read ON job_run;
CREATE POLICY job_run_writer_status_read ON job_run FOR SELECT TO CURRENT_USER
  USING (job_id = 'outbound.generate');

CREATE OR REPLACE FUNCTION outreach_writer_status()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT CASE
           WHEN r.writer IN ('anthropic','fake') THEN r.writer
           WHEN r.not_configured THEN 'off'
           ELSE 'unknown'
         END
    FROM (SELECT 1) x
    LEFT JOIN LATERAL (
      SELECT j.metadata->>'writer' AS writer, coalesce((j.metadata->>'notConfigured')::boolean, false) AS not_configured
        FROM job_run j
       WHERE j.job_id = 'outbound.generate' AND j.status IN ('ok','partial') AND j.started_at > now() - interval '1 day'
       ORDER BY j.started_at DESC, j.id DESC
       LIMIT 1) r ON true
$$;

REVOKE ALL ON FUNCTION outreach_writer_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outreach_writer_status() TO mc_app;
COMMENT ON FUNCTION outreach_writer_status() IS
  'anthropic, fake, off o unknown: si el worker redacta con IA, según la última corrida de outbound.generate (0062).';
