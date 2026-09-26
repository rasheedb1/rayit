-- =====================================================================
-- 0059 · Una respuesta detiene a la marca, no solo al hilo (VEN-10)
-- ---------------------------------------------------------------------
-- Número: 0059. La serie de integración va de 0043 a 0075, detrás de
-- la 0042 de main (0034–0042, ya aplicadas en Supabase); ninguna de la
-- serie está aplicada aún. Hasta el pulido r2 de ventas esta fue la
-- 0054. Va detrás de 0058_motor_intento_sin_confirmar y no depende de
-- nada más.
--
-- El error número uno de Chief (docs/ventas-outreach.md §9): el mensaje
-- sale DESPUÉS de que la marca respondió. Hasta aquí una respuesta solo
-- detenía el enrolamiento de su hilo. El motor ahora, ante una respuesta
-- de verdad (ni automática ni una baja):
--
--   · detiene TODOS los enrolamientos vivos de esa ficha en el workspace
--     (pasan a 'replied' y se cancela lo suyo cancelable), aunque estén
--     en otra secuencia: ya contestó, y lo que sigue lo decide una persona;
--   · si stop_company_on_reply está encendido (el valor por defecto),
--     PAUSA los enrolamientos vivos de las otras fichas de la misma marca
--     (status 'paused' sin resume_at): Ana respondió, así que a Pedro, de
--     la misma marca, no le sigue llegando «Una última idea». Se pausan y
--     no se cancelan: si la conversación con Ana no llega a nada, la
--     creadora puede reanudar a Pedro. El despachador pospone lo de un
--     enrolamiento pausado y nunca lo envía mientras siga así.
--
-- Lo decide la aplicación (applyInboundEffects, @mc/db); la base solo
-- guarda la preferencia del workspace.
-- =====================================================================

ALTER TABLE outbound_policy
  ADD COLUMN IF NOT EXISTS stop_company_on_reply boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN outbound_policy.stop_company_on_reply IS
  'Si una persona de la marca responde, se pausan las cadencias de las demás personas de esa marca (VEN-10, 0059).';
