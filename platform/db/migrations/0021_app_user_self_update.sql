-- =====================================================================
-- 0021 · app_user: la política de UPDATE que faltaba (integración fase 1)
-- ---------------------------------------------------------------------
-- 0020 cerró app_user con dos políticas, SELECT e INSERT, y dejó UPDATE
-- y DELETE sin política a propósito: «nadie edita app_user todavía».
-- Al integrar la pieza del seed resultó que sí: 0002 refresca
-- app_user.last_seen_at en cada corrida —es la última visita, no una
-- métrica— con
--
--     INSERT INTO app_user (...) VALUES (...)
--     ON CONFLICT (id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at;
--
-- y eso falla con «new row violates row-level security policy for table
-- app_user» ya en la PRIMERA pasada, sobre una tabla vacía. No es el
-- conflicto: Postgres exige la política de UPDATE para planear el
-- ON CONFLICT DO UPDATE, haya fila con la que chocar o no. Una tabla sin
-- política para un comando no admite ese comando, ni siquiera en la
-- rama que no se va a ejecutar.
--
-- Las dos piezas tienen razón por separado —el seed refresca lo que es
-- una visita, y 0020 no quería abrir la edición de perfiles— así que lo
-- que falta es exactamente la línea que 0020 anunció para CIM-3: cada
-- quien edita SU fila. El seed pasa a fijar app.user_id junto a
-- app.workspace_id, que es lo que hará withWorkspace, y entonces el
-- refresco de last_seen_at es «la usuaria de la demo actualiza su
-- propia última visita», no un permiso nuevo.
--
-- Sigue sin haber política de DELETE: borrar una persona es otra
-- historia (CIM-3) y no la abre esta migración.
-- =====================================================================

CREATE POLICY app_user_update ON app_user FOR UPDATE
  USING (id = current_user_id())
  WITH CHECK (id = current_user_id());
