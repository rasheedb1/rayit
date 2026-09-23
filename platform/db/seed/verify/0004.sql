-- =====================================================================
-- Verificación del seed 0004 (Cotizar de la demo, CIM-6).
-- ---------------------------------------------------------------------
-- Cómo correrlo:
--   Postgres embebido, sin tocar Supabase:
--     node db/seed/verify/run.mjs 0004
--   Contra una base con 0024–0031 y los seeds, como mc_app:
--     node db/sql.mjs -f db/seed/verify/0004.sql
--
-- Cada consulta con columna `ok` es una prueba: un false hace fallar
-- run.mjs. Lo que se cuida es que Cotizar cuente la MISMA historia que
-- el pipeline de 0002 y las campañas y facturas de 0003.
-- =====================================================================

SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);

-- (a) Conteos: un tarifario vigente con 5 entregables, un media kit
--     público, 8 cotizaciones (4 aceptadas, 1 enviada, 3 vistas) con
--     14 líneas, y las 4 campañas con su cotización.
SELECT 'a_conteos' AS check_id,
       (SELECT count(*) FROM rate_card WHERE is_current)                               AS tarifarios_vigentes,
       (SELECT count(*) FROM rate_card_item i JOIN rate_card r ON r.id = i.rate_card_id WHERE r.is_current) AS entregables,
       (SELECT count(*) FROM media_kit WHERE is_public)                                AS media_kits,
       (SELECT count(*) FROM quote)                                                    AS cotizaciones,
       (SELECT count(*) FROM quote WHERE status = 'accepted')                          AS aceptadas,
       (SELECT count(*) FROM quote WHERE status IN ('sent', 'viewed'))                 AS abiertas,
       (SELECT count(*) FROM quote_item)                                               AS lineas,
       (SELECT count(*) FROM campaign WHERE quote_id IS NOT NULL)                      AS campanas_con_cotizacion,
       (SELECT count(*) FROM rate_card WHERE is_current) = 1
         AND (SELECT count(*) FROM rate_card_item i JOIN rate_card r ON r.id = i.rate_card_id WHERE r.is_current) = 5
         AND (SELECT count(*) FROM media_kit WHERE is_public) = 1
         AND (SELECT count(*) FROM quote) = 8
         AND (SELECT count(*) FROM quote WHERE status = 'accepted') = 4
         AND (SELECT count(*) FROM quote WHERE status IN ('sent', 'viewed')) = 4
         AND (SELECT count(*) FROM quote_item) = 14
         AND (SELECT count(*) FROM campaign WHERE quote_id IS NOT NULL) = 4 AS ok;

-- (b) Cada negocio en propuesta, negociación o ganado con campaña tiene
--     su cotización: la demo no puede decir «Seguimiento a la
--     cotización» en Ventas y «Todavía no has cotizado nada» en Cotizar.
SELECT 'b_negocios_cotizados' AS check_id,
       count(*) AS negocios,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM quote q WHERE q.deal_id = d.id)) AS sin_cotizacion,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM quote q WHERE q.deal_id = d.id)) = 0 AS ok
FROM deal d
WHERE d.stage_id IN ('propuesta', 'negociacion')
   OR (d.stage_id = 'ganado' AND EXISTS (SELECT 1 FROM campaign c WHERE c.deal_id = d.id));

-- (c) Una sola convención de montos en las cuatro tablas (0031, CAM-2):
--       quote.total = quote.subtotal − quote.discount + quote.tax
--       quote.subtotal = Σ quote_item.total
--       deal.amount     = quote.total − quote.tax  (neto)
--       campaign.amount = quote.total              (con IVA)
--       invoice.subtotal = deal.amount y invoice.total = campaign.amount
SELECT 'c_convencion_de_montos' AS check_id,
       count(*) AS cotizaciones,
       count(*) FILTER (WHERE q.total <> q.subtotal - q.discount + q.tax)                         AS total_descuadrado,
       count(*) FILTER (WHERE q.subtotal <> (SELECT sum(i.total) FROM quote_item i WHERE i.quote_id = q.id)) AS lineas_descuadradas,
       count(*) FILTER (WHERE q.tax <> round((q.subtotal - q.discount) * q.tax_rate, 2))          AS iva_descuadrado,
       count(*) FILTER (WHERE d.amount <> q.total - q.tax)                                        AS deal_no_neto,
       count(*) FILTER (WHERE c.id IS NOT NULL AND c.amount <> q.total)                           AS campana_no_total,
       count(*) FILTER (WHERE inv.id IS NOT NULL AND (inv.subtotal <> d.amount OR inv.total <> c.amount)) AS factura_descuadrada,
       count(*) FILTER (WHERE q.total <> q.subtotal - q.discount + q.tax) = 0
         AND count(*) FILTER (WHERE q.subtotal <> (SELECT sum(i.total) FROM quote_item i WHERE i.quote_id = q.id)) = 0
         AND count(*) FILTER (WHERE q.tax <> round((q.subtotal - q.discount) * q.tax_rate, 2)) = 0
         AND count(*) FILTER (WHERE d.amount <> q.total - q.tax) = 0
         AND count(*) FILTER (WHERE c.id IS NOT NULL AND c.amount <> q.total) = 0
         AND count(*) FILTER (WHERE inv.id IS NOT NULL AND (inv.subtotal <> d.amount OR inv.total <> c.amount)) = 0 AS ok
FROM quote q
JOIN deal d ON d.id = q.deal_id
LEFT JOIN campaign c ON c.quote_id = q.id
LEFT JOIN invoice inv ON inv.campaign_id = c.id;

-- (d) La cadena de cada aceptada: cotización aceptada → negocio ganado
--     → campaña enlazada por quote_id y por deal_id al MISMO negocio.
SELECT 'd_aceptadas' AS check_id, q.number, co.name AS marca, d.stage_id, c.name AS campana,
       d.amount AS neto, q.total, c.amount AS campana_monto,
       d.stage_id = 'ganado' AND c.id IS NOT NULL AND c.deal_id = q.deal_id AND q.accepted_at IS NOT NULL AS ok
FROM quote q
JOIN company co ON co.id = q.company_id
JOIN deal d ON d.id = q.deal_id
LEFT JOIN campaign c ON c.quote_id = q.id
WHERE q.status = 'accepted'
ORDER BY q.number;

-- (e) Las abiertas siguen vivas con cualquier reloj: ninguna vencida
--     (valid_until se refresca al volver a sembrar), todas con su
--     documento público y su slug de 26 signos del alfabeto de
--     nuevoSlug(); la numeración es la de la app (COT-AAAA-NNN).
SELECT 'e_abiertas_vivas' AS check_id,
       count(*) AS abiertas,
       count(*) FILTER (WHERE q.valid_until < CURRENT_DATE) AS vencidas,
       count(*) FILTER (WHERE q.public_snapshot IS NULL) AS sin_documento,
       count(*) FILTER (WHERE q.valid_until < CURRENT_DATE) = 0
         AND count(*) FILTER (WHERE q.public_snapshot IS NULL) = 0 AS ok
FROM quote q
WHERE q.status IN ('sent', 'viewed');

SELECT 'e2_enlaces_y_numeros' AS check_id,
       count(*) AS cotizaciones,
       count(*) FILTER (WHERE q.slug !~ '^[23456789abcdefghjkmnpqrstuvwxyz]{26}$') AS slug_raro,
       count(*) FILTER (WHERE q.number !~ '^COT-[0-9]{4}-[0-9]{3}$') AS numero_raro,
       count(*) FILTER (WHERE q.public_snapshot->>'number' <> q.number
                          OR q.public_snapshot->>'total' <> q.total::text) AS documento_distinto,
       count(*) FILTER (WHERE q.slug !~ '^[23456789abcdefghjkmnpqrstuvwxyz]{26}$') = 0
         AND count(*) FILTER (WHERE q.number !~ '^COT-[0-9]{4}-[0-9]{3}$') = 0
         AND count(*) FILTER (WHERE q.public_snapshot->>'number' <> q.number
                            OR q.public_snapshot->>'total' <> q.total::text) = 0
         AND (SELECT count(*) FROM media_kit k WHERE k.slug !~ '^[23456789abcdefghjkmnpqrstuvwxyz]{26}$') = 0 AS ok
FROM quote q;

-- (f) El media kit ofrece las tarifas del tarifario vigente, y ningún
--     rango está al revés.
SELECT 'f_tarifas' AS check_id,
       jsonb_array_length(k.snapshot->'tarifas') AS tarifas_en_el_kit,
       (SELECT count(*) FROM rate_card_item i WHERE i.rate_card_id = k.rate_card_id AND NOT i.is_modifier) AS en_el_tarifario,
       (SELECT count(*) FROM rate_card_item i WHERE i.rate_card_id = k.rate_card_id AND i.price_low > i.price_high) AS rangos_al_reves,
       jsonb_array_length(k.snapshot->'tarifas')
         = (SELECT count(*) FROM rate_card_item i WHERE i.rate_card_id = k.rate_card_id AND NOT i.is_modifier)
         AND (SELECT count(*) FROM rate_card_item i WHERE i.rate_card_id = k.rate_card_id AND i.price_low > i.price_high) = 0 AS ok
FROM media_kit k
WHERE k.id = '00000004-0000-4000-8000-000000d0c001';

-- (g) El «N× su mediana» de cada post del media kit cuadra con la
--     mediana que el MISMO kit publica de su red (pulido r8). Una marca
--     que divide las dos cifras de la página tiene que encontrar el
--     mismo número: buildMediaKitSnapshot lo calcula así al congelar
--     (round(views / mediana, 1)), y el kit del seed, escrito a mano,
--     no puede decir otra cosa.
SELECT 'g_multiplos_del_kit' AS check_id,
       count(*) AS posts,
       count(*) FILTER (WHERE r.mediana IS NULL OR r.mediana = 0) AS sin_mediana,
       count(*) FILTER (WHERE abs((p->>'viewsVsMedian')::numeric - (p->>'views')::numeric / r.mediana) >= 0.05) AS descuadrados,
       count(*) > 0
         AND count(*) FILTER (WHERE r.mediana IS NULL OR r.mediana = 0) = 0
         AND count(*) FILTER (WHERE abs((p->>'viewsVsMedian')::numeric - (p->>'views')::numeric / r.mediana) >= 0.05) = 0 AS ok
FROM media_kit k
CROSS JOIN LATERAL jsonb_array_elements(k.snapshot->'topPosts') p
LEFT JOIN LATERAL (
  SELECT (red->>'medianViews')::numeric AS mediana
    FROM jsonb_array_elements(k.snapshot->'redes') red
   WHERE red->>'platformId' = p->>'platformId'
) r ON true
WHERE k.id = '00000004-0000-4000-8000-000000d0c001';

-- (h) Las tarifas son las del tarifario, cifra por cifra y en su orden,
--     y van redondeadas a tres cifras significativas como las deja
--     redondearParaNegociar (@mc/core): 5.195.070 sale 5.200.000. Un
--     rango al peso en el kit que ve la marca es una precisión falsa.
SELECT 'h_tarifas_redondeadas' AS check_id,
       count(*) AS tarifas,
       count(*) FILTER (WHERE i.id IS NULL
                          OR (t->>'priceLow')::numeric <> i.price_low
                          OR (t->>'priceHigh')::numeric <> i.price_high) AS distintas_del_tarifario,
       count(*) FILTER (WHERE i.price_low  <> round(i.price_low,  -greatest(floor(log(i.price_low))  + 1 - 3, 0)::int)
                           OR i.price_high <> round(i.price_high, -greatest(floor(log(i.price_high)) + 1 - 3, 0)::int)) AS al_peso,
       count(*) = 5
         AND count(*) FILTER (WHERE i.id IS NULL
                            OR (t->>'priceLow')::numeric <> i.price_low
                            OR (t->>'priceHigh')::numeric <> i.price_high) = 0
         AND count(*) FILTER (WHERE i.price_low  <> round(i.price_low,  -greatest(floor(log(i.price_low))  + 1 - 3, 0)::int)
                             OR i.price_high <> round(i.price_high, -greatest(floor(log(i.price_high)) + 1 - 3, 0)::int)) = 0 AS ok
FROM media_kit k
CROSS JOIN LATERAL jsonb_array_elements(k.snapshot->'tarifas') WITH ORDINALITY AS x(t, n)
LEFT JOIN LATERAL (
  SELECT ri.id, ri.price_low, ri.price_high
    FROM rate_card_item ri
   WHERE ri.rate_card_id = k.rate_card_id AND NOT ri.is_modifier
   ORDER BY ri.position
  OFFSET x.n - 1 LIMIT 1
) i ON true
WHERE k.id = '00000004-0000-4000-8000-000000d0c001';
