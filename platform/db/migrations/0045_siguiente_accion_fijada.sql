-- =====================================================================
-- 0045 · Cuándo se escribió la siguiente acción de un negocio (VEN-4)
-- ---------------------------------------------------------------------
-- Número: 0045. La serie de integración va de 0043 a 0075, detrás de
-- la 0042 de main (0034–0042, ya aplicadas en Supabase); ninguna de la
-- serie está aplicada aún. Hasta el pulido r2 de ventas esta fue la
-- 0036. Va detrás de 0043 (seguimientos) y 0044 (zona del espacio
-- válida) y no depende de nada posterior.
--
-- deal.next_action_set_at
--
--   El job sales.follow_ups (apps/worker/src/jobs/ventas/seguimientos.ts)
--   no manda «Vence hoy» de una acción que alguien escribió HOY después
--   de la hora de aviso: quien la acaba de decidir no necesita que se la
--   recuerden una hora después. Hasta ahora lo sabía por deal.updated_at,
--   pero updated_at cambia por cualquier cosa: registrar una llamada
--   (logActivity mueve last_contact_at de los negocios de la empresa),
--   mover la etapa o corregir el monto. Si el worker no corría a las
--   7:05 y alguien registraba una llamada a las 8:00, la corrida
--   atrasada de las 9:00 se saltaba el «Vence hoy» de un negocio cuya
--   acción nadie había tocado.
--
--   Esta columna guarda solo eso: el instante en que cambió el texto o
--   el vencimiento de la siguiente acción. La pone un disparador, así
--   que vale para todo el que escriba la acción (la ficha, el tablero,
--   el radar al abrir un negocio, Cotizar al enviar una cotización) sin
--   que ninguno tenga que acordarse.
--
--   Reglas del disparador:
--     - INSERT: si el negocio nace con acción o con fecha y nadie dijo
--       cuándo, now().
--     - UPDATE: si cambió next_action o next_action_due y quien escribe
--       no fijó la columna en el mismo UPDATE, now(). Quien la fija a
--       mano (un seed, una prueba con reloj fijo) conserva la suya, como
--       el marcador de 0032.
--   No es SECURITY DEFINER: solo cambia NEW y corre con los permisos de
--   quien escribe.
--
--   Las filas que ya existen quedan en NULL: «no se sabe», que el job
--   trata como «de antes de hoy» y avisa. Es lo que hacía con ellas
--   antes de esta migración (su updated_at era de otro día), y evita un
--   relleno con FORCE ROW LEVEL SECURITY apagado.
-- =====================================================================

ALTER TABLE deal ADD COLUMN next_action_set_at timestamptz;

COMMENT ON COLUMN deal.next_action_set_at IS
  'Cuándo cambió por última vez next_action o next_action_due (0045). NULL: antes de 0045. Lo pone deal_next_action_set_at.';

CREATE FUNCTION deal_next_action_set_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.next_action_set_at IS NULL AND (NEW.next_action IS NOT NULL OR NEW.next_action_due IS NOT NULL) THEN
      NEW.next_action_set_at := now();
    END IF;
  ELSIF (NEW.next_action IS DISTINCT FROM OLD.next_action OR NEW.next_action_due IS DISTINCT FROM OLD.next_action_due)
        AND NEW.next_action_set_at IS NOT DISTINCT FROM OLD.next_action_set_at THEN
    NEW.next_action_set_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER deal_next_action_set_at
  BEFORE INSERT OR UPDATE OF next_action, next_action_due ON deal
  FOR EACH ROW EXECUTE FUNCTION deal_next_action_set_at();
