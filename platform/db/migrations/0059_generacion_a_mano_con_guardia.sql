-- =====================================================================
-- 0059 · VEN-12 ronda 4: el pitch a mano solo se guarda sobre un correo
-- que todavía se puede editar
-- =====================================================================
--
-- outbound_generation_save_manual (0057, 0058) es SECURITY DEFINER y la
-- puede llamar mc_app. Comprobaba el workspace, pero no que el toque se
-- pudiera editar: sobre un correo ya enviado o programado escribía un
-- marcado 'manual' que no correspondía a lo que salió. Hoy solo la llama
-- savePitch, después de su UPDATE con guardia; pero la frontera está en la
-- base, no en quien la llama.
--
-- Aquí repite la misma guardia que outbound_generation_request: un correo
-- (channel 'email') en draft o held, sin intento sin confirmar, y si es
-- de una cadencia, de un paso de tipo email. Si no, 'not_editable', sin
-- escribir nada. Además toma el toque FOR UPDATE: lo que guarda savePitch
-- justo después (el texto y el estado) no se cruza con otra escritura.
--
-- savePitch (@mc/db) la llama ANTES de mover el toque a 'scheduled'.
-- =====================================================================

CREATE OR REPLACE FUNCTION outbound_generation_save_manual(p_touch uuid, p_subject text, p_body_marked text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ws uuid := current_workspace_id();
  t outbound_touch%ROWTYPE;
BEGIN
  IF ws IS NULL THEN
    RAISE EXCEPTION 'outbound_generation_save_manual necesita un workspace fijado en la transacción.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO t FROM outbound_touch WHERE id = p_touch AND workspace_id = ws FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF t.channel <> 'email' OR t.status NOT IN ('draft','held') OR t.unconfirmed_attempt IS NOT NULL
     OR (t.step_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM outbound_step st WHERE st.id = t.step_id AND st.step_type = 'email')) THEN
    RETURN 'not_editable';
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
  '(outcome ''manual'') y cancela cualquier redacción pendiente de ese toque, en su workspace, solo si el toque es un '
  'correo en draft o held sin intento sin confirmar (la misma guardia que outbound_generation_request); si no, '
  'devuelve ''not_editable'' sin escribir (0057, 0058, 0059).';
