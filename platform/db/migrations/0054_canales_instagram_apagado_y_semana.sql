-- =====================================================================
-- 0054 · Canales de outreach: Instagram nace apagado y el tope semanal
--        dice quién lo fija (VEN-9, ronda 5 de canales)
-- ---------------------------------------------------------------------
-- Número: 0054. La serie de integración va de 0043 a 0075, detrás de
-- la 0042 de main (0034–0042, ya aplicadas en Supabase); ninguna de la
-- serie está aplicada aún. Hasta el pulido r2 de ventas esta fue la
-- 0045. Va detrás de 0053_canales_last_error_codigo y no depende de
-- nada posterior.
--
-- 1 · outbound_policy.allowed_channels nace sin Instagram
--
--     docs/ventas-outreach.md §5.1: Instagram es «opcional, apagado por
--     defecto; se enciende por workspace». 0007 lo dejó encendido en el
--     valor por defecto ('{email,linkedin,instagram_dm}'), y la pantalla
--     de canales ofrecía «Conectar» en un espacio donde el despachador
--     nunca lo iba a usar, mientras Unipile cobraba la cuenta cada mes.
--     Desde aquí, un espacio NUEVO nace con '{email,linkedin}'. Las
--     filas que ya existen no se tocan: quitarle un canal a un espacio
--     que ya lo tiene es una decisión de ese espacio, no de una
--     migración. La web lee la lista (getChannelPolicyCaps) y pinta
--     «Apagado en este espacio» en el canal que no está; sin fila de
--     política, vale este mismo valor por defecto.
--
-- 2 · outreach_channel_account_limits.weekly_limited_by
--
--     La vista de canales_liberar_y_limites decía quién fija el máximo diario
--     (daily_limited_by) pero no el semanal, y la pantalla decía
--     «Máximo 140» sin explicar de dónde sale. El semanal es
--     least(proveedor semanal, 7 × máximo diario): si manda el segundo,
--     lo fija quien fija el diario (la política, en un correo con
--     max_emails_per_day = 20: 140); si no, el proveedor. Se añade al
--     FINAL de la vista (CREATE OR REPLACE VIEW solo admite columnas
--     nuevas al final) y el resto queda idéntico a canales_liberar_y_limites.
-- =====================================================================

ALTER TABLE outbound_policy ALTER COLUMN allowed_channels SET DEFAULT '{email,linkedin}';

COMMENT ON COLUMN outbound_policy.allowed_channels IS
  'Los canales que el despachador puede usar en este espacio. Nace con correo y LinkedIn (canales_instagram_apagado_y_semana): Instagram es opcional '
  'y se enciende por workspace (docs/ventas-outreach.md §5.1). La pantalla de canales no ofrece conectar uno que no esté.';

CREATE OR REPLACE VIEW outreach_channel_account_limits WITH (security_invoker = on) AS
WITH base AS (
  SELECT a.id, a.workspace_id, a.channel, a.daily_cap, a.weekly_cap,
         (a.channel = 'email' AND split_part(a.provider_account_id, '@', 2) IN ('gmail.com', 'googlemail.com')) AS personal,
         CASE WHEN a.channel = 'email' THEN coalesce(p.max_emails_per_day, 20) END AS policy_daily
    FROM outreach_channel_account a
    LEFT JOIN outbound_policy p ON p.workspace_id = a.workspace_id
),
proveedor AS (
  SELECT b.*,
         CASE b.channel WHEN 'email' THEN CASE WHEN b.personal THEN 500 ELSE 2000 END ELSE 100 END AS provider_daily,
         CASE b.channel WHEN 'email' THEN CASE WHEN b.personal THEN 3500 ELSE 10000 END
                        WHEN 'linkedin' THEN 200 ELSE 700 END AS provider_weekly
    FROM base b
),
maximos AS (
  SELECT v.*, least(v.provider_daily, coalesce(v.policy_daily, v.provider_daily)) AS max_daily
    FROM proveedor v
),
semana AS (
  SELECT m.*, least(m.provider_weekly, m.max_daily * 7) AS max_weekly FROM maximos m
),
quien AS (
  SELECT s.*,
         CASE WHEN s.policy_daily IS NOT NULL AND s.policy_daily < s.provider_daily THEN 'policy' ELSE 'provider' END AS daily_by
    FROM semana s
)
SELECT q.id AS channel_account_id,
       q.workspace_id,
       q.channel,
       q.personal AS personal_mailbox,
       q.provider_daily,
       q.provider_weekly,
       q.policy_daily,
       q.max_daily,
       q.max_weekly,
       q.daily_by AS daily_limited_by,
       least(coalesce(q.daily_cap, q.max_daily), q.max_daily) AS effective_daily,
       least(coalesce(q.weekly_cap, q.max_weekly), q.max_weekly) AS effective_weekly,
       -- Si el semanal sale de 7 × el diario, lo fija quien fija el diario; si no, el proveedor.
       CASE WHEN q.max_daily * 7 < q.provider_weekly THEN q.daily_by ELSE 'provider' END AS weekly_limited_by
  FROM quien q;

REVOKE INSERT, UPDATE, DELETE ON outreach_channel_account_limits FROM mc_app;
COMMENT ON VIEW outreach_channel_account_limits IS
  'Los límites de cada cuenta de canal (canales_liberar_y_limites, canales_instagram_apagado_y_semana): el techo del proveedor, el de la política, lo que la persona puede '
  'poner, lo que rige hoy y quién fija cada máximo. La pantalla de canales y el despachador leen de aquí; nadie recalcula.';
