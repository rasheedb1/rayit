-- =====================================================================
-- 0052 · El ritmo del motor de cadencias (VEN-10 r5)
-- ---------------------------------------------------------------------
-- Número: va detrás de 0051_motor_cadencias y no depende de nada más.
-- Al integrar con main se renumera junto con la serie de outreach (ver
-- docs/ventas-outreach.md §5.2, «Renumeración al integrar»): siempre
-- inmediatamente después de la que hoy es 0051.
--
-- Lo que trae:
--
--   1. El ritmo por hora de cada cuenta (outreach_channel_account_limits:
--      effective_hourly y min_gap_seconds). Hasta 0051 el reclamo solo
--      contaba el día y la semana: una corrida podía mandar decenas de
--      mensajes de la MISMA cuenta en segundos (lo acumulado de la noche,
--      al abrir la ventana), y docs/ventas-outreach.md §5.1 pide a
--      Instagram «10 por hora» y a LinkedIn espaciar al azar.
--   2. outbound_touch.unconfirmed_caps_on: el día en que el intento
--      AMBIGUO reservó su plaza. Si el proveedor dice después que ese
--      intento no salió, la plaza vuelve a ese día (sin esto, cada
--      ambigüedad que no salió gastaba dos plazas del tope). Y una
--      persona que aprueba en la ficha un mensaje retenido por un intento
--      sin comprobar puede borrar la marca de ese intento (antes solo el
--      despachador: el retenido volvía a retenerse para siempre).
--   3. increment_if_under_cap e increment_weekly con el instante que
--      cuenta (p_at): los topes cuentan el día del reloj del despachador,
--      no el de la base. Las de 0037 quedan igual.
--
-- Idempotente (CREATE OR REPLACE, IF NOT EXISTS), como las anteriores.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · El ritmo por hora de cada cuenta
-- ---------------------------------------------------------------------
-- Dos columnas nuevas al final de la vista de 0040 (lo demás, igual):
--
--   effective_hourly   cuántos mensajes puede sacar la cuenta en una hora
--                      (la última hora corrida, no la hora del reloj):
--                        correo      un cuarto de su tope diario, redondeado
--                                    hacia arriba: 20 al día → 5 por hora.
--                                    El tope del día no sale de golpe a las
--                                    09:00 aunque se haya acumulado
--                        LinkedIn    15 (y nunca más que su tope diario)
--                        Instagram   10, lo que dice §5.1 (WhatsApp, igual)
--   min_gap_seconds    la separación mínima entre dos envíos de la cuenta:
--                        correo      0: Gmail cuenta por día, y el tope por
--                                    hora ya reparte
--                        LinkedIn    90 s, más un azar determinista de
--                                    hasta otro tanto (lo pone el reclamo)
--                        Instagram   120 s, más su azar
--
-- Los fija la plataforma, no la persona: son el cuidado de la cuenta del
-- creador frente al proveedor. El reclamo del despachador (claimDueTouches)
-- los aplica después de los topes del día y de la semana (lo que ya no cabe
-- hoy va directo al siguiente día hábil): lo que cabe hoy pero viola el
-- ritmo se mueve al primer momento en que cabe, sin gastar intento, y la
-- plaza que se acababa de reservar se deshace.
CREATE OR REPLACE VIEW outreach_channel_account_limits WITH (security_invoker = on) AS
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
),
rige AS (
  SELECT s.*,
         least(coalesce(s.daily_cap, s.max_daily), s.max_daily) AS effective_daily,
         least(coalesce(s.weekly_cap, s.max_weekly), s.max_weekly) AS effective_weekly
    FROM semana s
)
SELECT r.id AS channel_account_id,
       r.workspace_id,
       r.channel,
       r.personal AS personal_mailbox,
       r.provider_daily,
       r.provider_weekly,
       r.policy_daily,
       r.max_daily,
       r.max_weekly,
       CASE WHEN r.policy_daily IS NOT NULL AND r.policy_daily < r.provider_daily THEN 'policy' ELSE 'provider' END AS daily_limited_by,
       r.effective_daily,
       r.effective_weekly,
       greatest(1, CASE r.channel
                     WHEN 'email'    THEN ceil(r.effective_daily / 4.0)::int
                     WHEN 'linkedin' THEN least(15, r.effective_daily)
                     ELSE least(10, r.effective_daily)
                   END) AS effective_hourly,
       CASE r.channel WHEN 'email' THEN 0 WHEN 'linkedin' THEN 90 ELSE 120 END AS min_gap_seconds
  FROM rige r;

REVOKE INSERT, UPDATE, DELETE ON outreach_channel_account_limits FROM mc_app;
COMMENT ON VIEW outreach_channel_account_limits IS
  'Los límites de cada cuenta de canal (0040, 0052): el techo del proveedor, el de la política, lo que la persona puede '
  'poner, lo que rige hoy y el ritmo por hora (effective_hourly, min_gap_seconds). La pantalla de canales y el '
  'despachador leen de aquí; nadie recalcula.';

-- ---------------------------------------------------------------------
-- 2 · El día de la plaza de un intento ambiguo
-- ---------------------------------------------------------------------
-- Un intento cuyo resultado no se supo (unconfirmed_attempt, 0051 §6)
-- conserva su plaza: pudo haber salido. El siguiente reclamo reserva
-- otra. Si el proveedor responde después que el intento NO salió, la
-- plaza del intento ambiguo vuelve al día en que se reservó, que es este.
-- Es del despachador, como las demás pruebas de envío (0051 §6).
ALTER TABLE outbound_touch
  ADD COLUMN IF NOT EXISTS unconfirmed_caps_on date;

CREATE OR REPLACE FUNCTION outbound_touch_dispatch_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF outreach_is_dispatcher() THEN
    RETURN NEW;
  END IF;
  -- Una persona aprueba (o descarta) un mensaje retenido porque no se supo
  -- si un intento anterior salió (releaseHeldTouch): dice que no salió, y
  -- la marca del intento se borra. Solo borrarla, solo desde 'held', y sin
  -- tocar las demás columnas del despachador.
  IF TG_OP = 'UPDATE' AND OLD.status = 'held' AND NEW.status IN ('scheduled', 'canceled')
     AND NEW.unconfirmed_attempt IS NULL AND NEW.unconfirmed_caps_on IS NULL
     AND NEW.send_started_at IS NOT DISTINCT FROM OLD.send_started_at
     AND NEW.replies_checked_at IS NOT DISTINCT FROM OLD.replies_checked_at
     AND NEW.caps_reserved_on IS NOT DISTINCT FROM OLD.caps_reserved_on THEN
    RETURN NEW;
  END IF;
  IF (TG_OP = 'INSERT' AND (NEW.send_started_at IS NOT NULL OR NEW.unconfirmed_attempt IS NOT NULL
                             OR NEW.replies_checked_at IS NOT NULL OR NEW.caps_reserved_on IS NOT NULL
                             OR NEW.unconfirmed_caps_on IS NOT NULL))
     OR (TG_OP = 'UPDATE' AND (NEW.send_started_at IS DISTINCT FROM OLD.send_started_at
                               OR NEW.unconfirmed_attempt IS DISTINCT FROM OLD.unconfirmed_attempt
                               OR NEW.replies_checked_at IS DISTINCT FROM OLD.replies_checked_at
                               OR NEW.caps_reserved_on IS DISTINCT FROM OLD.caps_reserved_on
                               OR NEW.unconfirmed_caps_on IS DISTINCT FROM OLD.unconfirmed_caps_on)) THEN
    RAISE EXCEPTION 'send_started_at, unconfirmed_attempt, unconfirmed_caps_on, replies_checked_at y caps_reserved_on los escribe solo el despachador (rol %).', current_user
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Dicen qué llegó al proveedor: la aplicación no los escribe.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS outbound_touch_dispatch_columns ON outbound_touch;
CREATE TRIGGER outbound_touch_dispatch_columns
  BEFORE INSERT OR UPDATE OF send_started_at, unconfirmed_attempt, unconfirmed_caps_on, replies_checked_at, caps_reserved_on
  ON outbound_touch
  FOR EACH ROW EXECUTE FUNCTION outbound_touch_dispatch_columns();

-- ---------------------------------------------------------------------
-- 3 · Los topes cuentan el día del reloj de quien reclama
-- ---------------------------------------------------------------------
-- increment_if_under_cap e increment_weekly (0037 §8.3) cuentan el día
-- local del workspace con now() de la base. El despachador reclama con
-- SU reloj (ClaimOptions.now): en producción es el mismo instante, pero
-- en las pruebas, con un reloj falso, el contador no cambiaba de día
-- aunque el reloj sí, y había que borrar outbound_counter a mano. Estas
-- variantes reciben el instante (p_at) y cuentan el día local de ESE
-- instante; las de 0037 quedan igual (delegan con now()). El reclamo
-- anota caps_reserved_on con el mismo instante, así que la plaza vuelve
-- exactamente a la fila que se sumó.
CREATE OR REPLACE FUNCTION outbound_counter_bump_at(p_workspace uuid, p_account uuid, p_period text,
                                                    p_action_type text, p_cap int, p_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  hoy date;
  inicio date;
  nuevo int;
BEGIN
  IF p_cap IS NULL OR p_cap <= 0 THEN
    RETURN false;
  END IF;
  IF p_account IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM outreach_channel_account a WHERE a.id = p_account AND a.workspace_id = p_workspace) THEN
    RAISE EXCEPTION 'La cuenta % no es del workspace %.', p_account, p_workspace
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  hoy := outreach_local_date(p_workspace, coalesce(p_at, now()));
  inicio := CASE p_period WHEN 'week' THEN hoy - (extract(isodow FROM hoy)::int - 1) ELSE hoy END;

  INSERT INTO outbound_counter AS c (workspace_id, channel_account_id, period, period_start, action_type, count)
  VALUES (p_workspace, p_account, p_period, inicio, p_action_type, 1)
  ON CONFLICT (workspace_id, channel_account_id, period, period_start, action_type)
  DO UPDATE SET count = c.count + 1, updated_at = now()
     WHERE c.count < p_cap
  RETURNING c.count INTO nuevo;
  RETURN nuevo IS NOT NULL;
END;
$$;

-- La de 0037, ahora un caso de la de arriba: una sola definición de la sentencia.
CREATE OR REPLACE FUNCTION outbound_counter_bump(p_workspace uuid, p_account uuid, p_period text,
                                                 p_action_type text, p_cap int)
RETURNS boolean
LANGUAGE sql
VOLATILE
SET search_path = public, pg_temp
AS $$
  SELECT outbound_counter_bump_at(p_workspace, p_account, p_period, p_action_type, p_cap, now());
$$;

CREATE OR REPLACE FUNCTION increment_if_under_cap(p_workspace uuid, p_account uuid, p_action_type text, p_cap int, p_at timestamptz)
RETURNS boolean LANGUAGE sql VOLATILE SET search_path = public, pg_temp
AS $$ SELECT outbound_counter_bump_at(p_workspace, p_account, 'day', p_action_type, p_cap, p_at); $$;

CREATE OR REPLACE FUNCTION increment_if_under_cap(p_workspace uuid, p_action_type text, p_cap int, p_at timestamptz)
RETURNS boolean LANGUAGE sql VOLATILE SET search_path = public, pg_temp
AS $$ SELECT outbound_counter_bump_at(p_workspace, NULL, 'day', p_action_type, p_cap, p_at); $$;

CREATE OR REPLACE FUNCTION increment_weekly(p_workspace uuid, p_account uuid, p_action_type text, p_cap int, p_at timestamptz)
RETURNS boolean LANGUAGE sql VOLATILE SET search_path = public, pg_temp
AS $$ SELECT outbound_counter_bump_at(p_workspace, p_account, 'week', p_action_type, p_cap, p_at); $$;

CREATE OR REPLACE FUNCTION increment_weekly(p_workspace uuid, p_action_type text, p_cap int, p_at timestamptz)
RETURNS boolean LANGUAGE sql VOLATILE SET search_path = public, pg_temp
AS $$ SELECT outbound_counter_bump_at(p_workspace, NULL, 'week', p_action_type, p_cap, p_at); $$;
