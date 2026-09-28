-- =====================================================================
-- 0076 · Ganar o perder un negocio detiene su cadencia (VEN-10, pulido r5)
-- ---------------------------------------------------------------------
-- Número: 0076, la siguiente libre de la serie de integración (0043–0075,
-- detrás de la 0042 de main). No está aplicada en ningún sitio.
--
-- El hallazgo. Sofía Cárdenas (Vitalé) aceptó COT-2026-007 desde el
-- enlace público: el negocio pasó a «Ganado», la marca a cliente y se
-- creó la campaña, pero /ventas/aprobaciones seguía ofreciendo aprobar
-- el paso 4 de la prospección y la ficha enseñaba el paso 5 de LinkedIn
-- «Programado». Ni acceptQuote ni deal_move_stage (0031, 0033, 0073)
-- tocaban outbound_enrollment, y ni el reclamo ni la relectura antes de
-- enviar miraban la etapa del negocio: una marca que acaba de firmar, o
-- un negocio perdido con su motivo, seguía recibiendo el pitch en frío.
--
-- La regla, en la base, para todos los caminos (mover la etapa desde la
-- web, la aceptación desde el enlace público, un script):
--
--   · GANAR un negocio (won_at se fija, o la etapa pasa a una is_won)
--     cierra como 'completed' los enrolamientos vivos (active, paused,
--     cooldown) de ese negocio y los de CUALQUIER persona de esa marca en
--     ese workspace, y cancela sus toques en borrador, retenidos y
--     programados con blocked_reason 'deal_won'. Una marca que firmó no
--     recibe más prospección, venga de la cadencia que venga.
--   · PERDER un negocio (lost_at, o una etapa is_lost) hace lo mismo con
--     los enrolamientos de ESE negocio, con blocked_reason 'deal_lost'.
--     Otra cadencia a la misma marca por otro negocio sigue su curso.
--
-- «De ese negocio» es el deal_id del enrolamiento o el de cualquiera de
-- sus toques. Lo que está en 'processing' (reclamado, a medio enviar) no
-- se toca aquí: lo cancela la relectura antes de enviar (send.ts,
-- decideBeforeSend), que mira lo mismo (DEAL_CLOSED_SQL de @mc/db), igual
-- que el reclamo para lo que vuelva a la cola después.
--
-- Por qué SECURITY DEFINER. La aceptación pública corre como
-- mc_public_share (0030), que no tiene privilegios en outbound_*. Y
-- esas tablas llevan FORCE ROW LEVEL SECURITY: el dueño de la función
-- solo ve el workspace de la transacción (current_workspace_id()), que
-- en la aceptación pública no está fijado. La función lo fija al del
-- negocio mientras dura y lo devuelve como estaba al salir. Solo escribe
-- en ESE workspace, solo cancela y cierra (nunca programa ni reabre), y
-- la dispara solo un cambio de etapa que la RLS de deal ya autorizó.
-- Declarado en DISPARADORES_DEFINER_DECLARADOS y en
-- FUNCIONES_DEFINER_DECLARADAS (packages/db/src/esquema.ts).
--
-- Lo que ya estaba ganado o perdido antes de aplicar esta migración no
-- se barre aquí: con FORCE ROW LEVEL SECURITY quien migra no ve ningún
-- workspace. Lo cubren el reclamo (se cancela al vencer) y la bandeja de
-- aprobación, que ya no lo enseña (listApprovalQueue).
--
-- Re-ejecutable: CREATE OR REPLACE y DROP TRIGGER IF EXISTS.
-- =====================================================================

CREATE OR REPLACE FUNCTION deal_closed_stops_outreach()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  antes   text := current_setting('app.workspace_id', true);
  gana    boolean;
  pierde  boolean;
  motivo  text;
  vivos   uuid[];
BEGIN
  PERFORM set_config('app.workspace_id', NEW.workspace_id::text, true);

  gana := (NEW.won_at IS NOT NULL AND OLD.won_at IS NULL)
          OR (coalesce((SELECT ps.is_won FROM pipeline_stage ps WHERE ps.id = NEW.stage_id), false)
              AND NOT coalesce((SELECT ps.is_won FROM pipeline_stage ps WHERE ps.id = OLD.stage_id), false));
  pierde := (NEW.lost_at IS NOT NULL AND OLD.lost_at IS NULL)
            OR (coalesce((SELECT ps.is_lost FROM pipeline_stage ps WHERE ps.id = NEW.stage_id), false)
                AND NOT coalesce((SELECT ps.is_lost FROM pipeline_stage ps WHERE ps.id = OLD.stage_id), false));

  IF gana OR pierde THEN
    motivo := CASE WHEN gana THEN 'deal_won' ELSE 'deal_lost' END;

    SELECT array_agg(e.id) INTO vivos
      FROM outbound_enrollment e
     WHERE e.workspace_id = NEW.workspace_id
       AND e.status IN ('active', 'paused', 'cooldown')
       AND (e.deal_id = NEW.id
            OR EXISTS (SELECT 1 FROM outbound_touch t WHERE t.enrollment_id = e.id AND t.deal_id = NEW.id)
            OR (gana AND EXISTS (SELECT 1 FROM contact c WHERE c.id = e.contact_id AND c.company_id = NEW.company_id)));

    IF vivos IS NOT NULL THEN
      UPDATE outbound_touch
         SET status = 'canceled', blocked_reason = motivo
       WHERE workspace_id = NEW.workspace_id
         AND enrollment_id = ANY (vivos)
         AND status IN ('draft', 'held', 'scheduled');

      UPDATE outbound_enrollment
         SET status = 'completed', resume_at = NULL, finished_at = coalesce(finished_at, now())
       WHERE workspace_id = NEW.workspace_id
         AND id = ANY (vivos);
    END IF;
  END IF;

  PERFORM set_config('app.workspace_id', coalesce(antes, ''), true);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION deal_closed_stops_outreach() FROM PUBLIC;

COMMENT ON FUNCTION deal_closed_stops_outreach() IS
  'Al ganar un negocio, cierra (completed) las cadencias vivas de ese negocio y de todas las personas de su marca en ese '
  'workspace y cancela sus toques en borrador, retenidos y programados (deal_won); al perderlo, las de ese negocio '
  '(deal_lost). SECURITY DEFINER: la aceptación pública corre como mc_public_share. Solo el workspace del negocio, que '
  'fija mientras dura y devuelve al salir; nunca programa ni reabre (0076, VEN-10).';

DROP TRIGGER IF EXISTS deal_closed_stops_outreach ON deal;
CREATE TRIGGER deal_closed_stops_outreach
  AFTER UPDATE OF stage_id, won_at, lost_at ON deal
  FOR EACH ROW
  WHEN (NEW.stage_id IS DISTINCT FROM OLD.stage_id
        OR NEW.won_at IS DISTINCT FROM OLD.won_at
        OR NEW.lost_at IS DISTINCT FROM OLD.lost_at)
  EXECUTE FUNCTION deal_closed_stops_outreach();
