-- =====================================================================
-- Seed 3 · Finanzas y campañas de la creadora ficticia (CIM-8).
-- ---------------------------------------------------------------------
-- Deja Finanzas y Campañas con los números del mock (dashboard/local/
-- app.js: CXC, CAMPS, renderFinanzas, renderCampanas). Idempotente: se
-- puede correr N veces y la segunda pasada no cambia ningún conteo.
--
-- Reglas del archivo:
--   * Todo vive en el workspace del seed 0002 (la creadora "Laura").
--   * Dinero numeric(14,2), moneda 'COP' aparte. Nada de float.
--   * UUID fijos y legibles. Tablas maestras con ON CONFLICT (id) DO
--     UPDATE (corregir una cifra y volver a correr actualiza). Tablas
--     append-only con ON CONFLICT DO NOTHING sobre su clave natural.
--   * Fechas de las facturas abiertas relativas a CURRENT_DATE para que
--     la demo diga "vencida hace 41 días" cualquier día. La campaña de
--     Café Alma y el snapshot de @cafealma van con fechas FIJAS (10–17
--     ago 2026): son hechos históricos que el reporte y la factura
--     citan, y así la consulta de verificación da siempre lo mismo.
--     Es la misma línea de tiempo que 0002 (sección 13): reel el 10 y
--     TikTok el 12 ago, 30 días cumplidos el 11 sep, resultado calculado
--     y reporte enviado el 12 sep. Ninguna fecha queda en el futuro
--     respecto al día del seed (verify/0002.sql lo comprueba).
--
-- Mapa de identificadores (solo dígitos hexadecimales):
--   00000002-…  ids que DEBEN existir en 0002 (contrato con Rasheed):
--     …-000000000001  workspace           …-0000000000c1/c2/c3 conexiones
--     …-000000000002  app_user            …-0000000000e1..e4   empresas
--     …-000000000003  creator_profile     …-000000000d01..d05  posts
--   00000003-…  ids de este seed:
--     …-000000ca0001..  campaign            (ca  = campaña)
--     …-0000fac26001..  invoice             (fac = factura, año, secuencia)
--     …-0000c0b26001..  payment             (c0b = cobro)
--     …-0000ade26001..  tax_reserve         (ade = apartado de impuestos)
--     …-0009a5MM0001..  expense             (9a5 = gasto, mes, secuencia)
--     …-000000ab0001..  campaign_brand_input (ab = aporte de la marca)
--
-- Numeración de facturas (FIN-1 la continúa con el mismo formato):
--   'FV-' || año de emisión || '-' || secuencia por workspace y año,
--   con al menos tres dígitos: FV-2026-001, FV-2026-002, … FV-2026-011.
--   La siguiente que cree la app en 2026 es FV-2026-012.
--
-- Totales: total = subtotal + IVA (19 %). La retención en la fuente
-- (11 %, servicios) se guarda en `withholding` como lo que la marca va a
-- retener al pagar; NO se resta del total de la factura. Los subtotales
-- están elegidos para que el total dé la cifra redonda del mock.
-- =====================================================================

-- RLS está en modo FORCE: incluso el dueño de la tabla (mc_migrator)
-- necesita el workspace fijado para insertar. Vale para toda la sesión.
SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);


-- =====================================================================
-- 0 · Prerrequisitos que vienen del seed 0002 (Rasheed)
-- ---------------------------------------------------------------------
-- Este bloque existe porque 0002 todavía no está en main. Son las filas
-- mínimas que este seed necesita, con los ids del contrato de arriba y
-- ON CONFLICT DO NOTHING: cuando 0002 exista con esos ids, todo esto es
-- un no-op y Rasheed puede borrarlo. Detalle en docs/propuestas/CIM-8.md.
-- =====================================================================
INSERT INTO workspace (id, slug, name, kind, country, currency, timezone, locale, plan, niche_slugs, settings)
VALUES (
  '00000002-0000-4000-8000-000000000001', 'laura-cocina-facil', 'Laura · Cocina fácil',
  'creator', 'CO', 'COP', 'America/Bogota', 'es-CO', 'creator', '{cocina}',
  '{"finanzas": {"iva_pct": 19, "retencion_pct": 11, "reserva_pct": 11, "plazo_dias": 30}}'::jsonb
)
ON CONFLICT DO NOTHING;

INSERT INTO app_user (id, email, name, locale)
VALUES ('00000002-0000-4000-8000-000000000002', 'laura@ejemplo.com', 'Laura Méndez', 'es-CO')
ON CONFLICT DO NOTHING;

INSERT INTO membership (workspace_id, user_id, role)
VALUES ('00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000002', 'owner')
ON CONFLICT DO NOTHING;

INSERT INTO creator_profile (id, workspace_id, user_id, display_name, handle, bio, country, languages, niche_slugs)
VALUES (
  '00000002-0000-4000-8000-000000000003', '00000002-0000-4000-8000-000000000001',
  '00000002-0000-4000-8000-000000000002', 'Laura Méndez', 'laura.cocinafacil',
  'Cocina fácil para 412 mil personas en Colombia.', 'CO', '{es}', '{cocina}'
)
ON CONFLICT DO NOTHING;

INSERT INTO social_connection (id, workspace_id, creator_id, platform_id, external_account_id, handle, display_name, account_type, secret_ref, scopes, status, last_synced_at)
VALUES
  ('00000002-0000-4000-8000-0000000000c1', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000003',
   'instagram', '17841400000000123', 'laura.cocinafacil', 'Laura · Cocina fácil', 'creator',
   'vault://demo/instagram/laura', '{instagram_basic,instagram_manage_insights}', 'active', now() - interval '26 hours'),
  ('00000002-0000-4000-8000-0000000000c2', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000003',
   'tiktok', 'open_id_demo_laura', 'laura.cocinafacil', 'Laura · Cocina fácil', 'creator',
   'vault://demo/tiktok/laura', '{user.info.basic,video.list,video.insights}', 'active', now() - interval '30 hours'),
  ('00000002-0000-4000-8000-0000000000c3', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000003',
   'youtube', 'UCdemo000000000000000001', 'LauraCocinaFacil', 'Laura · Cocina fácil', 'channel',
   'vault://demo/youtube/laura', '{youtube.readonly,yt-analytics.readonly}', 'active', now() - interval '40 hours')
ON CONFLICT DO NOTHING;

INSERT INTO company (id, name, legal_name, domain, country, city, industry, niche_slugs, size_bucket, socials, runs_ads)
VALUES
  ('00000002-0000-4000-8000-0000000000e1', 'Café Alma',     'Café Alma S.A.S.',          'cafealma.co',     'CO', 'Bogotá',   'alimentos', '{cocina}', 'pyme',    '{"instagram": "cafealma", "tiktok": "cafealma.co"}', true),
  ('00000002-0000-4000-8000-0000000000e2', 'Fresko Market', 'Fresko Market S.A.S.',      'freskomarket.co', 'CO', 'Bogotá',   'alimentos', '{cocina}', 'mediana', '{"instagram": "freskomarket", "tiktok": "freskomarket"}', true),
  ('00000002-0000-4000-8000-0000000000e3', 'Hogar Lindo',   'Hogar Lindo Ltda.',         'hogarlindo.co',   'CO', 'Medellín', 'hogar',     '{hogar}',  'pyme',    '{"instagram": "hogarlindo"}', false),
  ('00000002-0000-4000-8000-0000000000e4', 'Nutrivé',       'Nutrivé Alimentos S.A.S.',  'nutrive.co',      'CO', 'Cali',     'alimentos', '{cocina,fitness}', 'mediana', '{"instagram": "nutrive", "youtube": "NutriveOficial"}', true)
ON CONFLICT DO NOTHING;

INSERT INTO company_link (workspace_id, company_id, owner_user_id, relationship, notes)
VALUES
  ('00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e1', '00000002-0000-4000-8000-000000000002', 'client',      'Cliente actual. Renovación Q4 en conversación.'),
  ('00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e2', '00000002-0000-4000-8000-000000000002', 'client',      'Cliente actual. Cotización de desayunos enviada el 2 sep.'),
  ('00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e3', '00000002-0000-4000-8000-000000000002', 'past_client', 'Cliente anterior con factura en mora.'),
  ('00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e4', '00000002-0000-4000-8000-000000000002', 'client',      'Cliente actual. Serie de 3 videos Q4 en conversación.')
ON CONFLICT DO NOTHING;

-- Posts que las campañas asocian. Un reel y un TikTok para Café Alma,
-- dos TikTok para Fresko, un video dedicado de YouTube para Nutrivé.
INSERT INTO post (id, workspace_id, creator_id, connection_id, platform_id, external_post_id, url, media_type, surface, caption, hashtags, mentions, duration_s, is_branded_content, published_at)
VALUES
  ('00000002-0000-4000-8000-000000000d01', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000003',
   '00000002-0000-4000-8000-0000000000c1', 'instagram', 'ig_18000000000000d01', 'https://www.instagram.com/reel/demo-d01/',
   'video', 'reels', 'Cold brew en casa en 3 pasos ☕ Con @cafealma · código LAURA15', '{coldbrew,cafe,recetafacil}', '{cafealma}', 41, true,
   '2026-08-10 17:00:00+00'),
  ('00000002-0000-4000-8000-000000000d02', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000003',
   '00000002-0000-4000-8000-0000000000c2', 'tiktok', 'tt_7400000000000000d02', 'https://www.tiktok.com/@laura.cocinafacil/video/demo-d02',
   'video', 'feed', 'El cold brew que me salva las mañanas 🧊 #ad @cafealma.co', '{coldbrew,cafe,ad}', '{cafealma.co}', 34, true,
   '2026-08-12 16:30:00+00'),
  ('00000002-0000-4000-8000-000000000d03', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000003',
   '00000002-0000-4000-8000-0000000000c2', 'tiktok', 'tt_7400000000000000d03', 'https://www.tiktok.com/@laura.cocinafacil/video/demo-d03',
   'video', 'feed', 'Tres desayunos con lo que llega en la caja de @freskomarket 🥑 #ad', '{desayuno,recetafacil,ad}', '{freskomarket}', 52, true,
   '2026-09-02 15:00:00+00'),
  ('00000002-0000-4000-8000-000000000d04', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000003',
   '00000002-0000-4000-8000-0000000000c2', 'tiktok', 'tt_7400000000000000d04', 'https://www.tiktok.com/@laura.cocinafacil/video/demo-d04',
   'video', 'feed', 'Mercado de la semana en 10 minutos con @freskomarket 🛒 #ad', '{mercado,ahorro,ad}', '{freskomarket}', 47, true,
   '2026-09-06 15:00:00+00'),
  ('00000002-0000-4000-8000-000000000d05', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000003',
   '00000002-0000-4000-8000-0000000000c3', 'youtube', 'yt_demo00000000d05', 'https://www.youtube.com/watch?v=demo-d05',
   'video', 'video', 'Una semana de almuerzos saludables con Nutrivé', '{mealprep,saludable}', '{}', 612, true,
   '2026-07-15 14:00:00+00')
ON CONFLICT DO NOTHING;

-- Una lectura manual a 30 días de los posts cuya campaña ya cerró, para
-- que Campañas pueda mostrar views y clics aunque 0002 no esté: Café
-- Alma 412 K + 300 K = 712 K; Nutrivé 58 K; Fresko 140 K + 125 K. Se
-- capturan a las 06:00 UTC del día siguiente a las 720 h del video
-- (d01 el 10 sep, d02 el 12 sep, d05 el 15 ago, d03 el 3 oct y d04 el
-- 7 oct) y NUNCA en el futuro: las dos de Fresko solo entran cuando esa
-- fecha ya pasó (WHERE v.captured_at <= now()), porque una lectura "a
-- 30 días" fechada antes de que el video cumpla las 720 h sería una
-- mentira. Mientras tanto las views de esa campaña salen de la curva de
-- 0002 (≈ 137 K + 120 K), así que la ficha nunca queda vacía si 0002
-- está; si no está, Fresko no tiene views hasta octubre, y es el precio
-- de no inventar una lectura que no ha ocurrido.
-- Sin clave natural: se evita el duplicado con WHERE NOT EXISTS.
INSERT INTO post_metric_snapshot (post_id, workspace_id, captured_at, age_hours, views, reach, likes, comments, shares, saves, total_interactions, profile_visits, follows_from_post, link_clicks, reach_followers, reach_non_followers, source)
SELECT v.post_id, '00000002-0000-4000-8000-000000000001', v.captured_at, 720, v.views, v.reach, v.likes, v.comments, v.shares, v.saves,
       v.likes + v.comments + v.shares + v.saves, v.profile_visits, v.follows, v.link_clicks, v.reach - v.reach_nf, v.reach_nf, 'manual'
FROM (VALUES
  ('00000002-0000-4000-8000-000000000d01'::uuid, '2026-09-10 06:00:00+00'::timestamptz, 412000, 296000, 24800, 610, 3100, 6200, 4100, 780, 3900, 172000),
  ('00000002-0000-4000-8000-000000000d02'::uuid, '2026-09-12 06:00:00+00'::timestamptz, 300000, 190000, 17000, 420, 2000, 3400, 2600, 460, 2340, 110000),
  ('00000002-0000-4000-8000-000000000d05'::uuid, '2026-08-15 06:00:00+00'::timestamptz,  58000,  41000,  2900, 140,  310,  900,  600,  95,  420,  22000),
  ('00000002-0000-4000-8000-000000000d03'::uuid, '2026-10-03 06:00:00+00'::timestamptz, 140000,  89000,  7900, 200,  930, 1500, 1200, 210, 1106,  51000),
  ('00000002-0000-4000-8000-000000000d04'::uuid, '2026-10-07 06:00:00+00'::timestamptz, 125000,  79000,  7000, 175,  830, 1300, 1080, 190,  838,  46000)
) AS v(post_id, captured_at, views, reach, likes, comments, shares, saves, profile_visits, follows, link_clicks, reach_nf)
WHERE v.captured_at <= now()
  AND NOT EXISTS (
    SELECT 1 FROM post_metric_snapshot s WHERE s.post_id = v.post_id AND s.captured_at = v.captured_at
  );


-- =====================================================================
-- 1 · Campañas
-- =====================================================================
INSERT INTO campaign (id, workspace_id, company_id, creator_id, name, brief, starts_on, ends_on, tracking_code, tracking_url, utm, brand_baseline_from, brand_accounts, amount, currency, status)
VALUES
  ('00000003-0000-4000-8000-000000ca0001', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e1', '00000002-0000-4000-8000-000000000003',
   'Lanzamiento cold brew', '1 reel + 1 TikTok + 3 historias. Código propio y enlace rastreado; reporte a 30 días con cortes a 7 y 30.',
   DATE '2026-08-10', DATE '2026-08-17', 'LAURA15',
   'https://cafealma.co/cold-brew?utm_source=instagram&utm_medium=creator&utm_campaign=laura_coldbrew',
   '{"utm_source": "instagram", "utm_medium": "creator", "utm_campaign": "laura_coldbrew"}'::jsonb,
   DATE '2026-07-27', '[{"platform_id": "instagram", "handle": "cafealma"}]'::jsonb,
   3100000.00, 'COP', 'reported'),
  ('00000003-0000-4000-8000-000000ca0002', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e2', '00000002-0000-4000-8000-000000000003',
   'Campaña 2 TikTok · sep', '2 TikTok con enlace rastreado a la caja de desayunos. Medición a 30 días.',
   DATE '2026-09-02', DATE '2026-09-09', 'LAURAFRESKO',
   'https://freskomarket.co/caja?utm_source=tiktok&utm_medium=creator&utm_campaign=laura_sep',
   '{"utm_source": "tiktok", "utm_medium": "creator", "utm_campaign": "laura_sep"}'::jsonb,
   DATE '2026-08-19', '[{"platform_id": "tiktok", "handle": "freskomarket"}]'::jsonb,
   5200000.00, 'COP', 'measuring'),
  ('00000003-0000-4000-8000-000000ca0003', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e4', '00000002-0000-4000-8000-000000000003',
   'Video dedicado · julio', '1 video dedicado en YouTube. La marca no compartió datos de ventas.',
   DATE '2026-07-15', DATE '2026-07-22', NULL, NULL, '{}'::jsonb,
   DATE '2026-07-01', '[{"platform_id": "youtube", "handle": "NutriveOficial"}]'::jsonb,
   4700000.00, 'COP', 'closed'),
  ('00000003-0000-4000-8000-000000ca0004', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e3', '00000002-0000-4000-8000-000000000003',
   '3 historias · jun', '3 historias con código. Reporte enviado; la factura sigue pendiente de pago.',
   DATE '2026-06-05', DATE '2026-06-06', 'LAURAHOGAR', NULL, '{}'::jsonb,
   DATE '2026-05-22', '[{"platform_id": "instagram", "handle": "hogarlindo"}]'::jsonb,
   1100000.00, 'COP', 'reported')
ON CONFLICT (id) DO UPDATE SET
  company_id = EXCLUDED.company_id, creator_id = EXCLUDED.creator_id, name = EXCLUDED.name,
  brief = EXCLUDED.brief, starts_on = EXCLUDED.starts_on, ends_on = EXCLUDED.ends_on,
  tracking_code = EXCLUDED.tracking_code, tracking_url = EXCLUDED.tracking_url, utm = EXCLUDED.utm,
  brand_baseline_from = EXCLUDED.brand_baseline_from, brand_accounts = EXCLUDED.brand_accounts,
  amount = EXCLUDED.amount, currency = EXCLUDED.currency, status = EXCLUDED.status;

INSERT INTO campaign_post (campaign_id, post_id, deliverable, is_primary)
VALUES
  ('00000003-0000-4000-8000-000000ca0001', '00000002-0000-4000-8000-000000000d01', 'reel',     true),
  ('00000003-0000-4000-8000-000000ca0001', '00000002-0000-4000-8000-000000000d02', 'tiktok',   false),
  ('00000003-0000-4000-8000-000000ca0002', '00000002-0000-4000-8000-000000000d03', 'tiktok',   true),
  ('00000003-0000-4000-8000-000000ca0002', '00000002-0000-4000-8000-000000000d04', 'tiktok',   false),
  ('00000003-0000-4000-8000-000000ca0003', '00000002-0000-4000-8000-000000000d05', 'dedicado', true)
ON CONFLICT (campaign_id, post_id) DO UPDATE SET
  deliverable = EXCLUDED.deliverable, is_primary = EXCLUDED.is_primary;


-- =====================================================================
-- 2 · Seguidores públicos de @cafealma: 60 días diarios, deterministas
-- ---------------------------------------------------------------------
-- Día 0 = 4 jul 2026 con 18 200 seguidores. Ganancia diaria:
--   antes (d < 37):      12 + (d·2 mod 3)   → 12..14, promedio 12,9/día
--   ventana 10–17 ago:   150,155,175,160,150,150,150,150 → 1 240 en total
--   después (d > 44):    22 + (d·5 mod 9)   → 22..30, promedio 26/día
-- d=23 es el 27 jul (brand_baseline_from), d=37 el 10 ago, d=44 el 17 ago.
-- Con la línea base de 14 días (12,93/día) y 155/día en campaña, el
-- ritmo es 12×, como dice el mock. Sin random(): dos corridas dan lo mismo.
-- =====================================================================
INSERT INTO brand_account_snapshot (campaign_id, company_id, platform_id, external_account_id, handle, day, followers, media_count, source, captured_at)
SELECT
  '00000003-0000-4000-8000-000000ca0001',
  '00000002-0000-4000-8000-0000000000e1',
  'instagram', '17841400000000e01', 'cafealma',
  DATE '2026-07-04' + a.d,
  18200 + a.ganados,
  640 + a.d / 3,
  'business_discovery',
  ((DATE '2026-07-04' + a.d + 1)::timestamp + interval '6 hours') AT TIME ZONE 'UTC'
FROM (
  SELECT d, sum(gain) OVER (ORDER BY d) AS ganados
  FROM (
    SELECT d,
      CASE
        WHEN d = 0 THEN 0
        WHEN d BETWEEN 37 AND 44 THEN (ARRAY[150, 155, 175, 160, 150, 150, 150, 150])[d - 36]
        WHEN d > 44 THEN 22 + (d * 5) % 9
        ELSE 12 + (d * 2) % 3
      END AS gain
    FROM generate_series(0, 59) AS d
  ) g
) a
ON CONFLICT (company_id, platform_id, day) DO NOTHING;


-- =====================================================================
-- 3 · Lo que aportó la marca
-- =====================================================================
INSERT INTO campaign_brand_input (id, workspace_id, campaign_id, kind, day, value_num, currency, source, received_at, notes)
VALUES
  ('00000003-0000-4000-8000-000000ab0001', '00000002-0000-4000-8000-000000000001', '00000003-0000-4000-8000-000000ca0001',
   'code_redemptions', DATE '2026-09-11', 318, NULL, 'brand_manual', '2026-09-11 14:00:00+00', 'Canjes de LAURA15 acumulados al 11 sep, reportados por la marca.'),
  ('00000003-0000-4000-8000-000000ab0002', '00000002-0000-4000-8000-000000000001', '00000003-0000-4000-8000-000000ca0001',
   'revenue',          DATE '2026-09-11', 8400000.00, 'COP', 'brand_manual', '2026-09-11 14:00:00+00', 'Ventas con código, reportadas por la marca. Falta el CSV diario para el lift.'),
  ('00000003-0000-4000-8000-000000ab0003', '00000002-0000-4000-8000-000000000001', '00000003-0000-4000-8000-000000ca0004',
   'code_redemptions', DATE '2026-06-30', 42, NULL, 'brand_manual', '2026-06-30 16:00:00+00', 'Canjes de LAURAHOGAR al cierre de junio.'),
  ('00000003-0000-4000-8000-000000ab0004', '00000002-0000-4000-8000-000000000001', '00000003-0000-4000-8000-000000ca0004',
   'revenue',          DATE '2026-06-30', 1100000.00, 'COP', 'brand_manual', '2026-06-30 16:00:00+00', 'Ventas con código al cierre de junio.')
ON CONFLICT (id) DO UPDATE SET
  campaign_id = EXCLUDED.campaign_id, kind = EXCLUDED.kind, day = EXCLUDED.day, value_num = EXCLUDED.value_num,
  currency = EXCLUDED.currency, source = EXCLUDED.source, received_at = EXCLUDED.received_at, notes = EXCLUDED.notes;


-- =====================================================================
-- 4 · Resultado consolidado (los KPIs del mock)
-- ---------------------------------------------------------------------
-- Café Alma: cpm 11 800 y cpa 26 400 son los del mock tal cual; no salen
-- de amount/views (3,1 M / 712 K × 1000 = 4 354). CAM-5 los recalcula.
-- =====================================================================
INSERT INTO campaign_result (campaign_id, workspace_id, computed_at, cut_hours, views, reach, interactions, saves, shares, link_clicks, reach_non_followers_pct, views_vs_median, brand_followers_gained, brand_followers_baseline_rate, brand_followers_campaign_rate, code_redemptions, attributed_revenue, currency, cpm, cost_per_follower, cpa, emv, missing_inputs)
VALUES
  ('00000003-0000-4000-8000-000000ca0001', '00000002-0000-4000-8000-000000000001', '2026-09-12 07:30:00+00', 720,
   712000, 486000, 57630, 9600, 5100, 6240, 0.58000, NULL,
   1240, 12.9286, 155.0000, 318, 8400000.00, 'COP', 11800.00, 2500.00, 26400.00, NULL, '{brand_csv_sales}'),
  ('00000003-0000-4000-8000-000000ca0003', '00000002-0000-4000-8000-000000000001', '2026-08-22 07:30:00+00', 720,
   58000, 41000, 4250, 900, 310, 420, 0.53659, NULL,
   NULL, NULL, NULL, NULL, NULL, 'COP', NULL, NULL, NULL, NULL, '{brand_inputs,brand_followers}'),
  ('00000003-0000-4000-8000-000000ca0004', '00000002-0000-4000-8000-000000000001', '2026-07-07 07:30:00+00', 720,
   94000, 61000, 5900, 1200, 480, 700, 0.49180, NULL,
   NULL, NULL, NULL, 42, 1100000.00, 'COP', 11702.13, NULL, 26190.48, NULL, '{brand_followers}')
ON CONFLICT (campaign_id) DO UPDATE SET
  computed_at = EXCLUDED.computed_at, cut_hours = EXCLUDED.cut_hours, views = EXCLUDED.views, reach = EXCLUDED.reach,
  interactions = EXCLUDED.interactions, saves = EXCLUDED.saves, shares = EXCLUDED.shares, link_clicks = EXCLUDED.link_clicks,
  reach_non_followers_pct = EXCLUDED.reach_non_followers_pct, views_vs_median = EXCLUDED.views_vs_median,
  brand_followers_gained = EXCLUDED.brand_followers_gained,
  brand_followers_baseline_rate = EXCLUDED.brand_followers_baseline_rate,
  brand_followers_campaign_rate = EXCLUDED.brand_followers_campaign_rate,
  code_redemptions = EXCLUDED.code_redemptions, attributed_revenue = EXCLUDED.attributed_revenue, currency = EXCLUDED.currency,
  cpm = EXCLUDED.cpm, cost_per_follower = EXCLUDED.cost_per_follower, cpa = EXCLUDED.cpa, emv = EXCLUDED.emv,
  missing_inputs = EXCLUDED.missing_inputs;


-- =====================================================================
-- 5 · Facturas
-- ---------------------------------------------------------------------
-- 2025: seis pagadas, 29,5 M (para el "+31 % vs 2025": 38,6 / 29,5).
-- 2026: ocho pagadas (38,6 M) y las tres abiertas del mock (9,4 M):
--   FV-2026-011 Fresko Market · Campaña 2 TikTok · sep · 5,2 M · vence en 23 días
--   FV-2026-010 Café Alma · Lanzamiento cold brew · 3,1 M · vence en 7 días
--   FV-2026-007 Hogar Lindo · 3 historias · jun · 1,1 M · vencida hace 41 días
-- Café Alma vence en 7 y no en 14 como el mock: la vista receivables
-- marca vence_pronto solo a ≤ 7 días y la pastilla "Vence pronto" manda.
-- =====================================================================
INSERT INTO invoice (id, workspace_id, company_id, campaign_id, number, currency, subtotal, tax, withholding, total, issued_on, due_on, status, paid_amount, paid_at, reminders_sent, last_reminder_at, external_ref)
VALUES
  -- 2025
  ('00000003-0000-4000-8000-0000fac25001', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e1', NULL,
   'FV-2025-001', 'COP', 3109243.70, 590756.30, 342016.81, 3700000.00, DATE '2025-01-20', DATE '2025-02-19', 'paid', 3700000.00, '2025-02-05 15:00:00+00', 0, NULL, 'FE-25-0001'),
  ('00000003-0000-4000-8000-0000fac25002', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e4', NULL,
   'FV-2025-002', 'COP', 3865546.22, 734453.78, 425210.08, 4600000.00, DATE '2025-03-03', DATE '2025-04-02', 'paid', 4600000.00, '2025-03-28 15:00:00+00', 0, NULL, 'FE-25-0002'),
  ('00000003-0000-4000-8000-0000fac25003', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e2', NULL,
   'FV-2025-003', 'COP', 4369747.90, 830252.10, 480672.27, 5200000.00, DATE '2025-04-14', DATE '2025-05-14', 'paid', 5200000.00, '2025-05-09 15:00:00+00', 0, NULL, 'FE-25-0003'),
  ('00000003-0000-4000-8000-0000fac25004', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e3', NULL,
   'FV-2025-004', 'COP', 3949579.83, 750420.17, 434453.78, 4700000.00, DATE '2025-06-02', DATE '2025-07-02', 'paid', 4700000.00, '2025-06-25 15:00:00+00', 0, NULL, 'FE-25-0004'),
  ('00000003-0000-4000-8000-0000fac25005', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e1', NULL,
   'FV-2025-005', 'COP', 4621848.74, 878151.26, 508403.36, 5500000.00, DATE '2025-07-14', DATE '2025-08-13', 'paid', 5500000.00, '2025-08-01 15:00:00+00', 0, NULL, 'FE-25-0005'),
  ('00000003-0000-4000-8000-0000fac25006', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e4', NULL,
   'FV-2025-006', 'COP', 4873949.58, 926050.42, 536134.45, 5800000.00, DATE '2025-08-18', DATE '2025-09-17', 'paid', 5800000.00, '2025-09-10 15:00:00+00', 0, NULL, 'FE-25-0006'),
  -- 2026 · pagadas
  ('00000003-0000-4000-8000-0000fac26001', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e1', NULL,
   'FV-2026-001', 'COP', 3949579.83, 750420.17, 434453.78, 4700000.00, DATE '2026-01-12', DATE '2026-02-11', 'paid', 4700000.00, '2026-01-28 15:00:00+00', 0, NULL, 'FE-26-0001'),
  ('00000003-0000-4000-8000-0000fac26002', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e4', NULL,
   'FV-2026-002', 'COP', 4621848.74, 878151.26, 508403.36, 5500000.00, DATE '2026-02-09', DATE '2026-03-11', 'paid', 5500000.00, '2026-02-25 15:00:00+00', 0, NULL, 'FE-26-0002'),
  ('00000003-0000-4000-8000-0000fac26003', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e2', NULL,
   'FV-2026-003', 'COP', 5210084.03, 989915.97, 573109.24, 6200000.00, DATE '2026-03-16', DATE '2026-04-15', 'paid', 6200000.00, '2026-03-30 15:00:00+00', 0, NULL, 'FE-26-0003'),
  ('00000003-0000-4000-8000-0000fac26004', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e3', NULL,
   'FV-2026-004', 'COP', 3109243.70, 590756.30, 342016.81, 3700000.00, DATE '2026-04-06', DATE '2026-05-06', 'paid', 3700000.00, '2026-04-29 15:00:00+00', 0, NULL, 'FE-26-0004'),
  ('00000003-0000-4000-8000-0000fac26005', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e1', NULL,
   'FV-2026-005', 'COP', 4957983.19, 942016.81, 545378.15, 5900000.00, DATE '2026-05-04', DATE '2026-06-03', 'paid', 5900000.00, '2026-05-20 15:00:00+00', 0, NULL, 'FE-26-0005'),
  ('00000003-0000-4000-8000-0000fac26006', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e1', NULL,
   'FV-2026-006', 'COP', 3445378.15, 654621.85, 378991.60, 4100000.00, DATE '2026-06-08', DATE '2026-07-08', 'paid', 4100000.00, '2026-07-08 15:00:00+00', 0, NULL, 'FE-26-0006'),
  -- 2026 · abierta y vencida (fechas relativas: "vencida hace 41 días" cualquier día)
  ('00000003-0000-4000-8000-0000fac26007', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e3', '00000003-0000-4000-8000-000000ca0004',
   'FV-2026-007', 'COP', 924369.75, 175630.25, 101680.67, 1100000.00, CURRENT_DATE - 71, CURRENT_DATE - 41, 'sent', 0.00, NULL, 2, now() - interval '3 days', 'FE-26-0007'),
  -- 2026 · pagadas
  ('00000003-0000-4000-8000-0000fac26008', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e2', NULL,
   'FV-2026-008', 'COP', 3193277.31, 606722.69, 351260.50, 3800000.00, DATE '2026-07-20', DATE '2026-08-19', 'paid', 3800000.00, '2026-08-05 15:00:00+00', 0, NULL, 'FE-26-0008'),
  ('00000003-0000-4000-8000-0000fac26009', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e4', '00000003-0000-4000-8000-000000ca0003',
   'FV-2026-009', 'COP', 3949579.83, 750420.17, 434453.78, 4700000.00, DATE '2026-07-27', DATE '2026-08-26', 'paid', 4700000.00, '2026-08-20 15:00:00+00', 0, NULL, 'FE-26-0009'),
  -- 2026 · abiertas al día (fechas relativas)
  ('00000003-0000-4000-8000-0000fac26010', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e1', '00000003-0000-4000-8000-000000ca0001',
   'FV-2026-010', 'COP', 2605042.02, 494957.98, 286554.62, 3100000.00, CURRENT_DATE - 23, CURRENT_DATE + 7, 'sent', 0.00, NULL, 0, NULL, 'FE-26-0010'),
  ('00000003-0000-4000-8000-0000fac26011', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e2', '00000003-0000-4000-8000-000000ca0002',
   'FV-2026-011', 'COP', 4369747.90, 830252.10, 480672.27, 5200000.00, CURRENT_DATE - 7, CURRENT_DATE + 23, 'sent', 0.00, NULL, 0, NULL, 'FE-26-0011')
ON CONFLICT (id) DO UPDATE SET
  company_id = EXCLUDED.company_id, campaign_id = EXCLUDED.campaign_id, number = EXCLUDED.number, currency = EXCLUDED.currency,
  subtotal = EXCLUDED.subtotal, tax = EXCLUDED.tax, withholding = EXCLUDED.withholding, total = EXCLUDED.total,
  issued_on = EXCLUDED.issued_on, due_on = EXCLUDED.due_on, status = EXCLUDED.status, paid_amount = EXCLUDED.paid_amount,
  paid_at = EXCLUDED.paid_at, reminders_sent = EXCLUDED.reminders_sent, last_reminder_at = EXCLUDED.last_reminder_at,
  external_ref = EXCLUDED.external_ref;


-- =====================================================================
-- 6 · Cobros (payment, direction = 'in') y apartado de impuestos
-- ---------------------------------------------------------------------
-- Un cobro por factura pagada, por el total. Cobrado en 2026: 38,6 M;
-- en 2025: 29,5 M. Cada cobro aparta el 11 % en tax_reserve; la suma de
-- 2026 es 4 246 000 (el mock muestra "COP 4,2 M" con un decimal). Las
-- reservas de 2025 ya están liberadas (released_at); las de 2026, no.
-- Append-only: ON CONFLICT DO NOTHING.
-- =====================================================================
INSERT INTO payment (id, workspace_id, invoice_id, direction, amount, currency, method, received_at, reference, notes)
SELECT p.id, '00000002-0000-4000-8000-000000000001', p.invoice_id, 'in', p.amount, 'COP', 'transferencia', p.received_at, p.reference, NULL
FROM (VALUES
  ('00000003-0000-4000-8000-0000c0b25001'::uuid, '00000003-0000-4000-8000-0000fac25001'::uuid, 3700000.00, '2025-02-05 15:00:00+00'::timestamptz, 'TRF-250205-CAFEALMA'),
  ('00000003-0000-4000-8000-0000c0b25002'::uuid, '00000003-0000-4000-8000-0000fac25002'::uuid, 4600000.00, '2025-03-28 15:00:00+00'::timestamptz, 'TRF-250328-NUTRIVE'),
  ('00000003-0000-4000-8000-0000c0b25003'::uuid, '00000003-0000-4000-8000-0000fac25003'::uuid, 5200000.00, '2025-05-09 15:00:00+00'::timestamptz, 'TRF-250509-FRESKO'),
  ('00000003-0000-4000-8000-0000c0b25004'::uuid, '00000003-0000-4000-8000-0000fac25004'::uuid, 4700000.00, '2025-06-25 15:00:00+00'::timestamptz, 'TRF-250625-HOGARLINDO'),
  ('00000003-0000-4000-8000-0000c0b25005'::uuid, '00000003-0000-4000-8000-0000fac25005'::uuid, 5500000.00, '2025-08-01 15:00:00+00'::timestamptz, 'TRF-250801-CAFEALMA'),
  ('00000003-0000-4000-8000-0000c0b25006'::uuid, '00000003-0000-4000-8000-0000fac25006'::uuid, 5800000.00, '2025-09-10 15:00:00+00'::timestamptz, 'TRF-250910-NUTRIVE'),
  ('00000003-0000-4000-8000-0000c0b26001'::uuid, '00000003-0000-4000-8000-0000fac26001'::uuid, 4700000.00, '2026-01-28 15:00:00+00'::timestamptz, 'TRF-260128-CAFEALMA'),
  ('00000003-0000-4000-8000-0000c0b26002'::uuid, '00000003-0000-4000-8000-0000fac26002'::uuid, 5500000.00, '2026-02-25 15:00:00+00'::timestamptz, 'TRF-260225-NUTRIVE'),
  ('00000003-0000-4000-8000-0000c0b26003'::uuid, '00000003-0000-4000-8000-0000fac26003'::uuid, 6200000.00, '2026-03-30 15:00:00+00'::timestamptz, 'TRF-260330-FRESKO'),
  ('00000003-0000-4000-8000-0000c0b26004'::uuid, '00000003-0000-4000-8000-0000fac26004'::uuid, 3700000.00, '2026-04-29 15:00:00+00'::timestamptz, 'TRF-260429-HOGARLINDO'),
  ('00000003-0000-4000-8000-0000c0b26005'::uuid, '00000003-0000-4000-8000-0000fac26005'::uuid, 5900000.00, '2026-05-20 15:00:00+00'::timestamptz, 'TRF-260520-CAFEALMA'),
  ('00000003-0000-4000-8000-0000c0b26006'::uuid, '00000003-0000-4000-8000-0000fac26006'::uuid, 4100000.00, '2026-07-08 15:00:00+00'::timestamptz, 'TRF-260708-CAFEALMA'),
  ('00000003-0000-4000-8000-0000c0b26008'::uuid, '00000003-0000-4000-8000-0000fac26008'::uuid, 3800000.00, '2026-08-05 15:00:00+00'::timestamptz, 'TRF-260805-FRESKO'),
  ('00000003-0000-4000-8000-0000c0b26009'::uuid, '00000003-0000-4000-8000-0000fac26009'::uuid, 4700000.00, '2026-08-20 15:00:00+00'::timestamptz, 'TRF-260820-NUTRIVE')
) AS p(id, invoice_id, amount, received_at, reference)
ON CONFLICT (id) DO NOTHING;

INSERT INTO tax_reserve (id, workspace_id, payment_id, rate, amount, currency, period, released_at)
SELECT r.id, '00000002-0000-4000-8000-000000000001', r.payment_id, 0.1100, r.amount, 'COP', r.period, r.released_at
FROM (VALUES
  ('00000003-0000-4000-8000-0000ade25001'::uuid, '00000003-0000-4000-8000-0000c0b25001'::uuid, 407000.00, '2025-Q1', '2025-04-20 12:00:00+00'::timestamptz),
  ('00000003-0000-4000-8000-0000ade25002'::uuid, '00000003-0000-4000-8000-0000c0b25002'::uuid, 506000.00, '2025-Q1', '2025-04-20 12:00:00+00'::timestamptz),
  ('00000003-0000-4000-8000-0000ade25003'::uuid, '00000003-0000-4000-8000-0000c0b25003'::uuid, 572000.00, '2025-Q2', '2025-07-20 12:00:00+00'::timestamptz),
  ('00000003-0000-4000-8000-0000ade25004'::uuid, '00000003-0000-4000-8000-0000c0b25004'::uuid, 517000.00, '2025-Q2', '2025-07-20 12:00:00+00'::timestamptz),
  ('00000003-0000-4000-8000-0000ade25005'::uuid, '00000003-0000-4000-8000-0000c0b25005'::uuid, 605000.00, '2025-Q3', '2025-10-20 12:00:00+00'::timestamptz),
  ('00000003-0000-4000-8000-0000ade25006'::uuid, '00000003-0000-4000-8000-0000c0b25006'::uuid, 638000.00, '2025-Q3', '2025-10-20 12:00:00+00'::timestamptz),
  ('00000003-0000-4000-8000-0000ade26001'::uuid, '00000003-0000-4000-8000-0000c0b26001'::uuid, 517000.00, '2026-Q1', NULL),
  ('00000003-0000-4000-8000-0000ade26002'::uuid, '00000003-0000-4000-8000-0000c0b26002'::uuid, 605000.00, '2026-Q1', NULL),
  ('00000003-0000-4000-8000-0000ade26003'::uuid, '00000003-0000-4000-8000-0000c0b26003'::uuid, 682000.00, '2026-Q1', NULL),
  ('00000003-0000-4000-8000-0000ade26004'::uuid, '00000003-0000-4000-8000-0000c0b26004'::uuid, 407000.00, '2026-Q2', NULL),
  ('00000003-0000-4000-8000-0000ade26005'::uuid, '00000003-0000-4000-8000-0000c0b26005'::uuid, 649000.00, '2026-Q2', NULL),
  ('00000003-0000-4000-8000-0000ade26006'::uuid, '00000003-0000-4000-8000-0000c0b26006'::uuid, 451000.00, '2026-Q3', NULL),
  ('00000003-0000-4000-8000-0000ade26008'::uuid, '00000003-0000-4000-8000-0000c0b26008'::uuid, 418000.00, '2026-Q3', NULL),
  ('00000003-0000-4000-8000-0000ade26009'::uuid, '00000003-0000-4000-8000-0000c0b26009'::uuid, 517000.00, '2026-Q3', NULL)
) AS r(id, payment_id, amount, period, released_at)
ON CONFLICT (id) DO NOTHING;


-- =====================================================================
-- 7 · Gastos
-- ---------------------------------------------------------------------
-- Cinco recurrentes mensuales (3,7 M/mes ≈ 0,85 M/semana), registrados
-- en julio, agosto y septiembre de 2026, más dos puntuales. Con el 11 %
-- de reserva sobre los cobros esperados, "Gastos e impuestos" del flujo
-- de caja queda entre 1,1 y 1,7 M por semana, como el mock.
-- =====================================================================
INSERT INTO expense (id, workspace_id, category, vendor, description, amount, currency, incurred_on, is_recurring, recurrence, deductible)
SELECT e.id, '00000002-0000-4000-8000-000000000001', e.category, e.vendor, e.description, e.amount, 'COP', e.incurred_on, e.is_recurring, e.recurrence, true
FROM (VALUES
  -- julio
  ('00000003-0000-4000-8000-0009a5070001'::uuid, 'edicion',      'Mateo R. (freelance)',           'Edición de video · julio',           1800000.00, DATE '2026-07-01', true,  'monthly'),
  ('00000003-0000-4000-8000-0009a5070002'::uuid, 'software',     'Adobe · CapCut · Notion · Canva', 'Suscripciones · julio',              380000.00, DATE '2026-07-01', true,  'monthly'),
  ('00000003-0000-4000-8000-0009a5070003'::uuid, 'equipo',       'Estudio La Loma',                'Alquiler de estudio y luces · julio', 900000.00, DATE '2026-07-01', true,  'monthly'),
  ('00000003-0000-4000-8000-0009a5070004'::uuid, 'contabilidad', 'Contadora (Diana P.)',           'Contabilidad · julio',                400000.00, DATE '2026-07-01', true,  'monthly'),
  ('00000003-0000-4000-8000-0009a5070005'::uuid, 'servicios',    'Claro',                          'Internet y telefonía · julio',        220000.00, DATE '2026-07-01', true,  'monthly'),
  ('00000003-0000-4000-8000-0009a5070101'::uuid, 'equipo',       'DJI',                            'Micrófono inalámbrico DJI Mic 2',     890000.00, DATE '2026-07-14', false, NULL),
  -- agosto
  ('00000003-0000-4000-8000-0009a5080001'::uuid, 'edicion',      'Mateo R. (freelance)',           'Edición de video · agosto',          1800000.00, DATE '2026-08-01', true,  'monthly'),
  ('00000003-0000-4000-8000-0009a5080002'::uuid, 'software',     'Adobe · CapCut · Notion · Canva', 'Suscripciones · agosto',             380000.00, DATE '2026-08-01', true,  'monthly'),
  ('00000003-0000-4000-8000-0009a5080003'::uuid, 'equipo',       'Estudio La Loma',                'Alquiler de estudio y luces · agosto', 900000.00, DATE '2026-08-01', true, 'monthly'),
  ('00000003-0000-4000-8000-0009a5080004'::uuid, 'contabilidad', 'Contadora (Diana P.)',           'Contabilidad · agosto',               400000.00, DATE '2026-08-01', true,  'monthly'),
  ('00000003-0000-4000-8000-0009a5080005'::uuid, 'servicios',    'Claro',                          'Internet y telefonía · agosto',       220000.00, DATE '2026-08-01', true,  'monthly'),
  ('00000003-0000-4000-8000-0009a5080101'::uuid, 'viajes',       'Transporte y alojamiento',       'Grabación en la finca de Café Alma',  460000.00, DATE '2026-08-06', false, NULL),
  -- septiembre
  ('00000003-0000-4000-8000-0009a5090001'::uuid, 'edicion',      'Mateo R. (freelance)',           'Edición de video · septiembre',      1800000.00, DATE '2026-09-01', true,  'monthly'),
  ('00000003-0000-4000-8000-0009a5090002'::uuid, 'software',     'Adobe · CapCut · Notion · Canva', 'Suscripciones · septiembre',         380000.00, DATE '2026-09-01', true,  'monthly'),
  ('00000003-0000-4000-8000-0009a5090003'::uuid, 'equipo',       'Estudio La Loma',                'Alquiler de estudio y luces · septiembre', 900000.00, DATE '2026-09-01', true, 'monthly'),
  ('00000003-0000-4000-8000-0009a5090004'::uuid, 'contabilidad', 'Contadora (Diana P.)',           'Contabilidad · septiembre',           400000.00, DATE '2026-09-01', true,  'monthly'),
  ('00000003-0000-4000-8000-0009a5090005'::uuid, 'servicios',    'Claro',                          'Internet y telefonía · septiembre',   220000.00, DATE '2026-09-01', true,  'monthly')
) AS e(id, category, vendor, description, amount, incurred_on, is_recurring, recurrence)
ON CONFLICT (id) DO UPDATE SET
  category = EXCLUDED.category, vendor = EXCLUDED.vendor, description = EXCLUDED.description, amount = EXCLUDED.amount,
  currency = EXCLUDED.currency, incurred_on = EXCLUDED.incurred_on, is_recurring = EXCLUDED.is_recurring,
  recurrence = EXCLUDED.recurrence, deductible = EXCLUDED.deductible;

-- =====================================================================
-- Consentimiento delegado (ACC-8): el mánager de la demo
-- ---------------------------------------------------------------------
-- Andrés Pardo es el mánager de Laura (membership 'admin': hasta ACC-3
-- es el rol que lleva conexiones.cuenta.conectar). Conectó él la cuenta
-- de Instagram de Laura: el consentimiento queda a nombre de Laura con
-- Andrés en evidence.actedBy (evidencia v2), Laura tiene el aviso
-- connection_added (0034) sin leer, y /conexiones dice «Conectada por
-- Andrés Pardo el …». Es lo que hace visible ACC-8 en dev con el seed.
-- Ids fijos y ON CONFLICT DO NOTHING: el verificador exige idempotencia.
--
-- app_user y membership solo admiten la fila PROPIA (0025 §4 y 0028):
-- la sesión pasa a ser Andrés para darlo de alta y vuelve a ser Laura
-- (que fijó 0002) para el resto.
-- =====================================================================
SELECT set_config('app.user_id', '00000002-0000-4000-8000-000000000004', false);

INSERT INTO app_user (id, email, name, locale)
VALUES ('00000002-0000-4000-8000-000000000004', 'andres@ejemplo.com', 'Andrés Pardo', 'es-CO')
ON CONFLICT DO NOTHING;

INSERT INTO membership (workspace_id, user_id, role)
VALUES ('00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000004', 'admin')
ON CONFLICT DO NOTHING;

SELECT set_config('app.user_id', '00000002-0000-4000-8000-000000000002', false);

INSERT INTO data_consent (id, workspace_id, creator_id, connection_id, purpose, granted, granted_at, policy_version, evidence)
VALUES (
  '00000003-0000-4000-8000-0000ac080001', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000003',
  '00000002-0000-4000-8000-0000000000c1', 'analytics', true, now() - interval '140 days', '2026-09-22',
  jsonb_build_object(
    'v', 2, 'method', 'oauth', 'declaredOwner', false, 'ipHash', NULL, 'userAgent', 'seed',
    'textShown', 'Texto de consentimiento de la demo.', 'policyVersion', '2026-09-22',
    'at', to_char(now() - interval '140 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'onBehalfOf', jsonb_build_object('creatorId', '00000002-0000-4000-8000-000000000003'),
    'actedBy', jsonb_build_object('userId', '00000002-0000-4000-8000-000000000004', 'email', 'andres@ejemplo.com', 'roleKey', 'admin')
  )
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO notification (id, workspace_id, user_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url, created_at)
VALUES (
  '00000003-0000-4000-8000-0000ac080002', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000002',
  'connection_added', 'info', 'Una cuenta se conectó en tu nombre',
  'Andrés Pardo conectó la cuenta @laura.cocinafacil de Instagram el ' || to_char(now() - interval '140 days', 'DD/MM/YYYY') || ' en tu nombre. Puedes quitarla cuando quieras desde Cuentas.',
  'social_connection', '00000002-0000-4000-8000-0000000000c1', '/conexiones', now() - interval '140 days'
)
ON CONFLICT (id) DO NOTHING;
