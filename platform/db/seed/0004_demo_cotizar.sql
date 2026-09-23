-- =====================================================================
-- Seed 4 · Cotizar de la creadora de demostración (CIM-6, COT-1 a COT-4).
-- ---------------------------------------------------------------------
-- La demo contaba una historia que Cotizar contradecía: el pipeline de
-- 0002 tiene negocios en «Propuesta enviada» y «Negociación» (Fresko
-- con «Seguimiento a la cotización», Vitalé, Sabores Caseros, Nutrivé) y
-- cuatro ganados con campaña, pero /cotizar decía «Tu tarifario todavía
-- no está guardado» y «Todavía no has cotizado nada». Este seed pone lo
-- que falta, con la misma línea de tiempo que 0002 y 0003:
--
--   * un tarifario guardado (v1) con los rangos que da la fórmula de
--     @mc/core sobre la línea base del seed (TikTok, Reel, 3 historias,
--     YouTube y un paquete de lanzamiento con −10 %);
--   * un media kit público, congelado el 22-sep-2026;
--   * ocho cotizaciones, COT-2026-001 … 008, una por negocio en
--     propuesta, negociación o ganado con campaña, con quote.deal_id y
--     campaign.quote_id enlazados.
--
-- La convención de montos (0031, CAM-2 y la sección 10 de 0002) es la
-- que este seed hace visible en las tres pantallas:
--   deal.amount     = quote.total − quote.tax  (el NETO: subtotal − descuento)
--   campaign.amount = quote.total              (con IVA: lo que se cobra)
--   invoice         = subtotal (neto) + tax → total (el de la campaña)
-- Las cuatro aceptadas cuadran al peso con las facturas de 0003
-- (FV-2026-007, 009, 010 y 011): el IVA del 19 % sobre el neto da el
-- total redondo de la campaña. Las abiertas llevan como neto el monto
-- que el negocio tiene en 0002, que es lo que enviar una cotización
-- deja en el negocio (sendQuote → deal_move_stage).
--
-- Reglas del archivo (las de 0002):
--   * Idempotente. UUID fijos y ON CONFLICT (id). Lo que ya PASÓ (las
--     aceptadas, sus fechas y sus entregables, el tarifario, el media
--     kit) se congela en la primera corrida con DO NOTHING. Lo que la
--     demo MIRA HOY de las abiertas —hasta cuándo valen y la ventana de
--     campaña que proponen— se refresca con DO UPDATE mientras sigan
--     enviadas o vistas, para que una base sembrada dentro de dos
--     meses no enseñe cuatro cotizaciones vencidas.
--   * No pisa lo de nadie. El tarifario solo entra si la creadora no
--     tiene ninguno (UNIQUE (creator_id, version) de 0008), y una
--     cotización solo entra si su número no lo tomó ya otra fila del
--     workspace (UNIQUE (workspace_id, number)): `make db.seed` contra
--     un Supabase donde alguien ya cotizó no falla ni duplica.
--   * Los slugs de los enlaces públicos NO van en el archivo: son la
--     credencial del enlace (enlace.ts) y el repositorio es público.
--     Se sortean en la primera corrida con gen_random_uuid() y un
--     alfabeto sin 0 ni 1, como nuevoSlug(); después no cambian.
--   * Requiere el esquema de 0030 (tax_rate, public_snapshot, ventana de
--     campaña, firmante): se siembra después de aplicar 0024–0031.
--
-- Mapa de identificadores (00000004-…, solo dígitos hexadecimales):
--   …-0000007a1f01          rate_card          (7a1f = tarifa)
--   …-0000007a1f11..15      rate_card_item
--   …-000000d0c001          media_kit          (d0c = documento)
--   …-0000000c0701..0708    quote              (c07 = cotización; 07NN = COT-…-0NN)
--   …-0000c07NNNII          quote_item         (NNN = cotización, II = línea)
-- =====================================================================

SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);
SELECT set_config('app.user_id', '00000002-0000-4000-8000-000000000002', false);
SELECT set_config('TimeZone', 'UTC', false);


-- =====================================================================
-- 1 · El tarifario guardado (COT-1)
-- ---------------------------------------------------------------------
-- basis es lo que la creadora decidió en la pantalla: 13 000 views por
-- historia escritas a mano (no se miden historias, D4) y un paquete de
-- lanzamiento. Los ítems y sus pasos son los que guardarTarifario()
-- calcula con esa basis y la línea base del seed, tal cual: salen de
-- calcularItem / calcularPaquete de @mc/core, con el rango final a tres
-- cifras (redondearParaNegociar: 5.195.070 → 5.200.000) y su paso
-- «redondeo» en el «Cómo se calcula». Si la fórmula cambia, se
-- regeneran: packages/db/test/cotizar.test.ts los vuelve a calcular
-- desde sus entradas y falla si no coinciden (pulido r8).
-- =====================================================================
INSERT INTO rate_card (id, workspace_id, creator_id, currency, version, is_current, computed_at, basis)
SELECT '00000004-0000-4000-8000-0000007a1f01', '00000002-0000-4000-8000-000000000001',
       '00000002-0000-4000-8000-000000000003', 'COP', 1, true, '2026-09-22 11:00:00+00',
       '{"viewsManuales": {"historias": 13000}, "modificadores": [], "precios": {}, "cpm": {}, "paquetes": [{"id": "lanzamiento", "componentes": {"tiktok": 1, "reel": 1, "historias": 1}, "descuentoPct": "0.10"}]}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM rate_card
   WHERE creator_id = '00000002-0000-4000-8000-000000000003'
     AND id <> '00000004-0000-4000-8000-0000007a1f01'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO rate_card_item (id, rate_card_id, deliverable, platform_id, label_es, price_low, price_high, avg_views, cpm_low, cpm_high, adjustments, overridden, position)
SELECT v.id::uuid, v.rate_card_id::uuid, v.deliverable, v.platform_id, v.label_es, v.price_low, v.price_high,
       v.avg_views, v.cpm_low, v.cpm_high, v.adjustments, v.overridden, v.position
FROM (VALUES
  ('00000004-0000-4000-8000-0000007a1f11', '00000004-0000-4000-8000-0000007a1f01', 'tiktok', 'tiktok', 'TikTok dedicado', 5200000.00, 8080000.00, 115446, 45000.00, 70000.00, '{"pasos": [{"tipo": "views", "views": 115446, "cantidad": 1, "fuente": "baseline", "muestra": 17, "corteHoras": 168}, {"tipo": "cpm", "cpmLow": "45000.00", "cpmHigh": "70000.00", "fuente": "manual", "nicheSlug": "cocina", "country": "CO", "platformId": "tiktok"}, {"tipo": "base", "low": "5195070.00", "high": "8081220.00"}, {"tipo": "redondeo", "exactoLow": "5195070.00", "exactoHigh": "8081220.00", "low": "5200000.00", "high": "8080000.00"}, {"tipo": "total", "low": "5200000.00", "high": "8080000.00"}], "cantidad": 1, "viewsSource": "baseline", "cpmSource": "manual", "modificadores": []}'::jsonb, false, 0),
  ('00000004-0000-4000-8000-0000007a1f12', '00000004-0000-4000-8000-0000007a1f01', 'reel', 'instagram', 'Reel de Instagram', 3420000.00, 5290000.00, 62177, 55000.00, 85000.00, '{"pasos": [{"tipo": "views", "views": 62177, "cantidad": 1, "fuente": "baseline", "muestra": 16, "corteHoras": 168}, {"tipo": "cpm", "cpmLow": "55000.00", "cpmHigh": "85000.00", "fuente": "manual", "nicheSlug": "cocina", "country": "CO", "platformId": "instagram"}, {"tipo": "base", "low": "3419735.00", "high": "5285045.00"}, {"tipo": "redondeo", "exactoLow": "3419735.00", "exactoHigh": "5285045.00", "low": "3420000.00", "high": "5290000.00"}, {"tipo": "total", "low": "3420000.00", "high": "5290000.00"}], "cantidad": 1, "viewsSource": "baseline", "cpmSource": "manual", "modificadores": []}'::jsonb, false, 1),
  ('00000004-0000-4000-8000-0000007a1f13', '00000004-0000-4000-8000-0000007a1f01', 'historias', 'instagram', 'Historias (3)', 2150000.00, 3320000.00, 13000, 55000.00, 85000.00, '{"pasos": [{"tipo": "views", "views": 13000, "cantidad": 3, "fuente": "manual"}, {"tipo": "cpm", "cpmLow": "55000.00", "cpmHigh": "85000.00", "fuente": "manual", "nicheSlug": "cocina", "country": "CO", "platformId": "instagram"}, {"tipo": "base", "low": "715000.00", "high": "1105000.00"}, {"tipo": "cantidad", "cantidad": 3, "low": "2145000.00", "high": "3315000.00"}, {"tipo": "redondeo", "exactoLow": "2145000.00", "exactoHigh": "3315000.00", "low": "2150000.00", "high": "3320000.00"}, {"tipo": "total", "low": "2150000.00", "high": "3320000.00"}], "cantidad": 3, "viewsSource": "manual", "cpmSource": "manual", "modificadores": []}'::jsonb, false, 2),
  ('00000004-0000-4000-8000-0000007a1f14', '00000004-0000-4000-8000-0000007a1f01', 'youtube', 'youtube', 'Video en YouTube', 2480000.00, 3920000.00, 41310, 60000.00, 95000.00, '{"pasos": [{"tipo": "views", "views": 41310, "cantidad": 1, "fuente": "baseline", "muestra": 11, "corteHoras": 168}, {"tipo": "cpm", "cpmLow": "60000.00", "cpmHigh": "95000.00", "fuente": "manual", "nicheSlug": "cocina", "country": "CO", "platformId": "youtube"}, {"tipo": "base", "low": "2478600.00", "high": "3924450.00"}, {"tipo": "redondeo", "exactoLow": "2478600.00", "exactoHigh": "3924450.00", "low": "2480000.00", "high": "3920000.00"}, {"tipo": "total", "low": "2480000.00", "high": "3920000.00"}], "cantidad": 1, "viewsSource": "baseline", "cpmSource": "manual", "modificadores": []}'::jsonb, false, 3),
  ('00000004-0000-4000-8000-0000007a1f15', '00000004-0000-4000-8000-0000007a1f01', 'paquete-lanzamiento', NULL, 'Paquete: 1 × TikTok dedicado + 1 × Reel de Instagram + 1 × Historias (3)', 9690000.00, 15000000.00, NULL, NULL, NULL, '{"pasos": [{"tipo": "componente", "deliverable": "tiktok", "cantidad": 1, "low": "5200000.00", "high": "8080000.00"}, {"tipo": "componente", "deliverable": "reel", "cantidad": 1, "low": "3420000.00", "high": "5290000.00"}, {"tipo": "componente", "deliverable": "historias", "cantidad": 1, "low": "2150000.00", "high": "3320000.00"}, {"tipo": "subtotal", "low": "10770000.00", "high": "16690000.00"}, {"tipo": "descuento", "pct": "0.1", "low": "1077000.00", "high": "1669000.00"}, {"tipo": "redondeo", "exactoLow": "9693000.00", "exactoHigh": "15021000.00", "low": "9690000.00", "high": "15000000.00"}, {"tipo": "total", "low": "9690000.00", "high": "15000000.00"}], "componentes": [{"deliverable": "tiktok", "cantidad": 1, "priceLow": "5200000.00", "priceHigh": "8080000.00"}, {"deliverable": "reel", "cantidad": 1, "priceLow": "3420000.00", "priceHigh": "5290000.00"}, {"deliverable": "historias", "cantidad": 1, "priceLow": "2150000.00", "priceHigh": "3320000.00"}], "descuentoPct": "0.1", "modificadores": []}'::jsonb, false, 4)
) AS v(id, rate_card_id, deliverable, platform_id, label_es, price_low, price_high, avg_views, cpm_low, cpm_high, adjustments, overridden, position)
WHERE EXISTS (SELECT 1 FROM rate_card WHERE id = '00000004-0000-4000-8000-0000007a1f01')
ON CONFLICT (id) DO NOTHING;


-- =====================================================================
-- 2 · El media kit (COT-2)
-- ---------------------------------------------------------------------
-- Congelado el 22-sep-2026, después del tarifario (sus tarifas son las
-- de la sección 1). Es un documento: no cambia al volver a sembrar,
-- como no cambia uno que la creadora generó y ya mandó.
--
-- Se escribe a mano porque la demo es relativa al reloj y el kit está
-- fechado, pero con las reglas de buildMediaKitSnapshot (pulido r8):
--   * el «N× su mediana» de cada post es round(views / mediana, 1)
--     contra la mediana que el MISMO kit publica de su red (62.177 en
--     Instagram, 115.446 en TikTok): 395.810 / 115.446 = 3,4×;
--   * las tarifas son las de la sección 1, ya redondeadas a tres cifras.
-- verify/0004.sql (g, h) y packages/db/test/cotizar.test.ts lo exigen.
-- =====================================================================
INSERT INTO media_kit (id, workspace_id, creator_id, rate_card_id, slug, snapshot, theme, is_public, created_at)
SELECT '00000004-0000-4000-8000-000000d0c001', '00000002-0000-4000-8000-000000000001',
       '00000002-0000-4000-8000-000000000003',
       (SELECT id FROM rate_card WHERE id = '00000004-0000-4000-8000-0000007a1f01'),
       translate(substr(replace(gen_random_uuid()::text, '-', ''), 1, 26), '01', 'mn'),
       '{"version": 2, "capturedAt": "2026-09-22T12:00:00.000Z", "creator": {"displayName": "Laura Méndez", "handle": "laura.cocinafacil", "bio": "Cocina fácil para más de 400 mil personas en Colombia. Recetas de menos de diez minutos con lo que ya tienes en casa.", "country": "CO", "nicheSlugs": ["cocina"]}, "currency": "COP", "locale": "es-CO", "timezone": "America/Bogota", "redes": [{"platformId": "facebook", "handle": "lauracocinafacil", "followers": 21000, "followersAsOf": "2026-09-22", "medianViews": 19698, "engagement": "0.067243", "sampleSize": 10, "isReliable": true}, {"platformId": "instagram", "handle": "laura.cocinafacil", "followers": 128000, "followersAsOf": "2026-09-22", "medianViews": 62177, "engagement": "0.070793", "sampleSize": 16, "isReliable": true}, {"platformId": "tiktok", "handle": "laura.cocinafacil", "followers": 214000, "followersAsOf": "2026-09-22", "medianViews": 115446, "engagement": "0.068798", "sampleSize": 17, "isReliable": true}, {"platformId": "youtube", "handle": "LauraCocinaFacil", "followers": 49000, "followersAsOf": "2026-09-22", "medianViews": 41310, "engagement": "0.068786", "sampleSize": 11, "isReliable": true}], "totales": {"followers": 412000, "medianViewsMax": 115446, "medianViewsMaxPlatform": "tiktok"}, "topPosts": [{"platformId": "instagram", "url": "https://www.instagram.com/reel/demo-d01/", "caption": "Cold brew en casa en 3 pasos ☕ Con @cafealma · código LAURA15", "publishedAt": "2026-08-10T17:00:00.000Z", "views": 417673, "viewsVsMedian": "6.7"}, {"platformId": "tiktok", "url": "https://www.tiktok.com/@laura.cocinafacil/video/demo-d06", "caption": "Reto: arepa sin plancha y sin que se pegue. Sí se puede 🫓 #arepa #recetafacil #sinplancha", "publishedAt": "2026-09-19T19:00:00.000Z", "views": 395810, "viewsVsMedian": "3.4"}, {"platformId": "tiktok", "url": "https://www.tiktok.com/@laura.cocinafacil/video/demo-d02", "caption": "El cold brew que me salva las mañanas 🧊 #ad @cafealma.co", "publishedAt": "2026-08-12T16:30:00.000Z", "views": 303685, "viewsVsMedian": "2.6"}, {"platformId": "tiktok", "url": "https://www.tiktok.com/@laura.cocinafacil/video/demo-d07", "caption": "El error que arruina tu arroz (y lo cometemos todos) 🍚 #arroz #cocinafacil #truco", "publishedAt": "2026-09-11T19:00:00.000Z", "views": 238829, "viewsVsMedian": "2.1"}, {"platformId": "tiktok", "url": "https://www.tiktok.com/@laura.cocinafacil/video/demo-d16", "caption": "Buñuelos que no se abren en el aceite: la masa correcta 🟠 #bunuelos #cocinacolombiana #truco", "publishedAt": "2026-07-01T19:00:00.000Z", "views": 215117, "viewsVsMedian": "1.9"}, {"platformId": "instagram", "url": "https://www.instagram.com/reel/demo-d18/", "caption": "Tres desayunos con dos ingredientes cada uno. Guárdalo para mañana 🍳 #desayuno #recetafacil #dosingredientes", "publishedAt": "2026-09-14T19:00:00.000Z", "views": 166861, "viewsVsMedian": "2.7"}], "audiencia": [{"platformId": "tiktok", "dimension": "age", "buckets": [{"bucket": "13-17", "share": "0.040000"}, {"bucket": "18-24", "share": "0.340000"}, {"bucket": "25-34", "share": "0.370000"}, {"bucket": "35-44", "share": "0.150000"}, {"bucket": "45-54", "share": "0.070000"}, {"bucket": "55+", "share": "0.030000"}]}, {"platformId": "tiktok", "dimension": "gender", "buckets": [{"bucket": "F", "share": "0.610000"}, {"bucket": "M", "share": "0.390000"}]}, {"platformId": "tiktok", "dimension": "country", "buckets": [{"bucket": "CO", "share": "0.690000"}, {"bucket": "MX", "share": "0.130000"}, {"bucket": "US", "share": "0.060000"}, {"bucket": "ES", "share": "0.040000"}, {"bucket": "PE", "share": "0.030000"}, {"bucket": "EC", "share": "0.020000"}, {"bucket": "OTHER", "share": "0.030000"}]}], "tarifas": [{"labelEs": "TikTok dedicado", "platformId": "tiktok", "priceLow": "5200000.00", "priceHigh": "8080000.00"}, {"labelEs": "Reel de Instagram", "platformId": "instagram", "priceLow": "3420000.00", "priceHigh": "5290000.00"}, {"labelEs": "Historias (3)", "platformId": "instagram", "priceLow": "2150000.00", "priceHigh": "3320000.00"}, {"labelEs": "Video en YouTube", "platformId": "youtube", "priceLow": "2480000.00", "priceHigh": "3920000.00"}, {"labelEs": "Paquete: 1 × TikTok dedicado + 1 × Reel de Instagram + 1 × Historias (3)", "platformId": null, "priceLow": "9690000.00", "priceHigh": "15000000.00"}], "tarifasIncluyen": []}'::jsonb,
       'studio', true, '2026-09-22 12:00:00+00'
ON CONFLICT (id) DO NOTHING;


-- =====================================================================
-- 3 · Las cotizaciones (COT-3, COT-4)
-- ---------------------------------------------------------------------
--   001 Hogar Lindo     · 3 historias · jun        aceptada (panel)  → ca0004 · FV-2026-007
--   002 Nutrivé         · Video dedicado · julio   aceptada (panel)  → ca0003 · FV-2026-009
--   003 Café Alma       · Lanzamiento cold brew    aceptada (enlace) → ca0001 · FV-2026-010
--   004 Fresko Market   · 2 TikTok · septiembre    aceptada (enlace) → ca0002 · FV-2026-011
--   005 Fresko Market   · Lanzamiento desayunos    vista    (propuesta,   14,2 M neto)
--   006 Sabores Caseros · Paquete + exclusividad   vista    (negociación, 16 M neto)
--   007 Vitalé          · 2 Reels + derechos 90 d  enviada  (propuesta,   9,8 M neto)
--   008 Nutrivé         · 1 TikTok + 1 Short       vista    (negociación, 6,5 M neto; sin fechas)
-- Las fechas siguen la historia de etapas de 0002: se envía el día en
-- que el negocio entró en «Propuesta enviada» y se acepta el día en que
-- se ganó. 005 y 006 son fijas (2 y 5 sep, como sus actividades); 007
-- y 008 son relativas, como sus negocios, y su número lleva el año de
-- ese envío.
-- =====================================================================
INSERT INTO quote (id, workspace_id, deal_id, company_id, creator_id, number, slug, currency,
                   subtotal, discount, tax, total, tax_rate, agreed_metrics, report_cuts_hours,
                   usage_rights_days, exclusivity_days, exclusivity_scope, payment_terms_days,
                   campaign_starts_on, campaign_ends_on, status, valid_until,
                   sent_at, viewed_at, accepted_at, accepted_by_name, accepted_by_email, view_count, created_at)
SELECT v.id, '00000002-0000-4000-8000-000000000001', v.deal_id, v.company_id, '00000002-0000-4000-8000-000000000003',
       v.number, translate(substr(replace(gen_random_uuid()::text, '-', ''), 1, 26), '01', 'mn'), 'COP',
       v.subtotal, 0, v.tax, v.subtotal + v.tax, 0.19, v.metrics, '{24,168,720}',
       v.usage_rights_days, v.exclusivity_days, v.exclusivity_scope, 30,
       v.starts_on, v.ends_on, v.status, v.valid_until,
       v.sent_at, v.viewed_at, v.accepted_at, v.signer_name, v.signer_email, v.view_count, v.sent_at - interval '1 day'
FROM (VALUES
  ('00000004-0000-4000-8000-0000000c0701'::uuid, '00000002-0000-4000-8000-0000000dea12'::uuid, '00000002-0000-4000-8000-0000000000e3'::uuid,
   'COT-2026-001', 924369.75::numeric, 175630.25::numeric, '{views,reach,code_redemptions}'::text[],
   NULL::int, NULL::int, NULL::text, DATE '2026-06-05', DATE '2026-06-06', 'accepted', DATE '2026-06-10',
   '2026-05-26 15:00:00+00'::timestamptz, '2026-05-27 13:00:00+00'::timestamptz, '2026-06-01 15:00:00+00'::timestamptz,
   NULL::text, NULL::text, 2),
  ('00000004-0000-4000-8000-0000000c0702', '00000002-0000-4000-8000-0000000dea10', '00000002-0000-4000-8000-0000000000e4',
   'COT-2026-002', 3949579.83, 750420.17, '{views,reach,interactions}',
   NULL, NULL, NULL, DATE '2026-07-15', DATE '2026-07-22', 'accepted', DATE '2026-07-08',
   '2026-06-24 15:00:00+00', '2026-06-25 14:00:00+00', '2026-07-01 14:00:00+00',
   NULL, NULL, 3),
  ('00000004-0000-4000-8000-0000000c0703', '00000002-0000-4000-8000-0000000dea11', '00000002-0000-4000-8000-0000000000e1',
   'COT-2026-003', 2605042.02, 494957.98, '{views,reach,link_clicks,code_redemptions}',
   NULL, NULL, NULL, DATE '2026-08-10', DATE '2026-08-17', 'accepted', DATE '2026-08-07',
   '2026-07-23 14:00:00+00', '2026-07-24 15:30:00+00', '2026-07-29 16:00:00+00',
   'Valentina Ortiz', 'valentina@cafealma.co', 4),
  ('00000004-0000-4000-8000-0000000c0704', '00000002-0000-4000-8000-0000000dea09', '00000002-0000-4000-8000-0000000000e2',
   'COT-2026-004', 4369747.90, 830252.10, '{views,link_clicks}',
   NULL, NULL, NULL, DATE '2026-09-02', DATE '2026-09-09', 'accepted', DATE '2026-09-08',
   '2026-08-25 15:00:00+00', '2026-08-26 13:00:00+00', '2026-08-27 17:30:00+00',
   'Camila Rojas', 'camila.rojas@freskomarket.co', 3),
  ('00000004-0000-4000-8000-0000000c0705', '00000002-0000-4000-8000-0000000dea07', '00000002-0000-4000-8000-0000000000e2',
   'COT-2026-005', 14200000.00, 2698000.00, '{views,reach,link_clicks,code_redemptions}',
   90, NULL, NULL, CURRENT_DATE + 30, CURRENT_DATE + 37, 'viewed', CURRENT_DATE + 8,
   '2026-09-02 15:00:00+00', '2026-09-03 14:00:00+00', NULL,
   NULL, NULL, 3),
  ('00000004-0000-4000-8000-0000000c0706', '00000002-0000-4000-8000-0000000dea03', '00000002-0000-4000-8000-0000000000e5',
   'COT-2026-006', 16000000.00, 3040000.00, '{views,reach,interactions,link_clicks}',
   NULL, 30, 'Salsas y aderezos en Colombia', CURRENT_DATE + 15, CURRENT_DATE + 22, 'viewed', CURRENT_DATE + 8,
   '2026-09-05 14:00:00+00', '2026-09-06 16:00:00+00', NULL,
   NULL, NULL, 5),
  ('00000004-0000-4000-8000-0000000c0707', '00000002-0000-4000-8000-0000000dea08', '00000002-0000-4000-8000-0000000000e7',
   'COT-' || to_char(CURRENT_DATE - 13, 'YYYY') || '-007', 9800000.00, 1862000.00, '{views,reach,saves}',
   90, NULL, NULL, CURRENT_DATE + 21, CURRENT_DATE + 28, 'sent', CURRENT_DATE + 14,
   (CURRENT_DATE - 13 + time '15:00') AT TIME ZONE 'UTC', NULL, NULL,
   NULL, NULL, 0),
  ('00000004-0000-4000-8000-0000000c0708', '00000002-0000-4000-8000-0000000dea15', '00000002-0000-4000-8000-0000000000e4',
   'COT-' || to_char(CURRENT_DATE - 7, 'YYYY') || '-008', 6500000.00, 1235000.00, '{views,reach}',
   NULL, NULL, NULL, NULL::date, NULL::date, 'viewed', CURRENT_DATE + 10,
   (CURRENT_DATE - 7 + time '15:00') AT TIME ZONE 'UTC', (CURRENT_DATE - 6 + time '14:00') AT TIME ZONE 'UTC', NULL,
   NULL, NULL, 2)
) AS v(id, deal_id, company_id, number, subtotal, tax, metrics, usage_rights_days, exclusivity_days, exclusivity_scope,
       starts_on, ends_on, status, valid_until, sent_at, viewed_at, accepted_at, signer_name, signer_email, view_count)
WHERE NOT EXISTS (
  SELECT 1 FROM quote q
   WHERE q.workspace_id = '00000002-0000-4000-8000-000000000001' AND q.number = v.number AND q.id <> v.id
)
-- Volver a sembrar refresca el PLAN de las que siguen abiertas (hasta
-- cuándo valen y la ventana que proponen); las aceptadas, y una que
-- alguien aceptó o rechazó en la demo, no se tocan.
ON CONFLICT (id) DO UPDATE SET
  valid_until        = EXCLUDED.valid_until,
  campaign_starts_on = EXCLUDED.campaign_starts_on,
  campaign_ends_on   = EXCLUDED.campaign_ends_on
WHERE quote.status IN ('sent', 'viewed');

-- Los entregables. Solo de las cotizaciones que entraron.
INSERT INTO quote_item (id, quote_id, deliverable, platform_id, description, quantity, unit_price, total, position)
SELECT i.id, i.quote_id, i.deliverable, i.platform_id, i.description, i.quantity, i.unit_price, i.quantity * i.unit_price, i.position
FROM (VALUES
  ('00000004-0000-4000-8000-0000c0700101'::uuid, '00000004-0000-4000-8000-0000000c0701'::uuid, 'historias', 'instagram', '3 historias con código LAURAHOGAR', 1, 924369.75::numeric, 0),
  ('00000004-0000-4000-8000-0000c0700201', '00000004-0000-4000-8000-0000000c0702', 'youtube',   'youtube',   'Video dedicado en YouTube (10 min, mención integrada)', 1, 3949579.83, 0),
  ('00000004-0000-4000-8000-0000c0700301', '00000004-0000-4000-8000-0000000c0703', 'reel',      'instagram', 'Reel del cold brew en casa', 1, 1200000.00, 0),
  ('00000004-0000-4000-8000-0000c0700302', '00000004-0000-4000-8000-0000000c0703', 'tiktok',    'tiktok',    'TikTok del cold brew', 1, 1005042.02, 1),
  ('00000004-0000-4000-8000-0000c0700303', '00000004-0000-4000-8000-0000000c0703', 'historias', 'instagram', '3 historias con código LAURA15', 1, 400000.00, 2),
  ('00000004-0000-4000-8000-0000c0700401', '00000004-0000-4000-8000-0000000c0704', 'tiktok',    'tiktok',    'TikTok con enlace a la caja de desayunos', 2, 2184873.95, 0),
  ('00000004-0000-4000-8000-0000c0700501', '00000004-0000-4000-8000-0000000c0705', 'tiktok',    'tiktok',    'TikTok del lanzamiento de desayunos', 1, 6200000.00, 0),
  ('00000004-0000-4000-8000-0000c0700502', '00000004-0000-4000-8000-0000000c0705', 'reel',      'instagram', 'Reel del lanzamiento de desayunos', 1, 4800000.00, 1),
  ('00000004-0000-4000-8000-0000c0700503', '00000004-0000-4000-8000-0000000c0705', 'historias', 'instagram', '3 historias con código y enlace propios', 1, 3200000.00, 2),
  ('00000004-0000-4000-8000-0000c0700601', '00000004-0000-4000-8000-0000000c0706', 'tiktok',    'tiktok',    'TikTok de recetas con salsas', 2, 5500000.00, 0),
  ('00000004-0000-4000-8000-0000c0700602', '00000004-0000-4000-8000-0000000c0706', 'reel',      'instagram', 'Reel de recetas con salsas', 1, 5000000.00, 1),
  ('00000004-0000-4000-8000-0000c0700701', '00000004-0000-4000-8000-0000000c0707', 'reel',      'instagram', 'Reel con la línea de bienestar, derechos 90 días', 2, 4900000.00, 0),
  ('00000004-0000-4000-8000-0000c0700801', '00000004-0000-4000-8000-0000000c0708', 'tiktok',    'tiktok',    'TikTok de meal prep', 1, 5200000.00, 0),
  ('00000004-0000-4000-8000-0000c0700802', '00000004-0000-4000-8000-0000000c0708', 'youtube',   'youtube',   'YouTube Short de meal prep', 1, 1300000.00, 1)
) AS i(id, quote_id, deliverable, platform_id, description, quantity, unit_price, position)
WHERE EXISTS (SELECT 1 FROM quote q WHERE q.id = i.quote_id)
ON CONFLICT (id) DO NOTHING;

-- Lo que la marca ve en el enlace: el documento congelado al enviarlo
-- (QuotePublicSnapshot de cotizacion.ts), armado con las filas de
-- arriba. Las aceptadas lo reciben una vez; las abiertas, en cada
-- corrida, porque su ventana y su validez se refrescan con ellas.
UPDATE quote q
   SET public_snapshot = jsonb_build_object(
         'version', 1,
         'number', q.number,
         'currency', upper(q.currency::text),
         'locale', w.locale,
         'timezone', w.timezone,
         'company', jsonb_build_object('name', co.name),
         'creator', jsonb_build_object('displayName', cp.display_name, 'handle', cp.handle),
         'items', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                            'description', i.description, 'platformId', i.platform_id, 'quantity', i.quantity,
                            'unitPrice', i.unit_price::text, 'total', i.total::text) ORDER BY i.position), '[]'::jsonb)
                     FROM quote_item i WHERE i.quote_id = q.id),
         'subtotal', q.subtotal::text,
         'discount', q.discount::text,
         'tax', q.tax::text,
         'taxRate', '0.19',
         'total', q.total::text,
         'acordado', jsonb_build_object(
           'metrics', to_jsonb(q.agreed_metrics),
           'cutsHours', to_jsonb(q.report_cuts_hours),
           'usageRightsDays', q.usage_rights_days,
           'exclusivityDays', q.exclusivity_days,
           'exclusivityScope', q.exclusivity_scope,
           'paymentTermsDays', q.payment_terms_days,
           'campaignStartsOn', to_char(q.campaign_starts_on, 'YYYY-MM-DD'),
           'campaignEndsOn', to_char(q.campaign_ends_on, 'YYYY-MM-DD')),
         'mediaKitSlug', NULL)
  FROM workspace w, company co, creator_profile cp
 WHERE q.id IN ('00000004-0000-4000-8000-0000000c0701', '00000004-0000-4000-8000-0000000c0702',
                '00000004-0000-4000-8000-0000000c0703', '00000004-0000-4000-8000-0000000c0704',
                '00000004-0000-4000-8000-0000000c0705', '00000004-0000-4000-8000-0000000c0706',
                '00000004-0000-4000-8000-0000000c0707', '00000004-0000-4000-8000-0000000c0708')
   AND w.id = q.workspace_id AND co.id = q.company_id AND cp.id = q.creator_id
   AND (q.public_snapshot IS NULL OR q.status IN ('sent', 'viewed'));


-- =====================================================================
-- 4 · La campaña de cada cotización aceptada (COT-4 → CAM-2)
-- ---------------------------------------------------------------------
-- Las cuatro campañas nacen en 0002/0003 sin cotización. Aquí se
-- enlazan a la que las originó, que es lo que createCampaignFromQuote
-- hace en la app. Solo si la campaña no tiene ya una (0016: una
-- cotización, una campaña).
-- =====================================================================
UPDATE campaign c
   SET quote_id = v.quote_id
  FROM (VALUES
    ('00000003-0000-4000-8000-000000ca0004'::uuid, '00000004-0000-4000-8000-0000000c0701'::uuid),
    ('00000003-0000-4000-8000-000000ca0003', '00000004-0000-4000-8000-0000000c0702'),
    ('00000003-0000-4000-8000-000000ca0001', '00000004-0000-4000-8000-0000000c0703'),
    ('00000003-0000-4000-8000-000000ca0002', '00000004-0000-4000-8000-0000000c0704')
  ) AS v(campaign_id, quote_id)
 WHERE c.id = v.campaign_id
   AND c.quote_id IS NULL
   AND EXISTS (SELECT 1 FROM quote q WHERE q.id = v.quote_id AND q.status = 'accepted')
   AND NOT EXISTS (SELECT 1 FROM campaign o WHERE o.quote_id = v.quote_id);

-- =====================================================================
-- Conteos esperados (verify/0004.sql los comprueba, con las cifras):
--
--   tabla             filas
--   rate_card             1  (v1, vigente)
--   rate_card_item        5  (TikTok, Reel, Historias, YouTube, paquete)
--   media_kit             1  (público, sin contraseña)
--   quote                 8  (4 aceptadas, 1 enviada, 3 vistas)
--   quote_item           14
--   campaign              4  (las cuatro con quote_id)
-- =====================================================================
