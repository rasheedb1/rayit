-- =====================================================================
-- 0075 · Reservar el presupuesto del modelo antes de llamarlo
--        (VEN-12, pulido r1)
-- ---------------------------------------------------------------------
-- Número: 0075. La serie de integración va de 0043 a 0075, detrás de
-- la 0042 de main (0034–0042, ya aplicadas en Supabase); ninguna de la
-- serie está aplicada aún. Hasta el pulido r2 de ventas esta fue la
-- 0072. No depende de nada posterior a 0046 y 0061. Solo agrega una
-- tabla; no toca datos ni funciones existentes.
--
-- Por qué. outbound.generate y outbound.review miran el tope diario
-- (outbound_policy.llm_daily_cap_usd, sumado por outbound_health sobre
-- outbound_llm_call) antes de cada llamada al modelo, pero sin apartar lo
-- que van a gastar. Si los dos corren a la vez en el mismo espacio, ambos
-- pasan la comprobación con el mismo saldo y el tope se supera hasta en
-- una llamada por job.
--
-- Cómo. Antes de llamar, el worker toma un candado de transacción por
-- espacio (pg_advisory_xact_lock), calcula lo que queda (tope − gastado
-- hoy − reservas abiertas) y, si alcanza, anota aquí la estimación de la
-- llamada. Al registrar la llamada de verdad en outbound_llm_call (en la
-- misma transacción) borra su reserva. Una reserva que nadie borró (un
-- worker que murió a media llamada) deja de contar a los diez minutos:
-- el candado dura una transacción corta, nunca lo que tarda el modelo.
--
-- outbound_llm_call sigue siendo la bitácora: solo se inserta y lleva el
-- costo real de cada llamada. Las reservas son otra cosa (una promesa de
-- gasto que se cumple o vence), por eso van aparte y sí se borran.
--
-- Aislamiento: la escribe el worker (mc_worker, BYPASSRLS). mc_app puede
-- leer las de su espacio y no tiene INSERT ni DELETE (como
-- outbound_generation, 0061).
--
-- Pulido r3 (VEN-11), en su sitio: «Recalcular» del perfil comercial
-- llama al modelo desde la web y solo miraba gastado >= tope, sin apartar
-- nada ni restar las reservas del worker. Ahora aparta igual que el
-- worker: con el mismo candado por espacio, la web calcula lo que queda
-- (tope − gastado hoy − reservas abiertas) y, si alcanza, anota su
-- reserva con outbound_llm_reserve_profile; al registrar la llamada la
-- borra con outbound_llm_release_profile. Las dos son SECURITY DEFINER,
-- solo del workspace de la transacción y solo con purpose 'profile': lo
-- peor que puede hacer un workspace con ellas es apartarse o soltarse su
-- propio presupuesto, nunca el de otro ni las reservas del worker.
-- =====================================================================

CREATE TABLE IF NOT EXISTS outbound_llm_reservation (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  purpose             text NOT NULL CHECK (purpose IN ('generate', 'judge', 'profile')),
  amount              numeric(14,6) NOT NULL CHECK (amount >= 0),
  cost_currency       char(3) NOT NULL DEFAULT 'USD',
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbound_llm_reservation_ws_idx ON outbound_llm_reservation (workspace_id, created_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'outbound_llm_reservation' AND column_name = 'workspace_id'
  ) THEN
    RAISE EXCEPTION 'outbound_llm_reservation está en la lista de RLS pero no tiene workspace_id';
  END IF;
END $$;
ALTER TABLE outbound_llm_reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_llm_reservation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outbound_llm_reservation_ws_read ON outbound_llm_reservation;
CREATE POLICY outbound_llm_reservation_ws_read ON outbound_llm_reservation FOR SELECT
  USING (workspace_id = current_workspace_id());
REVOKE INSERT, UPDATE, DELETE ON outbound_llm_reservation FROM mc_app;

COMMENT ON TABLE outbound_llm_reservation IS
  'Lo apartado del tope diario del modelo mientras una llamada está en curso (VEN-12). La escribe y la borra el '
  'worker, y la web solo para «Recalcular» del perfil (purpose profile, con outbound_llm_reserve_profile y '
  'outbound_llm_release_profile); una reserva de más de diez minutos ya no cuenta.';

-- ---------------------------------------------------------------------
-- La reserva de «Recalcular» del perfil comercial (pulido r3, VEN-11)
-- ---------------------------------------------------------------------
-- La tabla lleva FORCE ROW LEVEL SECURITY: las dos funciones corren como
-- su dueño y necesitan sus políticas, TO CURRENT_USER (mc_migrator, o
-- mc_migrator_embedded en PGlite) y solo para filas 'profile' del
-- workspace de la transacción, como outbound_workspace_optout_record
-- (0055 §8.4). A mc_app no le alcanza: sigue sin INSERT ni DELETE.
--
-- La cuenta (tope − gastado − reservas) y el candado los pone quien llama
-- (reserveProfileLlmBudget de @mc/db, con el mismo candado por espacio
-- que el worker): la función solo anota o suelta.
DROP POLICY IF EXISTS outbound_llm_reservation_owner_profile_insert ON outbound_llm_reservation;
CREATE POLICY outbound_llm_reservation_owner_profile_insert ON outbound_llm_reservation
  FOR INSERT TO CURRENT_USER
  WITH CHECK (purpose = 'profile' AND workspace_id = current_workspace_id());
DROP POLICY IF EXISTS outbound_llm_reservation_owner_profile_delete ON outbound_llm_reservation;
CREATE POLICY outbound_llm_reservation_owner_profile_delete ON outbound_llm_reservation
  FOR DELETE TO CURRENT_USER
  USING (purpose = 'profile' AND workspace_id = current_workspace_id());

CREATE OR REPLACE FUNCTION outbound_llm_reserve_profile(p_amount numeric)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ws uuid := current_workspace_id();
  id uuid;
BEGIN
  IF ws IS NULL THEN
    RAISE EXCEPTION 'outbound_llm_reserve_profile necesita un workspace fijado en la transacción.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_amount IS NULL OR p_amount < 0 OR p_amount > 1000 THEN
    RAISE EXCEPTION 'Una reserva del perfil va de 0 a 1000 USD (llegó %).', p_amount
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO outbound_llm_reservation (workspace_id, purpose, amount)
  VALUES (ws, 'profile', round(p_amount, 6))
  RETURNING outbound_llm_reservation.id INTO id;
  RETURN id;
END;
$$;
REVOKE ALL ON FUNCTION outbound_llm_reserve_profile(numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbound_llm_reserve_profile(numeric) TO mc_app;
COMMENT ON FUNCTION outbound_llm_reserve_profile(numeric) IS
  'Aparta la estimación de una llamada de «Recalcular» del perfil comercial (VEN-11) en outbound_llm_reservation, '
  'con purpose profile y el workspace de la transacción. La cuenta y el candado los pone quien llama.';

CREATE OR REPLACE FUNCTION outbound_llm_release_profile(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM outbound_llm_reservation r
   WHERE r.id = p_id AND r.purpose = 'profile' AND r.workspace_id = current_workspace_id();
END;
$$;
REVOKE ALL ON FUNCTION outbound_llm_release_profile(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbound_llm_release_profile(uuid) TO mc_app;
COMMENT ON FUNCTION outbound_llm_release_profile(uuid) IS
  'Suelta una reserva de «Recalcular» del perfil comercial (VEN-11): la llamada se registró, o no se hizo. Solo '
  'purpose profile del workspace de la transacción.';
