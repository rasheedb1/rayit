-- =====================================================================
-- 0058 · Un intento sin confirmar lo resuelve una persona (VEN-10 r3)
-- ---------------------------------------------------------------------
-- Número: 0058. La serie de integración va de 0043 a 0075, detrás de
-- la 0042 de main (0034–0042, ya aplicadas en Supabase); ninguna de la
-- serie está aplicada aún. Hasta el pulido r2 de ventas esta fue la
-- 0053. Va detrás de 0057_motor_ritmo y no depende de nada más.
--
-- El problema: cuando el proveedor no dice si un intento salió (un corte
-- después del POST) y el canal no sabe comprobarlo (Unipile en un chat
-- nuevo o una invitación: findSent responde 'unknown'), el despachador
-- retiene el mensaje (held, held_reason 'unconfirmed_attempt:<n>') y le
-- pide a una persona que mire su carpeta de enviados. Hasta aquí esa
-- persona solo podía «aprobar» (volver a enviar): si el mensaje SÍ había
-- salido, no había forma de decirlo, y la cadencia quedaba frenada detrás
-- de él o salía dos veces. Y marcar el enlace de baja de ese intento como
-- enviado, o devolver su plaza del tope, solo lo podía hacer el
-- despachador.
--
-- La salida es una operación con nombre, como las de 0048: una función
-- SECURITY DEFINER, dueña del rol que migra (el dueño de outbound_touch,
-- que outreach_is_dispatcher cuenta como despachador), que hace UNA cosa
-- en el workspace de la transacción (current_workspace_id(), que fija el
-- cliente de base; las tablas llevan FORCE ROW LEVEL SECURITY):
--
--   outreach_resolve_unconfirmed(touch, outcome)
--     'was_sent'  la persona lo vio en su carpeta de enviados: el toque
--                 pasa a 'sent' (sin pruebas del proveedor, con
--                 blocked_reason 'sent_confirmed_by_user' para que VEN-16
--                 lo distinga), el enlace de baja de ESE intento queda
--                 como enviado (la baja de un clic que llevaba sigue
--                 funcionando) y la plaza del intento se queda gastada.
--     'resend'    no salió: vuelve a 'scheduled' sin la marca del intento,
--                 el enlace de ese intento se borra (nunca salió) y su
--                 plaza vuelve al día en que se reservó
--                 (unconfirmed_caps_on, 0057 §2).
--
-- Devuelve 'ok', 'not_found' (no existe en este workspace),
-- 'not_unconfirmed' (ya no está retenido por un intento sin confirmar) u
-- 'opted_out' (la persona se dio de baja entretanto: no sale ni se marca;
-- se descarta). No toca nada más: el avance de la cadencia lo hace quien
-- la llama (advanceEnrollment), como con cualquier envío.
--
-- EXECUTE a mc_app (la ficha de la empresa) y a mc_worker.
-- Idempotente (CREATE OR REPLACE).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · El enlace de baja del intento, para la función
-- ---------------------------------------------------------------------
-- outbound_optout_link lleva FORCE ROW LEVEL SECURITY y solo tenía
-- políticas de lectura (mc_public_share) y la de alta de quien siembra
-- (0046 §9.2): la función, que corre como su dueño, no podría anotar ni
-- borrar el enlace del intento. Estas tres le alcanzan a quien migra
-- (TO CURRENT_USER: mc_migrator, o mc_migrator_embedded en PGlite) y solo
-- en el workspace fijado; a mc_app no le alcanzan.
DROP POLICY IF EXISTS outbound_optout_link_owner_read ON outbound_optout_link;
CREATE POLICY outbound_optout_link_owner_read ON outbound_optout_link FOR SELECT TO CURRENT_USER
  USING (current_workspace_id() IS NOT NULL AND workspace_id = current_workspace_id());
DROP POLICY IF EXISTS outbound_optout_link_owner_mark ON outbound_optout_link;
CREATE POLICY outbound_optout_link_owner_mark ON outbound_optout_link FOR UPDATE TO CURRENT_USER
  USING (current_workspace_id() IS NOT NULL AND workspace_id = current_workspace_id())
  WITH CHECK (current_workspace_id() IS NOT NULL AND workspace_id = current_workspace_id());
DROP POLICY IF EXISTS outbound_optout_link_owner_drop ON outbound_optout_link;
CREATE POLICY outbound_optout_link_owner_drop ON outbound_optout_link FOR DELETE TO CURRENT_USER
  USING (current_workspace_id() IS NOT NULL AND workspace_id = current_workspace_id());

-- ---------------------------------------------------------------------
-- 2 · La función
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION outreach_resolve_unconfirmed(p_touch uuid, p_outcome text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ws uuid := current_workspace_id();
  t outbound_touch%ROWTYPE;
  accion text;
  fuera boolean;
BEGIN
  IF ws IS NULL THEN
    RAISE EXCEPTION 'outreach_resolve_unconfirmed necesita un workspace fijado en la transacción.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Es SECURITY DEFINER: las políticas no la frenan, así que el permiso
  -- se mira aquí. Resolverlo manda (o anota) un mensaje a una marca: es
  -- del equipo (membership_is_team, 0060: ni 'client' ni 'viewer'). Falla
  -- CERRADA como outreach_can_manage (0055 §7): sin identidad, solo con
  -- app.auth_disabled = 'on' (desarrollo sin Supabase Auth, pruebas).
  -- membership_is_team la crea 0060, que siempre se aplica después; el
  -- cuerpo se resuelve al llamar, no al crear.
  IF NOT ((current_user_id() IS NULL AND coalesce(current_setting('app.auth_disabled', true), '') = 'on')
          OR (current_user_id() IS NOT NULL AND membership_is_team(ws, current_user_id()))) THEN
    RAISE EXCEPTION 'Resolver un intento sin confirmar es del equipo del workspace, no de un cliente ni de un lector.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('was_sent', 'resend') THEN
    RAISE EXCEPTION 'Resultado desconocido: %. Es was_sent o resend.', p_outcome USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO t FROM outbound_touch WHERE id = p_touch AND workspace_id = ws FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF t.status <> 'held' OR t.unconfirmed_attempt IS NULL THEN
    RETURN 'not_unconfirmed';
  END IF;

  -- La misma regla que enforce_outbound_optout (0046 §4.1): ni sale ni se
  -- registra como enviado a quien pidió la baja. Se dice antes de que el
  -- disparador lo rechace con un error.
  SELECT coalesce(c.opted_out, false) OR address_is_suppressed(c.email) INTO fuera FROM contact c WHERE c.id = t.contact_id;
  IF coalesce(fuera, false) OR address_is_suppressed(t.recipient_address) THEN
    RETURN 'opted_out';
  END IF;

  IF p_outcome = 'was_sent' THEN
    UPDATE outbound_touch
       SET status = 'sent', sent_at = now(), held_reason = NULL, next_retry_at = NULL,
           blocked_reason = 'sent_confirmed_by_user', unconfirmed_attempt = NULL, unconfirmed_caps_on = NULL
     WHERE id = t.id;
    UPDATE outbound_optout_link SET sent_at = now()
     WHERE touch_id = t.id AND attempt = t.unconfirmed_attempt AND sent_at IS NULL;
    RETURN 'ok';
  END IF;

  UPDATE outbound_touch
     SET status = 'scheduled', held_reason = NULL, next_retry_at = NULL,
         unconfirmed_attempt = NULL, unconfirmed_caps_on = NULL
   WHERE id = t.id;
  DELETE FROM outbound_optout_link
   WHERE touch_id = t.id AND attempt = t.unconfirmed_attempt AND sent_at IS NULL;
  IF t.unconfirmed_caps_on IS NOT NULL AND t.channel_account_id IS NOT NULL THEN
    accion := CASE t.channel WHEN 'instagram_dm' THEN 'instagram_dm' WHEN 'linkedin' THEN 'linkedin' ELSE 'email' END;
    PERFORM outbound_counter_release(t.workspace_id, t.channel_account_id, accion, t.unconfirmed_caps_on);
    IF t.channel = 'email' THEN
      PERFORM outbound_counter_release(t.workspace_id, NULL, 'email', t.unconfirmed_caps_on);
    END IF;
  END IF;
  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION outreach_resolve_unconfirmed(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outreach_resolve_unconfirmed(uuid, text) TO mc_app, mc_worker;
COMMENT ON FUNCTION outreach_resolve_unconfirmed(uuid, text) IS
  'Una persona resuelve un mensaje retenido porque no se supo si un intento salió (unconfirmed_attempt): '
  '''was_sent'' lo registra como enviado; ''resend'' lo devuelve a la cola con su plaza (0058).';
