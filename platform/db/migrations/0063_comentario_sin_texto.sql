-- =====================================================================
-- 0063 · Un comentario público no lleva texto de la cadencia (VEN-13)
-- ---------------------------------------------------------------------
-- Número: nació como 0057, detrás de 0056_recomendador_cadencias; al
-- integrar la fase 5 las dos pasaron a 0062 y 0063 (VEN-12 conservó
-- 0056–0060 y VEN-11 tomó 0061). Esta solo toca un CHECK de
-- outbound_step y no depende de ninguna otra.
--
-- 0037 dejó que un paso sin generación automática ni texto fijo solo
-- fuera una reacción (linkedin_like, instagram_like) o una tarea a mano.
-- Pero el despachador tampoco envía los comentarios públicos
-- (linkedin_comment, instagram_comment: DISPATCHABLE_STEP_TYPES de
-- @mc/core), el generador no los redacta, y al enrolar nacen como gesto
-- a mano igual que la reacción (docs/ventas-outreach.md §5.5). Con el
-- CHECK viejo la base tenía que guardarlos con generate_with_ai = true,
-- y la tarjeta los enseñaba como «Generación automática» mientras
-- «Activar» los contaba como gestos a mano.
--
-- Aquí el CHECK pasa a decir lo mismo que el despachador: sin texto, los
-- cinco tipos que hace una persona. Solo afloja la regla (toda fila que
-- cumplía la vieja cumple esta), así que no hay datos que migrar. Las
-- filas que ya existen con un comentario y generate_with_ai = true se
-- ponen en false: nadie las iba a redactar.
--
-- El CHECK de 0037 no tiene nombre propio; se busca por su definición,
-- no por el nombre que Postgres le puso (outbound_step_check1), para no
-- depender del orden en que se crearon las restricciones.
-- =====================================================================

DO $$
DECLARE
  viejo text;
BEGIN
  SELECT c.conname INTO viejo
    FROM pg_constraint c
   WHERE c.conrelid = 'public.outbound_step'::regclass
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) LIKE '%generate_with_ai%body_template%';
  IF viejo IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.outbound_step DROP CONSTRAINT %I', viejo);
  END IF;
END;
$$;

ALTER TABLE outbound_step
  ADD CONSTRAINT outbound_step_text_or_by_hand CHECK (
    generate_with_ai OR body_template IS NOT NULL
    OR step_type IN ('linkedin_comment', 'linkedin_like', 'instagram_comment', 'instagram_like', 'manual_task')
  );

COMMENT ON CONSTRAINT outbound_step_text_or_by_hand ON outbound_step IS
  'Sin generación automática, el paso necesita su texto fijo; salvo los que hace una persona (comentario, reacción, tarea a mano): esos no llevan texto (VEN-13, 0063).';

UPDATE outbound_step
   SET generate_with_ai = false
 WHERE step_type IN ('linkedin_comment', 'instagram_comment') AND generate_with_ai;
