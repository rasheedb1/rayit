-- =====================================================================
-- 0068 · Un comentario público no lleva texto de la cadencia (VEN-13)
-- ---------------------------------------------------------------------
-- Número: 0068. La serie de integración va de 0043 a 0075, detrás de
-- la 0042 de main (0034–0042, ya aplicadas en Supabase); ninguna de la
-- serie está aplicada aún. Hasta el pulido r2 de ventas esta fue la
-- 0063. Solo toca un CHECK de outbound_step y no depende de ninguna
-- otra.
--
-- 0046 dejó que un paso sin generación automática ni texto fijo solo
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
-- cumplía la vieja cumple esta), así que no hay datos que migrar.
--
-- Las filas viejas se quedan como están: un comentario con
-- generate_with_ai = true (la secuencia demo del seed 0005) no se
-- corrige aquí. No haría falta, porque el motor y la pantalla miran el
-- tipo del paso y no la bandera (al enrolar, lo que no se despacha nace
-- como borrador a mano; la tarjeta usa sinTexto). Y no se podría:
-- outbound_step tiene RLS en FORCE y quien migra no fija workspace, así
-- que un UPDATE aquí no tocaría ninguna fila (lo mismo que 0067 §4).
--
-- El CHECK de 0046 no tiene nombre propio; se busca por su definición,
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
  'Sin generación automática, el paso necesita su texto fijo; salvo los que hace una persona (comentario, reacción, tarea a mano): esos no llevan texto (VEN-13, 0068).';
