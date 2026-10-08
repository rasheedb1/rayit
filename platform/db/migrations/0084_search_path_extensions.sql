-- =====================================================================
-- 0084 · Toda función con search_path propio ve el esquema extensions
--
-- En Supabase, citext, pgcrypto y pg_trgm viven en el esquema
-- `extensions`, no en `public`. Quince funciones de 0026–0045 (ya
-- aplicadas, inmutables) fijan `search_path = public, pg_temp`: dentro de
-- ellas citext no existe. En producción, contact_suppression_apply()
-- hacía fallar cada turno del lector de respuestas del outreach
-- (outbound.replies: «type citext does not exist», VEN-17).
--
-- El 7-oct se corrigió en caliente en Supabase con este mismo bloque;
-- esta migración lo deja escrito para cualquier base nueva y es
-- idempotente: donde ya está bien, no cambia nada. Las migraciones
-- desde 0046 ya lo escriben bien y la prueba
-- packages/db/test/search-path-extensions.test.ts lo exige.
--
-- En pglite las extensiones viven en public, así que `extensions` en el
-- search_path es un esquema que no existe, y Postgres lo ignora.
-- =====================================================================

DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c
                    WHERE c LIKE 'search_path=%' AND c !~ 'extensions')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, extensions, pg_temp', f);
  END LOOP;
END $$;
