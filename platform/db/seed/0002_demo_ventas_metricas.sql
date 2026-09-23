-- =====================================================================
-- Seed 2 · Ventas y métricas de la creadora de demostración (CIM-6).
-- ---------------------------------------------------------------------
-- Deja Resumen, Mis videos y Ventas con datos del orden del mock
-- (dashboard/local/app.js): la creadora de cocina fácil con cuatro
-- redes, sesenta videos en 120 días, noventa días de lecturas, su línea
-- base por red y corte, y un CRM con ocho marcas, doce señales, quince
-- deals y su historia. Es la base sobre la que 0003 (CIM-8) monta
-- finanzas y campañas.
--
-- Reglas del archivo:
--   * Idempotente. UUID fijos y ON CONFLICT DO NOTHING en las tablas
--     con clave; WHERE NOT EXISTS sobre la clave natural en las que no
--     la tienen (post_metric_snapshot, historia de etapas). Correr dos
--     veces deja los mismos conteos, el mismo día o cualquier día
--     después (verify/run.mjs lo prueba con una tercera pasada con el
--     reloj adelantado un día).
--   * Determinista. Nada de random(): las curvas, los conteos y todo lo
--     derivado de generate_series salen de funciones cerradas, así que
--     dos corridas dan lo mismo y dos máquinas que siembren el mismo
--     día UTC dan lo mismo en todo eso. Lo que NO coincide entre dos
--     máquinas son las nueve columnas de frescura, que salen de now() y
--     llevan la hora exacta de la siembra: social_connection
--     .last_synced_at, .access_expires_at, .refresh_expires_at y
--     .connected_at; app_user.last_seen_at; signal.detected_at y
--     .reviewed_at (las pendientes y la duplicada);
--     audience_breakdown.captured_at; y company.enriched_at (Olla
--     Fácil). Un diff entre dos entornos que solo toque esas nueve es
--     lo esperado, no un síntoma.
--     De esas nueve, las que la demo MIRA HOY se refrescan en cada
--     corrida: las tres de social_connection, app_user.last_seen_at,
--     signal.detected_at y .reviewed_at de las PENDIENTES, y
--     audience_breakdown.captured_at. Las otras tres son hechos
--     ocurridos y se quedan con la hora de la primera siembra:
--     .connected_at, la señal duplicada y company.enriched_at.
--   * El seed fija TimeZone = UTC para su sesión, junto al workspace.
--     CURRENT_DATE y date_trunc('day', now()) dependen del TimeZone de
--     la sesión, no del sistema: sin fijarlo, un Postgres inicializado
--     en Bogotá a las 02:00 UTC sembraría "ayer" y daría otra demo. Es
--     un ajuste de sesión, así que sobrevive al archivo; quien cargue
--     los seeds dentro de otro proceso lo fija además por su cuenta
--     (packages/db/src/provisional/embedded.ts), para no depender de
--     este efecto lateral.
--   * El reloj del seed es la medianoche UTC de hoy, date_trunc('day',
--     now()): es la hora a la que correría el job nocturno, que solo
--     tiene cerrado el día de ayer. Las lecturas que "ya ocurrieron",
--     los cortes que un video "ya alcanzó", computed_at de línea base y
--     puntaje y el último día de la serie de la cuenta (ayer) se miden
--     contra ese reloj, no contra now(), para que dar el seed a las 9 o
--     a las 21 deje exactamente las mismas filas.
--   * Fechas relativas y fechas fijas. Lo que ya pasó y se cita en un
--     reporte o una factura (los cinco posts de las campañas de 0003,
--     los cierres, los correos y llamadas de los clientes) va fijo. Lo
--     que la demo mira "hoy" (videos recientes, seguidores, bandeja del
--     radar, próximas acciones, cierres esperados, los dos seguimientos
--     vencidos) va relativo a CURRENT_DATE, para que una base sembrada en dos meses
--     (CI, Postgres embebido, un Supabase nuevo) tenga la misma demo
--     viva; y toda la fila lo es: el texto, la dedupe_key y las fechas
--     que la acompañan se derivan de la misma fecha, para que nunca
--     diga "hace 2 horas" de algo del 14 de septiembre.
--   * Tres reglas, según la NATURALEZA de cada columna. Volver a
--     sembrar una base que ya tiene la demo —`make db.seed` contra un
--     Supabase que la lleva puesta, que es el camino documentado— no
--     puede reescribir la historia ni dejar la demo caducada.
--     1) Lo que YA PASÓ se congela en la primera corrida. published_at
--        de los videos de la lista y el día 0 de la serie de la cuenta
--        se toman de lo ya guardado si existe (COALESCE sobre la fila
--        anterior), así que una corrida en otro día no desplaza fechas
--        ni duplica lecturas: las que entran son solo las que la curva
--        de cada video ya alcanzó. Las señales aceptadas, los deals
--        cerrados, la historia de etapas y las actividades históricas
--        usan ON CONFLICT DO NOTHING y quedan fechadas el día en que el
--        seed corrió por primera vez: son hechos ocurridos, y las
--        actividades los citan por su texto.
--     2) Lo que la demo MIRA HOY se refresca, con DO UPDATE: la
--        frescura de las conexiones (social_connection.last_synced_at,
--        .access_expires_at, .refresh_expires_at) y app_user
--        .last_seen_at; el cierre esperado, la fecha de la próxima
--        acción y el ÚLTIMO CONTACTO de los deals ABIERTOS (sección 10)
--        con su actividad de seguimiento (11b); el titular, la fecha,
--        el evidence y la dedupe_key de las señales PENDIENTES (9); la
--        ventana del brief activo (12); la foto de la demografía y las
--        personas que cuenta (6); y el puntaje de cada video, que SUBE
--        al corte que el video ya alcanzó (7), porque post_score es el
--        puntaje vigente y no un registro append-only. Son tablas
--        maestras, planes y valores vigentes, no métricas: no viola el
--        append-only.
--     3) Lo que FALTA se añade, sin tocar lo anterior: la serie de la
--        cuenta se extiende hasta ayer (5), la línea base se recalcula
--        con la fecha del día (7) y la parrilla recibe los videos que
--        se habrían publicado desde el último guardado (3b), con sus
--        lecturas.
--     Sin las tres, una base sembrada hace seis semanas enseña ocho de
--     diez deals abiertos con el cierre en el pasado, la bandeja del
--     radar de mes y medio, la gráfica de seguidores terminando hace
--     mes y medio y —lo peor— "Mis videos" vacía al lado de un
--     "sincronizado hace 2 h". verify/run.mjs lo prueba con una cuarta
--     pasada que vuelve a sembrar la MISMA base con el reloj adelantado
--     seis semanas y exige que la demo siga viva, videos incluidos.
--   * Las métricas se insertan, nunca se actualizan (append-only).
--   * RLS está en modo FORCE: incluso mc_migrator, dueño de las tablas,
--     necesita app.workspace_id fijado. Se fija al principio para toda
--     la sesión.
--   * El seed no crea ningún objeto: ni tablas de trabajo ni funciones.
--     Lo que necesita calcular va en CTEs dentro de la misma sentencia.
--
-- Contrato con 0003 (docs/propuestas/CIM-8.md §1). Estos ids los usa
-- 0003 en su sección 0 con ON CONFLICT DO NOTHING; como 0002 corre
-- antes, esa sección queda en no-op:
--   00000002-0000-4000-8000-000000000001  workspace (Laura · Cocina fácil)
--   …-000000000002  app_user          …-0000000000c1 instagram
--   …-000000000003  creator_profile   …-0000000000c2 tiktok
--   …-0000000000e1 Café Alma          …-0000000000c3 youtube
--   …-0000000000e2 Fresko Market      …-0000000000c4 facebook (solo 0002)
--   …-0000000000e3 Hogar Lindo        …-000000000d01..d05 posts de campaña
--   …-0000000000e4 Nutrivé
--
-- Ids propios de este seed (últimos doce dígitos hexadecimales):
--   …-0000000000e5..e8   empresas nuevas (Sabores Caseros, Granos del
--                        Valle, Vitalé, Olla Fácil)
--   …-000000000dNN       posts, NN = secuencia en hexadecimal (01..3c).
--                        En realidad el id es …-00000000 || hex(0x0d00
--                        + seq), así que los videos que añade 3b siguen
--                        en 0d3d, 0d3e, … sin tope práctico
--   …-0000000c0001..     contactos (c0 = contacto)
--   …-00000005e001..     señales (5e = señal)
--   …-0000000dea01..     deals
--   …-00000ac70001..     actividades (ac7 = actividad); 0027..002f son
--                        las nueve de seguimiento de 11b, una por deal
--                        abierto ya contactado
--   …-0000adHHHHHH       audience_breakdown, HHHHHH = red·100 + bucket
--                        en hexadecimal (id fijo = clave de idempotencia)
--   …-0000000b0001       outbound_brief
--   …-ba5PCCCCDDDD       creator_baseline, P = red (1 tiktok, 2 instagram,
--                        3 youtube, 4 facebook), CCCC = corte en horas,
--                        DDDD = día del cálculo (días desde el 1-ene-2026,
--                        en hexadecimal): una línea base por día
--   00000003-…-ca0001/ca0004  las dos campañas reportadas: mismos ids y
--                        cifras que 0003, que al correr después las
--                        reafirma; aquí se enlazan a su deal ganado.
--
-- Cómo se aplica y se verifica:
--   node db/migrate.mjs <url> --seed         (Supabase o Docker)
--   node db/seed/verify/run.mjs 0002          (Postgres embebido: dos
--                                              pasadas, las cifras, una
--                                              tercera pasada mañana y
--                                              una cuarta a +40 días
--                                              sobre la misma base)
-- Al final del archivo está la tabla de conteos esperados.
-- =====================================================================

SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);
-- Y quién es: lo mismo que fijará withWorkspace cuando CIM-3 exista.
-- El seed no es un proceso anónimo con permisos de más, es esta
-- usuaria; por eso puede refrescar SU last_seen_at (política
-- app_user_update, migración 0021) y nada más.
SELECT set_config('app.user_id', '00000002-0000-4000-8000-000000000002', false);
-- CURRENT_DATE es local a la sesión: se fija UTC para que "hoy" sea el
-- mismo día en Supabase, Docker, PGlite, CI y un Postgres nativo.
SELECT set_config('TimeZone', 'UTC', false);


-- =====================================================================
-- 1 · Workspace, usuaria y creadora
-- ---------------------------------------------------------------------
-- Creadora, COP, Bogotá. settings.finanzas lo lee FIN-8 (0003 trae el
-- mismo bloque). es-CO es el valor por defecto del workspace, no una
-- constante de la app: la interfaz formatea con Intl a partir de
-- currency, timezone y locale.
-- =====================================================================
INSERT INTO workspace (id, slug, name, kind, country, currency, timezone, locale, plan, niche_slugs, settings)
VALUES (
  '00000002-0000-4000-8000-000000000001', 'laura-cocina-facil', 'Laura · Cocina fácil',
  'creator', 'CO', 'COP', 'America/Bogota', 'es-CO', 'creator', '{cocina}',
  '{"finanzas": {"iva_pct": 19, "retencion_pct": 11, "reserva_pct": 11, "plazo_dias": 30}}'::jsonb
)
ON CONFLICT DO NOTHING;

-- last_seen_at se refresca en cada corrida: es la última visita, no
-- una métrica.
INSERT INTO app_user (id, email, name, locale, last_seen_at)
VALUES ('00000002-0000-4000-8000-000000000002', 'demo@multicampaign.test', 'Laura Méndez', 'es-CO', now() - interval '2 hours')
ON CONFLICT (id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at;

INSERT INTO membership (workspace_id, user_id, role)
VALUES ('00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000002', 'owner')
ON CONFLICT DO NOTHING;

-- media_kit: las cifras que el pitch del mock cita, con su procedencia.
INSERT INTO creator_profile (id, workspace_id, user_id, display_name, handle, bio, country, languages, niche_slugs, media_kit)
VALUES (
  '00000002-0000-4000-8000-000000000003', '00000002-0000-4000-8000-000000000001',
  '00000002-0000-4000-8000-000000000002', 'Laura Méndez', 'laura.cocinafacil',
  -- La bio la escribe la creadora, no el producto: por eso la cifra va
  -- redondeada ("más de 400 mil") y no con el número exacto, que sube
  -- cada día y dejaría el texto desfasado frente al KPI de Resumen.
  'Cocina fácil para más de 400 mil personas en Colombia. Recetas de menos de diez minutos con lo que ya tienes en casa.',
  'CO', '{es}', '{cocina}',
  '{"tagline": "Cocina fácil, sin vueltas",
    "formats": ["tiktok", "reel", "short", "historias"],
    "audience_summary": {"country_top": "CO", "country_top_share": 0.71, "age_18_34_share": 0.71, "female_share": 0.64},
    "last_campaign": {"company": "Café Alma", "views": 712000, "brand_followers_gained": 1240, "source": "campaign_result:00000003-0000-4000-8000-000000ca0001"}
  }'::jsonb
)
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 2 · Conexiones: una por red
-- ---------------------------------------------------------------------
-- secret_ref apunta a un vault ficticio (seed://): el token nunca está
-- en la base. TikTok es cuenta business para que exista demografía por
-- cuenta (la personal no la da por API). YouTube tiene el acceso a
-- punto de vencer: connection_health lo marca token_expiring_soon.
-- La frescura (last_synced_at y los dos vencimientos) es relativa a
-- now() y se refresca con DO UPDATE en cada corrida: la demo siempre
-- está "sincronizada hace 2–6 h", y el token de YouTube siempre está a
-- 50 minutos de vencer, que es la historia que connection_health cuenta.
-- =====================================================================
INSERT INTO social_connection
  (id, workspace_id, creator_id, platform_id, external_account_id, handle, display_name, profile_url,
   account_type, secret_ref, scopes, access_expires_at, refresh_expires_at, access_mode, status, last_synced_at, connected_at)
VALUES
  ('00000002-0000-4000-8000-0000000000c1', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000003',
   'instagram', '17841400000000123', 'laura.cocinafacil', 'Laura · Cocina fácil', 'https://www.instagram.com/laura.cocinafacil/',
   'creator', 'seed://demo/instagram/laura', '{instagram_basic,instagram_manage_insights,pages_read_engagement}',
   now() + interval '41 days', NULL, 'direct_oauth', 'active', now() - interval '3 hours', now() - interval '140 days'),
  ('00000002-0000-4000-8000-0000000000c2', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000003',
   'tiktok', 'open_id_demo_laura', 'laura.cocinafacil', 'Laura · Cocina fácil', 'https://www.tiktok.com/@laura.cocinafacil',
   'business', 'seed://demo/tiktok/laura', '{user.info.basic,user.info.stats,video.list,video.insights}',
   now() + interval '20 hours', now() + interval '300 days', 'direct_oauth', 'active', now() - interval '2 hours', now() - interval '140 days'),
  ('00000002-0000-4000-8000-0000000000c3', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000003',
   'youtube', 'UCdemo000000000000000001', 'LauraCocinaFacil', 'Laura · Cocina fácil', 'https://www.youtube.com/@LauraCocinaFacil',
   'channel', 'seed://demo/youtube/laura', '{youtube.readonly,yt-analytics.readonly}',
   now() + interval '50 minutes', NULL, 'direct_oauth', 'active', now() - interval '5 hours', now() - interval '138 days'),
  ('00000002-0000-4000-8000-0000000000c4', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000003',
   'facebook', '1000000000000c4', 'lauracocinafacil', 'Laura · Cocina fácil', 'https://www.facebook.com/lauracocinafacil',
   'page', 'seed://demo/facebook/laura', '{pages_read_engagement,pages_show_list,read_insights}',
   now() + interval '55 days', NULL, 'business_portfolio', 'active', now() - interval '6 hours', now() - interval '120 days')
ON CONFLICT (id) DO UPDATE SET
  last_synced_at     = EXCLUDED.last_synced_at,
  access_expires_at  = EXCLUDED.access_expires_at,
  refresh_expires_at = EXCLUDED.refresh_expires_at;


-- =====================================================================
-- 3 · Sesenta videos en 120 días
-- ---------------------------------------------------------------------
-- Una sola sentencia: la lista de lo que define a cada video (CTE
-- seed_post_base), los que faltan para llegar a esta semana (3b, CTE
-- seed_nuevo), la unión de los dos (seed_post), lo derivado
-- (seed_post_curve), el INSERT del post y el de sus lecturas. Va junto
-- porque los parámetros de la curva no viven en ninguna tabla, y el
-- seed no crea tablas de trabajo (el rol migrador no tiene TEMP en
-- Postgres embebido). De la línea base y el puntaje se ocupa la
-- sección 7, leyendo lo ya insertado.
--
--   seq        secuencia: el id del post es …-00000000 más
--              hex(0x0d00 + seq), o sea …-000000000d01..0d3c para estos
--              sesenta y 0d3d en adelante para los que añade 3b.
--   days_ago   publicado hace N días (relativo a CURRENT_DATE), a las
--              hour_utc. NULL para los cinco posts de campaña de 0003,
--              que van con fecha fija (fixed_at) porque sus reportes y
--              facturas las citan. days_ago se congela en la primera
--              corrida: si el post ya existe, su published_at guardado
--              manda (seed_post_curve lo toma con COALESCE), así que
--              una corrida en otro día no mueve el video ni sus
--              lecturas.
--   v_ref      views conocidas a la edad ref_age_h. Para los doce videos
--              de la tabla "Mis videos" del mock son las views que el
--              mock muestra a su edad de hoy; para los de campaña, las
--              views a 30 días que 0003 usa; para el resto, views a 30
--              días. La curva reconstruye el resto de la serie.
--   saves_per_1k, nofol, skip3   valores del mock donde los da; NULL se
--              deriva con una función determinista de seq.
--   link_rate  clics por view; solo los posts de campaña (branded).
-- =====================================================================
WITH seed_post_base AS (
SELECT *
FROM (VALUES
  -- seq, platform, surface, days_ago, fixed_at, hour_utc, title, caption, hashtags, mentions, duration_s, v_ref, ref_age_h, saves_per_1k, nofol, skip3, link_rate
  -- Posts de campaña (contrato con 0003): fecha fija, texto idéntico.
  ( 1, 'instagram', 'reels', NULL, '2026-08-10 17:00:00+00'::timestamptz, NULL, 'Cold brew en casa en 3 pasos',
    'Cold brew en casa en 3 pasos ☕ Con @cafealma · código LAURA15', '{coldbrew,cafe,recetafacil}'::text[], '{cafealma}'::text[], 41, 412000, 720, 15.0, 0.58, 0.21, 0.0095),
  ( 2, 'tiktok', 'feed', NULL, '2026-08-12 16:30:00+00', NULL, 'El cold brew que me salva las mañanas',
    'El cold brew que me salva las mañanas 🧊 #ad @cafealma.co', '{coldbrew,cafe,ad}', '{cafealma.co}', 34, 300000, 720, 11.3, 0.58, 0.23, 0.0078),
  ( 3, 'tiktok', 'feed', NULL, '2026-09-02 15:00:00+00', NULL, 'Tres desayunos con la caja de Fresko',
    'Tres desayunos con lo que llega en la caja de @freskomarket 🥑 #ad', '{desayuno,recetafacil,ad}', '{freskomarket}', 52, 140000, 720, 10.7, 0.57, 0.26, 0.0079),
  ( 4, 'tiktok', 'feed', NULL, '2026-09-06 15:00:00+00', NULL, 'Mercado de la semana en 10 minutos',
    'Mercado de la semana en 10 minutos con @freskomarket 🛒 #ad', '{mercado,ahorro,ad}', '{freskomarket}', 47, 125000, 720, 10.4, 0.58, 0.29, 0.0067),
  ( 5, 'youtube', 'video', NULL, '2026-07-15 14:00:00+00', NULL, 'Una semana de almuerzos saludables con Nutrivé',
    'Una semana de almuerzos saludables con Nutrivé', '{mealprep,saludable}', '{}', 612, 58000, 720, 15.5, 0.54, NULL, 0.0072),
  -- TikTok · los cuatro de "Mis videos" del mock
  ( 6, 'tiktok', 'feed',   4, NULL, 19, 'La arepa que se hace sin plancha',
    'Reto: arepa sin plancha y sin que se pegue. Sí se puede 🫓 #arepa #recetafacil #sinplancha', '{arepa,recetafacil,sinplancha}', '{}', 34, 412000, 96, 21.4, 0.74, 0.19, NULL),
  ( 7, 'tiktok', 'feed',  12, NULL, 19, 'El error que arruina tu arroz',
    'El error que arruina tu arroz (y lo cometemos todos) 🍚 #arroz #cocinafacil #truco', '{arroz,cocinafacil,truco}', '{}', 38, 240000, 288, 15.2, 0.69, 0.24, NULL),
  ( 8, 'tiktok', 'feed',   2, NULL, 19, 'Huevo perfecto: el truco del vaso',
    'Huevo perfecto en 40 segundos: el truco del vaso 🥚 #huevo #desayuno #truco', '{huevo,desayuno,truco}', '{}', 29, 74000, 48, 11.0, 0.61, 0.28, NULL),
  ( 9, 'tiktok', 'feed',  23, NULL, 16, 'Sopa de la abuela paso a paso',
    'La sopa de mi abuela, paso a paso y sin afán 🍲 #sopa #recetadefamilia #cocinacolombiana', '{sopa,recetadefamilia,cocinacolombiana}', '{}', 88, 58000, 552, 6.4, 0.35, 0.41, NULL),
  -- TikTok · el resto de la parrilla
  (10, 'tiktok', 'feed',   1, NULL, 19, 'Pan de queso en airfryer',
    'Pan de queso en airfryer en 12 minutos 🧀 #pandequeso #airfryer #recetafacil', '{pandequeso,airfryer,recetafacil}', '{}', 31, 38000, 24, NULL, NULL, NULL, NULL),
  (11, 'tiktok', 'feed',   7, NULL, 19, 'Lentejas que sí saben',
    'Lentejas que sí saben, con dos trucos que nadie te cuenta 🫘 #lentejas #almuerzo #cocinafacil', '{lentejas,almuerzo,cocinafacil}', '{}', 45, 90000, 168, NULL, NULL, NULL, NULL),
  (12, 'tiktok', 'feed',  16, NULL, 23, 'Cena en 10 minutos con lo que hay',
    'Cena en 10 minutos con lo que hay en la nevera 🍳 #cena #recetafacil #10minutos', '{cena,recetafacil,10minutos}', '{}', 42, 110000, 384, NULL, NULL, NULL, NULL),
  (13, 'tiktok', 'feed',  19, NULL, 19, 'Patacones que no se rompen',
    'Patacones que no se rompen al aplastarlos 🍌 #patacones #cocinacolombiana #truco', '{patacones,cocinacolombiana,truco}', '{}', 36, 130000, 456, NULL, NULL, NULL, NULL),
  (14, 'tiktok', 'feed',  27, NULL, 19, 'Pollo jugoso siempre',
    'Pollo jugoso siempre: la temperatura importa más que el tiempo 🍗 #pollo #cocinafacil #truco', '{pollo,cocinafacil,truco}', '{}', 40, 95000, 648, NULL, NULL, NULL, NULL),
  (15, 'tiktok', 'feed',  33, NULL, 16, 'Arroz con coco fácil',
    'Arroz con coco fácil, sin titoté y sin drama 🥥 #arrozconcoco #cocinacolombiana #recetafacil', '{arrozconcoco,cocinacolombiana,recetafacil}', '{}', 48, 88000, 720, NULL, NULL, NULL, NULL),
  (16, 'tiktok', 'feed',  38, NULL, 19, 'Tres salsas para todo',
    'Tres salsas que mejoran cualquier plato de la semana 🥣 #salsas #recetafacil #mealprep', '{salsas,recetafacil,mealprep}', '{}', 39, 145000, 720, NULL, NULL, NULL, NULL),
  (17, 'tiktok', 'feed',  45, NULL, 19, 'Almuerzo por 8 mil pesos',
    'Almuerzo completo por 8 mil pesos, con recibo y todo 🧾 #ahorro #almuerzo #cocinafacil', '{ahorro,almuerzo,cocinafacil}', '{}', 55, 160000, 720, NULL, NULL, NULL, NULL),
  (18, 'tiktok', 'feed',  52, NULL, 12, 'Empanadas al horno crujientes',
    'Empanadas al horno que quedan crujientes de verdad 🥟 #empanadas #alhorno #recetafacil', '{empanadas,alhorno,recetafacil}', '{}', 58, 105000, 720, NULL, NULL, NULL, NULL),
  (19, 'tiktok', 'feed',  60, NULL, 19, 'Changua para el guayabo',
    'Changua para el guayabo, como la hacen en Boyacá 🥛 #changua #desayuno #cocinacolombiana', '{changua,desayuno,cocinacolombiana}', '{}', 33, 72000, 720, NULL, NULL, NULL, NULL),
  (20, 'tiktok', 'feed',  68, NULL, 19, 'Tortilla de papa en sartén',
    'Tortilla de papa en sartén, sin voltearla con plato 🥔 #tortilla #cena #truco', '{tortilla,cena,truco}', '{}', 44, 98000, 720, NULL, NULL, NULL, NULL),
  (21, 'tiktok', 'feed',  75, NULL, 19, 'Ajiaco exprés',
    'Ajiaco exprés en olla a presión: 35 minutos 🍲 #ajiaco #cocinacolombiana #ollaapresion', '{ajiaco,cocinacolombiana,ollaapresion}', '{}', 61, 118000, 720, NULL, NULL, NULL, NULL),
  (22, 'tiktok', 'feed',  84, NULL, 19, 'Buñuelos que no se abren',
    'Buñuelos que no se abren en el aceite: la masa correcta 🟠 #bunuelos #cocinacolombiana #truco', '{bunuelos,cocinacolombiana,truco}', '{}', 37, 210000, 720, NULL, NULL, NULL, NULL),
  (23, 'tiktok', 'feed', 103, NULL, 16, 'Arroz chino casero',
    'Arroz chino casero con el arroz de ayer 🍚 #arrozchino #sobras #recetafacil', '{arrozchino,sobras,recetafacil}', '{}', 52, 125000, 720, NULL, NULL, NULL, NULL),
  -- Instagram · los cuatro reels de "Mis videos" del mock
  (24, 'instagram', 'reels',  9, NULL, 19, 'Tres desayunos con dos ingredientes',
    'Tres desayunos con dos ingredientes cada uno. Guárdalo para mañana 🍳 #desayuno #recetafacil #dosingredientes', '{desayuno,recetafacil,dosingredientes}', '{}', 41, 168000, 216, 18.0, 0.66, 0.22, NULL),
  (25, 'instagram', 'reels', 15, NULL, 19, 'Salsa que mejora cualquier cosa',
    'La salsa que mejora cualquier cosa que tengas en el plato 🥣 #salsa #recetafacil #cena', '{salsa,recetafacil,cena}', '{}', 36, 101000, 360, 13.4, 0.55, 0.27, NULL),
  (26, 'instagram', 'reels', 20, NULL, 16, 'Compras de la semana por 80 mil',
    'Compras de la semana por 80 mil pesos, con menú incluido 🛒 #mercado #ahorro #mealprep', '{mercado,ahorro,mealprep}', '{}', 71, 61000, 480, 9.8, 0.42, 0.36, NULL),
  (27, 'instagram', 'reels', 26, NULL, 19, 'Postre sin horno para visitas',
    'Postre sin horno para cuando llegan visitas sin avisar 🍮 #postre #sinhorno #recetafacil', '{postre,sinhorno,recetafacil}', '{}', 67, 44000, 624, 8.9, 0.40, 0.39, NULL),
  -- Instagram · el resto
  (28, 'instagram', 'reels',  3, NULL, 19, 'Avena nocturna en tres sabores',
    'Avena nocturna en tres sabores para no pensar el desayuno 🥣 #avena #desayuno #mealprep', '{avena,desayuno,mealprep}', '{}', 33, 48000, 72, NULL, NULL, NULL, NULL),
  (29, 'instagram', 'reels', 11, NULL, 12, 'Mi desayuno de los martes',
    'Mi desayuno de los martes: huevos pericos con aguacate en 6 minutos 🥑 #desayuno #huevospericos #recetafacil', '{desayuno,huevospericos,recetafacil}', '{}', 38, 58000, 264, NULL, NULL, NULL, NULL),
  (30, 'instagram', 'reels', 17, NULL, 19, 'Pasta al pesto sin licuadora',
    'Pasta al pesto sin licuadora ni procesador 🌿 #pasta #pesto #cena', '{pasta,pesto,cena}', '{}', 44, 70000, 408, NULL, NULL, NULL, NULL),
  (31, 'instagram', 'reels', 24, NULL, 19, 'Ensalada que sí llena',
    'Una ensalada que sí llena, para la semana 🥗 #ensalada #almuerzo #mealprep', '{ensalada,almuerzo,mealprep}', '{}', 40, 52000, 576, NULL, NULL, NULL, NULL),
  (32, 'instagram', 'reels', 31, NULL, 19, 'Galletas de avena en 20 minutos',
    'Galletas de avena en 20 minutos con tres ingredientes 🍪 #galletas #avena #recetafacil', '{galletas,avena,recetafacil}', '{}', 47, 66000, 720, NULL, NULL, NULL, NULL),
  (33, 'instagram', 'reels', 40, NULL, 16, 'Meal prep de domingo',
    'Meal prep de domingo: cinco almuerzos en una hora 🍱 #mealprep #almuerzo #ahorro', '{mealprep,almuerzo,ahorro}', '{}', 74, 81000, 720, NULL, NULL, NULL, NULL),
  (34, 'instagram', 'reels', 48, NULL, 19, 'Smoothie verde que sabe bien',
    'Smoothie verde que sí sabe bien, lo prometo 🥬 #smoothie #desayuno #saludable', '{smoothie,desayuno,saludable}', '{}', 30, 59000, 720, NULL, NULL, NULL, NULL),
  (35, 'instagram', 'reels', 56, NULL, 19, 'Arepas rellenas para la lonchera',
    'Arepas rellenas para la lonchera, tres rellenos 🫓 #arepas #lonchera #recetafacil', '{arepas,lonchera,recetafacil}', '{}', 49, 74000, 720, NULL, NULL, NULL, NULL),
  (36, 'instagram', 'reels', 64, NULL, 19, 'Salmón en airfryer',
    'Salmón en airfryer en 9 minutos, sin que se seque 🐟 #salmon #airfryer #cena', '{salmon,airfryer,cena}', '{}', 42, 63000, 720, NULL, NULL, NULL, NULL),
  (37, 'instagram', 'reels', 71, NULL, 23, 'Brownie en taza',
    'Brownie en taza en 90 segundos de microondas 🍫 #brownie #postre #recetafacil', '{brownie,postre,recetafacil}', '{}', 35, 88000, 720, NULL, NULL, NULL, NULL),
  (38, 'instagram', 'reels', 80, NULL, 16, 'Lo que compro en la plaza',
    'Lo que compro en la plaza cada sábado y cuánto me cuesta 🧺 #plaza #mercado #ahorro', '{plaza,mercado,ahorro}', '{}', 68, 56000, 720, NULL, NULL, NULL, NULL),
  (39, 'instagram', 'reels', 97, NULL, 19, 'Tostadas francesas fáciles',
    'Tostadas francesas con el pan de ayer 🍞 #tostadasfrancesas #desayuno #sobras', '{tostadasfrancesas,desayuno,sobras}', '{}', 39, 69000, 720, NULL, NULL, NULL, NULL),
  -- YouTube · los dos de "Mis videos" del mock
  (40, 'youtube', 'shorts',  6, NULL, 19, 'Pasta cremosa en cuatro minutos',
    'Pasta cremosa en cuatro minutos, sin crema de leche #shorts #pasta #recetafacil', '{shorts,pasta,recetafacil}', '{}', 55, 96000, 144, 9.1, 0.58, NULL, NULL),
  (41, 'youtube', 'shorts', 17, NULL, 19, 'Mi cocina en 60 segundos',
    'Mi cocina en 60 segundos: qué tengo y qué no #shorts #cocina', '{shorts,cocina}', '{}', 60, 39000, 408, 3.1, 0.39, NULL, NULL),
  -- YouTube · el resto
  (42, 'youtube', 'shorts', 10, NULL, 16, 'Arroz perfecto en olla normal',
    'Arroz perfecto en olla normal, sin arrocera #shorts #arroz #truco', '{shorts,arroz,truco}', '{}', 48, 44000, 240, NULL, NULL, NULL, NULL),
  (43, 'youtube', 'shorts', 21, NULL, 19, 'Cómo afilar cuchillos en casa',
    'Cómo afilar cuchillos en casa con lo que ya tienes #shorts #cuchillos #truco', '{shorts,cuchillos,truco}', '{}', 57, 37000, 504, NULL, NULL, NULL, NULL),
  (44, 'youtube', 'video',  32, NULL, 14, 'Un almuerzo completo en 25 minutos',
    'Un almuerzo completo en 25 minutos: arroz, proteína y ensalada al tiempo', '{almuerzo,recetafacil,25minutos}', '{}', 480, 52000, 720, NULL, NULL, NULL, NULL),
  (45, 'youtube', 'shorts', 36, NULL, 19, 'Pollo al curry sin curry en polvo',
    'Pollo al curry sin curry en polvo #shorts #pollo #cena', '{shorts,pollo,cena}', '{}', 52, 41000, 720, NULL, NULL, NULL, NULL),
  (46, 'youtube', 'video',  50, NULL, 14, 'Desayunos de una semana',
    'Siete desayunos distintos para una semana, con lista de compras', '{desayuno,mealprep,semana}', '{}', 540, 61000, 720, NULL, NULL, NULL, NULL),
  (47, 'youtube', 'shorts', 58, NULL, 19, 'Huevos: cinco formas',
    'Huevos de cinco formas en un minuto #shorts #huevos #desayuno', '{shorts,huevos,desayuno}', '{}', 59, 35000, 720, NULL, NULL, NULL, NULL),
  (48, 'youtube', 'video',  70, NULL, 14, 'Lasaña para principiantes',
    'Lasaña para principiantes: sin bechamel complicada y sin miedo', '{lasana,cena,principiantes}', '{}', 620, 48000, 720, NULL, NULL, NULL, NULL),
  (49, 'youtube', 'shorts', 86, NULL, 19, 'Papas fritas crocantes en casa',
    'Papas fritas crocantes en casa: el doble frito #shorts #papas #truco', '{shorts,papas,truco}', '{}', 45, 46000, 720, NULL, NULL, NULL, NULL),
  (50, 'youtube', 'video', 100, NULL, 14, 'Guía de especias básicas',
    'Guía de especias básicas: las diez que sí necesitas en la cocina', '{especias,guia,cocina}', '{}', 700, 39000, 720, NULL, NULL, NULL, NULL),
  -- Facebook · los dos de "Mis videos" del mock
  (51, 'facebook', 'feed',  8, NULL, 19, 'Qué cocino un lunes sin ganas',
    'Qué cocino un lunes sin ganas de cocinar 🙃 #cena #recetafacil', '{cena,recetafacil}', '{}', 62, 31000, 192, 4.2, 0.31, NULL, NULL),
  (52, 'facebook', 'feed', 28, NULL, 23, 'Respondo sus preguntas de cocina',
    'Respondo sus preguntas de cocina: las que más se repiten en los comentarios', '{preguntas,cocina}', '{}', 140, 12000, 672, 1.2, 0.18, NULL, NULL),
  -- Facebook · el resto
  (53, 'facebook', 'feed',  35, NULL, 19, 'La receta de mi mamá: arroz con pollo',
    'La receta de mi mamá: arroz con pollo para 6 personas 🍗 #arrozconpollo #recetadefamilia', '{arrozconpollo,recetadefamilia}', '{}', 95, 24000, 720, NULL, NULL, NULL, NULL),
  (54, 'facebook', 'feed',  42, NULL, 16, 'Cómo guardar el cilantro fresco',
    'Cómo guardar el cilantro para que dure dos semanas 🌿 #cilantro #truco', '{cilantro,truco}', '{}', 58, 19000, 720, NULL, NULL, NULL, NULL),
  (55, 'facebook', 'feed',  49, NULL, 19, 'Sopa de verduras para toda la semana',
    'Sopa de verduras para toda la semana, en una sola olla 🥕 #sopa #mealprep', '{sopa,mealprep}', '{}', 88, 21000, 720, NULL, NULL, NULL, NULL),
  (56, 'facebook', 'feed',  57, NULL, 19, 'Trucos para una cocina pequeña',
    'Trucos para una cocina pequeña: orden, ollas y lo que no hace falta', '{cocinapequena,orden}', '{}', 120, 17000, 720, NULL, NULL, NULL, NULL),
  (57, 'facebook', 'feed',  65, NULL, 16, 'Postre de natas de la abuela',
    'Postre de natas de la abuela, paso a paso 🍮 #postredenatas #recetadefamilia', '{postredenatas,recetadefamilia}', '{}', 92, 26000, 720, NULL, NULL, NULL, NULL),
  (58, 'facebook', 'feed',  78, NULL, 19, 'Mercado económico en la plaza',
    'Mercado económico en la plaza: qué comprar y qué no 🧺 #plaza #ahorro', '{plaza,ahorro}', '{}', 150, 22000, 720, NULL, NULL, NULL, NULL),
  (59, 'facebook', 'feed',  90, NULL, 19, 'Torta de banano sin horno',
    'Torta de banano sin horno, en sartén 🍌 #torta #sinhorno', '{torta,sinhorno}', '{}', 84, 28000, 720, NULL, NULL, NULL, NULL),
  (60, 'facebook', 'feed', 110, NULL, 16, 'Cena rápida para visitas',
    'Cena rápida para visitas en 20 minutos 🍝 #cena #recetafacil', '{cena,recetafacil}', '{}', 76, 18000, 720, NULL, NULL, NULL, NULL)
) AS v(seq, platform, surface, days_ago, fixed_at, hour_utc, title, caption, hashtags, mentions, duration_s, v_ref, ref_age_h, saves_per_1k, nofol, skip3, link_rate)
),

-- ---------------------------------------------------------------------
-- 3b · Los videos que faltan: del último publicado hasta ayer
-- ---------------------------------------------------------------------
-- Los sesenta de arriba se CONGELAN en la primera corrida (el
-- published_at guardado manda). Sin nada más, volver a sembrar la misma
-- base seis semanas después dejaba la parrilla muerta: cero videos en
-- los últimos 30 días y el más nuevo con 42 días, justo al lado de unas
-- conexiones "sincronizadas hace 3 h", un radar de esta semana y una
-- curva de seguidores que llega hasta ayer. El contraste era peor que
-- tenerlo todo viejo.
--
-- Aquí se le aplica a los videos la MISMA regla que a la serie de la
-- cuenta (sección 5): lo publicado no se toca y se AÑADE lo que falta.
-- Un video cada dos días desde el ancla —el último video de la lista de
-- arriba, que ya está congelado y por eso nunca se mueve— hasta ayer.
--   seq = 60 + n, con n contado DESDE EL ANCLA, no desde el último
--   video generado: así el video del día X tiene siempre el mismo id,
--   se siembre una vez o diez, y ningún id se reutiliza.
--   id  = …-00000000 || hex(0x0d00 + seq): 0d3d, 0d3e, … justo después
--   de los sesenta (0d01..0d3c). Caben 58 000, no 195.
-- Sembrando en limpio no entra ninguno: el video más nuevo de la lista
-- es de ayer, así que el primer día candidato (ancla + 2) es mañana, y
-- los conteos de una base recién sembrada siguen siendo 60 videos.
-- El texto, la red y la duración salen de una rotación de veinticuatro
-- recetas (ninguna repetida de las sesenta) y las views de una función
-- cerrada de seq: dos corridas dan exactamente lo mismo, sin random().
-- Sus lecturas, su línea base y su puntaje los calculan las secciones 4
-- y 7 sin saber que estos videos son distintos de los otros.
seed_ancla AS (
  SELECT COALESCE(max(p.published_at)::date, CURRENT_DATE - 1) AS dia
  FROM post p
  WHERE p.workspace_id = '00000002-0000-4000-8000-000000000001'
    AND p.id BETWEEN '00000002-0000-4000-8000-000000000d01'
                 AND '00000002-0000-4000-8000-000000000d3c'
),

seed_nuevo AS (
SELECT (60 + g.n)::int AS seq, t.platform, t.surface, NULL::int AS days_ago,
       ((a.dia + 2 * g.n)::timestamp + make_interval(hours => t.hour_utc)) AT TIME ZONE 'UTC' AS fixed_at,
       NULL::int AS hour_utc, t.title, t.caption, t.hashtags, '{}'::text[] AS mentions, t.duration_s,
       -- views a 30 días: la base de la red movida entre 0,75 y 1,34 por
       -- una función de seq, así que la misma receta no repite cifra al
       -- volver a salir 48 días después.
       round(t.v_base * (0.75 + (((60 + g.n) * 29) % 60) / 100.0))::int AS v_ref,
       720 AS ref_age_h,
       NULL::numeric AS saves_per_1k, NULL::numeric AS nofol, NULL::numeric AS skip3, NULL::numeric AS link_rate
FROM seed_ancla a
-- Los días que van del ancla a ayer, uno de cada dos. Con el ancla en
-- ayer (base recién sembrada) el rango es vacío.
CROSS JOIN generate_series(1, greatest(0, ((CURRENT_DATE - 1) - a.dia) / 2)) AS g(n)
CROSS JOIN LATERAL (
  SELECT * FROM (VALUES
    -- k, platform, surface, hour_utc, duration_s, v_base, title, caption, hashtags
    ( 0, 'tiktok',    'feed',   19,  38, 110000, 'Arroz con pollo en una sola olla',
      'Arroz con pollo en una sola olla, sin dorar aparte 🍗 #arrozconpollo #cocinafacil #unaolla', '{arrozconpollo,cocinafacil,unaolla}'::text[]),
    ( 1, 'instagram', 'reels',  19,  35,  70000, 'Desayuno de 5 minutos con avena y banano',
      'Desayuno de 5 minutos con avena y banano maduro 🍌 #desayuno #avena #recetafacil', '{desayuno,avena,recetafacil}'),
    ( 2, 'youtube',   'video',  14, 520,  55000, 'Cinco cenas de la semana en una hora',
      'Cinco cenas para toda la semana, cocinadas en una hora y con lista de compras', '{cena,mealprep,semana}'),
    ( 3, 'tiktok',    'feed',   19,  31, 110000, 'El truco para que el aguacate no se dañe',
      'El truco para que el aguacate no se ponga negro 🥑 #aguacate #truco #cocinafacil', '{aguacate,truco,cocinafacil}'),
    ( 4, 'facebook',  'feed',   16, 110,  22000, 'Sancocho de gallina como en casa',
      'Sancocho de gallina como lo hacía mi abuela, paso a paso 🍲 #sancocho #cocinacolombiana', '{sancocho,cocinacolombiana}'),
    ( 5, 'tiktok',    'feed',   23,  29, 110000, 'Chocolate caliente espeso sin grumos',
      'Chocolate caliente espeso y sin un solo grumo ☕ #chocolate #desayuno #truco', '{chocolate,desayuno,truco}'),
    ( 6, 'instagram', 'reels',  19,  42,  70000, 'Bowl de pollo y arroz para llevar',
      'Bowl de pollo y arroz para llevar al trabajo 🥡 #mealprep #almuerzo #recetafacil', '{mealprep,almuerzo,recetafacil}'),
    ( 7, 'tiktok',    'feed',   19,  33, 110000, 'Mazamorra rápida en olla a presión',
      'Mazamorra en 20 minutos con olla a presión 🌽 #mazamorra #cocinacolombiana #ollaapresion', '{mazamorra,cocinacolombiana,ollaapresion}'),
    ( 8, 'youtube',   'shorts', 19,  54,  42000, 'Cómo organizar la nevera para cocinar rápido',
      'Cómo organizo la nevera para cocinar rápido entre semana #shorts #orden #cocina', '{shorts,orden,cocina}'),
    ( 9, 'instagram', 'reels',  16,  46,  70000, 'Tortillas de maíz caseras',
      'Tortillas de maíz caseras con tres ingredientes 🌽 #tortillas #recetafacil #maiz', '{tortillas,recetafacil,maiz}'),
    (10, 'tiktok',    'feed',   19,  40, 110000, 'Frijoles en 30 minutos sin remojar',
      'Frijoles en 30 minutos y sin remojarlos desde anoche 🫘 #frijoles #almuerzo #truco', '{frijoles,almuerzo,truco}'),
    (11, 'facebook',  'feed',   19, 130,  22000, 'Mi lista de mercado de 100 mil',
      'Mi lista de mercado de 100 mil pesos para una semana 🧾 #mercado #ahorro', '{mercado,ahorro}'),
    (12, 'tiktok',    'feed',   19,  36, 110000, 'Salchipapa casera al horno',
      'Salchipapa casera al horno, con salsa de la casa 🍟 #salchipapa #alhorno #recetafacil', '{salchipapa,alhorno,recetafacil}'),
    (13, 'instagram', 'reels',  12,  37,  70000, 'Yogur casero con dos ingredientes',
      'Yogur casero con dos ingredientes y sin máquina 🥛 #yogur #desayuno #recetafacil', '{yogur,desayuno,recetafacil}'),
    (14, 'youtube',   'video',  14, 560,  55000, 'Almuerzos de oficina para toda la semana',
      'Cinco almuerzos de oficina que aguantan la nevera y el microondas', '{almuerzo,mealprep,oficina}'),
    (15, 'youtube',   'shorts', 19,  50,  42000, 'Pescado al horno que no huele',
      'Pescado al horno que no deja oliendo la casa #shorts #pescado #cena', '{shorts,pescado,cena}'),
    (16, 'instagram', 'reels',  19,  39,  70000, 'Crema de auyama en 15 minutos',
      'Crema de auyama en 15 minutos, con lo que ya tienes 🎃 #crema #auyama #cena', '{crema,auyama,cena}'),
    (17, 'tiktok',    'feed',   19,  43, 110000, 'Pan casero sin amasar',
      'Pan casero sin amasar: se mezcla y al horno 🍞 #pan #sinamasar #recetafacil', '{pan,sinamasar,recetafacil}'),
    (18, 'facebook',  'feed',   19,  96,  22000, 'Qué hacer con el pollo de ayer',
      'Tres formas de aprovechar el pollo de ayer sin que sepa a sobras 🍗 #sobras #ahorro', '{sobras,ahorro}'),
    (19, 'youtube',   'shorts', 19,  57,  42000, 'Guía para comprar carne barata',
      'Cómo comprar carne barata y que quede blanda #shorts #carne #ahorro', '{shorts,carne,ahorro}'),
    (20, 'tiktok',    'feed',   16,  32, 110000, 'Limonada de coco sin licuadora grande',
      'Limonada de coco sin licuadora grande y sin grumos 🥥 #limonadadecoco #bebida #verano', '{limonadadecoco,bebida,verano}'),
    (21, 'instagram', 'reels',  19,  44,  70000, 'Ensalada de pasta para el calor',
      'Ensalada de pasta para el calor, aguanta dos días 🥗 #ensalada #pasta #mealprep', '{ensalada,pasta,mealprep}'),
    (22, 'instagram', 'reels',  19,  48,  70000, 'Torta de zanahoria en licuadora',
      'Torta de zanahoria hecha toda en la licuadora 🥕 #torta #zanahoria #postre', '{torta,zanahoria,postre}'),
    (23, 'facebook',  'feed',   16, 104,  22000, 'Cómo congelar comida sin perder sabor',
      'Cómo congelar comida sin que pierda sabor ni textura 🧊 #congelar #mealprep', '{congelar,mealprep}')
  ) AS x(k, platform, surface, hour_utc, duration_s, v_base, title, caption, hashtags)
  WHERE x.k = (g.n - 1) % 24
) t
),

-- Los sesenta de siempre, más los que hagan falta para que la parrilla
-- llegue hasta esta semana. De aquí para abajo son todos iguales.
seed_post AS (
  SELECT * FROM seed_post_base
  UNION ALL
  SELECT * FROM seed_nuevo
),

-- Lo derivado: fecha de publicación, ids, curva y tasas por post.
-- La curva de views acumuladas es
--   f(h) = 0,85·(1 − e^(−h/τ1)) + 0,15·(1 − e^(−h/400))
-- dos exponenciales: una rápida (τ1 por red: TikTok 24 h, Instagram
-- 30 h, Facebook 36 h, YouTube 48 h) que pone el 80 % de las views en
-- los primeros tres días, y una cola lenta de 400 h que sigue sumando
-- semanas después. views(h) = v_ref · f(h) / f(ref_age_h).
-- Las tasas (likes, comentarios, compartidos…) varían por post con
-- (seq·k) % n: deterministas y distintas entre sí, sin random().
seed_post_curve AS (
SELECT
  p.*,
  -- …-00000000 || hex(0x0d00 + seq). Para los sesenta de la lista da
  -- exactamente los ids de siempre (0d01..0d3c) y deja sitio de sobra
  -- para los de 3b, que siguen en 0d3d.
  ('00000002-0000-4000-8000-00000000' || lpad(to_hex(3328 + p.seq), 4, '0'))::uuid AS post_id,
  CASE p.platform
    WHEN 'instagram' THEN '00000002-0000-4000-8000-0000000000c1'::uuid
    WHEN 'tiktok'    THEN '00000002-0000-4000-8000-0000000000c2'::uuid
    WHEN 'youtube'   THEN '00000002-0000-4000-8000-0000000000c3'::uuid
    ELSE                  '00000002-0000-4000-8000-0000000000c4'::uuid
  END AS connection_id,
  -- Si el post ya existe (corrida anterior), su fecha guardada manda.
  -- La subconsulta ve la foto previa a la sentencia: NULL en la primera
  -- corrida, el valor guardado en las siguientes.
  COALESCE(
    (SELECT x.published_at FROM post x
      WHERE x.id = ('00000002-0000-4000-8000-00000000' || lpad(to_hex(3328 + p.seq), 4, '0'))::uuid),
    p.fixed_at,
    ((CURRENT_DATE - p.days_ago) + make_interval(hours => p.hour_utc)) AT TIME ZONE 'UTC'
  ) AS published_at,
  CASE p.platform
    WHEN 'tiktok'    THEN 'tt_7400000000000000d' || lpad(to_hex(p.seq), 2, '0')
    WHEN 'instagram' THEN 'ig_18000000000000d'   || lpad(to_hex(p.seq), 2, '0')
    WHEN 'youtube'   THEN 'yt_demo00000000d'     || lpad(to_hex(p.seq), 2, '0')
    ELSE                  'fb_1000000000000d'    || lpad(to_hex(p.seq), 2, '0')
  END AS external_post_id,
  CASE p.platform
    WHEN 'tiktok'    THEN 'https://www.tiktok.com/@laura.cocinafacil/video/demo-d' || lpad(to_hex(p.seq), 2, '0')
    WHEN 'instagram' THEN 'https://www.instagram.com/reel/demo-d' || lpad(to_hex(p.seq), 2, '0') || '/'
    WHEN 'youtube'   THEN CASE WHEN p.surface = 'shorts'
                               THEN 'https://www.youtube.com/shorts/demo-d' || lpad(to_hex(p.seq), 2, '0')
                               ELSE 'https://www.youtube.com/watch?v=demo-d' || lpad(to_hex(p.seq), 2, '0') END
    ELSE                  'https://www.facebook.com/lauracocinafacil/videos/demo-d' || lpad(to_hex(p.seq), 2, '0')
  END AS url,
  CASE p.platform WHEN 'tiktok' THEN 24.0 WHEN 'instagram' THEN 30.0 WHEN 'youtube' THEN 48.0 ELSE 36.0 END AS tau1,
  CASE p.platform WHEN 'tiktok' THEN 0.65 WHEN 'instagram' THEN 0.72 WHEN 'youtube' THEN 0.71 ELSE 0.70 END AS reach_ratio,
  0.045  + ((p.seq * 7) % 10) / 1000.0   AS like_rate,
  0.0015 + ((p.seq * 3) % 6)  / 10000.0  AS comment_rate,
  0.006  + ((p.seq * 3) % 5)  / 1000.0   AS share_rate,
  COALESCE(p.saves_per_1k, 6 + ((p.seq * 11) % 9))            AS saves_1k,
  COALESCE(p.nofol, 0.35 + ((p.seq * 13) % 30) / 100.0)        AS nofol_share,
  CASE WHEN p.platform IN ('tiktok', 'instagram')
       THEN COALESCE(p.skip3, 0.20 + ((p.seq * 17) % 22) / 100.0) END AS skip_rate,
  CASE WHEN p.platform IN ('tiktok', 'youtube')
       THEN 0.05 + ((p.seq * 5) % 9) / 100.0 END                AS completion,
  0.22 + ((p.seq * 3) % 25) / 100.0                             AS watch_ratio,
  (p.seq <= 5)                                                  AS branded
FROM seed_post p
),

-- El post. ON CONFLICT DO NOTHING: en la segunda pasada no hace nada.
-- RETURNING, para que la consulta principal lo lea (abajo, «ins_post
-- primero»).
ins_post AS (
INSERT INTO post (id, workspace_id, creator_id, connection_id, platform_id, external_post_id, url, media_type, surface,
                  title, caption, hashtags, mentions, duration_s, is_branded_content, published_at, first_seen_at)
SELECT c.post_id, '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000003', c.connection_id, c.platform,
       c.external_post_id, c.url, 'video', c.surface,
       c.title, c.caption, c.hashtags, c.mentions, c.duration_s, c.branded, c.published_at, c.published_at + interval '1 hour'
FROM seed_post_curve c
ON CONFLICT DO NOTHING
RETURNING id
),


-- ---------------------------------------------------------------------
-- 4 · Lecturas de cada video: la curva acumulada
-- ---------------------------------------------------------------------
-- Una lectura a 1, 3, 6, 12, 24, 48 y 72 h, y luego una diaria hasta
-- los 90 días (2 160 h), solo las que ya ocurrieron según el reloj del
-- seed (captured_at <= medianoche UTC de hoy). age_hours es exacta por
-- construcción, así que los cortes canónicos (24, 72, 168, 720)
-- encuentran su lectura justa. Sin clave natural en la tabla: el
-- duplicado se evita por (post_id, captured_at), y como captured_at
-- sale del published_at guardado, una corrida en otro día solo añade
-- las lecturas que la curva alcanzó desde entonces.
-- =====================================================================
seed_age AS (
SELECT h FROM (VALUES (1), (3), (6), (12), (24), (48), (72)) AS v(h)
UNION ALL
SELECT generate_series(96, 2160, 24)
)
INSERT INTO post_metric_snapshot
  (post_id, workspace_id, captured_at, age_hours, views, reach, likes, comments, shares, saves, total_interactions,
   avg_watch_time_s, completion_rate, skip_rate_3s, profile_visits, follows_from_post, link_clicks,
   reach_followers, reach_non_followers, source)
SELECT c.post_id, '00000002-0000-4000-8000-000000000001', c.published_at + make_interval(hours => a.h), a.h,
       x.v, y.reach, y.likes, y.comments, y.shares, y.saves, y.likes + y.comments + y.shares + y.saves,
       round(c.duration_s * c.watch_ratio, 3), c.completion, c.skip_rate,
       round(x.v * 0.0099), round(x.v * 0.0019), CASE WHEN c.branded THEN round(x.v * c.link_rate) END,
       y.reach - y.reach_nf, y.reach_nf, 'api'
FROM seed_post_curve c
CROSS JOIN seed_age a
CROSS JOIN LATERAL (
  SELECT round(c.v_ref
               * (0.85 * (1 - exp(-a.h / c.tau1))         + 0.15 * (1 - exp(-a.h / 400.0)))
               / (0.85 * (1 - exp(-c.ref_age_h / c.tau1)) + 0.15 * (1 - exp(-c.ref_age_h / 400.0))))::bigint AS v
) x
CROSS JOIN LATERAL (
  SELECT round(x.v * c.reach_ratio)::bigint AS reach,
         round(x.v * c.like_rate)::bigint    AS likes,
         round(x.v * c.comment_rate)::bigint AS comments,
         round(x.v * c.share_rate)::bigint   AS shares,
         round(x.v * c.saves_1k / 1000)::bigint AS saves,
         round(x.v * c.reach_ratio * c.nofol_share)::bigint AS reach_nf
) y
WHERE c.published_at + make_interval(hours => a.h) <= date_trunc('day', now())
  -- ins_post primero. Un INSERT en un WITH que nadie lee se ejecuta
  -- AL FINAL de la sentencia, y desde 0025 cada lectura lleva el
  -- disparador assert_reference_visible en post_id (la web también
  -- inserta lecturas: el CSV de RES-2), que busca el post al insertar
  -- la fila. Leer ins_post aquí —un subplan que se evalúa una vez,
  -- antes de la primera fila— obliga a insertar los posts antes, y el
  -- disparador, que corre en una función volátil, ya los ve.
  AND (SELECT count(*) FROM ins_post) >= 0
  AND NOT EXISTS (
    SELECT 1 FROM post_metric_snapshot s
    WHERE s.post_id = c.post_id AND s.captured_at = c.published_at + make_interval(hours => a.h)
  );


-- =====================================================================
-- 5 · La serie de la cuenta, por red: noventa días, y los que vengan
-- ---------------------------------------------------------------------
-- Seguidores: de los valores de hace 90 días a los de FOLLOWERS_NOW del
-- mock (TikTok 214 000, Instagram 128 000, YouTube 49 000, Facebook
-- 21 000 = 412 000). La ganancia diaria es un peso determinista
-- 0,6..1,4 sobre (d·37 + red·11) % 100, con el salto de TikTok de la
-- semana 9 (días 63–69) y el empujón de Instagram desde el día 77, como
-- en followersSeries() del mock. Se acumula con redondeo sobre la suma
-- acumulada de pesos, así que el día 89 da exactamente el valor final
-- y la serie nunca baja.
-- Views diarias: una base por red (TikTok 39 400, Instagram 18 100,
-- YouTube 7 400, Facebook 2 300; el reparto por red es el de weeklyViews()
-- del mock) con oscilación 0,75..1,25, tendencia de +16 % en el
-- trimestre y el pico de TikTok de la semana 9 (×1,9) más el del reto
-- de la arepa (días 85–87, ×1,5). La base está calibrada para que los
-- últimos 30 días, con la tendencia y el pico de la arepa dentro de la
-- ventana, sumen ≈ 2,6 M: el KPI "Views en 30 días" del mock.
--
-- La serie llega SIEMPRE hasta ayer, también al volver a sembrar una
-- base que ya la tiene. El día 0 se ancla al primer día guardado (si lo
-- hay) y se generan los días que falten desde entonces hasta ayer: d
-- pasa de 89 en una base vieja, UNIQUE (connection_id, day, source)
-- deja fuera los días que ya están y solo entran los nuevos. Por eso el
-- normalizador de los seguidores es la suma de pesos de los días 0..89
-- (constante) y no la del rango generado: los días ya guardados vuelven
-- a dar exactamente el mismo número, y los nuevos siguen subiendo por
-- encima de FOLLOWERS_NOW en vez de dejar un escalón. Anclar por el
-- final (día 89 = ayer) daría ese escalón: la parte vieja de la serie
-- ya vale 214 000 seguidores en TikTok y la nueva volvería a empezar en
-- 205 000, y "la serie nunca baja" dejaría de ser cierto.
-- El día 89 de la primera corrida es AYER (día 0 = CURRENT_DATE - 90):
-- el job nocturno solo tiene cerrado el día anterior, y así el aviso
-- «datos hasta el {fecha}» de Resumen nunca dice "hoy" con un día a
-- medias. Cada día se captura a las 05:00 UTC del día siguiente (la
-- hora del job), que para el último día ya pasó siempre.
-- =====================================================================
INSERT INTO account_metric_snapshot
  (connection_id, workspace_id, captured_at, day, followers, following, media_count, views, reach,
   profile_views, accounts_engaged, total_interactions, follows, unfollows, website_clicks, source)
SELECT s.connection_id, '00000002-0000-4000-8000-000000000001',
       ((s.day + 1)::timestamp + interval '5 hours') AT TIME ZONE 'UTC',
       s.day, s.followers, s.following, s.media_count, s.views, round(s.views * 0.80),
       round(s.views * 0.020), round(s.views * 0.050), round(s.views * 0.060),
       s.gain + round(s.gain * 0.25), round(s.gain * 0.25), round(s.views * 0.002), 'api'
FROM (
  SELECT c.*, w.d, w.day, w.views,
         c.f_start + round((c.f_end - c.f_start) * w.cw / w.sw)::bigint AS followers,
         c.f_start + round((c.f_end - c.f_start) * w.cw / w.sw)::bigint
           - lag(c.f_start + round((c.f_end - c.f_start) * w.cw / w.sw)::bigint, 1,
                 c.f_start + round((c.f_end - c.f_start) * w.cw / w.sw)::bigint) OVER (PARTITION BY c.connection_id ORDER BY w.d) AS gain,
         c.media_base + (w.d * 30) / 90 AS media_count
  FROM (VALUES
    ('00000002-0000-4000-8000-0000000000c2'::uuid, 'tiktok',    1, 196000, 214000, 39400, 312,  640),
    ('00000002-0000-4000-8000-0000000000c1'::uuid, 'instagram', 2, 119500, 128000, 18100, 488,  910),
    ('00000002-0000-4000-8000-0000000000c3'::uuid, 'youtube',   3,  45200,  49000,  7400,  57,  214),
    ('00000002-0000-4000-8000-0000000000c4'::uuid, 'facebook',  4,  20100,  21000,  2300,  40,  530)
  ) AS c(connection_id, platform, pcode, f_start, f_end, views_base, following, media_base)
  CROSS JOIN LATERAL (
    -- El día 0: el primer día ya guardado, o hace 90 días si la base
    -- está limpia. El último día generado es siempre ayer.
    SELECT COALESCE((SELECT min(a.day) FROM account_metric_snapshot a
                      WHERE a.connection_id = c.connection_id AND a.source = 'api'),
                    CURRENT_DATE - 90) AS dia_cero
  ) a0
  CROSS JOIN LATERAL (
    SELECT g.d, a0.dia_cero + g.d AS day,
           sum(g.wt) OVER (ORDER BY g.d)                  AS cw,
           -- Normalizador fijo: los noventa primeros días. Así cw/sw
           -- vale 1 el día 89 (FOLLOWERS_NOW) y pasa de 1 después.
           sum(g.wt) FILTER (WHERE g.d <= 89) OVER ()     AS sw,
           round(c.views_base
                 * (0.75 + 0.5 * (((g.d * 53 + c.pcode * 7) % 100) / 100.0))
                 * (1 + g.d * 0.0018)
                 * CASE WHEN c.platform = 'tiktok' AND g.d BETWEEN 62 AND 68 THEN 1.9
                        WHEN c.platform = 'tiktok' AND g.d BETWEEN 85 AND 87 THEN 1.5
                        ELSE 1.0 END)::bigint AS views
    FROM (
      SELECT d,
             0.6 + 0.8 * (((d * 37 + c.pcode * 11) % 100) / 100.0)
               + CASE WHEN c.platform = 'tiktok'    AND d BETWEEN 63 AND 69 THEN 3.2
                      WHEN c.platform = 'instagram' AND d > 76              THEN 0.9
                      ELSE 0 END AS wt
      FROM generate_series(0, greatest(89, (CURRENT_DATE - 1) - a0.dia_cero)) AS d
    ) g
  ) w
) s
ON CONFLICT (connection_id, day, source) DO NOTHING;


-- =====================================================================
-- 6 · Demografía de la audiencia, por cuenta
-- ---------------------------------------------------------------------
-- Shares de seguidores por edad, género y país, con la foto de hoy. La
-- base es la del media kit del mock (71 % entre 18 y 34, 64 % mujeres,
-- Colombia 71 %, México 11 %, EE. UU. 6 %) y cada red se desvía unos
-- puntos: TikTok más joven y más México, YouTube más adulto y más
-- EE. UU., Facebook mayor y más Colombia. Cada ajuste suma cero dentro
-- de su dimensión, así que los shares siguen sumando 1.
--
-- El share es ESTRUCTURAL (cómo es la audiencia) y se congela; las
-- PERSONAS salen del último día de la serie de la cuenta (sección 5),
-- no de un literal, y se refrescan con la foto en cada corrida. Con el
-- literal y DO NOTHING la demografía acababa contradiciendo al resto de
-- la demo: tras resembrar a +41 días la serie daba 427 227 seguidores y
-- audience_breakdown seguía sumando 412 000, con day de hace seis
-- semanas, en la misma pantalla. Por eso captured_at, day y absolute
-- van en el DO UPDATE: así la columna de frescura que el encabezado de
-- este archivo promete es de verdad frescura.
-- =====================================================================
INSERT INTO audience_breakdown
  (id, workspace_id, scope, connection_id, captured_at, day, population, dimension, bucket, share, absolute)
SELECT ('00000002-0000-4000-8000-0000ad' || lpad(to_hex(c.pcode * 100 + b.n), 6, '0'))::uuid,
       '00000002-0000-4000-8000-000000000001', 'account', c.connection_id, now(), CURRENT_DATE, 'followers',
       b.dimension, b.bucket, b.share + COALESCE(adj.delta, 0),
       round(f.followers * (b.share + COALESCE(adj.delta, 0)))::bigint
FROM (VALUES
  ('00000002-0000-4000-8000-0000000000c2'::uuid, 'tiktok',    1, 214000),
  ('00000002-0000-4000-8000-0000000000c1'::uuid, 'instagram', 2, 128000),
  ('00000002-0000-4000-8000-0000000000c3'::uuid, 'youtube',   3,  49000),
  ('00000002-0000-4000-8000-0000000000c4'::uuid, 'facebook',  4,  21000)
) AS c(connection_id, platform, pcode, followers_mock)
-- Los seguidores de HOY, los mismos que enseña Resumen. La sección 5 ya
-- corrió, así que la serie existe; el valor del mock queda solo como
-- respaldo para una base a la que le falte la serie.
CROSS JOIN LATERAL (
  SELECT COALESCE((SELECT a.followers FROM account_metric_snapshot a
                    WHERE a.connection_id = c.connection_id AND a.source = 'api'
                    ORDER BY a.day DESC LIMIT 1), c.followers_mock) AS followers
) f
CROSS JOIN (VALUES
  ( 1, 'age',     '13-17', 0.04), ( 2, 'age',     '18-24', 0.31), ( 3, 'age',     '25-34', 0.40),
  ( 4, 'age',     '35-44', 0.15), ( 5, 'age',     '45-54', 0.07), ( 6, 'age',     '55+',   0.03),
  ( 7, 'gender',  'F',     0.64), ( 8, 'gender',  'M',     0.36),
  ( 9, 'country', 'CO',    0.71), (10, 'country', 'MX',    0.11), (11, 'country', 'US',    0.06),
  (12, 'country', 'ES',    0.04), (13, 'country', 'PE',    0.03), (14, 'country', 'EC',    0.02),
  (15, 'country', 'OTHER', 0.03)
) AS b(n, dimension, bucket, share)
LEFT JOIN (VALUES
  ('tiktok',   'age', '18-24',  0.03), ('tiktok',   'age', '25-34', -0.03),
  ('youtube',  'age', '18-24', -0.03), ('youtube',  'age', '35-44',  0.03),
  ('facebook', 'age', '18-24', -0.06), ('facebook', 'age', '25-34', -0.04),
  ('facebook', 'age', '45-54',  0.06), ('facebook', 'age', '55+',    0.04),
  ('tiktok',   'gender', 'F', -0.03), ('tiktok',   'gender', 'M',  0.03),
  ('youtube',  'gender', 'F', -0.06), ('youtube',  'gender', 'M',  0.06),
  ('facebook', 'gender', 'F',  0.06), ('facebook', 'gender', 'M', -0.06),
  ('tiktok',   'country', 'CO', -0.02), ('tiktok',   'country', 'MX',  0.02),
  ('youtube',  'country', 'CO', -0.02), ('youtube',  'country', 'US',  0.02),
  ('facebook', 'country', 'CO',  0.05), ('facebook', 'country', 'MX', -0.02),
  ('facebook', 'country', 'US', -0.02), ('facebook', 'country', 'ES', -0.01)
) AS adj(platform, dimension, bucket, delta)
  ON adj.platform = c.platform AND adj.dimension = b.dimension AND adj.bucket = b.bucket
-- El id fijo (…-0000ad + red·100 + fila) es la clave de idempotencia.
-- El share no se toca (es estructural); la foto y las personas sí, para
-- que la suma de `absolute` sea siempre la de la última lectura de
-- seguidores.
ON CONFLICT (id) DO UPDATE SET
  captured_at = EXCLUDED.captured_at,
  day         = EXCLUDED.day,
  absolute    = EXCLUDED.absolute;


-- =====================================================================
-- 7 · Línea base por red y corte, y puntaje de cada video
-- ---------------------------------------------------------------------
-- Se CALCULAN sobre las lecturas de arriba, con la misma regla que
-- packages/core/src/scoring.ts: mediana (no promedio) de los últimos
-- 20 videos que ya alcanzaron el corte, medida a esa misma edad
-- (post_metrics_at_cut). percentile_cont(0,5) es la mediana de
-- median(); percentile_cont(0,25/0,75) interpola igual que
-- percentile(). is_reliable pide 8 videos (MIN_SAMPLE_FOR_BASELINE).
-- computed_at es la medianoche UTC de hoy: es lo que dejaría el job
-- nocturno, y hace idempotente la fila dentro del día.
-- El id lleva el DÍA del cálculo, no solo la red y el corte: cada
-- siembra deja una línea base nueva (la tabla ya tiene UNIQUE (creator,
-- red, corte, computed_at) y un índice por computed_at DESC), y el
-- puntaje de más abajo usa la de max(computed_at). Con el id fijo por
-- (red, corte) la línea base se congelaba en la primera corrida y un
-- video puntuado hoy se comparaba contra la mediana de hace un mes,
-- calculada sobre una ventana de veinte videos que ya no era la actual.
-- =====================================================================
INSERT INTO creator_baseline
  (id, workspace_id, creator_id, platform_id, computed_at, window_posts, age_hours_cut, sample_size,
   median_views, p25_views, p75_views, median_reach, median_engagement, median_saves_per_1k,
   median_completion, median_skip_3s, is_reliable)
-- id = …-ba5 + red + corte (4 dígitos) + día en hexadecimal (días desde
-- el 1-ene-2026, cuatro dígitos: alcanza hasta el año 2205).
SELECT ('00000002-0000-4000-8000-ba5'
        || CASE r.platform_id WHEN 'tiktok' THEN '1' WHEN 'instagram' THEN '2' WHEN 'youtube' THEN '3' ELSE '4' END
        || lpad(r.cut::text, 4, '0')
        || lpad(to_hex(CURRENT_DATE - DATE '2026-01-01'), 4, '0'))::uuid,
       '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000003', r.platform_id,
       date_trunc('day', now()), 20, r.cut, count(*),
       round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY r.views)::numeric, 2),
       round(percentile_cont(0.25) WITHIN GROUP (ORDER BY r.views)::numeric, 2),
       round(percentile_cont(0.75) WITHIN GROUP (ORDER BY r.views)::numeric, 2),
       round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY r.reach)::numeric, 2),
       round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY r.engagement)::numeric, 6),
       round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY r.saves_per_1k)::numeric, 4),
       round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY r.completion_rate)::numeric, 5),
       round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY r.skip_rate_3s)::numeric, 5),
       count(*) >= 8
FROM (
  SELECT p.platform_id, c.cut, m.views, m.reach, m.completion_rate, m.skip_rate_3s,
         CASE WHEN m.views > 0 THEN m.total_interactions::numeric / m.views END AS engagement,
         CASE WHEN m.views > 0 THEN m.saves::numeric * 1000 / m.views END        AS saves_per_1k,
         row_number() OVER (PARTITION BY p.platform_id, c.cut ORDER BY p.published_at DESC) AS rn
  FROM post p
  CROSS JOIN (VALUES (24), (72), (168), (720)) AS c(cut)
  JOIN post_metrics_at_cut m ON m.post_id = p.id AND m.cut_hours = c.cut
  WHERE p.creator_id = '00000002-0000-4000-8000-000000000003'
    AND p.published_at <= date_trunc('day', now()) - make_interval(hours => c.cut)
) r
WHERE r.rn <= 20
GROUP BY r.platform_id, r.cut
ON CONFLICT DO NOTHING;

-- Cada video se puntúa en el mayor corte que ya alcanzó, contra la
-- línea base más reciente de su red en ese corte: la que acaba de
-- calcular la sentencia de arriba. Así una corrida posterior puntúa al
-- video que cumplió 24 h desde entonces contra la mediana de hoy, en
-- vez de dejarlo sin fila o compararlo con una mediana vieja.
-- versusMedian() devuelve null (no cero) con menos de 8 videos;
-- outlierTier(): ≥5 breakout, ≥2 outlier, ≥1,2 good, ≥0,7 normal, si
-- no under. is_outlier = ≥ 2.
--
-- post_score tiene PRIMARY KEY (post_id): es el puntaje VIGENTE del
-- video, no un registro append-only —el job compute.post_score lo
-- recalcula cada noche—, así que el puntaje SUBE de corte cuando el
-- video crece. Con DO NOTHING se congelaba en el corte de la primera
-- corrida: al resembrar a +41 días, 25 de 60 filas citaban un corte ya
-- superado y creator_post_board (0010_views_rls.sql) juntaba las views
-- de hoy (post_metrics_latest) con un "× mediana" medido a otra edad,
-- que es justo el error que scoring.ts existe para evitar.
-- La guarda WHERE age_hours_cut < EXCLUDED.age_hours_cut lo deja
-- MONÓTONO: el corte solo sube, nunca baja, así que dos corridas del
-- mismo día dan la misma fila y ninguna reescribe un puntaje por uno
-- medido antes.
INSERT INTO post_score
  (post_id, workspace_id, computed_at, baseline_id, age_hours_cut, views_at_cut,
   views_vs_median, reach_vs_median, saves_vs_median, engagement_vs_median, is_outlier, outlier_tier)
SELECT s.post_id, '00000002-0000-4000-8000-000000000001', date_trunc('day', now()), s.baseline_id, s.cut, s.views,
       s.views_vs, s.reach_vs, s.saves_vs, s.engagement_vs,
       COALESCE(s.views_vs >= 2, false),
       CASE WHEN s.views_vs IS NULL THEN NULL
            WHEN s.views_vs >= 5   THEN 'breakout'
            WHEN s.views_vs >= 2   THEN 'outlier'
            WHEN s.views_vs >= 1.2 THEN 'good'
            WHEN s.views_vs >= 0.7 THEN 'normal'
            ELSE 'under' END
FROM (
  SELECT p.id AS post_id, b.id AS baseline_id, k.cut, m.views,
         CASE WHEN b.sample_size >= 8 AND b.median_views > 0
              THEN round(m.views / b.median_views, 3) END AS views_vs,
         CASE WHEN b.sample_size >= 8 AND b.median_reach > 0
              THEN round(m.reach / b.median_reach, 3) END AS reach_vs,
         CASE WHEN b.sample_size >= 8 AND b.median_saves_per_1k > 0 AND m.views > 0
              THEN round((m.saves::numeric * 1000 / m.views) / b.median_saves_per_1k, 3) END AS saves_vs,
         CASE WHEN b.sample_size >= 8 AND b.median_engagement > 0 AND m.views > 0
              THEN round((m.total_interactions::numeric / m.views) / b.median_engagement, 3) END AS engagement_vs
  FROM post p
  CROSS JOIN LATERAL (
    SELECT CASE WHEN p.published_at <= date_trunc('day', now()) - interval '720 hours' THEN 720
                WHEN p.published_at <= date_trunc('day', now()) - interval '168 hours' THEN 168
                WHEN p.published_at <= date_trunc('day', now()) - interval '72 hours'  THEN 72
                WHEN p.published_at <= date_trunc('day', now()) - interval '24 hours'  THEN 24 END AS cut
  ) k
  JOIN post_metrics_at_cut m ON m.post_id = p.id AND m.cut_hours = k.cut
  JOIN creator_baseline b
    ON b.creator_id = p.creator_id AND b.platform_id = p.platform_id
   AND b.age_hours_cut = k.cut
   AND b.computed_at = (SELECT max(x.computed_at) FROM creator_baseline x
                         WHERE x.creator_id = b.creator_id AND x.platform_id = b.platform_id
                           AND x.age_hours_cut = b.age_hours_cut)
  WHERE p.creator_id = '00000002-0000-4000-8000-000000000003'
) s
ON CONFLICT (post_id) DO UPDATE SET
  computed_at          = EXCLUDED.computed_at,
  baseline_id          = EXCLUDED.baseline_id,
  age_hours_cut        = EXCLUDED.age_hours_cut,
  views_at_cut         = EXCLUDED.views_at_cut,
  views_vs_median      = EXCLUDED.views_vs_median,
  reach_vs_median      = EXCLUDED.reach_vs_median,
  saves_vs_median      = EXCLUDED.saves_vs_median,
  engagement_vs_median = EXCLUDED.engagement_vs_median,
  is_outlier           = EXCLUDED.is_outlier,
  outlier_tier         = EXCLUDED.outlier_tier
WHERE post_score.age_hours_cut < EXCLUDED.age_hours_cut;


-- =====================================================================
-- 8 · Ventas: las marcas
-- ---------------------------------------------------------------------
-- company es global (deduplicada por dominio); la relación con la
-- creadora vive en company_link. Las cuatro primeras son las de 0003
-- (clientes con factura); las otras cuatro entraron por el radar.
-- =====================================================================
INSERT INTO company (id, name, legal_name, domain, country, city, industry, niche_slugs, size_bucket, socials, runs_ads, ads_first_seen_at, ads_platforms, enriched_at)
VALUES
  ('00000002-0000-4000-8000-0000000000e1', 'Café Alma',        'Café Alma S.A.S.',            'cafealma.co',        'CO', 'Bogotá',   'alimentos', '{cocina}',         'pyme',    '{"instagram": "cafealma", "tiktok": "cafealma.co"}',                 true,  '2026-03-02 00:00:00+00', '{meta,tiktok}', '2026-07-22 12:00:00+00'),
  ('00000002-0000-4000-8000-0000000000e2', 'Fresko Market',    'Fresko Market S.A.S.',        'freskomarket.co',    'CO', 'Bogotá',   'alimentos', '{cocina}',         'mediana', '{"instagram": "freskomarket", "tiktok": "freskomarket"}',            true,  '2026-08-12 00:00:00+00', '{meta}',        '2026-08-12 09:00:00+00'),
  ('00000002-0000-4000-8000-0000000000e3', 'Hogar Lindo',      'Hogar Lindo Ltda.',           'hogarlindo.co',      'CO', 'Medellín', 'hogar',     '{hogar}',          'pyme',    '{"instagram": "hogarlindo"}',                                       false, NULL,                     '{}',            '2026-05-18 12:00:00+00'),
  ('00000002-0000-4000-8000-0000000000e4', 'Nutrivé',          'Nutrivé Alimentos S.A.S.',    'nutrive.co',         'CO', 'Cali',     'alimentos', '{cocina,fitness}', 'mediana', '{"instagram": "nutrive", "youtube": "NutriveOficial"}',              true,  '2026-01-15 00:00:00+00', '{meta,youtube}','2026-06-10 12:00:00+00'),
  ('00000002-0000-4000-8000-0000000000e5', 'Sabores Caseros',  'Sabores Caseros S.A.S.',      'saborescaseros.co',  'CO', 'Bogotá',   'alimentos', '{cocina}',         'pyme',    '{"instagram": "saborescaseros", "tiktok": "saborescaseros.co"}',     true,  '2026-07-30 00:00:00+00', '{tiktok}',      '2026-08-15 12:00:00+00'),
  -- Granos del Valle y Vitalé son las dos historias relativas (ver
  -- sección 10): su pauta y su enriquecimiento también lo son.
  ('00000002-0000-4000-8000-0000000000e6', 'Granos del Valle', 'Granos del Valle S.A.',       'granosdelvalle.co',  'CO', 'Cali',     'alimentos', '{cocina}',         'mediana', '{"instagram": "granosdelvalle", "tiktok": "granosdelvalle"}',        true,  (CURRENT_DATE - 32)::timestamp AT TIME ZONE 'UTC', '{tiktok,meta}', (CURRENT_DATE - 24 + time '12:00') AT TIME ZONE 'UTC'),
  ('00000002-0000-4000-8000-0000000000e7', 'Vitalé',           'Vitalé Bienestar S.A.S.',     'vitale.co',          'CO', 'Medellín', 'bienestar', '{cocina,fitness}', 'pyme',    '{"instagram": "vitale.co"}',                                        true,  (CURRENT_DATE - 32)::timestamp AT TIME ZONE 'UTC', '{meta}',        (CURRENT_DATE - 31 + time '12:00') AT TIME ZONE 'UTC'),
  ('00000002-0000-4000-8000-0000000000e8', 'Olla Fácil',       'Olla Fácil Utensilios S.A.S.','ollafacil.co',       'CO', 'Bogotá',   'hogar',     '{cocina,hogar}',   'pyme',    '{"instagram": "ollafacil", "tiktok": "ollafacil.co"}',              false, NULL,                     '{}',            now() - interval '3 days')
ON CONFLICT DO NOTHING;

-- fit_score: encaje de audiencia (los del mock). Las notas son lo que
-- la ficha de empresa muestra debajo del nombre.
INSERT INTO company_link (workspace_id, company_id, owner_user_id, relationship, fit_score, fit_explain, notes)
VALUES
  ('00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e1', '00000002-0000-4000-8000-000000000002', 'client',      0.8500, '{"audience_overlap": 0.85, "niche": "cocina", "country": "CO"}', 'Cliente actual. Renovación Q' || extract(quarter FROM CURRENT_DATE + 18) || ' en conversación.'),
  ('00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e2', '00000002-0000-4000-8000-000000000002', 'client',      0.8200, '{"audience_overlap": 0.82, "niche": "cocina", "country": "CO"}', 'Cliente actual. Cotización de desayunos enviada el 2 sep.'),
  ('00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e3', '00000002-0000-4000-8000-000000000002', 'past_client', 0.5800, '{"audience_overlap": 0.58, "niche": "hogar", "country": "CO"}',  'Cliente anterior con factura en mora.'),
  ('00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e4', '00000002-0000-4000-8000-000000000002', 'client',      0.7400, '{"audience_overlap": 0.74, "niche": "cocina", "country": "CO"}', 'Cliente actual. Serie de 3 videos Q' || extract(quarter FROM CURRENT_DATE + 28) || ' en conversación.'),
  ('00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e5', '00000002-0000-4000-8000-000000000002', 'contacted',   0.8000, '{"audience_overlap": 0.80, "niche": "cocina", "country": "CO"}', 'Entró por el marketplace de TikTok. Paquete con exclusividad en negociación.'),
  ('00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e6', '00000002-0000-4000-8000-000000000002', 'contacted',   0.7100, '{"audience_overlap": 0.71, "niche": "cocina", "country": "CO"}', 'Top Ads en TikTok. Un deal perdido en marzo; segundo intento en curso.'),
  ('00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e7', '00000002-0000-4000-8000-000000000002', 'contacted',   0.7300, '{"audience_overlap": 0.73, "niche": "bienestar", "country": "CO"}', 'Pauta en Meta desde hace un mes. Cotización de 2 reels con derechos enviada; segundo frente abierto por la línea de snacks.'),
  ('00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e8', '00000002-0000-4000-8000-000000000002', 'prospect',    0.7900, '{"audience_overlap": 0.79, "niche": "cocina", "country": "CO"}', 'Detectada por el radar: colaboración pagada con @la.olla.facil.')
ON CONFLICT DO NOTHING;

-- Contactos con procedencia obligatoria. Mateo Giraldo pidió la baja:
-- el disparador de outbound_touch impide programarle cualquier envío.
INSERT INTO contact (id, company_id, full_name, role_title, email, phone, linkedin_url, instagram_handle, source, source_url, opted_out, opted_out_at, opted_out_reason)
VALUES
  ('00000002-0000-4000-8000-0000000c0001', '00000002-0000-4000-8000-0000000000e2', 'Camila Rojas',      'Jefa de marketing',        'camila.rojas@freskomarket.co',      NULL, 'https://www.linkedin.com/in/camila-rojas-fresko', NULL,              'public_website',    'https://freskomarket.co/equipo',      false, NULL, NULL),
  ('00000002-0000-4000-8000-0000000c0002', '00000002-0000-4000-8000-0000000000e2', 'Andrés Pardo',      'Community manager',        NULL,                                NULL, NULL,                                              'andres.pardo.fm', 'public_profile',    'https://www.instagram.com/freskomarket/', false, NULL, NULL),
  ('00000002-0000-4000-8000-0000000c0003', '00000002-0000-4000-8000-0000000000e1', 'Valentina Ortiz',   'Fundadora',                'valentina@cafealma.co',             '+57 310 555 0142', NULL,                                  'cafealma',        'inbound',           NULL,                                  false, NULL, NULL),
  ('00000002-0000-4000-8000-0000000c0004', '00000002-0000-4000-8000-0000000000e1', 'Camilo Herrera',    'Marketing digital',        'c.herrera@cafealma.co',             NULL, 'https://www.linkedin.com/in/camilo-herrera-cafealma', NULL,          'public_profile',    'https://www.linkedin.com/in/camilo-herrera-cafealma', false, NULL, NULL),
  ('00000002-0000-4000-8000-0000000c0005', '00000002-0000-4000-8000-0000000000e4', 'Julián Mesa',       'Gerente de mercadeo',      'julian.mesa@nutrive.co',            '+57 315 555 0187', NULL,                                  NULL,              'user_provided',     NULL,                                  false, NULL, NULL),
  ('00000002-0000-4000-8000-0000000c0006', '00000002-0000-4000-8000-0000000000e4', 'Natalia Vélez',     'Trade marketing',          'natalia.velez@nutrive.co',          NULL, NULL,                                              NULL,              'enrichment_vendor', NULL,                                  false, NULL, NULL),
  ('00000002-0000-4000-8000-0000000c0007', '00000002-0000-4000-8000-0000000000e3', 'Andrea Salazar',    'Coordinadora de marketing','andrea.salazar@hogarlindo.co',      NULL, NULL,                                              'hogarlindo',      'user_provided',     NULL,                                  false, NULL, NULL),
  ('00000002-0000-4000-8000-0000000c0008', '00000002-0000-4000-8000-0000000000e5', 'Daniel Restrepo',   'Director comercial',       'daniel.restrepo@saborescaseros.co', NULL, 'https://www.linkedin.com/in/daniel-restrepo-sc',  'saborescaseros',  'public_website',    'https://saborescaseros.co/contacto',  false, NULL, NULL),
  ('00000002-0000-4000-8000-0000000c0009', '00000002-0000-4000-8000-0000000000e6', 'Laura Quintero',    'Brand manager',            'lquintero@granosdelvalle.co',       NULL, 'https://www.linkedin.com/in/laura-quintero-gdv',  NULL,              'public_website',    'https://granosdelvalle.co/prensa',    false, NULL, NULL),
  ('00000002-0000-4000-8000-0000000c0010', '00000002-0000-4000-8000-0000000000e6', 'Mateo Giraldo',     'Community manager',        'mateo.giraldo@granosdelvalle.co',   NULL, NULL,                                              NULL,              'public_profile',    'https://www.linkedin.com/in/mateo-giraldo-gdv', true, '2026-03-22 14:10:00+00', 'Respondió al último toque pidiendo no recibir más correos.'),
  ('00000002-0000-4000-8000-0000000c0011', '00000002-0000-4000-8000-0000000000e7', 'Sofía Cárdenas',    'Directora de marca',       'sofia@vitale.co',                   NULL, 'https://www.linkedin.com/in/sofia-cardenas-vitale', 'vitale.co',     'press',             'https://www.larepublica.co/empresas/vitale-lanza-linea-de-snacks', false, NULL, NULL),
  ('00000002-0000-4000-8000-0000000c0012', '00000002-0000-4000-8000-0000000000e8', 'Carolina Ruiz',     'Fundadora',                'hola@ollafacil.co',                 NULL, NULL,                                              'ollafacil',       'public_website',    'https://ollafacil.co/nosotros',       false, NULL, NULL)
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 9 · Radar: doce señales en estados mixtos
-- ---------------------------------------------------------------------
-- Las de la bandeja (pending, duplicate, discarded) son de estos días y
-- van relativas a CURRENT_DATE; las aceptadas son las que originaron un
-- deal y llevan la fecha en que se detectaron: fija si su deal tiene
-- historia fija (Fresko, Café Alma, Sabores Caseros), relativa si su
-- deal es relativo (Granos del Valle, Vitalé, Olla Fácil). En una fila
-- relativa TODO es relativo: el "desde el 14 sep" del titular, la
-- fecha del evidence y la dedupe_key salen de la misma CURRENT_DATE,
-- para que en dos meses el radar no diga "hace 2 horas" de algo del 14
-- de septiembre. La de Fresko (e008) también es relativa: es una noticia
-- de anteayer sobre un lanzamiento "el mes que viene" (CURRENT_DATE +
-- 30), y el titular, el evidence y la dedupe_key salen de esa fecha;
-- sembrada el 22 de septiembre dice "octubre", igual que la cotización
-- fija del 2 de septiembre y las llamadas de agosto con Fresko.
-- dedupe_key = fuente:dominio:fecha o detalle, única por workspace. El
-- mes en español se saca de un ARRAY porque to_char no tiene locale
-- garantizado en Postgres embebido.
-- =====================================================================
-- Los nombres de los meses en español, una sola vez por sentencia:
-- to_char no tiene locale garantizado en Postgres embebido, y tener la
-- lista repetida dentro de cada expresión hacía que corregir una tilde
-- fuera siete ediciones.
WITH meses AS (
  SELECT ARRAY['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'] AS largo,
         ARRAY['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'] AS corto
)
INSERT INTO signal (id, workspace_id, company_id, source_id, headline_es, detected_at, evidence_url, evidence, fit_score, budget_estimate, budget_currency, dedupe_key, status, reviewed_by, reviewed_at, discard_reason)
VALUES
  -- Aceptadas: cada una tiene su deal (origin_signal_id).
  ('00000002-0000-4000-8000-00000005e001', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e2', 'meta_ad_library',
   '6 anuncios activos en Meta desde el 12 ago · alimentos', '2026-08-12 08:00:00+00', 'https://www.facebook.com/ads/library/?q=freskomarket',
   '{"active_ads": 6, "country": "CO", "category": "alimentos", "since": "2026-08-12"}', 0.8200, 12000000.00, 'COP',
   'meta_ad_library:freskomarket.co:2026-08-12', 'accepted', '00000002-0000-4000-8000-000000000002', '2026-08-13 14:20:00+00', NULL),
  ('00000002-0000-4000-8000-00000005e002', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e1', 'press_launches',
   'Lanzó cold brew en botella el 22 jul', '2026-07-22 11:00:00+00', 'https://www.instagram.com/p/demo-cafealma-coldbrew/',
   '{"launch": "cold brew en botella", "channel": "instagram"}', 0.8500, 3000000.00, 'COP',
   'press_launches:cafealma.co:cold-brew-2026-07', 'accepted', '00000002-0000-4000-8000-000000000002', '2026-07-22 15:00:00+00', NULL),
  ('00000002-0000-4000-8000-00000005e003', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e8', 'watchlist_collab',
   'Colaboración pagada con @la.olla.facil', (CURRENT_DATE - 3 + time '10:00') AT TIME ZONE 'UTC', 'https://www.instagram.com/reel/demo-laollafacil-ollafacil/',
   '{"watched_account": "la.olla.facil", "platform": "instagram", "label": "Colaboración pagada"}', 0.7900, 6000000.00, 'COP',
   'watchlist_collab:ollafacil.co:la.olla.facil:1', 'accepted', '00000002-0000-4000-8000-000000000002', (CURRENT_DATE - 3 + time '12:00') AT TIME ZONE 'UTC', NULL),
  ('00000002-0000-4000-8000-00000005e004', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e6', 'tiktok_top_ads',
   'Top Ads en TikTok Creative Center · Colombia · 7 días', (CURRENT_DATE - 24 + time '09:00') AT TIME ZONE 'UTC', 'https://ads.tiktok.com/business/creativecenter/inspiration/topads/pc/es',
   '{"country": "CO", "window_days": 7, "rank": 14, "industry": "alimentos"}', 0.7100, 8000000.00, 'COP',
   'tiktok_top_ads:granosdelvalle.co:' || to_char(CURRENT_DATE - 24, 'IYYY-"w"IW'), 'accepted', '00000002-0000-4000-8000-000000000002', (CURRENT_DATE - 24 + time '16:00') AT TIME ZONE 'UTC', NULL),
  ('00000002-0000-4000-8000-00000005e005', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e5', 'creator_marketplace',
   'Buscó creadores de cocina en TikTok Creator Marketplace', '2026-08-15 10:00:00+00', 'https://creatormarketplace.tiktok.com/',
   '{"marketplace": "tiktok", "brief_category": "cocina", "budget_hint": "10-20M"}', 0.8000, 16000000.00, 'COP',
   'creator_marketplace:saborescaseros.co:tiktok:2026-08-15', 'accepted', '00000002-0000-4000-8000-000000000002', '2026-08-15 13:00:00+00', NULL),
  ('00000002-0000-4000-8000-00000005e006', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e7', 'meta_ad_library',
   '4 anuncios activos en Meta desde el ' || to_char(CURRENT_DATE - 32, 'FMDD') || ' '
     || (SELECT m.corto[extract(month FROM CURRENT_DATE - 32)::int] FROM meses m) || ' · bienestar',
   (CURRENT_DATE - 31 + time '08:00') AT TIME ZONE 'UTC', 'https://www.facebook.com/ads/library/?q=vitale',
   jsonb_build_object('active_ads', 4, 'country', 'CO', 'category', 'bienestar', 'since', to_char(CURRENT_DATE - 32, 'YYYY-MM-DD')), 0.7300, 9800000.00, 'COP',
   'meta_ad_library:vitale.co:' || to_char(CURRENT_DATE - 32, 'YYYY-MM-DD'), 'accepted', '00000002-0000-4000-8000-000000000002', (CURRENT_DATE - 31 + time '12:00') AT TIME ZONE 'UTC', NULL),
  -- Por revisar: la bandeja de hoy.
  ('00000002-0000-4000-8000-00000005e007', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e7', 'meta_ad_library',
   '4 anuncios nuevos en Meta desde el ' || to_char(CURRENT_DATE - 7, 'FMDD') || ' '
     || (SELECT m.corto[extract(month FROM CURRENT_DATE - 7)::int] FROM meses m) || ' · snacks',
   now() - interval '2 hours', 'https://www.facebook.com/ads/library/?q=vitale',
   jsonb_build_object('active_ads', 4, 'country', 'CO', 'category', 'snacks', 'since', to_char(CURRENT_DATE - 7, 'YYYY-MM-DD')), 0.7200, 5000000.00, 'COP',
   'meta_ad_library:vitale.co:' || to_char(CURRENT_DATE - 7, 'YYYY-MM-DD'), 'pending', NULL, NULL, NULL),
  ('00000002-0000-4000-8000-00000005e008', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e2', 'press_launches',
   'Anuncia línea de desayunos para ' || (SELECT m.largo[extract(month FROM CURRENT_DATE + 30)::int] FROM meses m),
   (CURRENT_DATE - 2 + time '15:00') AT TIME ZONE 'UTC', 'https://www.larepublica.co/empresas/fresko-market-lanza-linea-de-desayunos',
   jsonb_build_object('launch', 'línea de desayunos', 'month', to_char(CURRENT_DATE + 30, 'YYYY-MM')), 0.7500, 6000000.00, 'COP',
   'press_launches:freskomarket.co:desayunos-' || to_char(CURRENT_DATE + 30, 'YYYY-MM'), 'pending', NULL, NULL, NULL),
  ('00000002-0000-4000-8000-00000005e009', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e6', 'job_posts',
   'Vacante "coordinador de influencer marketing"', now() - interval '1 day' - interval '3 hours', 'https://www.linkedin.com/jobs/view/demo-granosdelvalle-influencer',
   '{"title": "Coordinador de influencer marketing", "board": "linkedin", "city": "Cali"}', 0.6100, 8000000.00, 'COP',
   'job_posts:granosdelvalle.co:influencer-marketing:' || to_char(CURRENT_DATE - 1, 'YYYY-MM'), 'pending', NULL, NULL, NULL),
  ('00000002-0000-4000-8000-00000005e010', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e4', 'tiktok_top_ads',
   'Top Ads en TikTok · Colombia · 7 días', now() - interval '2 days', 'https://ads.tiktok.com/business/creativecenter/inspiration/topads/pc/es',
   '{"country": "CO", "window_days": 7, "rank": 9, "industry": "alimentos"}', 0.6600, 4000000.00, 'COP',
   'tiktok_top_ads:nutrive.co:' || to_char(CURRENT_DATE - 2, 'IYYY-"w"IW'), 'pending', NULL, NULL, NULL),
  -- La quinta por revisar. El mock enseña CINCO señales pendientes y el
  -- aviso de Resumen lo dice con todas las letras («Hay 5 señales por
  -- revisar en el radar»); con cuatro, la pantalla que RES-1 copie del
  -- mock y el radar dirían números distintos el primer día.
  ('00000002-0000-4000-8000-00000005e013', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e5', 'meta_ad_library',
   '5 anuncios nuevos en Meta desde el ' || to_char(CURRENT_DATE - 4, 'FMDD') || ' '
     || (SELECT m.corto[extract(month FROM CURRENT_DATE - 4)::int] FROM meses m) || ' · salsas',
   now() - interval '6 hours', 'https://www.facebook.com/ads/library/?q=saborescaseros',
   jsonb_build_object('active_ads', 5, 'country', 'CO', 'category', 'salsas', 'since', to_char(CURRENT_DATE - 4, 'YYYY-MM-DD')), 0.8000, 7000000.00, 'COP',
   'meta_ad_library:saborescaseros.co:' || to_char(CURRENT_DATE - 4, 'YYYY-MM-DD'), 'pending', NULL, NULL, NULL),
  -- Duplicada: la misma colaboración, detectada otra vez.
  ('00000002-0000-4000-8000-00000005e011', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e8', 'watchlist_collab',
   'Colaboración pagada con @la.olla.facil', now() - interval '2 days', 'https://www.instagram.com/reel/demo-laollafacil-ollafacil/',
   '{"watched_account": "la.olla.facil", "platform": "instagram", "label": "Colaboración pagada", "duplicate_of": "00000002-0000-4000-8000-00000005e003"}', 0.7900, 6000000.00, 'COP',
   'watchlist_collab:ollafacil.co:la.olla.facil:2', 'duplicate', '00000002-0000-4000-8000-000000000002', now() - interval '2 days' + interval '1 hour', NULL),
  -- Descartada: cliente en mora, no se prospecta.
  ('00000002-0000-4000-8000-00000005e012', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e3', 'meta_ad_library',
   '9 anuncios activos en Meta · hogar', now() - interval '5 days', 'https://www.facebook.com/ads/library/?q=hogarlindo',
   '{"active_ads": 9, "country": "CO", "category": "hogar"}', 0.5800, 3000000.00, 'COP',
   'meta_ad_library:hogarlindo.co:' || to_char(CURRENT_DATE - 5, 'YYYY-MM-DD'), 'discarded', '00000002-0000-4000-8000-000000000002', now() - interval '5 days' + interval '3 hours', 'Cliente con factura en mora: no prospectar hasta cobrar FV-2026-007.')
-- Volver a sembrar refresca la bandeja: una señal PENDIENTE es trabajo
-- por hacer, no un hecho archivado, y cuatro señales de hace mes y
-- medio esperando revisión no son la demo. Se refresca la fila entera
-- (titular, fecha, evidence y dedupe_key salen de la misma
-- CURRENT_DATE), para que nunca diga "hace 2 horas" de algo de hace un
-- mes. Las aceptadas, la duplicada y la descartada ya ocurrieron y no
-- se tocan.
ON CONFLICT (id) DO UPDATE SET
  headline_es = EXCLUDED.headline_es,
  detected_at = EXCLUDED.detected_at,
  evidence    = EXCLUDED.evidence,
  dedupe_key  = EXCLUDED.dedupe_key
WHERE signal.status = 'pending';


-- =====================================================================
-- 10 · Pipeline: quince deals
-- ---------------------------------------------------------------------
-- Diez abiertos (COP 95,5 M, ponderado 43,15 M), cuatro ganados (los
-- tres del "Ganado en Q3" del mock, 13 M entre los tres, más el de
-- Hogar Lindo de junio, que es la factura en mora de 0003 y la campaña
-- ca0004) y uno perdido
-- (Granos del Valle en marzo: es lo que explica la baja de Mateo
-- Giraldo y el "segundo intento" de hoy). Las próximas acciones van
-- relativas a hoy: Granos del Valle (−2 d) y Vitalé (−1 d) están
-- vencidas; Olla Fácil y Sabores Caseros vencen hoy.
-- Dos relojes, y una regla para cada columna: lo que ya PASÓ (señal de
-- origen, creación, etapas, actividades, último contacto, cierre real
-- de los ganados y perdidos) va fijo en los deals de los clientes con
-- campaña o factura en 0003 (Fresko, Café Alma, Nutrivé, Hogar Lindo)
-- y en Sabores Caseros, y relativo en los que nacieron del radar y cuya
-- historia es solo seguimiento (Olla Fácil, Granos del Valle, Vitalé) y
-- en la activación corta de Nutrivé. Lo que todavía es un PLAN (próxima
-- acción y su fecha, cierre esperado de los abiertos, el mes o el
-- trimestre del nombre cuando lo lleva) va relativo a CURRENT_DATE en
-- todos, porque es lo que el tablero mira hoy: un cierre esperado fijo
-- sería "hace 50 días" en una base sembrada dentro de dos meses (verify
-- (p) lo vigila). Los cobros pendientes apuntan al vencimiento de su
-- factura en 0003.
-- =====================================================================
-- Los nombres de los meses en español, una sola vez por sentencia
-- (ver la sentencia de signal).
WITH meses AS (SELECT ARRAY['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'] AS largo)
INSERT INTO deal (id, workspace_id, company_id, creator_id, owner_user_id, origin_signal_id, name, stage_id, amount, currency, probability, expected_close_date, next_action, next_action_due, next_action_user_id, last_contact_at, won_at, lost_at, lost_reason, created_at)
SELECT d.id, '00000002-0000-4000-8000-000000000001', d.company_id, '00000002-0000-4000-8000-000000000003', '00000002-0000-4000-8000-000000000002', d.origin_signal_id,
       d.name, d.stage_id, d.amount, 'COP', NULL, d.expected_close_date, d.next_action, d.next_action_due, '00000002-0000-4000-8000-000000000002',
       d.last_contact_at, d.won_at, d.lost_at, d.lost_reason, d.created_at
FROM (VALUES
  -- Abiertos
  ('00000002-0000-4000-8000-0000000dea01'::uuid, '00000002-0000-4000-8000-0000000000e8'::uuid, '00000002-0000-4000-8000-00000005e003'::uuid,
   'Por definir', 'nuevo', 6000000.00, NULL::date, 'Enviar pitch',
   ((CURRENT_DATE + 1)::timestamp - interval '1 minute') AT TIME ZONE 'UTC', NULL::timestamptz, NULL::timestamptz, NULL::timestamptz, NULL::text, (CURRENT_DATE - 3 + time '12:00') AT TIME ZONE 'UTC'),
  ('00000002-0000-4000-8000-0000000dea02', '00000002-0000-4000-8000-0000000000e6', '00000002-0000-4000-8000-00000005e004',
   'Historias + 1 Reel', 'contactado', 8000000.00, CURRENT_DATE + 24, 'Seguimiento 2',
   (CURRENT_DATE - 2 + time '15:00') AT TIME ZONE 'UTC', (CURRENT_DATE - 5 + time '15:00') AT TIME ZONE 'UTC', NULL, NULL, NULL, (CURRENT_DATE - 24 + time '16:00') AT TIME ZONE 'UTC'),
  ('00000002-0000-4000-8000-0000000dea14', '00000002-0000-4000-8000-0000000000e7', NULL,
   'Paquete snacks · Q' || extract(quarter FROM CURRENT_DATE + 30), 'contactado', 9000000.00, CURRENT_DATE + 30, 'Seguimiento 1',
   (CURRENT_DATE + 3 + time '15:00') AT TIME ZONE 'UTC', (CURRENT_DATE - 1 + time '16:00') AT TIME ZONE 'UTC', NULL, NULL, NULL, (CURRENT_DATE - 5 + time '10:00') AT TIME ZONE 'UTC'),
  ('00000002-0000-4000-8000-0000000dea03', '00000002-0000-4000-8000-0000000000e5', '00000002-0000-4000-8000-00000005e005',
   'Paquete + exclusividad 30 d', 'negociacion', 16000000.00, CURRENT_DATE + 8, 'Enviar contrato',
   ((CURRENT_DATE + 1)::timestamp - interval '1 minute') AT TIME ZONE 'UTC', (CURRENT_DATE - 2 + time '15:00') AT TIME ZONE 'UTC', NULL, NULL, NULL, '2026-08-15 13:00:00+00'),
  ('00000002-0000-4000-8000-0000000dea04', '00000002-0000-4000-8000-0000000000e1', NULL,
   'Renovación Q' || extract(quarter FROM CURRENT_DATE + 18) || ' · 3 meses', 'conversacion', 12000000.00, CURRENT_DATE + 18, 'Llamada',
   ((CURRENT_DATE + 1)::timestamp + interval '15 hours') AT TIME ZONE 'UTC', (CURRENT_DATE - 4 + time '14:00') AT TIME ZONE 'UTC', NULL, NULL, NULL, '2026-09-11 15:00:00+00'),
  ('00000002-0000-4000-8000-0000000dea05', '00000002-0000-4000-8000-0000000000e4', NULL,
   'Serie de 3 videos Q' || extract(quarter FROM CURRENT_DATE + 28), 'conversacion', 11000000.00, CURRENT_DATE + 28, 'Enviar propuesta',
   ((CURRENT_DATE + 2)::timestamp + interval '15 hours') AT TIME ZONE 'UTC', (CURRENT_DATE - 3 + time '13:00') AT TIME ZONE 'UTC', NULL, NULL, NULL, '2026-09-10 13:40:00+00'),
  ('00000002-0000-4000-8000-0000000dea06', '00000002-0000-4000-8000-0000000000e3', NULL,
   'Historias navidad', 'conversacion', 3000000.00, CURRENT_DATE + 54, 'Esperar pago de la mora',
   NULL, (CURRENT_DATE - 6 + time '16:00') AT TIME ZONE 'UTC', NULL, NULL, NULL, '2026-09-04 16:00:00+00'),
  ('00000002-0000-4000-8000-0000000dea07', '00000002-0000-4000-8000-0000000000e2', '00000002-0000-4000-8000-00000005e001',
   'Lanzamiento desayunos · 1 TikTok + 1 Reel + 3 historias', 'propuesta', 14200000.00, CURRENT_DATE + 8, 'Seguimiento a la cotización',
   ((CURRENT_DATE + 2)::timestamp + interval '15 hours') AT TIME ZONE 'UTC', (CURRENT_DATE - 2 + time '15:00') AT TIME ZONE 'UTC', NULL, NULL, NULL, '2026-08-13 14:20:00+00'),
  ('00000002-0000-4000-8000-0000000dea08', '00000002-0000-4000-8000-0000000000e7', '00000002-0000-4000-8000-00000005e006',
   '2 Reels + derechos 90 d', 'propuesta', 9800000.00, CURRENT_DATE + 14, 'Ajustar entregables',
   (CURRENT_DATE - 1 + time '15:00') AT TIME ZONE 'UTC', (CURRENT_DATE - 4 + time '17:00') AT TIME ZONE 'UTC', NULL, NULL, NULL, (CURRENT_DATE - 31 + time '12:00') AT TIME ZONE 'UTC'),
  ('00000002-0000-4000-8000-0000000dea15', '00000002-0000-4000-8000-0000000000e4', NULL,
   '1 TikTok + 1 Short · ' || (SELECT m.largo[extract(month FROM CURRENT_DATE + 10)::int] FROM meses m), 'negociacion', 6500000.00, CURRENT_DATE + 10, 'Confirmar fechas',
   (CURRENT_DATE + 3 + time '15:00') AT TIME ZONE 'UTC', (CURRENT_DATE - 1 + time '13:00') AT TIME ZONE 'UTC', NULL, NULL, NULL, (CURRENT_DATE - 8 + time '13:00') AT TIME ZONE 'UTC'),
  -- Ganados
  ('00000002-0000-4000-8000-0000000dea09', '00000002-0000-4000-8000-0000000000e2', '00000002-0000-4000-8000-00000005e001',
   '2 TikTok · septiembre', 'ganado', 5200000.00, DATE '2026-08-27', 'Cobrar la factura FV-2026-011',
   ((CURRENT_DATE + 23)::timestamp + interval '15 hours') AT TIME ZONE 'UTC', '2026-09-09 15:10:00+00', '2026-08-27 17:30:00+00', NULL, NULL, '2026-08-13 14:20:00+00'),
  -- 4,7 M, no 4,5: es el mismo trabajo que la campaña ca0003 y la
  -- factura FV-2026-009 de 0003, que valen 4 700 000. El mock da 4,5 M
  -- para este deal, pero un tablero de Ventas que diga 4,5 al lado de
  -- una factura de 4,7 por el mismo video mata la demo antes que la
  -- cifra del mock.
  ('00000002-0000-4000-8000-0000000dea10', '00000002-0000-4000-8000-0000000000e4', NULL,
   'Video dedicado · julio', 'ganado', 4700000.00, DATE '2026-07-01', 'Cobrada',
   NULL, '2026-08-20 15:00:00+00', '2026-07-01 14:00:00+00', NULL, NULL, '2026-06-10 10:00:00+00'),
  ('00000002-0000-4000-8000-0000000dea11', '00000002-0000-4000-8000-0000000000e1', '00000002-0000-4000-8000-00000005e002',
   'Lanzamiento cold brew', 'ganado', 3100000.00, DATE '2026-07-29', 'Cobrar la factura FV-2026-010',
   ((CURRENT_DATE + 7)::timestamp + interval '15 hours') AT TIME ZONE 'UTC', '2026-09-12 14:00:00+00', '2026-07-29 16:00:00+00', NULL, NULL, '2026-07-22 15:00:00+00'),
  ('00000002-0000-4000-8000-0000000dea12', '00000002-0000-4000-8000-0000000000e3', NULL,
   '3 historias · junio', 'ganado', 1100000.00, DATE '2026-06-01', 'Esperar el pago de FV-2026-007 (2 recordatorios enviados)',
   NULL, '2026-09-04 16:00:00+00', '2026-06-01 15:00:00+00', NULL, NULL, '2026-05-18 10:00:00+00'),
  -- Perdido
  ('00000002-0000-4000-8000-0000000dea13', '00000002-0000-4000-8000-0000000000e6', NULL,
   'Receta con granola · marzo', 'perdido', 5000000.00, DATE '2026-03-15', NULL,
   NULL, '2026-03-18 14:00:00+00', NULL, '2026-03-20 15:00:00+00', 'eligio_otro_creador', '2026-02-20 10:00:00+00')
) AS d(id, company_id, origin_signal_id, name, stage_id, amount, expected_close_date, next_action, next_action_due, last_contact_at, won_at, lost_at, lost_reason, created_at)
-- Volver a sembrar refresca lo que el tablero MIRA HOY de los deals
-- abiertos: el cierre esperado, la fecha de la próxima acción y el
-- último contacto. Sin esto, una base sembrada hace seis semanas enseña
-- ocho de diez deals abiertos con el cierre en el pasado; y con el
-- último contacto congelado, un deal en "Negociación" decía «Enviar
-- contrato · vence hoy» al lado de un último contacto de hace seis
-- semanas, que no es una historia creíble sino un deal abandonado.
-- last_contact_at va emparejado con la actividad de seguimiento de la
-- sección 11b (misma fecha y misma hora, deal por deal): la ficha de
-- empresa y la tarjeta del tablero cuentan lo mismo. La consulta (q) de
-- verify/0002.sql exige esa igualdad, para que no se separen.
-- Lo que ya pasó (etapas, cierres reales, el mes o el trimestre del
-- nombre, que las actividades citan) no se toca, y los ganados y
-- perdidos quedan intactos: su cierre esperado es historia.
-- Qué es "cerrado" lo dice pipeline_stage con is_won/is_lost, como la
-- vista deal_pipeline y el propio verify: con la lista de literales,
-- añadir una etapa terminal ('archivado') o renombrar una hacía que el
-- seed reescribiera en silencio el plan de deals ya cerrados.
ON CONFLICT (id) DO UPDATE SET
  expected_close_date = EXCLUDED.expected_close_date,
  next_action_due     = EXCLUDED.next_action_due,
  last_contact_at     = EXCLUDED.last_contact_at
WHERE deal.stage_id IN (SELECT st.id FROM pipeline_stage st WHERE NOT st.is_won AND NOT st.is_lost);

-- Historia de etapas: de aquí salen el ciclo de venta y la conversión
-- por etapa. Sin clave natural: se evita el duplicado por (deal, etapa
-- de llegada).
INSERT INTO deal_stage_history (deal_id, from_stage_id, to_stage_id, changed_by, changed_at, days_in_stage)
SELECT h.deal_id, h.from_stage_id, h.to_stage_id, '00000002-0000-4000-8000-000000000002', h.changed_at, h.days_in_stage
FROM (VALUES
  ('00000002-0000-4000-8000-0000000dea01'::uuid, NULL::text,      'nuevo',        (CURRENT_DATE - 3 + time '12:00') AT TIME ZONE 'UTC', NULL::numeric),
  ('00000002-0000-4000-8000-0000000dea02', NULL,           'nuevo',        (CURRENT_DATE - 24 + time '16:00') AT TIME ZONE 'UTC', NULL),
  ('00000002-0000-4000-8000-0000000dea02', 'nuevo',        'contactado',   (CURRENT_DATE - 21 + time '14:00') AT TIME ZONE 'UTC', 2.92),
  ('00000002-0000-4000-8000-0000000dea03', NULL,           'nuevo',        '2026-08-15 13:00:00+00', NULL),
  ('00000002-0000-4000-8000-0000000dea03', 'nuevo',        'contactado',   '2026-08-19 15:00:00+00', 4.08),
  ('00000002-0000-4000-8000-0000000dea03', 'contactado',   'conversacion', '2026-08-22 16:00:00+00', 3.04),
  ('00000002-0000-4000-8000-0000000dea03', 'conversacion', 'propuesta',    '2026-09-05 14:00:00+00', 13.92),
  ('00000002-0000-4000-8000-0000000dea03', 'propuesta',    'negociacion',  '2026-09-15 20:30:00+00', 10.27),
  ('00000002-0000-4000-8000-0000000dea04', NULL,           'conversacion', '2026-09-11 15:00:00+00', NULL),
  ('00000002-0000-4000-8000-0000000dea05', NULL,           'conversacion', '2026-09-10 13:40:00+00', NULL),
  ('00000002-0000-4000-8000-0000000dea06', NULL,           'conversacion', '2026-09-04 16:00:00+00', NULL),
  ('00000002-0000-4000-8000-0000000dea07', NULL,           'nuevo',        '2026-08-13 14:20:00+00', NULL),
  ('00000002-0000-4000-8000-0000000dea07', 'nuevo',        'contactado',   '2026-08-20 14:00:00+00', 6.99),
  ('00000002-0000-4000-8000-0000000dea07', 'contactado',   'conversacion', '2026-08-23 15:00:00+00', 3.04),
  ('00000002-0000-4000-8000-0000000dea07', 'conversacion', 'propuesta',    '2026-09-02 15:00:00+00', 10.00),
  ('00000002-0000-4000-8000-0000000dea08', NULL,           'nuevo',        (CURRENT_DATE - 31 + time '12:00') AT TIME ZONE 'UTC', NULL),
  ('00000002-0000-4000-8000-0000000dea08', 'nuevo',        'contactado',   (CURRENT_DATE - 27 + time '14:00') AT TIME ZONE 'UTC', 4.08),
  ('00000002-0000-4000-8000-0000000dea08', 'contactado',   'conversacion', (CURRENT_DATE - 20 + time '15:00') AT TIME ZONE 'UTC', 7.04),
  ('00000002-0000-4000-8000-0000000dea08', 'conversacion', 'propuesta',    (CURRENT_DATE - 13 + time '15:00') AT TIME ZONE 'UTC', 7.00),
  ('00000002-0000-4000-8000-0000000dea14', NULL,           'nuevo',        (CURRENT_DATE - 5 + time '10:00') AT TIME ZONE 'UTC', NULL),
  ('00000002-0000-4000-8000-0000000dea14', 'nuevo',        'contactado',   (CURRENT_DATE - 3 + time '14:00') AT TIME ZONE 'UTC', 2.17),
  ('00000002-0000-4000-8000-0000000dea15', NULL,           'conversacion', (CURRENT_DATE - 8 + time '13:00') AT TIME ZONE 'UTC', NULL),
  ('00000002-0000-4000-8000-0000000dea15', 'conversacion', 'propuesta',    (CURRENT_DATE - 7 + time '15:00') AT TIME ZONE 'UTC', 1.08),
  ('00000002-0000-4000-8000-0000000dea15', 'propuesta',    'negociacion',  (CURRENT_DATE - 3 + time '16:00') AT TIME ZONE 'UTC', 4.04),
  ('00000002-0000-4000-8000-0000000dea09', NULL,           'nuevo',        '2026-08-13 14:20:00+00', NULL),
  ('00000002-0000-4000-8000-0000000dea09', 'nuevo',        'contactado',   '2026-08-20 14:00:00+00', 6.99),
  ('00000002-0000-4000-8000-0000000dea09', 'contactado',   'conversacion', '2026-08-23 15:00:00+00', 3.04),
  ('00000002-0000-4000-8000-0000000dea09', 'conversacion', 'propuesta',    '2026-08-25 15:00:00+00', 2.00),
  ('00000002-0000-4000-8000-0000000dea09', 'propuesta',    'negociacion',  '2026-08-26 15:00:00+00', 1.00),
  ('00000002-0000-4000-8000-0000000dea09', 'negociacion',  'ganado',       '2026-08-27 17:30:00+00', 1.10),
  ('00000002-0000-4000-8000-0000000dea10', NULL,           'nuevo',        '2026-06-10 10:00:00+00', NULL),
  ('00000002-0000-4000-8000-0000000dea10', 'nuevo',        'contactado',   '2026-06-12 14:00:00+00', 2.17),
  ('00000002-0000-4000-8000-0000000dea10', 'contactado',   'conversacion', '2026-06-18 15:00:00+00', 6.04),
  ('00000002-0000-4000-8000-0000000dea10', 'conversacion', 'propuesta',    '2026-06-24 15:00:00+00', 6.00),
  ('00000002-0000-4000-8000-0000000dea10', 'propuesta',    'ganado',       '2026-07-01 14:00:00+00', 6.96),
  ('00000002-0000-4000-8000-0000000dea11', NULL,           'conversacion', '2026-07-22 15:00:00+00', NULL),
  ('00000002-0000-4000-8000-0000000dea11', 'conversacion', 'propuesta',    '2026-07-23 14:00:00+00', 0.96),
  ('00000002-0000-4000-8000-0000000dea11', 'propuesta',    'ganado',       '2026-07-29 16:00:00+00', 6.08),
  ('00000002-0000-4000-8000-0000000dea12', NULL,           'nuevo',        '2026-05-18 10:00:00+00', NULL),
  ('00000002-0000-4000-8000-0000000dea12', 'nuevo',        'contactado',   '2026-05-20 14:00:00+00', 2.17),
  ('00000002-0000-4000-8000-0000000dea12', 'contactado',   'propuesta',    '2026-05-26 15:00:00+00', 6.04),
  ('00000002-0000-4000-8000-0000000dea12', 'propuesta',    'ganado',       '2026-06-01 15:00:00+00', 6.00),
  ('00000002-0000-4000-8000-0000000dea13', NULL,           'nuevo',        '2026-02-20 10:00:00+00', NULL),
  ('00000002-0000-4000-8000-0000000dea13', 'nuevo',        'contactado',   '2026-02-24 14:00:00+00', 4.17),
  ('00000002-0000-4000-8000-0000000dea13', 'contactado',   'conversacion', '2026-03-03 15:00:00+00', 7.04),
  ('00000002-0000-4000-8000-0000000dea13', 'conversacion', 'propuesta',    '2026-03-10 15:00:00+00', 7.00),
  ('00000002-0000-4000-8000-0000000dea13', 'propuesta',    'perdido',      '2026-03-20 15:00:00+00', 10.00)
) AS h(deal_id, from_stage_id, to_stage_id, changed_at, days_in_stage)
WHERE NOT EXISTS (
  SELECT 1 FROM deal_stage_history x WHERE x.deal_id = h.deal_id AND x.to_stage_id = h.to_stage_id
);


-- =====================================================================
-- 11 · Actividades: la historia de cada deal
-- ---------------------------------------------------------------------
-- Lo que la ficha de empresa muestra como línea de tiempo. La de
-- Fresko Market es la del mock (COMPANIES en app.js), con las fechas
-- tal cual.
-- =====================================================================
-- Los nombres de los meses en español, una sola vez por sentencia
-- (ver la sentencia de signal).
WITH meses AS (SELECT ARRAY['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'] AS largo)
INSERT INTO activity (id, workspace_id, company_id, deal_id, contact_id, user_id, kind, subject, body, occurred_at, metadata)
SELECT ('00000002-0000-4000-8000-00000ac7' || lpad(to_hex(a.n), 4, '0'))::uuid,
       '00000002-0000-4000-8000-000000000001', a.company_id, a.deal_id, a.contact_id,
       CASE WHEN a.kind IN ('signal_detected', 'payment_received') THEN NULL ELSE '00000002-0000-4000-8000-000000000002'::uuid END,
       a.kind, a.subject, a.body, a.occurred_at, a.metadata
FROM (VALUES
  -- Fresko Market
  ( 1, '00000002-0000-4000-8000-0000000000e2'::uuid, '00000002-0000-4000-8000-0000000dea09'::uuid, NULL::uuid, 'signal_detected',
    'El radar detectó 6 anuncios activos en Meta', 'Categoría alimentos, Colombia. Encaje de audiencia 82 %.', '2026-08-12 08:00:00+00'::timestamptz, '{"signal_id": "00000002-0000-4000-8000-00000005e001"}'::jsonb),
  ( 2, '00000002-0000-4000-8000-0000000000e2', '00000002-0000-4000-8000-0000000dea09', '00000002-0000-4000-8000-0000000c0001', 'email_sent',
    'Pitch con media kit y el avance de Café Alma', 'Enviado a Camila con el media kit y el avance a 7 días de la campaña de Café Alma (10–17 ago) como prueba.', '2026-08-20 14:00:00+00', '{}'),
  ( 3, '00000002-0000-4000-8000-0000000000e2', '00000002-0000-4000-8000-0000000dea09', '00000002-0000-4000-8000-0000000c0001', 'email_received',
    'Camila responde: piden propuesta', 'Quieren 2 TikTok en septiembre y una propuesta aparte para el lanzamiento de desayunos de octubre.', '2026-08-23 15:00:00+00', '{}'),
  ( 4, '00000002-0000-4000-8000-0000000000e2', '00000002-0000-4000-8000-0000000dea09', '00000002-0000-4000-8000-0000000c0001', 'call',
    'Llamada de 25 min', 'Cierran los 2 TikTok de septiembre por COP 5,2 M. Para octubre, presupuesto entre COP 12 y 15 M. Quieren código y enlace propios.', '2026-08-27 16:00:00+00', '{"duration_min": 25}'),
  ( 5, '00000002-0000-4000-8000-0000000000e2', '00000002-0000-4000-8000-0000000dea09', '00000002-0000-4000-8000-0000000c0002', 'dm_sent',
    'Fechas de publicación', 'Coordinadas con Andrés por DM: 2 y 6 de septiembre a las 10:00.', '2026-08-28 13:00:00+00', '{}'),
  ( 6, '00000002-0000-4000-8000-0000000000e2', '00000002-0000-4000-8000-0000000dea07', '00000002-0000-4000-8000-0000000c0001', 'proposal_sent',
    'Cotización enviada', '1 TikTok + 1 Reel + 3 historias, derechos 90 días, COP 14,2 M. Código y enlace propios incluidos.', '2026-09-02 15:00:00+00', '{"amount": 14200000, "currency": "COP"}'),
  ( 7, '00000002-0000-4000-8000-0000000000e2', '00000002-0000-4000-8000-0000000dea09', '00000002-0000-4000-8000-0000000c0001', 'report_sent',
    'Avance a una semana de los 2 TikTok', 'Primer corte de la campaña de septiembre (sigue midiendo hasta el 6 de octubre): 236 K views y 1 736 clics entre los dos videos. Enviado como argumento para la cotización de octubre.', '2026-09-09 15:10:00+00', '{"campaign_id": "00000003-0000-4000-8000-000000ca0002", "cut_hours": 168}'),
  -- Café Alma
  ( 8, '00000002-0000-4000-8000-0000000000e1', '00000002-0000-4000-8000-0000000dea11', NULL, 'signal_detected',
    'Lanzó cold brew en botella', 'Anuncio del lanzamiento en Instagram el 22 de julio.', '2026-07-22 11:00:00+00', '{"signal_id": "00000002-0000-4000-8000-00000005e002"}'),
  ( 9, '00000002-0000-4000-8000-0000000000e1', '00000002-0000-4000-8000-0000000dea11', '00000002-0000-4000-8000-0000000c0003', 'proposal_sent',
    'Propuesta para el lanzamiento', '1 reel + 1 TikTok + 3 historias con código LAURA15 y enlace rastreado. COP 3,1 M.', '2026-07-23 14:00:00+00', '{"amount": 3100000, "currency": "COP"}'),
  (10, '00000002-0000-4000-8000-0000000000e1', '00000002-0000-4000-8000-0000000dea11', '00000002-0000-4000-8000-0000000c0003', 'email_received',
    'Aceptan la propuesta', 'Arranque el 10 de agosto. Valentina pide el reporte a 30 días con cortes a 7 y 30.', '2026-07-29 16:00:00+00', '{}'),
  (11, '00000002-0000-4000-8000-0000000000e1', '00000002-0000-4000-8000-0000000dea04', '00000002-0000-4000-8000-0000000c0003', 'call',
    'Renovación Q4', 'Tres meses, un reel y un TikTok al mes. Piden la propuesta antes del 30 de septiembre.', '2026-09-11 15:00:00+00', '{"duration_min": 18}'),
  (12, '00000002-0000-4000-8000-0000000000e1', '00000002-0000-4000-8000-0000000dea11', '00000002-0000-4000-8000-0000000c0003', 'report_sent',
    'Reporte a 30 días', '712 K views, 58 % del alcance en no seguidores, 318 canjes de LAURA15 y +1 240 seguidores para @cafealma.', '2026-09-12 14:00:00+00', '{"campaign_id": "00000003-0000-4000-8000-000000ca0001"}'),
  -- Nutrivé
  (13, '00000002-0000-4000-8000-0000000000e4', '00000002-0000-4000-8000-0000000dea10', '00000002-0000-4000-8000-0000000c0005', 'meeting',
    'Reunión con Julián', 'Video dedicado de YouTube sobre almuerzos saludables para julio.', '2026-06-18 15:00:00+00', '{"duration_min": 40}'),
  (14, '00000002-0000-4000-8000-0000000000e4', '00000002-0000-4000-8000-0000000dea10', '00000002-0000-4000-8000-0000000c0005', 'proposal_sent',
    'Cotización del video dedicado', 'Un video de 10 minutos con mención integrada. COP 4,7 M.', '2026-06-24 15:00:00+00', '{"amount": 4700000, "currency": "COP"}'),
  (15, '00000002-0000-4000-8000-0000000000e4', '00000002-0000-4000-8000-0000000dea10', NULL, 'payment_received',
    'Pago recibido', 'FV-2026-009 pagada por transferencia.', '2026-08-20 15:00:00+00', '{"invoice_number": "FV-2026-009"}'),
  (16, '00000002-0000-4000-8000-0000000000e4', '00000002-0000-4000-8000-0000000dea05', '00000002-0000-4000-8000-0000000c0005', 'email_received',
    'Piden una serie para Q4', 'Tres videos entre octubre y diciembre, uno por mes. Presupuesto por confirmar.', '2026-09-10 13:40:00+00', '{}'),
  -- Hogar Lindo
  (17, '00000002-0000-4000-8000-0000000000e3', '00000002-0000-4000-8000-0000000dea12', '00000002-0000-4000-8000-0000000c0007', 'report_sent',
    'Reporte de las 3 historias', '94 K views y 42 canjes de LAURAHOGAR al cierre de junio.', '2026-06-30 16:00:00+00', '{"campaign_id": "00000003-0000-4000-8000-000000ca0004"}'),
  (18, '00000002-0000-4000-8000-0000000000e3', '00000002-0000-4000-8000-0000000dea06', '00000002-0000-4000-8000-0000000c0007', 'email_sent',
    'Recordatorio de la factura y propuesta de navidad', 'Segundo recordatorio de FV-2026-007. Se adjunta idea de 3 historias para diciembre, condicionada al pago.', '2026-09-04 16:00:00+00', '{"invoice_number": "FV-2026-007"}'),
  -- Sabores Caseros
  (19, '00000002-0000-4000-8000-0000000000e5', '00000002-0000-4000-8000-0000000dea03', NULL, 'signal_detected',
    'Buscó creadores de cocina en TikTok Creator Marketplace', 'Brief de la categoría cocina con presupuesto entre 10 y 20 M.', '2026-08-15 10:00:00+00', '{"signal_id": "00000002-0000-4000-8000-00000005e005"}'),
  (20, '00000002-0000-4000-8000-0000000000e5', '00000002-0000-4000-8000-0000000dea03', '00000002-0000-4000-8000-0000000c0008', 'dm_sent',
    'Pitch por DM de Instagram', 'Con media kit y los tres videos con mejor puntaje del mes.', '2026-08-19 15:00:00+00', '{}'),
  (21, '00000002-0000-4000-8000-0000000000e5', '00000002-0000-4000-8000-0000000dea03', '00000002-0000-4000-8000-0000000c0008', 'dm_received',
    'Responden', 'Quieren un paquete para el lanzamiento de la línea de salsas.', '2026-08-22 16:00:00+00', '{}'),
  (22, '00000002-0000-4000-8000-0000000000e5', '00000002-0000-4000-8000-0000000dea03', '00000002-0000-4000-8000-0000000c0008', 'meeting',
    'Reunión virtual de 40 min', '2 TikTok + 2 Reels + historias. Piden exclusividad de 30 días en la categoría salsas.', '2026-08-29 15:00:00+00', '{"duration_min": 40}'),
  (23, '00000002-0000-4000-8000-0000000000e5', '00000002-0000-4000-8000-0000000dea03', '00000002-0000-4000-8000-0000000c0008', 'proposal_sent',
    'Cotización del paquete', 'Paquete con exclusividad 30 d, COP 16 M.', '2026-09-05 14:00:00+00', '{"amount": 16000000, "currency": "COP"}'),
  (24, '00000002-0000-4000-8000-0000000000e5', '00000002-0000-4000-8000-0000000dea03', '00000002-0000-4000-8000-0000000c0008', 'call',
    'Aceptan el paquete', 'Pasan a contrato. Enviar el contrato esta semana con las fechas de octubre.', '2026-09-15 20:30:00+00', '{"duration_min": 12}'),
  -- Nutrivé · la activación corta de octubre (relativa)
  (25, '00000002-0000-4000-8000-0000000000e4', '00000002-0000-4000-8000-0000000dea15', '00000002-0000-4000-8000-0000000c0005', 'proposal_sent',
    'Cotización del TikTok + Short de ' || (SELECT m.largo[extract(month FROM CURRENT_DATE + 10)::int] FROM meses m),
    'Un TikTok y un Short sobre el almuerzo listo de Nutrivé, para la primera quincena de ' || (SELECT m.largo[extract(month FROM CURRENT_DATE + 10)::int] FROM meses m) || '. COP 6,5 M.', (CURRENT_DATE - 7 + time '15:00') AT TIME ZONE 'UTC', '{"amount": 6500000, "currency": "COP"}'),
  -- Granos del Valle (relativa)
  (26, '00000002-0000-4000-8000-0000000000e6', '00000002-0000-4000-8000-0000000dea02', NULL, 'signal_detected',
    'Top Ads en TikTok Creative Center', 'Colombia, últimos 7 días, categoría alimentos.', (CURRENT_DATE - 24 + time '09:00') AT TIME ZONE 'UTC', '{"signal_id": "00000002-0000-4000-8000-00000005e004"}'),
  (27, '00000002-0000-4000-8000-0000000000e6', '00000002-0000-4000-8000-0000000dea02', '00000002-0000-4000-8000-0000000c0009', 'email_sent',
    'Pitch por correo', 'Con media kit y la propuesta de historias + 1 reel.', (CURRENT_DATE - 21 + time '14:00') AT TIME ZONE 'UTC', '{}'),
  (28, '00000002-0000-4000-8000-0000000000e6', '00000002-0000-4000-8000-0000000dea02', '00000002-0000-4000-8000-0000000c0009', 'email_sent',
    'Seguimiento 1', 'Se cita el video "Almuerzo por 8 mil pesos" como referencia de formato.', (CURRENT_DATE - 14 + time '14:05') AT TIME ZONE 'UTC', '{}'),
  (29, '00000002-0000-4000-8000-0000000000e6', '00000002-0000-4000-8000-0000000dea13', '00000002-0000-4000-8000-0000000c0010', 'note',
    'Perdido', 'Eligieron a otra creadora del nicho. Mateo pidió no recibir más correos.', '2026-03-20 15:00:00+00', '{}'),
  -- Vitalé (relativa)
  (30, '00000002-0000-4000-8000-0000000000e7', '00000002-0000-4000-8000-0000000dea08', NULL, 'signal_detected',
    '4 anuncios activos en Meta', 'Categoría bienestar, Colombia. Pauta desde hace un mes.', (CURRENT_DATE - 31 + time '08:00') AT TIME ZONE 'UTC', '{"signal_id": "00000002-0000-4000-8000-00000005e006"}'),
  (31, '00000002-0000-4000-8000-0000000000e7', '00000002-0000-4000-8000-0000000dea08', '00000002-0000-4000-8000-0000000c0011', 'email_sent',
    'Pitch por correo', 'Con media kit; se citan los reels de desayunos.', (CURRENT_DATE - 27 + time '14:00') AT TIME ZONE 'UTC', '{}'),
  (32, '00000002-0000-4000-8000-0000000000e7', '00000002-0000-4000-8000-0000000dea08', '00000002-0000-4000-8000-0000000c0011', 'email_received',
    'Interesados', 'Sofía pide 2 reels con derechos de uso para pauta.', (CURRENT_DATE - 20 + time '15:00') AT TIME ZONE 'UTC', '{}'),
  (33, '00000002-0000-4000-8000-0000000000e7', '00000002-0000-4000-8000-0000000dea08', '00000002-0000-4000-8000-0000000c0011', 'proposal_sent',
    'Cotización', '2 Reels + derechos 90 d, COP 9,8 M.', (CURRENT_DATE - 13 + time '15:00') AT TIME ZONE 'UTC', '{"amount": 9800000, "currency": "COP"}'),
  (34, '00000002-0000-4000-8000-0000000000e7', '00000002-0000-4000-8000-0000000dea08', '00000002-0000-4000-8000-0000000c0011', 'call',
    'Piden ajustar entregables', 'Un reel más corto y una historia extra, mismo presupuesto.', (CURRENT_DATE - 6 + time '17:00') AT TIME ZONE 'UTC', '{"duration_min": 15}'),
  (35, '00000002-0000-4000-8000-0000000000e7', '00000002-0000-4000-8000-0000000dea14', '00000002-0000-4000-8000-0000000c0011', 'email_sent',
    'Pitch para la línea de snacks', 'Con el media kit y una propuesta de 1 TikTok + 1 Reel + 3 historias para el lanzamiento de snacks, aparte de los 2 reels en propuesta.', (CURRENT_DATE - 3 + time '14:00') AT TIME ZONE 'UTC', '{}'),
  -- Olla Fácil (relativa)
  (36, '00000002-0000-4000-8000-0000000000e8', '00000002-0000-4000-8000-0000000dea01', NULL, 'signal_detected',
    'Colaboración pagada con @la.olla.facil', 'Cuenta vigilada del nicho. Encaje de audiencia 79 %.', (CURRENT_DATE - 3 + time '10:00') AT TIME ZONE 'UTC', '{"signal_id": "00000002-0000-4000-8000-00000005e003"}'),
  -- Nutrivé · la activación corta de octubre (relativa), sigue de la 25
  (37, '00000002-0000-4000-8000-0000000000e4', '00000002-0000-4000-8000-0000000dea15', '00000002-0000-4000-8000-0000000c0005', 'dm_received',
    'Piden un TikTok y un Short para ' || (SELECT m.largo[extract(month FROM CURRENT_DATE + 10)::int] FROM meses m),
    'Julián quiere una activación corta del almuerzo listo, aparte de la serie de Q' || extract(quarter FROM CURRENT_DATE + 28) || '. Presupuesto hasta 7 M.', (CURRENT_DATE - 8 + time '13:00') AT TIME ZONE 'UTC', '{}'),
  (38, '00000002-0000-4000-8000-0000000000e4', '00000002-0000-4000-8000-0000000dea15', '00000002-0000-4000-8000-0000000c0005', 'dm_received',
    'Aceptan la cotización; faltan las fechas', 'Confirman los 6,5 M. Piden las fechas de publicación antes del viernes.', (CURRENT_DATE - 3 + time '16:00') AT TIME ZONE 'UTC', '{}')
) AS a(n, company_id, deal_id, contact_id, kind, subject, body, occurred_at, metadata)
ON CONFLICT DO NOTHING;


-- ---------------------------------------------------------------------
-- 11b · El último toque de cada deal abierto
-- ---------------------------------------------------------------------
-- Las actividades de arriba son hechos: se congelan. Pero una línea de
-- tiempo que termina hace seis semanas en un deal que dice «vence hoy»
-- no es una historia creíble. Por eso cada deal ABIERTO que ya fue
-- contactado —todos menos Olla Fácil, que sigue en "nuevo" y todavía no
-- ha recibido el pitch— lleva UNA actividad de seguimiento anclada a
-- CURRENT_DATE, con id fijo y DO UPDATE: al volver a sembrar se mueve
-- con el reloj, como el plan del deal.
-- occurred_at es exactamente deal.last_contact_at (sección 10): la
-- tarjeta del tablero y la ficha de empresa no pueden decir cosas
-- distintas. La consulta (q) de verify/0002.sql lo comprueba.
INSERT INTO activity (id, workspace_id, company_id, deal_id, contact_id, user_id, kind, subject, body, occurred_at, metadata)
SELECT ('00000002-0000-4000-8000-00000ac7' || lpad(to_hex(a.n), 4, '0'))::uuid,
       '00000002-0000-4000-8000-000000000001', a.company_id, a.deal_id, a.contact_id,
       '00000002-0000-4000-8000-000000000002', a.kind, a.subject, a.body,
       (CURRENT_DATE - a.dias + a.hora) AT TIME ZONE 'UTC', a.metadata
FROM (VALUES
  (39, '00000002-0000-4000-8000-0000000000e6'::uuid, '00000002-0000-4000-8000-0000000dea02'::uuid, '00000002-0000-4000-8000-0000000c0009'::uuid, 'dm_sent',
    'Recordatorio por DM', 'Se le recuerda a Laura Quintero la propuesta de historias + 1 reel. El seguimiento 2 por correo sigue pendiente.', 5, time '15:00', '{}'::jsonb),
  (40, '00000002-0000-4000-8000-0000000000e7', '00000002-0000-4000-8000-0000000dea14', '00000002-0000-4000-8000-0000000c0011', 'email_received',
    'Sofía pide el guion de las historias', 'Quiere ver las tres pantallas antes de pasar el presupuesto de snacks a aprobación.', 1, time '16:00', '{}'),
  (41, '00000002-0000-4000-8000-0000000000e5', '00000002-0000-4000-8000-0000000dea03', '00000002-0000-4000-8000-0000000c0008', 'email_sent',
    'Borrador del contrato para revisión', 'Enviado el borrador con las fechas de publicación y la exclusividad de 30 días. Falta la versión final para firma.', 2, time '15:00', '{}'),
  (42, '00000002-0000-4000-8000-0000000000e1', '00000002-0000-4000-8000-0000000dea04', '00000002-0000-4000-8000-0000000c0003', 'email_sent',
    'La propuesta de renovación llega esta semana', 'Se le confirma a Valentina el alcance: un reel y un TikTok al mes durante tres meses.', 4, time '14:00', '{}'),
  (43, '00000002-0000-4000-8000-0000000000e4', '00000002-0000-4000-8000-0000000dea05', '00000002-0000-4000-8000-0000000c0005', 'call',
    'Llamada de 12 min sobre la serie', 'Julián confirma los tres videos, uno por mes. Falta cerrar presupuesto y fechas de grabación.', 3, time '13:00', '{"duration_min": 12}'),
  (44, '00000002-0000-4000-8000-0000000000e3', '00000002-0000-4000-8000-0000000dea06', '00000002-0000-4000-8000-0000000c0007', 'call',
    'Llamada por la factura en mora', 'Andrea dice que el pago sale al cierre de mes. La propuesta de navidad sigue condicionada a que entre.', 6, time '16:00', '{"duration_min": 9}'),
  (45, '00000002-0000-4000-8000-0000000000e2', '00000002-0000-4000-8000-0000000dea07', '00000002-0000-4000-8000-0000000c0001', 'email_received',
    'Camila revisa la cotización esta semana', 'El comité de marketing la ve el jueves; piden mantener el código y el enlace propios.', 2, time '15:00', '{}'),
  (46, '00000002-0000-4000-8000-0000000000e7', '00000002-0000-4000-8000-0000000dea08', '00000002-0000-4000-8000-0000000c0011', 'dm_sent',
    'Entregables ajustados', 'Enviada la versión con el reel más corto y la historia extra, con el mismo presupuesto de COP 9,8 M.', 4, time '17:00', '{}'),
  (47, '00000002-0000-4000-8000-0000000000e4', '00000002-0000-4000-8000-0000000dea15', '00000002-0000-4000-8000-0000000c0005', 'dm_sent',
    'Fechas propuestas para el TikTok y el Short', 'Se proponen dos fechas de publicación de la primera quincena. Falta la confirmación de Julián.', 1, time '13:00', '{}')
) AS a(n, company_id, deal_id, contact_id, kind, subject, body, dias, hora, metadata)
ON CONFLICT (id) DO UPDATE SET
  occurred_at = EXCLUDED.occurred_at,
  subject     = EXCLUDED.subject,
  body        = EXCLUDED.body;


-- =====================================================================
-- 12 · Outbound: qué busca la creadora y con qué límites
-- ---------------------------------------------------------------------
-- deliverables son los rangos del tarifario del mock (RATES). El brief
-- está activo y mira el trimestre que viene: título y ventana (del
-- primer día del trimestre de CURRENT_DATE + 30, 75 días: 1 oct – 15
-- dic sembrado el 22 sep) salen de CURRENT_DATE y se congelan con DO
-- NOTHING. La política deja los valores conservadores del esquema,
-- explícitos.
-- =====================================================================
INSERT INTO outbound_brief (id, workspace_id, creator_id, title, wanted_categories, wanted_countries, min_budget, currency, deliverables, availability_from, availability_to, excluded_categories, excluded_companies, requires_disclosure, notes, status)
VALUES (
  '00000002-0000-4000-8000-0000000b0001', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000003',
  'Marcas de alimentos y cocina · Q' || extract(quarter FROM CURRENT_DATE + 30) || ' ' || extract(year FROM CURRENT_DATE + 30),
  '{alimentos,cocina,hogar,bienestar}', '{CO,MX}', 3000000.00, 'COP',
  '[{"kind": "tiktok",    "label": "Video de TikTok",                  "price_low": 7100000, "price_high": 10600000},
    {"kind": "reel",      "label": "Reel de Instagram",                "price_low": 4800000, "price_high": 7200000},
    {"kind": "short",     "label": "YouTube Short",                    "price_low": 2100000, "price_high": 3200000},
    {"kind": "historias", "label": "Historia de Instagram (3 pantallas)", "price_low": 1600000, "price_high": 2400000}]'::jsonb,
  date_trunc('quarter', CURRENT_DATE + 30)::date, date_trunc('quarter', CURRENT_DATE + 30)::date + 75, '{alcohol,apuestas,suplementos}', '{}', true,
  'Prioridad: lanzamientos de productos de despensa y desayuno. Siempre con código propio y enlace rastreado para poder reportar ventas.',
  'active'
)
-- La ventana del brief activo también es un plan: se refresca al volver
-- a sembrar, si no un brief "activo" acaba con la disponibilidad
-- cerrada hace semanas.
ON CONFLICT (id) DO UPDATE SET
  title             = EXCLUDED.title,
  availability_from = EXCLUDED.availability_from,
  availability_to   = EXCLUDED.availability_to
WHERE outbound_brief.status = 'active';

INSERT INTO outbound_policy (workspace_id, max_touches_per_company, min_days_between_touches, max_emails_per_day, cooldown_days_after_no, require_optout_link, require_human_review, claims_must_be_sourced, allowed_channels)
VALUES ('00000002-0000-4000-8000-000000000001', 4, 3, 20, 180, true, true, true, '{email,linkedin,instagram_dm}')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 13 · Las campañas, enlazadas a su deal ganado
-- ---------------------------------------------------------------------
-- Mismos ids y cifras que 0003 (que corre después y las reafirma con
-- DO UPDATE sobre todo menos deal_id), enlazadas aquí a su deal ganado
-- para que la cadena señal → deal → campaña → factura → cobro se pueda
-- recorrer. Van las CUATRO, no solo las dos reportadas: 0003 no toca
-- deal_id, así que si 0002 no las crea, Fresko (ca0002 → dea09) y
-- Nutrivé (ca0003 → dea10) quedan para siempre sin deal y su ficha no
-- puede decir de qué venta salieron, aunque el deal ganado exista y se
-- llame igual. Las dos reportadas traen además su campaign_result: son
-- la prueba social del perfil. Las views del resultado de Café Alma
-- (412 K + 300 K) son las que la curva de la sección 4 da a 720 h para
-- d01 y d02. Los entregables (campaign_post) y el resto de las cifras
-- de ca0002 y ca0003 son de 0003, que es su dueño.
-- Línea de tiempo de Café Alma, una sola para 0002 y 0003: lanzamiento
-- del cold brew el 22 jul, propuesta el 23, aceptada el 29; campaña del
-- 10 al 17 ago (reel el 10, TikTok el 12; línea base de @cafealma desde
-- el 27 jul); las 720 h del TikTok se cumplen el 11 sep; resultado
-- calculado el 12 sep a las 07:30 y reporte enviado ese día a las
-- 14:00. Todo antes de hoy: ninguna fecha del seed está en el futuro
-- (verify/0002.sql lo comprueba).
-- =====================================================================
INSERT INTO campaign (id, workspace_id, company_id, creator_id, deal_id, name, brief, starts_on, ends_on, tracking_code, tracking_url, utm, brand_baseline_from, brand_accounts, amount, currency, status)
VALUES
  ('00000003-0000-4000-8000-000000ca0001', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e1', '00000002-0000-4000-8000-000000000003',
   '00000002-0000-4000-8000-0000000dea11',
   'Lanzamiento cold brew', '1 reel + 1 TikTok + 3 historias. Código propio y enlace rastreado; reporte a 30 días con cortes a 7 y 30.',
   DATE '2026-08-10', DATE '2026-08-17', 'LAURA15',
   'https://cafealma.co/cold-brew?utm_source=instagram&utm_medium=creator&utm_campaign=laura_coldbrew',
   '{"utm_source": "instagram", "utm_medium": "creator", "utm_campaign": "laura_coldbrew"}'::jsonb,
   DATE '2026-07-27', '[{"platform_id": "instagram", "handle": "cafealma"}]'::jsonb,
   3100000.00, 'COP', 'reported'),
  ('00000003-0000-4000-8000-000000ca0004', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e3', '00000002-0000-4000-8000-000000000003',
   '00000002-0000-4000-8000-0000000dea12',
   '3 historias · jun', '3 historias con código. Reporte enviado; la factura sigue pendiente de pago.',
   DATE '2026-06-05', DATE '2026-06-06', 'LAURAHOGAR', NULL, '{}'::jsonb,
   DATE '2026-05-22', '[{"platform_id": "instagram", "handle": "hogarlindo"}]'::jsonb,
   1100000.00, 'COP', 'reported'),
  ('00000003-0000-4000-8000-000000ca0002', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e2', '00000002-0000-4000-8000-000000000003',
   '00000002-0000-4000-8000-0000000dea09',
   'Campaña 2 TikTok · sep', '2 TikTok con enlace rastreado a la caja de desayunos. Medición a 30 días.',
   DATE '2026-09-02', DATE '2026-09-09', 'LAURAFRESKO',
   'https://freskomarket.co/caja?utm_source=tiktok&utm_medium=creator&utm_campaign=laura_sep',
   '{"utm_source": "tiktok", "utm_medium": "creator", "utm_campaign": "laura_sep"}'::jsonb,
   DATE '2026-08-19', '[{"platform_id": "tiktok", "handle": "freskomarket"}]'::jsonb,
   5200000.00, 'COP', 'measuring'),
  ('00000003-0000-4000-8000-000000ca0003', '00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e4', '00000002-0000-4000-8000-000000000003',
   '00000002-0000-4000-8000-0000000dea10',
   'Video dedicado · julio', '1 video dedicado en YouTube. La marca no compartió datos de ventas.',
   DATE '2026-07-15', DATE '2026-07-22', NULL, NULL, '{}'::jsonb,
   DATE '2026-07-01', '[{"platform_id": "youtube", "handle": "NutriveOficial"}]'::jsonb,
   4700000.00, 'COP', 'closed')
ON CONFLICT DO NOTHING;

INSERT INTO campaign_post (campaign_id, post_id, deliverable, is_primary)
VALUES
  ('00000003-0000-4000-8000-000000ca0001', '00000002-0000-4000-8000-000000000d01', 'reel',   true),
  ('00000003-0000-4000-8000-000000ca0001', '00000002-0000-4000-8000-000000000d02', 'tiktok', false)
ON CONFLICT DO NOTHING;

INSERT INTO campaign_result (campaign_id, workspace_id, computed_at, cut_hours, views, reach, interactions, saves, shares, link_clicks, reach_non_followers_pct, views_vs_median, brand_followers_gained, brand_followers_baseline_rate, brand_followers_campaign_rate, code_redemptions, attributed_revenue, currency, cpm, cost_per_follower, cpa, emv, missing_inputs)
VALUES
  ('00000003-0000-4000-8000-000000ca0001', '00000002-0000-4000-8000-000000000001', '2026-09-12 07:30:00+00', 720,
   712000, 486000, 57630, 9600, 5100, 6240, 0.58000, NULL,
   1240, 12.9286, 155.0000, 318, 8400000.00, 'COP', 11800.00, 2500.00, 26400.00, NULL, '{brand_csv_sales}'),
  ('00000003-0000-4000-8000-000000ca0004', '00000002-0000-4000-8000-000000000001', '2026-07-07 07:30:00+00', 720,
   94000, 61000, 5900, 1200, 480, 700, 0.49180, NULL,
   NULL, NULL, NULL, 42, 1100000.00, 'COP', 11702.13, NULL, 26190.48, NULL, '{brand_followers}')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- Conteos esperados (node db/seed/verify/run.mjs 0002, pasadas 1 y 2)
-- ---------------------------------------------------------------------
-- Solo lo que este seed crea (sembrando 0001 + 0002); 0003 añade lo suyo
-- encima (campaign_post 2 → 5, post_metric_snapshot +3 o +5, y las
-- finanzas), y run.mjs corre los tres seeds, así que muestra esos de
-- más. Las lecturas por post dependen
-- de la edad de cada video, así que su conteo crece un poco cada día
-- (una lectura diaria por video con menos de 90 días, medida a
-- medianoche UTC); el resto es fijo. Una tercera corrida con el reloj
-- adelantado un día (run.mjs) deja idénticos todos los conteos salvo
-- ese, que crece solo en las lecturas del día nuevo.
--
--   tabla                    filas
--   workspace                    1
--   app_user                     1
--   membership                   1
--   creator_profile              1
--   social_connection            4
--   post                        60  (sembrando en limpio; al volver a sembrar N días
--                                    después crece en N/2: un video cada dos días hasta
--                                    ayer, sección 3b)
--   post_metric_snapshot     ~2 650  (60 posts × lecturas ya ocurridas; 2 650 el 22-sep-2026 y 2 708 al día
--                                    siguiente; run.mjs muestra 3 más porque 0003 añade sus tres lecturas manuales)
--   account_metric_snapshot    360  (4 conexiones × 90 días, el último es ayer; al volver a
--                                    sembrar N días después crece en 4·N: la serie llega hasta ayer)
--   audience_breakdown          60  (4 conexiones × 15 buckets; `absolute` sale del
--                                    último día de la serie, no de un literal)
--   creator_baseline            16  (4 redes × 4 cortes), is_reliable en todas; +16 por cada
--                                    día distinto en que se vuelva a sembrar (el id lleva el día)
--   post_score                  59  (todo video con al menos 24 h; 6 outliers, 1 breakout;
--                                    al resembrar, cada fila sube al corte alcanzado)
--   company                      8
--   company_link                 8
--   contact                     12  (1 con opted_out)
--   signal                      13  (6 accepted, 5 pending —las cinco del mock—,
--                                    1 duplicate, 1 discarded)
--   deal                        15  (10 abiertos, 4 ganados, 1 perdido)
--   deal_stage_history          47
--   activity                    47  (38 históricas + 9 de seguimiento, sección 11b)
--   outbound_brief               1
--   outbound_policy              1
--   campaign                     4  (las cuatro de 0003, enlazadas aquí a su deal ganado)
--   campaign_post                2  (los dos posts de Café Alma; los otros tres los pone 0003)
--   campaign_result              2  (las dos reportadas)
-- =====================================================================
