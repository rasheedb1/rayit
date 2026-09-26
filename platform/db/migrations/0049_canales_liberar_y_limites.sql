-- =====================================================================
-- 0049 · Canales de outreach: soltar lo que se desconecta y los límites
--        de cada cuenta (VEN-9, ronda 2)
-- ---------------------------------------------------------------------
-- Número: 0049. La serie de integración va de 0043 a 0075, detrás de
-- la 0042 de main (0034–0042, ya aplicadas en Supabase); ninguna de la
-- serie está aplicada aún. Hasta el pulido r2 de ventas esta fue la
-- 0040. Va detrás de 0048_callback_de_canales y no depende de nada
-- posterior.
--
--   1 · desconectar suelta la cuenta en el proveedor
--   2 · los límites de cada cuenta, en una vista (la pantalla no calcula)
--   3 · el job sales.channels_release
--
-- 1 · Desconectar suelta la cuenta en el proveedor
--
--   Desconectar solo cambiaba la fila a 'disconnected'. La sesión de
--   LinkedIn o Instagram seguía viva en Unipile, accesible con nuestra
--   llave; Unipile la seguía cobrando cada mes (§5.1: es el costo
--   variable dominante del módulo) y sus dos avisos seguían llegando. El
--   permiso de Google seguía concedido.
--
--   Ahora:
--     provider_webhook_ids  los avisos de Unipile de la cuenta (mensajes
--                           y salud), para borrarlos al soltarla. Los da
--                           de alta la web al conectar y los escribe por
--                           outreach_channel_set_webhooks, abajo.
--     released_at           cuándo se soltó en el proveedor (Google
--                           revocado; cuenta y avisos borrados en
--                           Unipile). Pasar a 'disconnected' lo pone a
--                           NULL por disparador: una fila desconectada
--                           con released_at NULL es trabajo pendiente
--                           para sales.channels_release (§3), que corre
--                           como mc_worker.
--
--   Las dos columnas son del despachador, como las de 0046 §2.1: mc_app
--   no las escribe (42501). Si pudiera, una fila con avisos inventados
--   haría que el worker borrara en Unipile avisos que no son de esa
--   cuenta, y una fila marcada como soltada se quedaría cobrando.
-- =====================================================================

ALTER TABLE outreach_channel_account
  ADD COLUMN provider_webhook_ids text[] NOT NULL DEFAULT '{}'
    CONSTRAINT outreach_channel_account_webhook_ids_check
    CHECK (cardinality(provider_webhook_ids) <= 10 AND (provider = 'unipile' OR cardinality(provider_webhook_ids) = 0)),
  ADD COLUMN released_at timestamptz;

COMMENT ON COLUMN outreach_channel_account.provider_webhook_ids IS
  'Los avisos de Unipile de la cuenta (canales_liberar_y_limites): se borran al soltarla. Solo los escribe el despachador o outreach_channel_set_webhooks.';
COMMENT ON COLUMN outreach_channel_account.released_at IS
  'Cuándo se soltó la cuenta en el proveedor tras desconectarla (canales_liberar_y_limites). NULL en una fila disconnected = pendiente para sales.channels_release.';

-- La cola del job: pocas filas, siempre las mismas condiciones.
CREATE INDEX outreach_channel_account_release_idx ON outreach_channel_account (updated_at)
  WHERE status = 'disconnected' AND released_at IS NULL;

CREATE FUNCTION outreach_channel_account_release_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  desconecta boolean := TG_OP = 'UPDATE' AND NEW.status = 'disconnected' AND OLD.status IS DISTINCT FROM 'disconnected';
BEGIN
  IF NOT outreach_is_dispatcher() THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.released_at IS NOT NULL OR cardinality(NEW.provider_webhook_ids) > 0 THEN
        RAISE EXCEPTION 'Los avisos y la liberación de una cuenta de canal los escribe el despachador (rol %).', current_user
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF NEW.provider_webhook_ids IS DISTINCT FROM OLD.provider_webhook_ids
       OR (NEW.released_at IS DISTINCT FROM OLD.released_at AND NOT desconecta) THEN
      RAISE EXCEPTION 'Los avisos y la liberación de una cuenta de canal los escribe el despachador (rol %).', current_user
        USING ERRCODE = 'insufficient_privilege',
              HINT = 'Desconectar deja released_at en NULL solo; lo pone sales.channels_release al soltar la cuenta.';
    END IF;
  END IF;
  -- Desconectar (lo haga quien lo haga) deja la cuenta pendiente de soltar.
  IF desconecta THEN
    NEW.released_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outreach_channel_account_release_columns
  BEFORE INSERT OR UPDATE OF status, provider_webhook_ids, released_at ON outreach_channel_account
  FOR EACH ROW EXECUTE FUNCTION outreach_channel_account_release_columns();

-- Los avisos que la web acaba de dar de alta en Unipile para una cuenta
-- que ESTE espacio tiene conectada. Mismo dueño y misma cerradura que las
-- funciones de callback_de_canales: FORCE ROW LEVEL SECURITY la ata al workspace de la
-- transacción. Solo añade: nunca quita ni reemplaza.
CREATE FUNCTION outreach_channel_set_webhooks(p_account_id uuid, p_webhook_ids text[])
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
  UPDATE outreach_channel_account a
     SET provider_webhook_ids = (
       SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}')
         FROM unnest(a.provider_webhook_ids || p_webhook_ids) x)
   WHERE a.id = p_account_id AND a.workspace_id = ws AND a.provider = 'unipile'
     AND a.status IN ('connected', 'needs_reconnect', 'error');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END;
$$;
REVOKE ALL ON FUNCTION outreach_channel_set_webhooks(uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outreach_channel_set_webhooks(uuid, text[]) TO mc_app;
COMMENT ON FUNCTION outreach_channel_set_webhooks(uuid, text[]) IS
  'Los avisos de Unipile de una cuenta conectada del workspace de la transacción (canales_liberar_y_limites): la web los da de alta al '
  'conectar y los anota aquí para que sales.channels_release los borre al desconectar. Solo añade.';


-- =====================================================================
-- 2 · Los límites de cada cuenta
-- ---------------------------------------------------------------------
-- La historia pide límites editables «dentro de la política», y solo se
-- comparaban con el techo del CHECK de 0046 (2.000 correos al día),
-- cuando la política del espacio dice 20 y una cuenta personal de Gmail
-- corta en 500 (§5.1). Un creador podía poner 2.000 y quemar su buzón.
--
-- La vista dice, por cuenta, qué se puede poner y qué manda hoy. La
-- pantalla la lee tal cual (no hace aritmética) y updateChannelAccountCaps
-- valida contra ella; el despachador de VEN-10 tomará de aquí el tope que
-- pasa a increment_if_under_cap.
--
--   provider_daily / provider_weekly   lo que aguanta el proveedor (§5.1):
--       correo @gmail.com o @googlemail.com   500 / 3.500
--       correo de Google Workspace            2.000 / 10.000
--       LinkedIn                              100 / 200
--       Instagram (y WhatsApp, fase 2)        100 / 700
--   policy_daily      solo el correo: outbound_policy.max_emails_per_day
--                     (20 sin fila, el valor de 0007)
--   max_daily         lo más que la persona puede poner al día:
--                     least(proveedor, política)
--   max_weekly        least(proveedor semanal, 7 × max_daily)
--   daily_limited_by  'policy' si manda la política, 'provider' si manda
--                     el proveedor: la pantalla dice «Máximo 20 (política)»
--   effective_daily   lo que rige hoy: el tope propio o, sin él, el
--   effective_weekly  máximo; nunca por encima del máximo (una cuenta con
--                     40 por día y una política de 20 envía 20)
--
-- security_invoker: lee con los permisos de quien consulta (0024 §8), así
-- que la web solo ve las cuentas y la política de su espacio.
-- =====================================================================
CREATE VIEW outreach_channel_account_limits WITH (security_invoker = on) AS
WITH base AS (
  SELECT a.id, a.workspace_id, a.channel, a.daily_cap, a.weekly_cap,
         (a.channel = 'email' AND split_part(a.provider_account_id, '@', 2) IN ('gmail.com', 'googlemail.com')) AS personal,
         CASE WHEN a.channel = 'email' THEN coalesce(p.max_emails_per_day, 20) END AS policy_daily
    FROM outreach_channel_account a
    LEFT JOIN outbound_policy p ON p.workspace_id = a.workspace_id
),
proveedor AS (
  SELECT b.*,
         CASE b.channel WHEN 'email' THEN CASE WHEN b.personal THEN 500 ELSE 2000 END ELSE 100 END AS provider_daily,
         CASE b.channel WHEN 'email' THEN CASE WHEN b.personal THEN 3500 ELSE 10000 END
                        WHEN 'linkedin' THEN 200 ELSE 700 END AS provider_weekly
    FROM base b
),
maximos AS (
  SELECT v.*, least(v.provider_daily, coalesce(v.policy_daily, v.provider_daily)) AS max_daily
    FROM proveedor v
),
semana AS (
  SELECT m.*, least(m.provider_weekly, m.max_daily * 7) AS max_weekly FROM maximos m
)
SELECT s.id AS channel_account_id,
       s.workspace_id,
       s.channel,
       s.personal AS personal_mailbox,
       s.provider_daily,
       s.provider_weekly,
       s.policy_daily,
       s.max_daily,
       s.max_weekly,
       CASE WHEN s.policy_daily IS NOT NULL AND s.policy_daily < s.provider_daily THEN 'policy' ELSE 'provider' END AS daily_limited_by,
       least(coalesce(s.daily_cap, s.max_daily), s.max_daily) AS effective_daily,
       least(coalesce(s.weekly_cap, s.max_weekly), s.max_weekly) AS effective_weekly
  FROM semana s;

REVOKE INSERT, UPDATE, DELETE ON outreach_channel_account_limits FROM mc_app;
COMMENT ON VIEW outreach_channel_account_limits IS
  'Los límites de cada cuenta de canal (canales_liberar_y_limites): el techo del proveedor, el de la política, lo que la persona puede '
  'poner y lo que rige hoy. La pantalla de canales y el despachador leen de aquí; nadie recalcula.';


-- =====================================================================
-- 3 · sales.channels_release
-- ---------------------------------------------------------------------
-- Cada cinco minutos suelta en el proveedor las cuentas desconectadas
-- (status 'disconnected', released_at NULL): revoca el permiso de Google
-- y borra el token del vault; borra en Unipile la cuenta y sus avisos.
-- Cada llamada queda en api_call_log. Lo que falla se reintenta en la
-- siguiente vuelta; el keepalive diario (canales_outreach) pasa por lo mismo.
-- Lo hace apps/worker/src/jobs/ventas/canales.release.ts.
-- =====================================================================
INSERT INTO job_definition (id, label_es, queue, default_cron, timeout_s, max_attempts, max_concurrency)
VALUES ('sales.channels_release', 'Soltar en el proveedor los canales desconectados', 'sales', '*/5 * * * *', 120, 1, 2)
ON CONFLICT (id) DO NOTHING;
