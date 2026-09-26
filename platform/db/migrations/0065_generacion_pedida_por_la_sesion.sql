-- =====================================================================
-- 0065 · VEN-12 ronda 5: quién pidió el borrador lo dice la sesión
-- =====================================================================
--
-- outbound_generation_request (0062, 0063) es SECURITY DEFINER y guardaba
-- requested_by = p_user tal como lo mandaba quien llama: mc_app podía
-- atribuir la petición a cualquier usuario, aunque current_user_id() ya
-- dice quién está en la sesión (el cliente de base fija app.user_id por
-- transacción, como el workspace).
--
-- Aquí la función es la misma, con la misma firma, salvo esa línea:
-- requested_by es current_user_id() cuando hay sesión; sin sesión (un
-- script o la demo embebida), p_user solo vale si es miembro de ESTE
-- espacio, y si no queda en NULL. La firma no cambia: @mc/db
-- (requestPitchDraft) la sigue llamando igual.
-- =====================================================================

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
  quien uuid;
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

  -- Quién lo pidió: la persona de la sesión (app.user_id, que fija el
  -- cliente de base por transacción) manda sobre lo que diga quien llama.
  -- Sin sesión (un script, la demo), p_user solo vale si es miembro de
  -- ESTE espacio; si no, queda sin atribuir.
  quien := current_user_id();
  IF quien IS NULL AND p_user IS NOT NULL
     AND EXISTS (SELECT 1 FROM membership m WHERE m.workspace_id = ws AND m.user_id = p_user) THEN
    quien := p_user;
  END IF;

  SELECT * INTO g FROM outbound_generation WHERE touch_id = t.id FOR UPDATE;
  IF FOUND AND g.stage IN ('generating','reviewing') AND g.lease_until > now() THEN
    RETURN 'busy';
  END IF;

  INSERT INTO outbound_generation (touch_id, workspace_id, stage, requested_hint, requested_instructions, requested_by, requested_at)
  VALUES (t.id, ws, 'requested', p_hint, nullif(btrim(coalesce(p_instructions, '')), ''), quien, now())
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
  'fila de outbound_generation queda en ''requested'' para outbound.generate, sin fallos ni nota vieja (0062, 0063). '
  'requested_by es la persona de la sesión (current_user_id()); p_user solo cuenta sin sesión y si es miembro del espacio (0065).';
