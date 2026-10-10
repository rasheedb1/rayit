-- =====================================================================
-- 0086 · «visualizaciones», no «views», en la guía de cada paso (VEN-13)
-- ---------------------------------------------------------------------
-- Número: 0086, el siguiente libre detrás de 0085_outreach_permisos_y_alcance.
-- Re-ejecutable: cada UPDATE solo toca filas que todavía dicen «views»
-- y la segunda vez no encuentra ninguna.
--
-- Compatible con el código que hoy está en producción: cambia texto que
-- la pantalla pinta tal cual (guidance_es), nada de estructura.
--
-- El pulido final del 28-sep (pendientes-pulido-final.json) vio en
-- /ventas/cadencias/<id> la guía «sus views frente a tu mediana»: las
-- notas de VEN-11 y VEN-13 decían que el producto ya hablaba de
-- «visualizaciones» (como Resumen y Campañas), pero las plantillas de
-- 0046 §303 y 0067 y las cadencias ya instanciadas desde ellas
-- (outbound_step.guidance_es) seguían con el anglicismo. Las migraciones
-- aplicadas son inmutables, así que se corrige aquí, en las filas:
--
--   1 · outbound_sequence_template.steps: cada guidance_es del jsonb.
--   2 · outbound_step.guidance_es: las cadencias que nacieron de ellas.
--
-- «views» solo como palabra entera (\m…\M) y sin distinguir mayúsculas:
-- «Views a 7 días» → «Visualizaciones a 7 días»; las claves del JSON
-- (views_vs_median) no son texto de guía y no se tocan porque viven en
-- otras claves, no en guidance_es. La prueba packages/db/test/
-- guia-sin-anglicismos.test.ts exige que ninguna guía lo diga.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · Las plantillas
-- ---------------------------------------------------------------------
UPDATE outbound_sequence_template tpl
   SET steps = (
     SELECT jsonb_agg(
              CASE
                WHEN p.paso ? 'guidance_es' AND (p.paso->>'guidance_es') ~* '\mviews\M'
                THEN jsonb_set(
                       p.paso, '{guidance_es}',
                       to_jsonb(regexp_replace(
                         regexp_replace(p.paso->>'guidance_es', '\mViews\M', 'Visualizaciones', 'g'),
                         '\mviews\M', 'visualizaciones', 'g')))
                ELSE p.paso
              END
              ORDER BY p.n)
       FROM jsonb_array_elements(tpl.steps) WITH ORDINALITY AS p(paso, n))
 WHERE EXISTS (
   SELECT 1 FROM jsonb_array_elements(tpl.steps) AS q(paso)
    WHERE (q.paso->>'guidance_es') ~* '\mviews\M');

-- ---------------------------------------------------------------------
-- 2 · Las cadencias ya instanciadas
-- ---------------------------------------------------------------------
UPDATE outbound_step
   SET guidance_es = regexp_replace(regexp_replace(guidance_es, '\mViews\M', 'Visualizaciones', 'g'), '\mviews\M', 'visualizaciones', 'g')
 WHERE guidance_es ~* '\mviews\M';
