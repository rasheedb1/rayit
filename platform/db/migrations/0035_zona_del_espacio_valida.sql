-- =====================================================================
-- 0035 · La zona horaria de un espacio es una zona que Postgres conoce
-- ---------------------------------------------------------------------
-- Número: 0034 (seguimientos) es la anterior y tampoco está aplicada en
-- Supabase; esta va con ella en el mismo deploy. No depende de nada que
-- venga después: si otra área eligió 0035, el integrador renumera.
--
-- El problema, reproducido en Postgres embebido: workspace.timezone es
-- text sin CHECK y mc_app puede cambiarla (esquema.ts, UPDATE sobre
-- timezone). Con UN espacio en 'Bogota' (sin «America/»), cualquier
-- `AT TIME ZONE w.timezone` que recorra varios espacios falla entero con
-- «time zone "Bogota" not recognized». El job de seguimientos (VEN-4)
-- recorre todos: una zona mal escrita dejaba sin avisos a TODOS los
-- espacios, y pg-boss lo reintentaba para volver a fallar.
--
-- Dos defensas:
--   1. El job resuelve la zona contra pg_timezone_names y cuenta en UTC
--      la que no existe (apps/worker/src/jobs/ventas/seguimientos.ts).
--      Eso cubre las filas que ya estén mal.
--   2. Esta migración: un disparador que no deja guardar una zona que no
--      esté en pg_timezone_names. Así no entra ninguna nueva, ni desde la
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
-- un valor distinto): un espacio con una zona vieja mal escrita puede
-- seguir cambiando su nombre o su moneda sin que el disparador lo
-- bloquee. Las filas que ya estén mal no se tocan aquí (es un dato del
-- cliente); se listan con un NOTICE para que el integrador las corrija.
-- =====================================================================

CREATE FUNCTION workspace_timezone_valida()
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

CREATE TRIGGER workspace_timezone_valida
  BEFORE INSERT OR UPDATE OF timezone ON workspace
  FOR EACH ROW EXECUTE FUNCTION workspace_timezone_valida();

DO $$
DECLARE
  malas text;
BEGIN
  SELECT string_agg(format('%s (%s)', w.slug, w.timezone), ', ')
    INTO malas
    FROM workspace w
   WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name = w.timezone);
  IF malas IS NOT NULL THEN
    RAISE NOTICE 'espacios con zona horaria desconocida (se cuentan en UTC hasta corregirlas): %', malas;
  END IF;
END;
$$;
