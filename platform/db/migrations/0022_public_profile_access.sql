-- =====================================================================
-- 0022 · Cuentas por @ con datos públicos (CON-10)
-- ---------------------------------------------------------------------
-- La conexión OAuth por creador se pospone (decisión del 22-sep-2026).
-- En el MVP una cuenta se agrega por su @ y se lee con lo que la
-- plataforma publica: business_discovery en Instagram, la Data API con
-- API key en YouTube, oEmbed en TikTok. Es un modo de acceso nuevo, no
-- un agregador ni un CSV; por eso se suma al CHECK de 0002.
--
-- Numeración: en Supabase están aplicadas hasta 0021 (0017–0021 no
-- están en el repositorio a la fecha; quien las creó debe subirlas).
-- =====================================================================

ALTER TABLE social_connection DROP CONSTRAINT social_connection_access_mode_check;
ALTER TABLE social_connection ADD CONSTRAINT social_connection_access_mode_check
  CHECK (access_mode IN ('direct_oauth','business_portfolio','aggregator','manual_csv','public_profile'));

COMMENT ON COLUMN social_connection.access_mode IS
  'direct_oauth: el creador autorizó; business_portfolio; aggregator: proveedor externo; manual_csv: archivo subido; public_profile: solo el @ y lo que la plataforma publica (CON-10)';
