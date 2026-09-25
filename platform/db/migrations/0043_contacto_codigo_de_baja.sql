-- =====================================================================
-- 0043 · Canales de outreach: el motivo de una baja por respuesta es un
--        código, no una frase (VEN-9, ronda 3 de canales)
-- ---------------------------------------------------------------------
-- Número: detrás de 0042, que tampoco está aplicada en Supabase. El
-- integrador las renumera juntas (0038 a 0043).
--
-- Cuando una respuesta de LinkedIn, Instagram o correo pide la baja
-- («no me escribas más»), recordInboundMessage (@mc/db, canales.ts) da
-- de baja la ficha. Hasta aquí escribía en contact.opted_out_reason una
-- frase en español («Pidió no ser contactado, respondiendo por
-- LinkedIn.»), y un espacio en otro idioma heredaba esa frase congelada.
-- La regla de la pieza (docs/ventas-outreach.md §9.2) es que en la base
-- quedan códigos y la pantalla los traduce, como last_error.
--
-- opted_out_reason no se puede reciclar para eso: ya la escriben la
-- persona (el «Motivo (opcional)» de la ficha, texto libre suyo), la
-- baja global de 0026 y el enlace de baja de 0037, los dos con frases.
-- Por eso el código va en una columna aparte:
--
--   opted_out_code   'reply_optout:<canal>': la ficha se dio de baja
--                    porque respondió pidiéndolo por ese canal. NULL en
--                    cualquier otra baja (la de la persona, la global, la
--                    del enlace), que siguen con su motivo en texto.
--
-- Enumerado como text + CHECK (convención del repositorio). Un canal
-- nuevo, o un código nuevo, es otra migración que amplía el CHECK.
-- La pantalla de la ficha traduce el código con el messages.ts de
-- Ventas; opted_out_reason, si lo hay, sigue mandando (es de la persona).
--
-- Sin permisos nuevos: mc_app y mc_worker escriben la tabla entera por
-- las concesiones que ya tienen; mc_public_share (el enlace de baja)
-- sigue limitado a sus tres columnas de 0037 y no escribe esta.
-- =====================================================================

ALTER TABLE contact
  ADD COLUMN opted_out_code text
    CONSTRAINT contact_opted_out_code_check
    CHECK (opted_out_code IS NULL OR opted_out_code IN (
      'reply_optout:email', 'reply_optout:linkedin', 'reply_optout:instagram_dm'
    ));

COMMENT ON COLUMN contact.opted_out_code IS
  'Por qué se dio de baja la ficha, como código que la pantalla traduce: reply_optout:<canal> si respondió pidiéndolo '
  'por ese canal (VEN-9). NULL en las demás bajas, que llevan su motivo en opted_out_reason.';
