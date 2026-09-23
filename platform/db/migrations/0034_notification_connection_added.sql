-- =====================================================================
-- 0034 · Aviso al titular cuando un tercero conecta su cuenta (ACC-8)
-- ---------------------------------------------------------------------
-- Número: la más alta en todas las ramas el 23 de septiembre es 0033.
-- Si otra área (ACC-3) eligió también 0034, el integrador renumera:
-- esta no depende de nada que venga después ni nada depende de ella.
--
-- Quien conecta una cuenta ajena no es quien consiente. El mánager
-- agrega el Instagram del creador: data_consent queda a nombre del
-- creador con el mánager en evidence.actedBy, y el creador tiene que
-- ENTERARSE (decisión E de docs/propuestas/ACC-accesos-y-roles.md). La
-- tabla notification (0009) no tiene ningún kind para «cuenta
-- conectada»: connection_error significa lo contrario (una lectura
-- que falló) y el worker ya lo usa con ese sentido. Se añade
-- 'connection_added'; los demás valores quedan igual (misma forma que
-- 0030, que añadió quote_accepted y media_kit_locked).
--
-- Re-ejecutable: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT.
-- =====================================================================

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check CHECK (kind IN
  ('outlier','breakout','signal','deal_due','deal_overdue',
   'payment_received','invoice_overdue','connection_error',
   'analysis_ready','report_sent','trend','quote_accepted','media_kit_locked',
   'connection_added'));
