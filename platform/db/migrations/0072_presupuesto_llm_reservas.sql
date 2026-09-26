-- =====================================================================
-- 0072 · Reservar el presupuesto del modelo antes de llamarlo
--        (VEN-12, pulido r1)
-- ---------------------------------------------------------------------
-- Número: la siguiente libre detrás de 0071_brief_indice_de_marca. Si
-- otra área del pulido eligió el mismo, el integrador renumera: esta
-- migración no depende de nada posterior a 0037 y 0056. Solo agrega una
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
-- Aislamiento: la escribe solo el worker (mc_worker, BYPASSRLS). mc_app
-- puede leer las de su espacio y nada más (como outbound_generation, 0056).
-- =====================================================================

CREATE TABLE IF NOT EXISTS outbound_llm_reservation (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  purpose             text NOT NULL CHECK (purpose IN ('generate', 'judge')),
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
  'worker; una reserva de más de diez minutos ya no cuenta.';
