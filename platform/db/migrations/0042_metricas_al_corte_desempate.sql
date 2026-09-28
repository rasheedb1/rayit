-- =====================================================================
-- 0042 · post_metrics_at_cut elige SIEMPRE la misma lectura (CON-6)
-- ---------------------------------------------------------------------
-- Qué hace:
--   Rehace la vista post_metrics_at_cut (0010) con las mismas columnas y
--   la misma regla —la lectura más cercana al corte SIN pasarse—, pero
--   con un desempate: entre dos lecturas con el MISMO age_hours gana la
--   que se tomó antes (captured_at ASC) y, si también coinciden, la de
--   id menor. Conserva security_invoker = on (0024 §8), que un CREATE OR
--   REPLACE sin la opción podría dejar en su valor por defecto.
--
-- Por qué:
--   · El DISTINCT ON de 0010 ordenaba solo por age_hours DESC. Con dos
--     lecturas de la misma edad (una de la API y otra manual o del CSV
--     de TikTok Studio, que conviven por diseño: CON-5 §0.2), Postgres
--     devolvía cualquiera de las dos según el plan. El 24-sep-2026 el
--     seed (como superusuario) tomó la de la API del post d02 de Café
--     Alma y compute.baseline (como mc_worker) la manual: la mediana de
--     completion de TikTok a 30 días salió 0,085 en una y 0,09 en otra,
--     y apps/worker/test/costuras-con.test.ts se puso rojo en main sin
--     que nadie tocara código. En producción, lo mismo haría que la línea
--     base y el puntaje de un video cambiaran de un día a otro sin datos
--     nuevos.
--   · captured_at ASC y no DESC: con la misma edad declarada, la que se
--     tomó antes es la que de verdad no se pasó del corte (la vista
--     existe para comparar videos a la MISMA edad). id desempata dos
--     lecturas del mismo instante.
--
-- Compatibilidad con el código que hoy está en producción: mismas
-- columnas, mismos tipos y mismo nombre, así que nada que la lea cambia
-- de forma; solo deja de variar qué fila devuelve cuando hay empate.
-- CREATE OR REPLACE conserva los GRANT de la vista.
--
-- Re-ejecutable: CREATE OR REPLACE VIEW.
-- =====================================================================

CREATE OR REPLACE VIEW post_metrics_at_cut WITH (security_invoker = on) AS
SELECT DISTINCT ON (s.post_id, c.cut_hours)
       s.post_id,
       s.workspace_id,
       c.cut_hours,
       s.age_hours,
       s.views, s.reach, s.likes, s.comments, s.shares, s.saves,
       s.total_interactions, s.completion_rate, s.skip_rate_3s
FROM post_metric_snapshot s
CROSS JOIN (VALUES (24), (72), (168), (720)) AS c(cut_hours)
WHERE s.age_hours <= c.cut_hours
ORDER BY s.post_id, c.cut_hours, s.age_hours DESC, s.captured_at ASC, s.id ASC;
