-- =====================================================================
-- 0044 · La zona horaria de un espacio es una zona que Postgres conoce
-- ---------------------------------------------------------------------
-- Número: 0044. La serie de integración va de 0043 a 0075, detrás de
-- la 0042 de main (0034–0042, ya aplicadas en Supabase); ninguna de la
-- serie está aplicada aún. Hasta el pulido r2 de ventas esta fue la
-- 0035. Va con 0043 (seguimientos) y no depende de nada posterior.
--
-- El problema, reproducido en Postgres embebido: workspace.timezone es
-- text sin CHECK y mc_app puede cambiarla (esquema.ts, UPDATE sobre
-- timezone). Con UN espacio en 'Bogota' (sin «America/»), cualquier
-- `AT TIME ZONE w.timezone` que recorra varios espacios falla entero con
-- «time zone "Bogota" not recognized». El job de seguimientos (VEN-4)
-- recorre todos: una zona mal escrita dejaba sin avisos a TODOS los
-- espacios, y pg-boss lo reintentaba para volver a fallar.
--
-- Tres defensas:
--   1. El job resuelve la zona contra pg_timezone_names y cuenta en UTC
--      la que no existe (apps/worker/src/jobs/ventas/seguimientos.ts).
--   2. Esta migración corrige las filas que YA estén mal (§2). Sin esto,
--      la defensa quedaba a medias: la vista deal_pipeline (0043) y
--      WORKSPACE_TZ (queries/ventas.ts: el tablero, «Para hoy», la
--      ficha) hacen `AT TIME ZONE` con la zona tal cual, y un espacio en
--      'Bogota' perdía esas pantallas enteras con «time zone not
--      recognized». Validar en cada lectura (un subselect sobre
--      pg_timezone_names por fila de la vista) cuesta un recorrido del
--      catálogo de zonas por negocio; corregir el dato una vez, y no
--      dejar que entre otro, hace que toda zona guardada sea válida y
--      que ninguna lectura tenga que desconfiar.
--   3. Un disparador que no deja guardar una zona que no esté en
--      pg_timezone_names (§1). Así no entra ninguna nueva, ni desde la
--      app ni desde un script.
--
-- Por qué disparador y no CHECK: un CHECK no puede consultar otra
-- relación (pg_timezone_names es una vista sobre una función), y el
-- catálogo de zonas cambia con las versiones de tzdata; el disparador
-- valida contra el catálogo del servidor en el momento de escribir.
--
-- Por qué pg_timezone_names y no «lo que acepte AT TIME ZONE»: AT TIME
-- ZONE también acepta desplazamientos POSIX ('UTC-5', '-05:00') cuyo
-- signo es el contrario al ISO y que Intl.DateTimeFormat, en la web, no
-- entiende. Solo nombres IANA ('America/Bogota', 'Europe/Madrid', 'UTC').
--
-- Solo se valida cuando la zona cambia (INSERT, o UPDATE OF timezone con
-- un valor distinto): así el UPDATE de §2 y cualquier cambio del nombre
-- o la moneda de un espacio pasan sin tropezar con el disparador.
--
-- Nombres en inglés, como el resto de identificadores de la base
-- (convención del repo): workspace_timezone_check.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · El disparador
-- ---------------------------------------------------------------------
CREATE FUNCTION workspace_timezone_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.timezone IS NOT DISTINCT FROM OLD.timezone THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'zona horaria desconocida: «%»', NEW.timezone
      USING ERRCODE = 'invalid_parameter_value',
            HINT = 'Usa un nombre IANA, como America/Bogota o Europe/Madrid.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workspace_timezone_check
  BEFORE INSERT OR UPDATE OF timezone ON workspace
  FOR EACH ROW EXECUTE FUNCTION workspace_timezone_check();

-- ---------------------------------------------------------------------
-- 2 · Las filas que ya estén mal
-- ---------------------------------------------------------------------
-- Cada zona desconocida se cambia por la IANA que sin duda quiso decir,
-- si hay UNA sola: la misma con otras mayúsculas ('america/bogota') o la
-- única que termina en ese nombre ('Bogota' → 'America/Bogota',
-- 'Madrid' → 'Europe/Madrid'). Si no hay ninguna, o hay varias
-- ('Central': US/Central, Canada/Central…), UTC, que es como ya la
-- contaba el job. El valor anterior queda en el NOTICE, para que el
-- integrador se lo diga a quien corresponda; no se adivina más.
--
-- workspace tiene RLS forzada: sin quitarla un momento, el dueño (el
-- migrador) no vería ninguna fila —no hay workspace fijado— y el UPDATE
-- no corregiría nada, en silencio. Se quita y se devuelve dentro de la
-- misma transacción, como en 0032.
DO $$
DECLARE
  forzada boolean;
  cambios text;
BEGIN
  SELECT c.relforcerowsecurity INTO forzada
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'workspace';
  IF forzada THEN
    ALTER TABLE workspace NO FORCE ROW LEVEL SECURITY;
  END IF;

  WITH zonas AS MATERIALIZED (SELECT name FROM pg_catalog.pg_timezone_names),
  malas AS (
    SELECT w.id, w.slug, w.timezone AS antes
      FROM workspace w
     WHERE NOT EXISTS (SELECT 1 FROM zonas z WHERE z.name = w.timezone)
  ),
  arreglo AS (
    SELECT m.id, m.slug, m.antes,
           coalesce(
             (SELECT min(z.name) FROM zonas z WHERE lower(z.name) = lower(btrim(m.antes))
              HAVING count(*) = 1),
             (SELECT min(z.name) FROM zonas z
               WHERE btrim(m.antes) <> '' AND lower(z.name) LIKE '%/' || lower(btrim(m.antes))
              HAVING count(*) = 1),
             'UTC') AS despues
      FROM malas m
  ),
  hecho AS (
    UPDATE workspace w SET timezone = a.despues
      FROM arreglo a
     WHERE w.id = a.id
    RETURNING a.slug, a.antes, a.despues
  )
  SELECT string_agg(format('%s: «%s» → %s', slug, antes, despues), ', ' ORDER BY slug)
    INTO cambios
    FROM hecho;

  IF forzada THEN
    ALTER TABLE workspace FORCE ROW LEVEL SECURITY;
  END IF;
  IF cambios IS NOT NULL THEN
    RAISE NOTICE 'espacios con zona horaria desconocida, corregidos: %', cambios;
  END IF;
END;
$$;
