-- =====================================================================
-- canales_identidad_y_rotacion · Canales de outreach: un perfil es una cuenta, el secreto de
--        los avisos se rota y el keepalive va por lotes (VEN-9, ronda 5)
-- ---------------------------------------------------------------------
-- Número: detrás de canales_reclamar_al_soltar, que tampoco está aplicada en Supabase. El
-- integrador las renumera juntas (canales_outreach a canales_identidad_y_rotacion).
--
--   1 · la identidad del perfil en el proveedor, única entre las vivas
--   2 · la huella del secreto con el que se dieron de alta los avisos
--   3 · keepalive_checked_at: el cursor de los lotes del keepalive
--   4 · outreach_channel_connect con identidad, duplicados y «en uso»
--   5 · outreach_channel_mark_ok: la cuenta vuelve sin esperar al keepalive
--   6 · outreach_channel_set_webhooks con la huella
--   7 · sales.channels_keepalive cada hora, por lotes
--   8 · notified_account_id: la cuenta que trajo el aviso, en la pendiente
--
-- 1 · La identidad del perfil
--
--   Para Unipile, la unicidad «ocupada» (outreach_channel_account_live_idx)
--   miraba el account_id, y ese id CAMBIA cada vez que la misma persona
--   completa una hosted auth de tipo «crear». El mismo LinkedIn se podía
--   conectar dos veces (con «Conectar otra cuenta» o desde otro espacio)
--   con dos ids: dos filas, dos topes diarios sumados (el riesgo de que
--   LinkedIn bloquee el perfil), dos cuentas cobradas, y la frase «Esa
--   cuenta ya está conectada en otro espacio» no salía nunca.
--
--   provider_identity es quién es la persona en el proveedor
--   (connection_params.im.id de Unipile: el member id de LinkedIn, el id
--   de Instagram). No cambia entre hosted auths. El índice único parcial
--   de abajo la hace única entre las filas VIVAS de todos los espacios,
--   con el mismo criterio que el de 0037 §2 (un perfil envía desde UN
--   espacio). La escribe solo quien habló con el proveedor: entra en el
--   candado de 0037 §2.1, como provider_account_id.
-- =====================================================================

ALTER TABLE outreach_channel_account
  ADD COLUMN provider_identity text
    CONSTRAINT outreach_channel_account_identity_check
    CHECK (provider_identity IS NULL OR (provider = 'unipile' AND length(provider_identity) BETWEEN 1 AND 256)),
  ADD COLUMN provider_webhook_secret_fp text
    CONSTRAINT outreach_channel_account_webhook_secret_fp_check
    CHECK (provider_webhook_secret_fp IS NULL OR (provider = 'unipile' AND provider_webhook_secret_fp ~ '^[0-9a-f]{16}$')),
  ADD COLUMN keepalive_checked_at timestamptz,
  -- 8 · La cuenta de Unipile que trajo el aviso de cuenta creada, guardada
  -- en la pendiente de ese intento al recibirlo (la web, por su nonce
  -- firmado). Si la conexión no se completa y el borrado en Unipile
  -- falla, la conciliación del keepalive reconoce la cuenta como nuestra
  -- por aquí, sin depender de que Unipile devuelva el `name` de la hosted
  -- auth en la cuenta (docs/ventas-outreach.md §9.3, el plan B). No entra
  -- en el candado de 0037 §2.1: no liga ni conecta nada, y lo único que
  -- abre es que la conciliación borre una cuenta que NINGUNA fila nombra.
  ADD COLUMN notified_account_id text
    CONSTRAINT outreach_channel_account_notified_account_check
    CHECK (notified_account_id IS NULL OR (provider = 'unipile' AND length(notified_account_id) BETWEEN 1 AND 256));

COMMENT ON COLUMN outreach_channel_account.provider_identity IS
  'Quién es la persona en el proveedor (canales_identidad_y_rotacion): el member id de LinkedIn o el id de Instagram que da Unipile. Única '
  'entre las filas vivas: el mismo perfil no se conecta dos veces aunque Unipile le dé otro account_id.';
COMMENT ON COLUMN outreach_channel_account.provider_webhook_secret_fp IS
  'La huella (HMAC, 16 hex) del UNIPILE_WEBHOOK_SECRET con el que se dieron de alta los avisos de la cuenta (canales_identidad_y_rotacion). '
  'El keepalive vuelve a darlos de alta cuando no es la del secreto actual: rotar el secreto no pierde respuestas.';
COMMENT ON COLUMN outreach_channel_account.notified_account_id IS
  'La cuenta de Unipile que trajo el aviso de cuenta creada de este intento (canales_identidad_y_rotacion §8). La conciliación del keepalive '
  'borra por aquí una cuenta que nadie nombra aunque Unipile no devuelva el name de la hosted auth.';
COMMENT ON COLUMN outreach_channel_account.keepalive_checked_at IS
  'Cuándo la comprobó el keepalive por última vez (canales_identidad_y_rotacion): el cursor de sus lotes. Cada corrida toma las más viejas.';

CREATE UNIQUE INDEX outreach_channel_account_identity_live_idx
  ON outreach_channel_account (provider, channel, provider_identity)
  WHERE provider_identity IS NOT NULL AND status IN ('connected', 'needs_reconnect', 'error');

-- El cursor del keepalive: las vivas, de la comprobación más vieja a la más nueva.
CREATE INDEX outreach_channel_account_keepalive_idx
  ON outreach_channel_account (provider, keepalive_checked_at NULLS FIRST, id)
  WHERE status IN ('connected', 'needs_reconnect', 'error');

-- El candado de 0037 §2.1, con provider_identity entre lo que solo escribe el callback del proveedor.
CREATE OR REPLACE FUNCTION outreach_channel_account_worker_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  escribe text[] := '{}';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('pending', 'disconnected') THEN escribe := escribe || 'status'::text; END IF;
    IF NEW.secret_ref IS NOT NULL THEN escribe := escribe || 'secret_ref'::text; END IF;
    IF cardinality(NEW.scopes) > 0 THEN escribe := escribe || 'scopes'::text; END IF;
    IF NEW.provider_identity IS NOT NULL THEN escribe := escribe || 'provider_identity'::text; END IF;
    IF NEW.warmup_started_at IS NOT NULL THEN escribe := escribe || 'warmup_started_at'::text; END IF;
    IF NEW.last_ok_at IS NOT NULL THEN escribe := escribe || 'last_ok_at'::text; END IF;
  ELSE
    -- Desde la web el estado solo va a 'disconnected': volver a
    -- 'pending' una cuenta que ya se autenticó la dejaría borrable
    -- (outreach_channel_account_keep_live) y con ella sus contadores.
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'disconnected' THEN
      escribe := escribe || 'status'::text;
    END IF;
    -- channel y provider son la identidad de la cuenta: cambiarlos saca
    -- el buzón del índice global (provider, provider_account_id) con la
    -- credencial de otro proveedor dentro.
    IF NEW.channel IS DISTINCT FROM OLD.channel THEN escribe := escribe || 'channel'::text; END IF;
    IF NEW.provider IS DISTINCT FROM OLD.provider THEN escribe := escribe || 'provider'::text; END IF;
    IF NEW.provider_account_id IS DISTINCT FROM OLD.provider_account_id THEN
      escribe := escribe || 'provider_account_id'::text;
    END IF;
    IF NEW.secret_ref IS DISTINCT FROM OLD.secret_ref THEN escribe := escribe || 'secret_ref'::text; END IF;
    IF NEW.scopes IS DISTINCT FROM OLD.scopes THEN escribe := escribe || 'scopes'::text; END IF;
    IF NEW.provider_identity IS DISTINCT FROM OLD.provider_identity THEN escribe := escribe || 'provider_identity'::text; END IF;
    -- El calentamiento y la última vez que el proveedor respondió bien los
    -- escribe quien habló con él: moverlos saltaba el calentamiento de
    -- VEN-15 o pintaba sana una cuenta que no lo está.
    IF NEW.warmup_started_at IS DISTINCT FROM OLD.warmup_started_at THEN escribe := escribe || 'warmup_started_at'::text; END IF;
    IF NEW.last_ok_at IS DISTINCT FROM OLD.last_ok_at THEN escribe := escribe || 'last_ok_at'::text; END IF;
  END IF;
  IF cardinality(escribe) = 0 OR outreach_is_dispatcher() THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Una cuenta de canal la autentica el callback del proveedor, no la aplicación: % (rol %).',
                  array_to_string(escribe, ', '), current_user
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'El OAuth de Google o el alta en Unipile escriben status, provider_account_id, provider_identity, '
                 'secret_ref y scopes con asWorker o por outreach_channel_connect. Desde la web solo se crea la fila '
                 'pendiente o se desconecta.';
END;
$$;

DROP TRIGGER outreach_channel_account_worker_columns ON outreach_channel_account;
CREATE TRIGGER outreach_channel_account_worker_columns
  BEFORE INSERT OR UPDATE OF status, provider_account_id, secret_ref, scopes, provider_identity, channel, provider, warmup_started_at, last_ok_at
  ON outreach_channel_account
  FOR EACH ROW EXECUTE FUNCTION outreach_channel_account_worker_columns();


-- =====================================================================
-- 2 · La huella del secreto de los avisos
-- ---------------------------------------------------------------------
-- Rotar UNIPILE_WEBHOOK_SECRET dejaba 401 cada aviso de mensajes y de
-- salud de las cuentas ya conectadas: los avisos en Unipile llevan el
-- secreto viejo en su cabecera. Ahora la web acepta el actual y el
-- anterior (UNIPILE_WEBHOOK_SECRET_PREVIOUS) durante la ventana de
-- rotación, y el keepalive vuelve a dar de alta los avisos de toda
-- cuenta cuya huella no es la del secreto actual (docs/ventas-outreach.md
-- §9.1). La huella es columna del despachador, como los ids de los
-- avisos (canales_liberar_y_limites): la web la escribe solo por outreach_channel_set_webhooks.
-- =====================================================================
CREATE OR REPLACE FUNCTION outreach_channel_account_release_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  desconecta boolean := TG_OP = 'UPDATE' AND NEW.status = 'disconnected' AND OLD.status IS DISTINCT FROM 'disconnected';
BEGIN
  IF NOT outreach_is_dispatcher() THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.released_at IS NOT NULL OR NEW.release_claimed_at IS NOT NULL OR cardinality(NEW.provider_webhook_ids) > 0
         OR NEW.provider_webhook_secret_fp IS NOT NULL THEN
        RAISE EXCEPTION 'Los avisos y la liberación de una cuenta de canal los escribe el despachador (rol %).', current_user
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF NEW.provider_webhook_ids IS DISTINCT FROM OLD.provider_webhook_ids
       OR NEW.provider_webhook_secret_fp IS DISTINCT FROM OLD.provider_webhook_secret_fp
       OR NEW.release_claimed_at IS DISTINCT FROM OLD.release_claimed_at
       OR (NEW.released_at IS DISTINCT FROM OLD.released_at AND NOT desconecta) THEN
      RAISE EXCEPTION 'Los avisos y la liberación de una cuenta de canal los escribe el despachador (rol %).', current_user
        USING ERRCODE = 'insufficient_privilege',
              HINT = 'Desconectar deja released_at en NULL solo; lo pone sales.channels_release al soltar la cuenta.';
    END IF;
  END IF;
  IF desconecta THEN
    NEW.released_at := NULL;
    NEW.release_claimed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER outreach_channel_account_release_columns ON outreach_channel_account;
CREATE TRIGGER outreach_channel_account_release_columns
  BEFORE INSERT OR UPDATE OF status, provider_webhook_ids, provider_webhook_secret_fp, released_at, release_claimed_at
  ON outreach_channel_account
  FOR EACH ROW EXECUTE FUNCTION outreach_channel_account_release_columns();


-- =====================================================================
-- 3 · ¿Esa cuenta del proveedor está viva en OTRO espacio?
-- ---------------------------------------------------------------------
-- Cuando la conexión no se completa (canal equivocado, perfil ocupado,
-- la pendiente ya usada, la fila soltándose), el proveedor YA creó algo:
-- una cuenta en Unipile, que cobra cada mes, o una concesión en Google.
-- La web la suelta (deleteAccount, revoke) SOLO si nadie más la usa:
-- revocar en Google tumba la concesión entera de esa persona con nuestro
-- cliente, también la del otro espacio donde el buzón sigue vivo; borrar
-- en Unipile una cuenta viva en otra fila la dejaría sin sesión.
--
-- Desde la web, la RLS solo deja ver el espacio de la transacción. El
-- índice global de 0037 §2 sí sabe lo de los demás, y responde con
-- 23505. Esta función lo pregunta sin escribir nada: dentro de un
-- subbloque, pone la cuenta como viva en ESTE espacio (o revive la fila
-- que ya tiene) y deshace el subbloque siempre. Si el índice global
-- salta, la cuenta vive en otro espacio.
--
-- No es un oráculo nuevo: outreach_channel_connect ya respondía 'taken'
-- con el mismo índice, y solo la llama outreach_channel_connect, después
-- de que el proveedor autenticara esa cuenta. EXECUTE a nadie: es
-- SECURITY INVOKER y corre con el dueño dentro de la otra.
-- =====================================================================
CREATE FUNCTION outreach_channel_live_elsewhere(p_ws uuid, p_channel text, p_provider text, p_provider_account_id text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  mine outreach_channel_account%ROWTYPE;
  cname text;
BEGIN
  SELECT * INTO mine FROM outreach_channel_account a
   WHERE a.workspace_id = p_ws AND a.provider = p_provider AND a.provider_account_id = p_provider_account_id;
  -- Viva aquí: el índice global no deja otra viva en otro sitio.
  IF mine.id IS NOT NULL AND mine.status IN ('connected', 'needs_reconnect', 'error') THEN
    RETURN false;
  END IF;
  BEGIN
    IF mine.id IS NOT NULL THEN
      UPDATE outreach_channel_account SET status = 'connected' WHERE id = mine.id;
    ELSE
      INSERT INTO outreach_channel_account (workspace_id, channel, provider, provider_account_id, status)
      VALUES (p_ws, p_channel, p_provider, p_provider_account_id, 'connected');
    END IF;
    -- Nunca se queda: el subbloque se deshace siempre.
    RAISE EXCEPTION 'sonda de outreach_channel_live_elsewhere' USING ERRCODE = 'P0001';
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
      RETURN cname = 'outreach_channel_account_live_idx';
    WHEN raise_exception THEN
      RETURN false;
  END;
END;
$$;
REVOKE ALL ON FUNCTION outreach_channel_live_elsewhere(uuid, text, text, text) FROM PUBLIC, mc_app;
COMMENT ON FUNCTION outreach_channel_live_elsewhere(uuid, text, text, text) IS
  'Si esa cuenta del proveedor está viva en OTRO workspace (canales_identidad_y_rotacion), por el índice global y sin escribir nada. Solo la '
  'llama outreach_channel_connect.';


-- =====================================================================
-- 4 · outreach_channel_connect, con identidad
-- ---------------------------------------------------------------------
-- La firma cambia (un argumento y tres columnas de salida más), así que
-- se reemplaza: la única que la llama es la web de esta historia.
--
--   p_provider_identity   connection_params.im.id de Unipile (NULL en Gmail)
--
-- Lo nuevo, cuando la cuenta de Unipile NO es la de una fila del espacio
-- (una hosted auth de «crear» estrena account_id) y el espacio ya tiene
-- ese PERFIL:
--
--   · conectado            'duplicate': no se escribe nada. La web borra
--                          en Unipile la cuenta nueva (el perfil ya envía
--                          desde la vieja) y la pendiente lo dice;
--   · caído o desconectado la fila de ese perfil adopta la cuenta nueva
--                          ('connected', reconnected): conserva su
--                          historial y sus contadores, pierde sus avisos
--                          (la web da de alta los de la cuenta nueva) y
--                          devuelve la cuenta VIEJA y sus avisos
--                          (replaced_*) para que la web los borre en
--                          Unipile: una cuenta caída sigue cobrando.
--
-- Si el perfil vive en OTRO espacio, el índice de identidad salta con
-- 23505 y la respuesta es 'taken', como la de un Gmail ocupado.
--
-- Y en toda respuesta que no conecta, in_use dice si esa cuenta del
-- proveedor la usa alguien (viva aquí o en otro espacio): la web solo
-- suelta en el proveedor lo que nadie usa. Un aviso de Unipile repetido
-- tras conectar ('unknown_state') o un buzón ocupado en otro espacio
-- ('taken') no se borran ni se revocan.
-- =====================================================================
DROP FUNCTION outreach_channel_connect(text, text, text, text, text, text[]);

CREATE FUNCTION outreach_channel_connect(
  p_channel text,
  p_nonce text,
  p_provider_account_id text,
  p_display_name text,
  p_secret_ref text,
  p_scopes text[],
  p_provider_identity text
)
RETURNS TABLE (result text, account_id uuid, reconnected boolean, in_use boolean, replaced_account_id text, replaced_webhook_ids text[])
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
  dup outreach_channel_account%ROWTYPE;
  cname text;
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
  IF p_provider_account_id IS NULL OR btrim(p_provider_account_id) = '' OR p_provider_account_id LIKE 'pending:%'
     OR length(p_provider_account_id) > 256 THEN
    RAISE EXCEPTION 'La cuenta del proveedor no puede estar vacía ni ser pendiente.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (p_channel = 'email') <> (p_secret_ref IS NOT NULL) THEN
    RAISE EXCEPTION 'Un Gmail se conecta con su token y un LinkedIn o Instagram sin él.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_provider_identity IS NOT NULL AND (p_channel = 'email' OR btrim(p_provider_identity) = '' OR length(p_provider_identity) > 256) THEN
    RAISE EXCEPTION 'La identidad del perfil es solo de Unipile y no puede estar vacía.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  prov := CASE p_channel WHEN 'email' THEN 'gmail_oauth' ELSE 'unipile' END;

  SELECT * INTO pend FROM outreach_channel_account a
   WHERE a.workspace_id = ws AND a.provider = prov AND a.channel = p_channel
     AND a.provider_account_id = 'pending:' || p_nonce AND a.status = 'pending'
   FOR UPDATE;
  IF NOT FOUND THEN
    -- Ya usada o reemplazada. Un aviso repetido tras conectar trae la cuenta que ya está viva aquí: en uso.
    RETURN QUERY SELECT 'unknown_state'::text, NULL::uuid, false,
      (EXISTS (SELECT 1 FROM outreach_channel_account a WHERE a.workspace_id = ws AND a.provider = prov
                 AND a.provider_account_id = p_provider_account_id AND a.status IN ('connected', 'needs_reconnect', 'error'))
       OR outreach_channel_live_elsewhere(ws, p_channel, prov, p_provider_account_id)),
      NULL::text, NULL::text[];
    RETURN;
  END IF;

  SELECT * INTO prev FROM outreach_channel_account a
   WHERE a.workspace_id = ws AND a.provider = prov AND a.provider_account_id = p_provider_account_id
   FOR UPDATE;

  IF prev.id IS NOT NULL AND prev.status = 'disconnected'
     AND prev.release_claimed_at IS NOT NULL AND prev.release_claimed_at > now() - interval '15 minutes' THEN
    RETURN QUERY SELECT 'releasing'::text, NULL::uuid, false,
      outreach_channel_live_elsewhere(ws, p_channel, prov, p_provider_account_id), NULL::text, NULL::text[];
    RETURN;
  END IF;

  -- El mismo perfil con otra cuenta de Unipile, en este espacio.
  IF prev.id IS NULL AND p_provider_identity IS NOT NULL THEN
    SELECT * INTO dup FROM outreach_channel_account a
     WHERE a.workspace_id = ws AND a.provider = prov AND a.channel = p_channel
       AND a.provider_identity = p_provider_identity AND a.id <> pend.id AND a.status <> 'pending'
     ORDER BY (a.status = 'connected') DESC, (a.status IN ('needs_reconnect', 'error')) DESC, a.updated_at DESC
     LIMIT 1
     FOR UPDATE;
    IF dup.id IS NOT NULL AND dup.status = 'connected' THEN
      RETURN QUERY SELECT 'duplicate'::text, dup.id, false, false, NULL::text, NULL::text[];
      RETURN;
    END IF;
    IF dup.id IS NOT NULL AND dup.status = 'disconnected'
       AND dup.release_claimed_at IS NOT NULL AND dup.release_claimed_at > now() - interval '15 minutes' THEN
      RETURN QUERY SELECT 'releasing'::text, NULL::uuid, false, false, NULL::text, NULL::text[];
      RETURN;
    END IF;
  END IF;

  BEGIN
    IF dup.id IS NOT NULL THEN
      -- La fila de ese perfil adopta la cuenta nueva; la vieja (si no se soltó ya) y sus avisos, a la web para borrarlos.
      DELETE FROM outreach_channel_account WHERE id = pend.id;
      UPDATE outreach_channel_account
         SET provider_account_id = p_provider_account_id, status = 'connected', creator_id = pend.creator_id,
             display_name = coalesce(p_display_name, display_name), provider_identity = p_provider_identity,
             last_ok_at = now(), last_error = NULL, last_error_at = NULL,
             warmup_started_at = coalesce(warmup_started_at, now()),
             provider_webhook_ids = '{}', provider_webhook_secret_fp = NULL,
             released_at = NULL, release_claimed_at = NULL
       WHERE id = dup.id;
      RETURN QUERY SELECT 'connected'::text, dup.id, true, true,
        CASE WHEN dup.status = 'disconnected' AND dup.released_at IS NOT NULL THEN NULL ELSE dup.provider_account_id END,
        CASE WHEN dup.status = 'disconnected' AND dup.released_at IS NOT NULL THEN '{}'::text[] ELSE dup.provider_webhook_ids END;
    ELSIF prev.id IS NOT NULL THEN
      DELETE FROM outreach_channel_account WHERE id = pend.id;
      UPDATE outreach_channel_account
         SET status = 'connected', creator_id = pend.creator_id,
             display_name = coalesce(p_display_name, display_name),
             provider_identity = coalesce(p_provider_identity, provider_identity),
             secret_ref = coalesce(p_secret_ref, secret_ref),
             scopes = CASE WHEN p_secret_ref IS NULL THEN scopes ELSE coalesce(p_scopes, '{}') END,
             last_ok_at = now(), last_error = NULL, last_error_at = NULL,
             warmup_started_at = coalesce(warmup_started_at, now()),
             released_at = NULL, release_claimed_at = NULL
       WHERE id = prev.id;
      IF prev.secret_ref IS NOT NULL AND p_secret_ref IS NOT NULL AND prev.secret_ref <> p_secret_ref THEN
        DELETE FROM connection_secret s
         WHERE s.secret_ref = prev.secret_ref AND s.workspace_id = ws
           AND NOT EXISTS (SELECT 1 FROM outreach_channel_account o WHERE o.secret_ref = s.secret_ref);
      END IF;
      RETURN QUERY SELECT 'connected'::text, prev.id, true, true, NULL::text, NULL::text[];
    ELSE
      UPDATE outreach_channel_account
         SET provider_account_id = p_provider_account_id, status = 'connected',
             display_name = coalesce(p_display_name, p_provider_account_id), provider_identity = p_provider_identity,
             secret_ref = p_secret_ref, scopes = coalesce(p_scopes, '{}'),
             last_ok_at = now(), last_error = NULL, last_error_at = NULL, warmup_started_at = now()
       WHERE id = pend.id;
      RETURN QUERY SELECT 'connected'::text, pend.id, false, true, NULL::text, NULL::text[];
    END IF;
  EXCEPTION WHEN unique_violation THEN
    -- Vive en otro espacio: la cuenta misma (live_idx: está en uso, no se suelta) o el perfil con otra cuenta
    -- (identity_live_idx: la cuenta nueva no la usa nadie y la web la borra).
    GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
    RETURN QUERY SELECT 'taken'::text, NULL::uuid, false, cname = 'outreach_channel_account_live_idx', NULL::text, NULL::text[];
  END;
END;
$$;
REVOKE ALL ON FUNCTION outreach_channel_connect(text, text, text, text, text, text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outreach_channel_connect(text, text, text, text, text, text[], text) TO mc_app;
COMMENT ON FUNCTION outreach_channel_connect(text, text, text, text, text, text[], text) IS
  'El callback de un canal de outreach desde la web (callback_de_canales, canales_reclamar_al_soltar, canales_identidad_y_rotacion): la fila pending de ese nonce, en el workspace '
  'de la transacción, pasa a connected con la cuenta que devolvió el proveedor, o la fila del mismo perfil la adopta. '
  'taken si la cuenta o el perfil viven en otro espacio; duplicate si el perfil ya está conectado aquí; releasing si '
  'se está soltando. in_use dice si la web puede soltar en el proveedor lo que se creó.';


-- =====================================================================
-- 5 · outreach_channel_mark_ok
-- ---------------------------------------------------------------------
-- El aviso account_status de Unipile que dice que la sesión volvió (OK,
-- RECONNECTED: la persona resolvió el reto de LinkedIn) se ignoraba: la
-- fila seguía en rojo, «Necesita reconectar», hasta el keepalive. Es la
-- pareja de outreach_channel_mark_down (callback_de_canales), con el mismo dueño y la
-- misma cerradura: needs_reconnect o error → connected, y last_error
-- fuera salvo el de los avisos sin dar de alta, que lo quita quien los da
-- de alta. Nada más.
-- =====================================================================
CREATE FUNCTION outreach_channel_mark_ok(p_account_id uuid)
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
    RAISE EXCEPTION 'outreach_channel_mark_ok necesita un workspace fijado en la transacción.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE outreach_channel_account
     SET status = 'connected', last_ok_at = now(),
         last_error = CASE WHEN last_error = 'webhooks_missing' THEN last_error END,
         last_error_at = CASE WHEN last_error = 'webhooks_missing' THEN last_error_at END
   WHERE id = p_account_id AND workspace_id = ws AND provider = 'unipile' AND status IN ('needs_reconnect', 'error');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END;
$$;
REVOKE ALL ON FUNCTION outreach_channel_mark_ok(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outreach_channel_mark_ok(uuid) TO mc_app;
COMMENT ON FUNCTION outreach_channel_mark_ok(uuid) IS
  'El aviso account_status de Unipile de una sesión que volvió, desde la web (canales_identidad_y_rotacion): una cuenta de Unipile '
  'needs_reconnect o error del workspace de la transacción vuelve a connected. Nada más.';


-- =====================================================================
-- 6 · outreach_channel_set_webhooks, con la huella del secreto
-- ---------------------------------------------------------------------
-- Igual que en canales_liberar_y_limites (solo añade ids, solo en el espacio de la
-- transacción), y además anota con qué secreto se dieron de alta. La
-- firma cambia: se reemplaza.
-- =====================================================================
DROP FUNCTION outreach_channel_set_webhooks(uuid, text[]);

CREATE FUNCTION outreach_channel_set_webhooks(p_account_id uuid, p_webhook_ids text[], p_secret_fp text)
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
    RAISE EXCEPTION 'outreach_channel_set_webhooks necesita un workspace fijado en la transacción.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_webhook_ids IS NULL OR cardinality(p_webhook_ids) = 0 OR cardinality(p_webhook_ids) > 4
     OR EXISTS (SELECT 1 FROM unnest(p_webhook_ids) w WHERE w IS NULL OR w !~ '^[A-Za-z0-9_-]{1,128}$') THEN
    RAISE EXCEPTION 'Ids de aviso inválidos.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_secret_fp IS NULL OR p_secret_fp !~ '^[0-9a-f]{16}$' THEN
    RAISE EXCEPTION 'Huella de secreto inválida.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE outreach_channel_account a
     SET provider_webhook_ids = (
           SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}')
             FROM unnest(a.provider_webhook_ids || p_webhook_ids) x),
         provider_webhook_secret_fp = p_secret_fp
   WHERE a.id = p_account_id AND a.workspace_id = ws AND a.provider = 'unipile'
     AND a.status IN ('connected', 'needs_reconnect', 'error');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END;
$$;
REVOKE ALL ON FUNCTION outreach_channel_set_webhooks(uuid, text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outreach_channel_set_webhooks(uuid, text[], text) TO mc_app;
COMMENT ON FUNCTION outreach_channel_set_webhooks(uuid, text[], text) IS
  'Los avisos de Unipile de una cuenta conectada del workspace de la transacción (canales_liberar_y_limites, canales_identidad_y_rotacion): la web los da de alta '
  'al conectar y los anota aquí, con la huella del secreto, para que sales.channels_release los borre al desconectar '
  'y el keepalive los renueve al rotar el secreto. Solo añade ids.';


-- =====================================================================
-- 7 · sales.channels_keepalive cada hora, por lotes
-- ---------------------------------------------------------------------
-- Una corrida diaria recorría en serie todas las cuentas de todos los
-- espacios con un tope de 300 s: con cientos de creadores se cortaba a
-- medias y las cuentas del final no se refrescaban nunca. Ahora corre
-- cada hora y toma un lote de las cuentas que no se comprobaron en las
-- últimas veinte horas (keepalive_checked_at, de la más vieja a la más
-- nueva), con cuatro a la vez (max_concurrency): cada cuenta se
-- comprueba una vez al día, y 24 lotes cubren miles. El token de Google
-- se renueva con un margen de 25 horas, así que ninguno vence entre dos
-- visitas. timeout_s sube a 600 como red: el job deja de tomar cuentas
-- nuevas cuando se le acaba el tiempo y las que quedan siguen primeras
-- en la cola de la hora siguiente.
-- =====================================================================
UPDATE job_definition
   SET default_cron = '17 * * * *', timeout_s = 600, max_concurrency = 4,
       label_es = 'Mantener vivos los canales de outreach (por lotes, cada hora)'
 WHERE id = 'sales.channels_keepalive';
