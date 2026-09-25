-- =====================================================================
-- 0043 · El brief de outbound con reglas, y el motivo de pérdida en la
--        base (VEN-7, VEN-8)
-- ---------------------------------------------------------------------
-- Número: 0042 es la última aplicada en Supabase (41 migraciones, con
-- el hueco declarado de 0023). rasheed/integracion ya usa 0043–0063
-- para outreach; si esta llega detrás de ellas, el integrador la
-- renumera: no depende de ninguna.
--
-- VEN-7 · outbound_brief existe desde 0007 pero nadie lo escribía: el
-- seed dejaba una fila y ninguna pantalla la leía. Desde VEN-7 el
-- creador lo edita en /ventas/brief y el radar lo aplica, y eso le pide
-- a la tabla tres cosas que no tenía:
--
--   1. UN brief activo por workspace. El radar es del workspace (signal
--      no tiene creador) y «oculta lo que tu brief no acepta» necesita
--      saber cuál es el brief. Con dos activos, qué señales se ven
--      dependería del orden en que Postgres devuelve las filas.
--   2. Límites que una pantalla no puede saltarse: presupuesto mínimo
--      no negativo, ventana de disponibilidad en orden, moneda ISO-4217,
--      entregables como lista y listas de tamaño humano.
--   3. updated_at que se mueve solo, como en deal y company: la pantalla
--      dice «Guardado el …» con esa fecha.
--
-- VEN-8 · Perder un negocio exige motivo. moveDeal ya lo exigía
-- (LostReasonRequired) pero era una regla de UNA puerta: cualquier otro
-- camino —un UPDATE de la web, un job, una función nueva— dejaba un
-- «Perdido» sin motivo, y la conversión por etapa y el informe de
-- motivos contaban un hueco. Aquí se vuelve regla de la base.
--
-- Es un disparador de restricción DIFERIDO, no un CHECK, a propósito:
-- deal_move_stage (0031) fija lost_at en su UPDATE y moveDeal escribe
-- lost_reason en la sentencia siguiente de la MISMA transacción. Un
-- CHECK fallaría entre las dos; el disparador mira la fila al COMMIT.
-- Solo salta en la TRANSICIÓN a «perdido sin motivo» (el WHEN compara
-- con OLD): un negocio perdido antes de que el motivo existiera no se
-- vuelve intocable. Hoy Supabase no tiene ninguno (medido el 25-sep:
-- 0 negocios perdidos), y el seed lleva motivo.
--
-- Nada de esto abre privilegios: la función del disparador es SECURITY
-- INVOKER y solo lee la fila que se acaba de escribir.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1 · outbound_brief: uno activo por workspace
-- ---------------------------------------------------------------------
-- Por inquilino (lleva workspace_id): no es un único global y no dice
-- nada de otro workspace.
CREATE UNIQUE INDEX IF NOT EXISTS outbound_brief_one_active
  ON outbound_brief (workspace_id)
  WHERE status = 'active';


-- ---------------------------------------------------------------------
-- 2 · outbound_brief: límites
-- ---------------------------------------------------------------------
ALTER TABLE outbound_brief
  ADD CONSTRAINT outbound_brief_min_budget_nonneg
    CHECK (min_budget IS NULL OR min_budget >= 0),
  ADD CONSTRAINT outbound_brief_window_order
    CHECK (availability_from IS NULL OR availability_to IS NULL OR availability_to >= availability_from),
  ADD CONSTRAINT outbound_brief_currency_iso
    CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT outbound_brief_deliverables_list
    CHECK (jsonb_typeof(deliverables) = 'array'),
  ADD CONSTRAINT outbound_brief_title_len
    CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  ADD CONSTRAINT outbound_brief_list_sizes
    CHECK (cardinality(wanted_categories) <= 30
           AND cardinality(excluded_categories) <= 30
           AND cardinality(wanted_countries) <= 30
           AND cardinality(excluded_companies) <= 100);


-- ---------------------------------------------------------------------
-- 3 · outbound_brief: updated_at
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS outbound_brief_updated ON outbound_brief;
CREATE TRIGGER outbound_brief_updated BEFORE UPDATE ON outbound_brief
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ---------------------------------------------------------------------
-- 4 · deal: un negocio perdido lleva motivo
-- ---------------------------------------------------------------------
-- Se relee la fila al disparar (al COMMIT): NEW es la foto del momento
-- del UPDATE de deal_move_stage, antes de que moveDeal escribiera el
-- motivo. Si la fila ya no existe (se borró en la misma transacción) no
-- hay nada que exigir.
CREATE OR REPLACE FUNCTION deal_lost_reason_required()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM deal d
              WHERE d.id = NEW.id
                AND d.lost_at IS NOT NULL
                AND d.lost_reason IS NULL) THEN
    RAISE EXCEPTION 'deal_lost_reason_required: un negocio perdido lleva motivo (deal %)', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS deal_lost_reason_on_insert ON deal;
CREATE CONSTRAINT TRIGGER deal_lost_reason_on_insert
  AFTER INSERT ON deal
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.lost_at IS NOT NULL AND NEW.lost_reason IS NULL)
  EXECUTE FUNCTION deal_lost_reason_required();

DROP TRIGGER IF EXISTS deal_lost_reason_on_update ON deal;
CREATE CONSTRAINT TRIGGER deal_lost_reason_on_update
  AFTER UPDATE OF lost_at, lost_reason ON deal
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.lost_at IS NOT NULL AND NEW.lost_reason IS NULL
        AND (OLD.lost_at IS NULL OR OLD.lost_reason IS NOT NULL))
  EXECUTE FUNCTION deal_lost_reason_required();
