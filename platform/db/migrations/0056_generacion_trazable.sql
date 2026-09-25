-- =====================================================================
-- 0056 · Generación con afirmaciones trazables (VEN-12)
-- ---------------------------------------------------------------------
-- Número: va detrás de 0055_motor_equipo_y_reclamo. No choca con la
-- serie de main (llega hasta 0042), así que no entra en
-- scripts/renumerar-outreach.sh.
--
-- Lo que ya estaba en 0037 y aquí se usa tal cual: outbound_angle (el
-- ángulo de cada toque), outbound_step_rubric (umbral, mínimo, banda
-- muerta e intentos por tipo de paso y día), outbound_review (una fila
-- por intento, con nota, tokens y costo), outbound_llm_call (cada
-- llamada al modelo) y outbound_policy.llm_daily_cap_usd.
--
-- Lo nuevo:
--
-- 1 · outbound_generation: el borrador generado de un toque, CON sus
--     marcas [claim:id], y el turno (lease) de quien lo está trabajando.
--     outbound_touch guarda el texto que sale (sin marcas) y los claims
--     citados; aquí queda de dónde salió cada cifra, que es lo que
--     enseña el editor del pitch (VEN-6) al abrir un borrador generado.
--     Y separa los dos jobs sin tocar la cola:
--       · outbound.generate reclama los borradores con generate_with_ai
--         que todavía no tienen fila (stage 'generating'), llama al
--         generador y deja la fila en 'generated';
--       · outbound.review reclama las 'generated' (stage 'reviewing'),
--         corre el pre-vuelo, el juez y las regeneraciones, escribe
--         outbound_review y deja el toque en scheduled o held
--         (stage 'reviewed').
--     El turno es lease_token + lease_until: un worker que se cae a
--     mitad deja la fila vencida y la siguiente corrida la retoma. El
--     resultado se escribe solo si el toque sigue en 'draft' y el turno
--     sigue siendo el mismo (compuerta C de VEN-12).
--     La escribe solo el worker; la web la lee (el editor), aislada por
--     workspace, con el patrón de 0037 §7.1b (política solo de lectura).
--
-- 2 · Los dos jobs en job_definition.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · outbound_generation
-- ---------------------------------------------------------------------
CREATE TABLE outbound_generation (
  touch_id            uuid PRIMARY KEY REFERENCES outbound_touch(id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  stage               text NOT NULL DEFAULT 'generating'
                           CHECK (stage IN ('generating','generated','reviewing','reviewed')),
  -- El borrador del generador, con sus marcas [claim:id]. Vacío mientras se genera.
  subject             text CHECK (length(subject) <= 300),
  body_marked         text CHECK (length(body_marked) BETWEEN 1 AND 20000),
  model               text CHECK (length(model) BETWEEN 1 AND 100),
  -- Intentos del generador en total (el primero y las regeneraciones del juez).
  attempts            int NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  -- Lo que decidió la puerta: approved (la puerta lo deja salir; la
  -- política decide si aún pasa por una persona) o held.
  outcome             text CHECK (outcome IN ('approved','held')),
  lease_token         uuid,
  lease_until         timestamptz,
  last_error          text CHECK (length(last_error) <= 300),
  generated_at        timestamptz,
  reviewed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (stage = 'generating' OR body_marked IS NOT NULL),
  CHECK ((stage = 'reviewed') = (outcome IS NOT NULL)),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);
CREATE INDEX outbound_generation_stage_idx ON outbound_generation (stage, lease_until) WHERE stage <> 'reviewed';
CREATE INDEX ON outbound_generation (workspace_id);
CREATE TRIGGER outbound_generation_updated BEFORE UPDATE ON outbound_generation
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- La fila es del workspace de su toque (nada de un borrador de A colgado de un toque de B).
CREATE FUNCTION outbound_generation_touch_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  ws uuid;
BEGIN
  SELECT workspace_id INTO ws FROM outbound_touch WHERE id = NEW.touch_id;
  IF ws IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'outbound_generation: el toque % no es del workspace %', NEW.touch_id, NEW.workspace_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER outbound_generation_touch_check
  BEFORE INSERT OR UPDATE OF touch_id, workspace_id ON outbound_generation
  FOR EACH ROW EXECUTE FUNCTION outbound_generation_touch_check();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'outbound_generation' AND column_name = 'workspace_id'
  ) THEN
    RAISE EXCEPTION 'outbound_generation está en la lista de RLS pero no tiene workspace_id';
  END IF;
END $$;
ALTER TABLE outbound_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_generation FORCE ROW LEVEL SECURITY;
CREATE POLICY outbound_generation_ws_read ON outbound_generation FOR SELECT
  USING (workspace_id = current_workspace_id());
REVOKE INSERT, UPDATE, DELETE ON outbound_generation FROM mc_app;

COMMENT ON TABLE outbound_generation IS
  'El borrador generado de un toque con sus marcas [claim:id] y el turno de los jobs outbound.generate y '
  'outbound.review (VEN-12). La escribe solo el worker; la web la lee para el editor del pitch.';

-- ---------------------------------------------------------------------
-- 2 · Los jobs
-- ---------------------------------------------------------------------
-- Cada dos minutos, como el despachador: un borrador generado no espera
-- más que un correo programado. timeout_s cubre un lote (cada llamada al
-- modelo tiene su propio tiempo límite de 60 s en el cliente).
INSERT INTO job_definition (id, label_es, queue, default_cron, timeout_s, max_attempts, max_concurrency) VALUES
  ('outbound.generate', 'Redactar los mensajes de las cadencias',  'sales', '*/2 * * * *', 280, 1, 1),
  ('outbound.review',   'Revisar la calidad de los mensajes',      'sales', '1-59/2 * * * *', 280, 1, 1)
ON CONFLICT (id) DO NOTHING;
