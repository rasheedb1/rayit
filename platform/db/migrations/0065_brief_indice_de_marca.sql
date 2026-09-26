-- =====================================================================
-- 0065 · Reconocer una marca por su dominio o su nombre con un índice
--        que sirva bajo RLS (VEN-7 r3)
-- ---------------------------------------------------------------------
-- Número: la siguiente libre detrás de 0064_brief_y_motivo_de_perdida,
-- de esta misma rama. No borra ni cambia datos: agrega una columna
-- calculada y dos índices.
--
-- Por qué. El veredicto del brief (queries/brief.ts) decide, por cada
-- señal pendiente, si su marca o su categoría están excluidas. Para eso
-- resuelve la empresa de la señal como resolveCompany: por id, por
-- dominio o, si la señal no trae ninguno de los dos, por el nombre
-- (brand_key: «Nutrivé» = «NUTRIVE») entre las empresas del CRM.
--
-- Hasta la ronda 2 esa búsqueda era una sola condición con OR sobre la
-- tabla company entera, que ningún índice puede servir: cada señal
-- recorría el catálogo. Con 10 000 empresas en el catálogo compartido
-- (lo llena el enriquecimiento del worker y lo ven todos los espacios) y
-- 100 señales, un solo countHiddenSignals tardaba 28,6 s, y la misma
-- expresión corre en la cabecera de Ventas, en la pestaña del radar y
-- en la lista de Empresas. Desde la ronda 3 son búsquedas separadas
-- unidas con UNION ALL. Pero separar no basta: bajo RLS, Postgres solo
-- usa un índice si la condición es LEAKPROOF (no puede filtrar datos
-- antes de la política), y medimos (EXPLAIN ANALYZE, en PGlite, como
-- mc_app, con 5 000 empresas en el catálogo):
--
--   · brand_key(co.name) = …   con un índice de expresión sobre
--     brand_key(name): NO lo usa. brand_key se expande a regexp_replace
--     y translate, que no son leakproof, así que la condición se evalúa
--     después de company_read, fila a fila: 5 000 filas, 19 ms por
--     señal. (Marcar brand_key LEAKPROOF pide superusuario, y
--     mc_migrator no lo es.)
--   · co.domain = lower(…)     compara como text (domain es citext y no
--     hay operador citext = text): los índices parciales de 0025 son
--     sobre citext y no sirven. Con un índice sobre (domain::text), sí:
--     0,02 ms. (Comparar como citext tampoco: citext_eq no es leakproof.)
--   · co.name_key = …          una columna calculada con brand_key(name)
--     e indexada: texteq sí es leakproof y usa el índice: 0,01 ms.
--
-- Así que:
--   1. name_key: brand_key(name), GENERATED ALWAYS … STORED. La calcula
--      la base en cada INSERT y UPDATE de name; nadie la escribe. Es el
--      «índice de brand_key(name)» que la revisión pedía, en la forma que
--      el planificador puede usar con RLS.
--   2. Un índice sobre name_key.
--   3. Un índice sobre (domain::text). Los dominios los guarda
--      normalizeDomain en minúsculas, igual que se buscan.
--
-- brand_key es IMMUTABLE (0031 §1), requisito de una columna generada.
--
-- Medición antes de aplicarla: company tiene hoy pocas filas (el seed y
-- lo que haya dado de alta cada espacio), así que reescribir la tabla
-- para la columna nueva y crear los índices es instantáneo. No va
-- CONCURRENTLY porque el runner aplica cada migración en una transacción.
-- =====================================================================

ALTER TABLE company
  ADD COLUMN IF NOT EXISTS name_key text GENERATED ALWAYS AS (brand_key(name)) STORED;

CREATE INDEX IF NOT EXISTS company_name_key_idx ON company (name_key);

CREATE INDEX IF NOT EXISTS company_domain_text_idx ON company ((domain::text));
