-- =====================================================================
-- canales_reclamar_al_soltar · Canales de outreach: soltar una cuenta sin pisar su
--        reconexión (VEN-9, ronda 3)
-- ---------------------------------------------------------------------
-- Número: detrás de canales_liberar_y_limites, que tampoco está aplicada en Supabase. El
-- integrador las renumera juntas (canales_outreach a canales_reclamar_al_soltar).
--
-- La carrera. sales.channels_release (canales_liberar_y_limites) leía la fila desconectada,
-- leía su token y revocaba en Google (o borraba la cuenta en Unipile),
-- y solo DESPUÉS comprobaba que la fila siguiera desconectada. Si la
-- persona reconectaba el mismo Gmail entre medias:
--
--   · el callback reutilizaba la MISMA ref del vault (existingGmailSecretRef)
--     y escribía allí el token nuevo; el job leía ese token y revocaba la
--     concesión recién creada;
--   · y aunque leyera el viejo: revocar en Google tumba la concesión
--     entera de ese usuario con nuestro cliente, también el token nuevo.
--
-- La fila quedaba «Conectado» con un permiso muerto hasta el keepalive
-- del día siguiente. En Unipile, deleteAccount borraba la sesión recién
-- reconectada.
--
-- La salida:
--
--   1 · release_claimed_at. El job RECLAMA la fila antes de hablar con el
--       proveedor, en una sola sentencia (status 'disconnected',
--       released_at NULL, sin reclamo vivo → release_claimed_at = now(),
--       RETURNING la ref y los avisos que va a soltar). Si el proveedor
--       falla, suelta el reclamo; si sale bien, marca released_at. Un
--       reclamo de más de 15 minutos es de un job que murió: otro lo
--       puede tomar. Es columna del despachador, como las de canales_liberar_y_limites.
--   2 · outreach_channel_connect se niega a revivir una fila reclamada:
--       devuelve 'releasing' y no escribe nada (la web deshace su
--       transacción, token incluido, y dice «vuelve a intentarlo en un
--       minuto»). Reconectar mientras el job revoca daría una cuenta
--       «Conectado» con un permiso que Google ya retiró; esperar un
--       minuto da una concesión nueva y sana. Al revivir una fila
--       desconectada limpia released_at y el reclamo, y si el Gmail
--       llega con una ref NUEVA (la web ya no reutiliza la de una fila
--       desconectada) borra del vault el token viejo de esa fila, que
--       nadie más nombra.
--
-- Por qué basta: el reclamo es un UPDATE sobre la fila y la conexión la
-- lee con FOR UPDATE, así que las dos se ordenan. Si reconectar va
-- primero, la fila ya no está 'disconnected' y el job no la reclama; si
-- el job va primero, la conexión ve el reclamo y se niega.
-- =====================================================================

ALTER TABLE outreach_channel_account ADD COLUMN release_claimed_at timestamptz;
COMMENT ON COLUMN outreach_channel_account.release_claimed_at IS
  'sales.channels_release reclamó la fila para soltarla en el proveedor (canales_reclamar_al_soltar). Mientras dure (15 min como mucho), '
  'outreach_channel_connect no la revive. Solo lo escribe el despachador.';

-- El disparador de canales_liberar_y_limites, con la columna nueva entre las del despachador.
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
      IF NEW.released_at IS NOT NULL OR NEW.release_claimed_at IS NOT NULL OR cardinality(NEW.provider_webhook_ids) > 0 THEN
        RAISE EXCEPTION 'Los avisos y la liberación de una cuenta de canal los escribe el despachador (rol %).', current_user
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF NEW.provider_webhook_ids IS DISTINCT FROM OLD.provider_webhook_ids
       OR NEW.release_claimed_at IS DISTINCT FROM OLD.release_claimed_at
       OR (NEW.released_at IS DISTINCT FROM OLD.released_at AND NOT desconecta) THEN
      RAISE EXCEPTION 'Los avisos y la liberación de una cuenta de canal los escribe el despachador (rol %).', current_user
        USING ERRCODE = 'insufficient_privilege',
              HINT = 'Desconectar deja released_at en NULL solo; lo pone sales.channels_release al soltar la cuenta.';
    END IF;
  END IF;
  -- Desconectar (lo haga quien lo haga) deja la cuenta pendiente de soltar, sin reclamo.
  IF desconecta THEN
    NEW.released_at := NULL;
    NEW.release_claimed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER outreach_channel_account_release_columns ON outreach_channel_account;
CREATE TRIGGER outreach_channel_account_release_columns
  BEFORE INSERT OR UPDATE OF status, provider_webhook_ids, released_at, release_claimed_at ON outreach_channel_account
  FOR EACH ROW EXECUTE FUNCTION outreach_channel_account_release_columns();

-- 2 · outreach_channel_connect (callback_de_canales), con 'releasing'. Misma firma, mismo
-- dueño, mismos permisos: CREATE OR REPLACE los conserva.
CREATE OR REPLACE FUNCTION outreach_channel_connect(
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

  -- El job la está soltando en el proveedor: revivirla ahora daría un permiso muerto. No se escribe nada.
  IF prev.id IS NOT NULL AND prev.status = 'disconnected'
     AND prev.release_claimed_at IS NOT NULL AND prev.release_claimed_at > now() - interval '15 minutes' THEN
    RETURN QUERY SELECT 'releasing'::text, NULL::uuid, false;
    RETURN;
  END IF;

  BEGIN
    IF prev.id IS NOT NULL THEN
      DELETE FROM outreach_channel_account WHERE id = pend.id;
      UPDATE outreach_channel_account
         SET status = 'connected', creator_id = pend.creator_id,
             display_name = coalesce(p_display_name, display_name),
             secret_ref = coalesce(p_secret_ref, secret_ref),
             scopes = CASE WHEN p_secret_ref IS NULL THEN scopes ELSE coalesce(p_scopes, '{}') END,
             last_ok_at = now(), last_error = NULL, last_error_at = NULL,
             warmup_started_at = coalesce(warmup_started_at, now()),
             released_at = NULL, release_claimed_at = NULL
       WHERE id = prev.id;
      -- El token viejo de una fila desconectada que vuelve con una ref nueva: ya nadie lo nombra.
      IF prev.secret_ref IS NOT NULL AND p_secret_ref IS NOT NULL AND prev.secret_ref <> p_secret_ref THEN
        DELETE FROM connection_secret s
         WHERE s.secret_ref = prev.secret_ref AND s.workspace_id = ws
           AND NOT EXISTS (SELECT 1 FROM outreach_channel_account o WHERE o.secret_ref = s.secret_ref);
      END IF;
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
    RETURN QUERY SELECT 'taken'::text, NULL::uuid, false;
  END;
END;
$$;
COMMENT ON FUNCTION outreach_channel_connect(text, text, text, text, text, text[]) IS
  'El callback de un canal de outreach desde la web (callback_de_canales, canales_reclamar_al_soltar): la fila pending de ese nonce, en el workspace de la '
  'transacción, pasa a connected con la cuenta que devolvió el proveedor. taken si el buzón vive en otro espacio; '
  'releasing si sales.channels_release está soltando esa misma cuenta (no escribe nada).';


-- =====================================================================
-- 3 · outbound_touch.channel_account_id: desde qué cuenta salió el toque
-- ---------------------------------------------------------------------
-- Una respuesta que llega por el LinkedIn o el Instagram de la persona
-- solo se guarda si su hilo es el de un toque enviado desde ESA cuenta
-- (recordInboundMessage, @mc/db). Sin la cuenta en el toque, cualquier
-- DM de un amigo o de un fan entraba a outbound_message con su cuerpo, y
-- un chat se podía atar al toque de otra cuenta del mismo espacio.
--
-- Es la misma columna que trae VEN-10 (el despachador la fija al
-- reclamar el toque), con las mismas guardias y los mismos nombres, y
-- todo idempotente: la migración del motor la encuentra hecha. Se
-- adelanta aquí porque la necesita el webhook de esta historia.
-- =====================================================================
ALTER TABLE outbound_touch
  ADD COLUMN IF NOT EXISTS channel_account_id uuid REFERENCES outreach_channel_account(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS outbound_touch_channel_account_idx ON outbound_touch (channel_account_id)
  WHERE channel_account_id IS NOT NULL;

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

-- La cuenta es del workspace del toque y de su canal, también para el worker (BYPASSRLS).
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
