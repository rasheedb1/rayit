-- =====================================================================
-- 0034 · Seguimientos de negocios (VEN-4)
-- ---------------------------------------------------------------------
-- Número: 0033 es la última aplicada en Supabase (23-sep). Esta NO se
-- aplica al integrar: va junto con el próximo deploy, porque la web
-- desplegada desde main compara sus migraciones con las de la base.
--
-- Ninguna de las dos piezas crea tablas, columnas ni funciones: es una
-- fila de catálogo y la misma vista con la misma forma. Por eso se puede
-- volver a correr sin daño (ON CONFLICT y CREATE OR REPLACE).
--
-- 1 · El job `sales.follow_ups`
--
--   Cada negocio abierto tiene una siguiente acción con fecha. El job
--   (apps/worker/src/jobs/ventas/seguimientos.ts) deja en `notification`
--   un 'deal_due' cuando la acción vence hoy y un 'deal_overdue' cuando
--   ya venció, una sola vez por fecha de vencimiento.
--
--   Corre cada hora y no una vez al día a propósito: «cada mañana» es la
--   mañana de CADA espacio, en su zona. Una sola hora UTC sería las 6:00
--   en Bogotá y las 13:00 en Madrid. El job procesa un espacio solo
--   desde las 7:00 de su hora local (SEGUIMIENTOS_HORA_LOCAL en el job);
--   las corridas de después de esa hora no repiten nada, porque cada
--   aviso se reconoce por su negocio, su tipo y su fecha de vencimiento.
--
--   Sin esta fila el runner no programa el job (definitions.ts: un id sin
--   job_definition no se ejecuta nunca).
--
-- 2 · deal_pipeline dice «Hoy» en la zona del espacio
--
--   La vista de 0010 comparaba `next_action_due::date = CURRENT_DATE`,
--   que en Supabase es el día en UTC. En Bogotá, a las 8:00, un negocio
--   que vence a las 20:00 (01:00 UTC del día siguiente) salía «Al día»
--   en el tablero y a la vez en la lista «Para hoy» de /ventas, que sí
--   cuenta el día en la zona del espacio. Ahora las dos cuentan igual.
--
--   Mismas columnas, mismos tipos, mismo orden: CREATE OR REPLACE. El
--   WITH (security_invoker = on) se repite porque CREATE OR REPLACE VIEW
--   reemplaza las opciones de la vista, y sin él la vista volvería a leer
--   con los privilegios de su dueño (0024 §8; la guardia de esquema lo
--   rechazaría).
--
--   La zona sale de la fila del workspace del negocio. Si no se ve (no
--   debería: RLS deja leer la propia), o está vacía, se cuenta en UTC,
--   como WORKSPACE_TZ en queries/ventas.ts. Que sea una zona que
--   Postgres conoce lo garantiza 0035, que va en el mismo deploy: corrige
--   las mal escritas y no deja guardar otra. Por eso aquí no se valida
--   contra pg_timezone_names fila a fila.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · El job
-- ---------------------------------------------------------------------
INSERT INTO job_definition (id, label_es, queue, default_cron, timeout_s, max_attempts, max_concurrency)
VALUES ('sales.follow_ups', 'Seguimientos de negocios', 'sales', '5 * * * *', 120, 3, 1)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 2 · deal_pipeline con «Hoy» en la zona del espacio
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW deal_pipeline WITH (security_invoker = on) AS
SELECT d.id,
       d.workspace_id,
       d.company_id,
       co.name AS company_name,
       d.creator_id,
       d.name,
       d.stage_id,
       st.label_es AS stage_label,
       st.position AS stage_position,
       d.amount,
       d.currency,
       COALESCE(d.probability, st.default_probability) AS probability,
       d.amount * COALESCE(d.probability, st.default_probability) AS weighted_amount,
       d.next_action,
       d.next_action_due,
       CASE
         WHEN d.next_action_due IS NULL THEN 'sin_fecha'
         WHEN d.next_action_due < now() THEN 'vencido'
         WHEN (d.next_action_due AT TIME ZONE coalesce(nullif(w.timezone, ''), 'UTC'))::date
              = (now() AT TIME ZONE coalesce(nullif(w.timezone, ''), 'UTC'))::date THEN 'hoy'
         ELSE 'futuro'
       END AS due_state,
       d.last_contact_at,
       d.expected_close_date,
       st.is_won, st.is_lost
FROM deal d
JOIN pipeline_stage st ON st.id = d.stage_id
JOIN company co        ON co.id = d.company_id
LEFT JOIN workspace w  ON w.id = d.workspace_id;
