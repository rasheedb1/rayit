-- =====================================================================
-- 0015 · Una campaña por cotización (CAM-2)
-- ---------------------------------------------------------------------
-- createCampaignFromQuote() (queries/campanas.ts) es idempotente por
-- quote_id: aceptar dos veces la misma cotización, o dos aceptaciones
-- concurrentes, dejan UNA campaña. El bloqueo consultivo de la función
-- solo protege a quien pasa por ella; este índice lo garantiza en la
-- base para cualquier escritor y con cualquier nivel de aislamiento.
--
-- Parcial: una campaña cancelada libera la cotización, para que se
-- pueda crear otra si la marca vuelve a aceptar (la cancelada queda
-- como historial con su quote_id).
-- =====================================================================
CREATE UNIQUE INDEX IF NOT EXISTS campaign_quote_id_active_key
  ON campaign (quote_id)
  WHERE quote_id IS NOT NULL AND status <> 'cancelled';
