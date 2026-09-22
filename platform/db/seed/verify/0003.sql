-- =====================================================================
-- Verificación del seed 0003 (CIM-8): las cifras del mock, por consulta.
-- ---------------------------------------------------------------------
-- Cómo correrlo:
--   Postgres embebido, sin tocar Supabase (migraciones + tres seeds,
--   dos veces, con conteos por tabla):
--     node db/seed/verify/run-0003.mjs
--   Contra Supabase, como mc_app (después de make db.unlock):
--     node db/sql.mjs -f db/seed/verify/0003.sql
--   (make db.sql Q="…" no sirve aquí: Q se pasa como un solo argumento
--   y sql.mjs no reconoce "-f archivo" dentro de él.)
--
-- Cada bloque dice el valor esperado en el comentario.
-- =====================================================================

-- RLS: sin el workspace fijado, todas las consultas devuelven cero filas.
SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);

-- (a) Por cobrar: 9 400 000 en 3 facturas.
SELECT 'a_por_cobrar' AS check_id, sum(outstanding) AS outstanding, count(*) AS facturas
FROM receivables
WHERE status <> 'paid';

-- (b) Hogar Lindo: vencida hace 41 días, aging_bucket 'vencida', 2 recordatorios.
SELECT 'b_vencida' AS check_id, r.company_name, r.number, r.outstanding, r.days_overdue, r.aging_bucket,
       i.reminders_sent, i.last_reminder_at
FROM receivables r
JOIN invoice i ON i.id = r.id
WHERE r.company_name = 'Hogar Lindo' AND r.status <> 'paid';

-- (b2) La tabla CXC completa del mock: Fresko al_dia (+23), Café Alma
--      vence_pronto (+7), Hogar Lindo vencida (−41).
SELECT 'b2_cxc' AS check_id, company_name, number, outstanding, due_on, -days_overdue AS days_to_due, aging_bucket
FROM receivables
WHERE status <> 'paid'
ORDER BY due_on DESC;

-- (c) Cobrado en 2026: 38 600 000. En 2025 (mismo período): 29 500 000 → +31 %.
SELECT 'c_cobrado' AS check_id,
       date_part('year', received_at)::int AS anio,
       sum(amount) AS cobrado,
       count(*) AS pagos
FROM payment
WHERE direction = 'in'
GROUP BY date_part('year', received_at)
ORDER BY 2;

SELECT 'c2_delta_vs_2025' AS check_id,
       round(
         (SELECT sum(amount) FROM payment WHERE direction = 'in' AND received_at >= DATE '2026-01-01')
         / (SELECT sum(amount) FROM payment WHERE direction = 'in' AND received_at >= DATE '2025-01-01' AND received_at < DATE '2026-01-01')
         - 1, 3) AS delta;

-- (d) Apartado para impuestos 2026: 4 246 000 (≈ 4,2 M), todo al 11 %.
SELECT 'd_apartado' AS check_id, sum(amount) AS apartado, count(*) AS reservas, min(rate) AS rate_min, max(rate) AS rate_max
FROM tax_reserve
WHERE released_at IS NULL;

-- (e) Seguidores ganados por @cafealma en la ventana 24–31 ago: 1 240.
--     Línea base (10–23 ago): 12,93/día. Campaña: 155/día → 12×.
SELECT 'e_seguidores' AS check_id,
       (SELECT followers FROM brand_account_snapshot WHERE handle = 'cafealma' AND day = DATE '2026-08-31')
     - (SELECT followers FROM brand_account_snapshot WHERE handle = 'cafealma' AND day = DATE '2026-08-23') AS ganados_ventana,
       round(((SELECT followers FROM brand_account_snapshot WHERE handle = 'cafealma' AND day = DATE '2026-08-23')
            - (SELECT followers FROM brand_account_snapshot WHERE handle = 'cafealma' AND day = DATE '2026-08-09'))::numeric / 14, 2) AS base_por_dia,
       round(((SELECT followers FROM brand_account_snapshot WHERE handle = 'cafealma' AND day = DATE '2026-08-31')
            - (SELECT followers FROM brand_account_snapshot WHERE handle = 'cafealma' AND day = DATE '2026-08-23'))::numeric / 8, 2) AS campana_por_dia,
       (SELECT count(*) FROM brand_account_snapshot WHERE handle = 'cafealma') AS dias,
       (SELECT followers FROM brand_account_snapshot WHERE handle = 'cafealma' AND day = DATE '2026-07-18') AS inicio;

-- (f) campaign_result de Café Alma: los KPIs del mock.
SELECT 'f_resultado' AS check_id, c.name, c.status, c.tracking_code, c.brand_baseline_from,
       r.reach, r.views, r.reach_non_followers_pct, r.link_clicks, r.code_redemptions, r.attributed_revenue,
       r.brand_followers_gained, r.brand_followers_baseline_rate, r.brand_followers_campaign_rate,
       round(r.brand_followers_campaign_rate / r.brand_followers_baseline_rate, 1) AS veces_ritmo,
       r.cpm, r.cpa, r.missing_inputs
FROM campaign c
JOIN campaign_result r ON r.campaign_id = c.id
WHERE c.name = 'Lanzamiento cold brew';

-- (g) La tabla de campañas del mock: marca, entregables, fechas, estado, views.
SELECT 'g_campanas' AS check_id, co.name AS marca, c.name AS campana, c.starts_on, c.ends_on, c.status, c.amount,
       (SELECT count(*) FROM campaign_post cp WHERE cp.campaign_id = c.id) AS posts,
       (SELECT sum(m.views) FROM campaign_post cp JOIN post_metrics_latest m ON m.post_id = cp.post_id WHERE cp.campaign_id = c.id) AS views,
       (SELECT sum(s.link_clicks) FROM campaign_post cp
          JOIN LATERAL (SELECT link_clicks FROM post_metric_snapshot WHERE post_id = cp.post_id ORDER BY captured_at DESC LIMIT 1) s ON true
         WHERE cp.campaign_id = c.id) AS clics,
       (SELECT count(*) FROM invoice i WHERE i.campaign_id = c.id) AS facturas
FROM campaign c
JOIN company co ON co.id = c.company_id
ORDER BY c.starts_on DESC;

-- (h) Invariantes: total = subtotal + IVA en todas; números únicos por
--     workspace; ninguna factura con moneda distinta de COP.
SELECT 'h_invariantes' AS check_id,
       count(*) AS facturas,
       count(*) FILTER (WHERE total <> subtotal + tax) AS totales_mal,
       count(*) FILTER (WHERE currency <> 'COP') AS moneda_rara,
       count(DISTINCT number) AS numeros_distintos,
       max(number) FILTER (WHERE number LIKE 'FV-2026-%') AS ultimo_2026
FROM invoice;

-- (i) Gastos recurrentes mensuales: 3,7 M/mes.
SELECT 'i_gastos' AS check_id, to_char(incurred_on, 'YYYY-MM') AS mes,
       sum(amount) FILTER (WHERE is_recurring) AS recurrentes,
       sum(amount) FILTER (WHERE NOT is_recurring) AS puntuales,
       count(*) AS filas
FROM expense
GROUP BY to_char(incurred_on, 'YYYY-MM')
ORDER BY 2;
