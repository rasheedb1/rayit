-- =====================================================================
-- 0073 · El brief de outbound con reglas, y el motivo de pérdida en la
--        base (VEN-7, VEN-8)
-- ---------------------------------------------------------------------
-- Número: 0073. La serie de integración va de 0043 a 0075, detrás de
-- la 0042 de main (0034–0042, ya aplicadas en Supabase); ninguna de la
-- serie está aplicada aún. Hasta el pulido r2 de ventas esta fue la
-- 0070. Toca outbound_brief (0007) y deal (0007, 0031), y depende de
-- 0055: la política de §5 usa outreach_can_manage (0055 §7).
--
-- Mediciones en Supabase antes de aplicarla (25-sep, como mc_migrator):
--   · Un brief activo por creador (§1). La tabla tiene FORCE RLS, así
--     que un SELECT sin workspace fijado ve 0 filas; se midió por
--     estadística: pg_stat_user_tables.n_live_tup = 1 en outbound_brief.
--     Con una sola fila en toda la tabla no puede haber dos activas de
--     un creador, y el CREATE UNIQUE INDEX no puede fallar. Aun así, el
--     integrador repite con postgres (sin RLS) justo antes de aplicar:
--       select workspace_id, creator_id, count(*) from outbound_brief
--        where status = 'active' group by 1, 2 having count(*) > 1;
--     → 0 filas esperadas. Si devolviera alguna, se pausa la más vieja
--     (status = 'paused') antes de correr esta migración.
--   · Límites (§2): el único brief es el del seed de Laura, que los
--     cumple (lo comprueba brief.test.ts contra el seed).
--   · Negocios perdidos sin motivo (§4): el disparador solo mira la
--     TRANSICIÓN, así que una fila vieja sin motivo no rompe la
--     migración; el seed lleva motivo en todos sus perdidos.
--
-- VEN-7 · outbound_brief existe desde 0007 pero nadie lo escribía: el
-- seed dejaba una fila y ninguna pantalla la leía. Desde VEN-7 el
-- creador lo edita en /ventas/brief y el radar lo aplica, y eso le pide
-- a la tabla tres cosas que no tenía:
--
--   1. UN brief activo por CREADOR. El recomendador y el generador de
--      rasheed/integracion (VEN-13 r4) ya leen el brief activo del
--      creador del negocio, y un espacio con dos creadores (una agencia)
--      tiene uno por cada uno. Con dos activos del MISMO creador, cuál
--      manda dependería del orden en que Postgres devuelve las filas.
--      El radar, que es del espacio (signal no tiene creador), oculta lo
--      que excluyen TODOS los activos (queries/brief.ts).
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
-- vuelve intocable, y por eso la migración no depende de cuántos haya.
--
-- VEN-7 · Quién cambia el brief. El brief es de UN creador (§1), pero
-- lo que excluye pesa en todo el espacio: el radar del equipo lo oculta
-- cuando lo excluyen todos los briefs activos, y las cadencias de los
-- negocios de ese creador no le escriben. Hasta aquí cualquier miembro
-- con mc_app lo reescribía. Lo
-- cambian los mismos que la política de envío: owner o admin, con la
-- misma función outreach_can_manage (0055 §7) y el mismo tipo de
-- política (RESTRICTIVE, TO mc_app). Leer sigue igual: lo lee todo el
-- espacio.
--
-- Nada de esto abre privilegios: la función del disparador es SECURITY
-- INVOKER y solo lee la fila que se acaba de escribir.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1 · outbound_brief: uno activo por creador
-- ---------------------------------------------------------------------
-- Por inquilino (lleva workspace_id): no es un único global y no dice
-- nada de otro workspace.
CREATE UNIQUE INDEX IF NOT EXISTS outbound_brief_one_active
  ON outbound_brief (workspace_id, creator_id)
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
SET search_path = public, extensions, pg_temp
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


-- ---------------------------------------------------------------------
-- 5 · outbound_brief: lo escriben owner y admin
-- ---------------------------------------------------------------------
-- RESTRICTIVE: se suman (AND) a la de aislamiento por workspace de 0010,
-- no la sustituyen. El worker (BYPASSRLS) y quien migra o siembra (las
-- políticas son TO mc_app) no cambian. Sin identidad, outreach_can_manage
-- solo deja pasar con app.auth_disabled = 'on' (desarrollo y pruebas).
DROP POLICY IF EXISTS outbound_brief_manage_insert ON outbound_brief;
CREATE POLICY outbound_brief_manage_insert ON outbound_brief AS RESTRICTIVE
  FOR INSERT TO mc_app
  WITH CHECK (outreach_can_manage(workspace_id));

DROP POLICY IF EXISTS outbound_brief_manage_update ON outbound_brief;
CREATE POLICY outbound_brief_manage_update ON outbound_brief AS RESTRICTIVE
  FOR UPDATE TO mc_app
  USING (true)
  WITH CHECK (outreach_can_manage(workspace_id));

DROP POLICY IF EXISTS outbound_brief_manage_delete ON outbound_brief;
CREATE POLICY outbound_brief_manage_delete ON outbound_brief AS RESTRICTIVE
  FOR DELETE TO mc_app
  USING (outreach_can_manage(workspace_id));
