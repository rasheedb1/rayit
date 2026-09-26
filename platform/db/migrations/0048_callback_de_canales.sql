-- =====================================================================
-- 0048 · El callback de un canal de outreach, desde la web (VEN-9)
-- ---------------------------------------------------------------------
-- Número: 0048. La serie de integración va de 0043 a 0075, detrás de
-- la 0042 de main (0034–0042, ya aplicadas en Supabase); ninguna de la
-- serie está aplicada aún. Hasta el pulido r2 de ventas esta fue la
-- 0039. Va detrás de 0047_canales_outreach y no depende de nada
-- posterior.
--
-- El problema. 0046 §2.1 cerró las columnas que prueban que la
-- plataforma habló con el proveedor (status autenticado,
-- provider_account_id de una fila que ya existe, secret_ref, scopes):
-- solo las escribe el despachador. Pero quien habla con el proveedor en
-- una conexión es la WEB: el callback del OAuth de Google vuelve al
-- navegador, y el aviso de cuenta creada de Unipile llega a una ruta de
-- la web. Y la web es mc_app, que no es miembro de mc_worker a
-- propósito (no puede cruzar workspaces), así que el asWorker que pedía
-- la pista del disparador no existe allí.
--
-- La salida es una operación con nombre, como las de los enlaces
-- públicos (0030): dos funciones SECURITY DEFINER, dueñas del rol que
-- migra (el dueño de outbound_touch, que outreach_is_dispatcher ya
-- cuenta como despachador), que hacen UNA cosa cada una y nada más:
--
--   outreach_channel_connect   pasa la fila 'pending' de ESE nonce, en
--                              el workspace de la transacción, a
--                              'connected' con la cuenta que devolvió el
--                              proveedor. Sin la fila 'pending' no hace
--                              nada: el nonce es de un solo uso y nace en
--                              el inicio de la conexión.
--   outreach_channel_mark_down  el proveedor dice que la cuenta cayó
--                              (el aviso account_status de Unipile):
--                              connected o error → needs_reconnect.
--
-- Por qué no cruzan workspaces: las tablas llevan FORCE ROW LEVEL
-- SECURITY (0024), que también ata al dueño. Las dos funciones ven solo
-- las filas de current_workspace_id(), que fija el cliente de base en
-- la transacción, igual que cualquier consulta de la web. Que un buzón
-- esté conectado en OTRO espacio lo dice el índice global
-- (outreach_channel_account_live_idx) con 23505, sin leer la fila ajena:
-- la función lo traduce a 'taken' y no escribe nada.
--
-- Quién las llama: solo los dos callbacks de la web, DESPUÉS de verificar
-- el estado firmado (HMAC con TOKEN_ENCRYPTION_KEY) y de haber hablado
-- con el proveedor con su propia llave: el code de Google canjeado, o la
-- cuenta de Unipile leída con UNIPILE_ACCESS_TOKEN. EXECUTE solo a
-- mc_app; mc_worker no las necesita (escribe directo).
-- =====================================================================

CREATE FUNCTION outreach_channel_connect(
  p_channel text,
  p_nonce text,
  p_provider_account_id text,
  p_display_name text,
  p_secret_ref text,
  p_scopes text[]
)
RETURNS TABLE (result text, account_id uuid, reconnected boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ws uuid := current_workspace_id();
  prov text;
  pend outreach_channel_account%ROWTYPE;
  prev outreach_channel_account%ROWTYPE;
BEGIN
  IF ws IS NULL THEN
    RAISE EXCEPTION 'outreach_channel_connect necesita un workspace fijado en la transacción.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_channel NOT IN ('email', 'linkedin', 'instagram_dm') THEN
    RAISE EXCEPTION 'Canal desconocido: %.', p_channel USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_nonce IS NULL OR p_nonce !~ '^[A-Za-z0-9_-]{32,64}$' THEN
    RAISE EXCEPTION 'Nonce inválido.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_provider_account_id IS NULL OR btrim(p_provider_account_id) = '' OR p_provider_account_id LIKE 'pending:%' THEN
    RAISE EXCEPTION 'La cuenta del proveedor no puede estar vacía ni ser pendiente.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- El correo lleva token (secret_ref y alcances); Unipile no: la llave es la nuestra.
  IF (p_channel = 'email') <> (p_secret_ref IS NOT NULL) THEN
    RAISE EXCEPTION 'Un Gmail se conecta con su token y un LinkedIn o Instagram sin él.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  prov := CASE p_channel WHEN 'email' THEN 'gmail_oauth' ELSE 'unipile' END;

  SELECT * INTO pend FROM outreach_channel_account a
   WHERE a.workspace_id = ws AND a.provider = prov AND a.channel = p_channel
     AND a.provider_account_id = 'pending:' || p_nonce AND a.status = 'pending'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unknown_state'::text, NULL::uuid, false;
    RETURN;
  END IF;

  SELECT * INTO prev FROM outreach_channel_account a
   WHERE a.workspace_id = ws AND a.provider = prov AND a.provider_account_id = p_provider_account_id
   FOR UPDATE;

  BEGIN
    IF prev.id IS NOT NULL THEN
      -- Reconectar: revive la fila que ya tenía el espacio (su historial y sus contadores) y borra la pendiente.
      DELETE FROM outreach_channel_account WHERE id = pend.id;
      UPDATE outreach_channel_account
         SET status = 'connected', creator_id = pend.creator_id,
             display_name = coalesce(p_display_name, display_name),
             secret_ref = coalesce(p_secret_ref, secret_ref),
             scopes = CASE WHEN p_secret_ref IS NULL THEN scopes ELSE coalesce(p_scopes, '{}') END,
             last_ok_at = now(), last_error = NULL, last_error_at = NULL,
             warmup_started_at = coalesce(warmup_started_at, now())
       WHERE id = prev.id;
      RETURN QUERY SELECT 'connected'::text, prev.id, true;
    ELSE
      UPDATE outreach_channel_account
         SET provider_account_id = p_provider_account_id, status = 'connected',
             display_name = coalesce(p_display_name, p_provider_account_id),
             secret_ref = p_secret_ref, scopes = coalesce(p_scopes, '{}'),
             last_ok_at = now(), last_error = NULL, last_error_at = NULL, warmup_started_at = now()
       WHERE id = pend.id;
      RETURN QUERY SELECT 'connected'::text, pend.id, false;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    -- Ese buzón está autenticado en otro espacio. No se escribe nada: quien llama marca la pendiente.
    RETURN QUERY SELECT 'taken'::text, NULL::uuid, false;
  END;
END;
$$;
REVOKE ALL ON FUNCTION outreach_channel_connect(text, text, text, text, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outreach_channel_connect(text, text, text, text, text, text[]) TO mc_app;
COMMENT ON FUNCTION outreach_channel_connect(text, text, text, text, text, text[]) IS
  'El callback de un canal de outreach desde la web (callback_de_canales): la fila pending de ese nonce, en el workspace de la '
  'transacción, pasa a connected con la cuenta que devolvió el proveedor. taken si el buzón vive en otro espacio.';

CREATE FUNCTION outreach_channel_mark_down(p_account_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ws uuid := current_workspace_id();
  n integer;
BEGIN
  IF ws IS NULL THEN
    RAISE EXCEPTION 'outreach_channel_mark_down necesita un workspace fijado en la transacción.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE outreach_channel_account
     SET status = 'needs_reconnect', last_error = left(coalesce(p_reason, ''), 500), last_error_at = now()
   WHERE id = p_account_id AND workspace_id = ws AND provider = 'unipile' AND status IN ('connected', 'error');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END;
$$;
REVOKE ALL ON FUNCTION outreach_channel_mark_down(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outreach_channel_mark_down(uuid, text) TO mc_app;
COMMENT ON FUNCTION outreach_channel_mark_down(uuid, text) IS
  'El aviso account_status de Unipile desde la web (callback_de_canales): una cuenta connected o error de ese workspace pasa a '
  'needs_reconnect con el motivo. Nada más.';
