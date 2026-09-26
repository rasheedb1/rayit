-- =====================================================================
-- 0071 · Las bandejas, ronda 3 (VEN-14)
-- ---------------------------------------------------------------------
-- Número: 0071. La serie de integración va de 0043 a 0075, detrás de
-- la 0042 de main (0034–0042, ya aplicadas en Supabase); ninguna de la
-- serie está aplicada aún. Hasta el pulido r2 de ventas esta fue la
-- 0066. Va detrás de 0070_bandejas_ronda_2, de la misma historia, y no
-- depende de nada más.
--
-- outbound_touch.approved_from_reason
--
--   El motivo con el que estaba retenido un toque cuando una persona lo
--   aprobó desde /ventas/aprobaciones. Aprobar lo libera (releaseHeldTouch
--   deja held_reason en NULL); «Deshacer» lo devuelve a la cola con ESTE
--   motivo, que guarda el servidor. Antes lo mandaba el navegador junto con
--   la petición de deshacer, y una petición alterada podía dejar en la
--   cola un motivo inventado que la pantalla enseñaba como si viniera del
--   motor. Se vacía al deshacer; si el toque sale, se queda como registro
--   de por qué estaba retenido lo que una persona aprobó.
--
-- outbound_generation_request (abajo)
--
--   «Regenerar» también para un seguimiento en el hilo (email_reply).
-- =====================================================================

ALTER TABLE outbound_touch
  ADD COLUMN approved_from_reason text
    CHECK (approved_from_reason IS NULL OR char_length(approved_from_reason) <= 500);

COMMENT ON COLUMN outbound_touch.approved_from_reason IS
  'El motivo con el que estaba retenido cuando una persona lo aprobó; «Deshacer» lo devuelve a la cola con él (0071).';

-- ---------------------------------------------------------------------
-- outbound_generation_request: también un seguimiento en el hilo
-- ---------------------------------------------------------------------
--
--   «Regenerar con una pista» se ofrecía solo para el primer correo de una
--   cadencia (step_type 'email'). Un seguimiento email_reply que redactó la
--   IA y que el juez dejó por debajo del mínimo (el caso más común de
--   retención) solo se podía aprobar tal cual, editar o saltar, aunque
--   outbound.generate ya sabe redactarlo (sin asunto: sale como «Re:» del
--   hilo). La función es la de 0065, con la misma firma y los mismos
--   permisos, salvo la regla de qué se puede pedir: un correo nuevo o un
--   seguimiento en el hilo, y nunca una respuesta escrita en la bandeja
--   (reply_to_message_id), que es la voz de una persona.
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
  -- Un correo nuevo o un seguimiento en el hilo (email_reply: outbound.generate
  -- lo redacta como «Re:», sin asunto propio). Lo escrito en la bandeja
  -- (reply_to_message_id) es la voz de una persona, no un borrador: no.
  IF t.channel <> 'email' OR t.status NOT IN ('draft','held') OR t.unconfirmed_attempt IS NOT NULL
     OR t.reply_to_message_id IS NOT NULL
     OR (t.step_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM outbound_step st WHERE st.id = t.step_id AND st.step_type IN ('email', 'email_reply'))) THEN
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
  'Una persona pide que la IA redacte (o regenere con una pista cerrada) un correo en draft o held de su workspace: '
  'un correo nuevo o un seguimiento en el hilo (email_reply, 0071), nunca una respuesta escrita en la bandeja, y solo '
  'si la persona que lo recibiría no pidió la baja (global o de este espacio). La fila de outbound_generation queda en '
  '''requested'' para outbound.generate (0062, 0063). requested_by es la persona de la sesión (current_user_id()); '
  'p_user solo cuenta sin sesión y si es miembro del espacio (0065).';
