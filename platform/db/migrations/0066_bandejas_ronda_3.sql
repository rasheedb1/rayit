-- =====================================================================
-- 0066 · Las bandejas, ronda 3 (VEN-14)
-- ---------------------------------------------------------------------
-- Número: va detrás de 0065_bandejas_ronda_2, de la misma historia, y no
-- depende de nada más. Si el integrador renumera 0064 y 0065, esta va
-- justo después.
--
-- outbound_touch.approved_from_reason
--
--   El motivo con el que estaba retenido un toque cuando una persona lo
--   aprobó desde /ventas/aprobaciones. Aprobar lo libera (releaseHeldTouch
--   deja held_reason en NULL); «Deshacer» lo devuelve a la cola con ESTE
--   motivo, que guarda el servidor. Antes lo mandaba el navegador junto con
--   la petición de deshacer, y una petición alterada podía dejar en la
--   cola un motivo inventado que la pantalla enseñaba como si viniera del
--   motor. Se vacía al deshacer; si el toque sale, se queda como registro
--   de por qué estaba retenido lo que una persona aprobó.
-- =====================================================================

ALTER TABLE outbound_touch
  ADD COLUMN approved_from_reason text
    CHECK (approved_from_reason IS NULL OR char_length(approved_from_reason) <= 500);

COMMENT ON COLUMN outbound_touch.approved_from_reason IS
  'El motivo con el que estaba retenido cuando una persona lo aprobó; «Deshacer» lo devuelve a la cola con él (0066).';
