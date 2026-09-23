-- =====================================================================
-- 0038 · Canales de outreach: bitácora de llamadas y keepalive (VEN-9)
-- ---------------------------------------------------------------------
-- Número: va detrás de 0037_outreach, que tampoco está aplicada en
-- Supabase. El integrador las renumera juntas detrás de lo que main ya
-- aplicó; esta no depende de nada que venga después.
--
--   1 · api_call_log registra también las llamadas a Gmail y a Unipile
--   2 · el job diario sales.channels_keepalive
--
-- 1 · api_call_log para los proveedores de outreach
--
--   Cada llamada de un conector deja una fila en api_call_log (0002).
--   La tabla nació para las cuatro redes sociales: platform_id es NOT
--   NULL, apunta al catálogo `platform` y connection_id a
--   social_connection. Gmail y Unipile no son redes del catálogo (el
--   catálogo lo leen las pantallas de Conexiones y Resumen para pintar
--   redes; meter «Gmail» ahí lo pintaría como una red más) y una cuenta
--   de canal no es una social_connection.
--
--   Se agregan dos columnas y la fila dice de dónde viene por una de dos
--   vías, nunca las dos:
--     platform_id          una red social (lo de siempre)
--     provider             'gmail' o 'unipile' (outreach, VEN-9)
--   y channel_account_id, la cuenta de canal (outreach_channel_account)
--   de la llamada, cuando la hay. Una llamada que falla antes de tener
--   cuenta (el intercambio del code de Google que no sale) va con
--   channel_account_id NULL, igual que las de OAuth de 0024 §5.
--
--   La RLS se reescribe con los mismos nombres y la misma forma:
--     read    mis conexiones sociales O mis cuentas de canal. Las filas
--             sin ninguna de las dos son de la aplicación y solo las ve
--             el worker.
--     insert  cada clave ajena presente tiene que ser mía; sin ninguna,
--             la rama abierta que ya declara esquema.ts
--             (POLITICAS_ABIERTAS_DECLARADAS).
--   Sin UPDATE ni DELETE (0024 §7.3 ya los revocó): es una bitácora.
-- =====================================================================

ALTER TABLE api_call_log ALTER COLUMN platform_id DROP NOT NULL;
ALTER TABLE api_call_log
  ADD COLUMN provider text CHECK (provider IN ('gmail', 'unipile')),
  ADD COLUMN channel_account_id uuid REFERENCES outreach_channel_account(id) ON DELETE SET NULL;
-- De una red social o de un proveedor de outreach: exactamente uno.
ALTER TABLE api_call_log ADD CONSTRAINT api_call_log_origin_check
  CHECK ((platform_id IS NULL) <> (provider IS NULL));
-- Una cuenta de canal solo en una llamada de outreach, y una conexión
-- social solo en una de red social.
ALTER TABLE api_call_log ADD CONSTRAINT api_call_log_channel_account_check
  CHECK (channel_account_id IS NULL OR provider IS NOT NULL);
ALTER TABLE api_call_log ADD CONSTRAINT api_call_log_connection_check
  CHECK (connection_id IS NULL OR platform_id IS NOT NULL);
CREATE INDEX ON api_call_log (channel_account_id, called_at DESC) WHERE channel_account_id IS NOT NULL;
CREATE INDEX ON api_call_log (provider, called_at DESC) WHERE provider IS NOT NULL;

DROP POLICY api_call_log_read ON api_call_log;
CREATE POLICY api_call_log_read ON api_call_log FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM social_connection c WHERE c.id = api_call_log.connection_id)
    OR EXISTS (SELECT 1 FROM outreach_channel_account a WHERE a.id = api_call_log.channel_account_id)
  );

DROP POLICY api_call_log_insert ON api_call_log;
CREATE POLICY api_call_log_insert ON api_call_log FOR INSERT
  WITH CHECK (
    (connection_id IS NULL
      OR EXISTS (SELECT 1 FROM social_connection c WHERE c.id = api_call_log.connection_id))
    AND (channel_account_id IS NULL
      OR EXISTS (SELECT 1 FROM outreach_channel_account a WHERE a.id = api_call_log.channel_account_id))
  );


-- =====================================================================
-- 2 · sales.channels_keepalive
-- ---------------------------------------------------------------------
-- Una vez al día (06:30 UTC, antes de la mañana de América): renueva el
-- token de Google de cada Gmail conectado que vence dentro del margen,
-- pregunta a Unipile por cada LinkedIn o Instagram, marca en
-- needs_reconnect las cuentas que el proveedor da por caídas y borra las
-- filas 'pending' de conexiones que nadie terminó. Lo hace
-- apps/worker/src/jobs/ventas/canales.keepalive.ts. El token se reescribe
-- en connection_secret con la MISMA ref: una fila por concesión.
-- =====================================================================
INSERT INTO job_definition (id, label_es, queue, default_cron, timeout_s, max_attempts, max_concurrency)
VALUES ('sales.channels_keepalive', 'Mantener vivos los canales de outreach', 'sales', '30 6 * * *', 300, 3, 4)
ON CONFLICT (id) DO NOTHING;
