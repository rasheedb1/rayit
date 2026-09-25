-- =====================================================================
-- 0060 · El perfil comercial del creador registra su narrativa (VEN-11)
-- ---------------------------------------------------------------------
-- Número: 0060 y no 0056, a propósito. En la fase C, VEN-12 trae
-- 0056_generacion_trazable y 0057_generacion_pedida_y_a_mano, y VEN-13
-- trae 0056_recomendador_cadencias (que al integrar pasa a la siguiente
-- libre, 0058). Esta no depende de ninguna de ellas ni ellas de esta
-- (ninguna toca outbound_llm_call_purpose_check), así que toma un número
-- que no puede chocar: el runner acepta huecos (0045 → 0050 ya lo es).
--
-- El perfil comercial (docs/ventas-outreach.md §5.4) se guarda en
-- creator_profile.media_kit bajo la clave perfil_comercial: no necesita
-- tabla. Lo que sí necesita es su bitácora de costo. La narrativa son
-- tres párrafos que escribe claude-sonnet-5, y la regla del proyecto es
-- que CADA llamada al modelo deja fila en outbound_llm_call: es lo que
-- suma outbound_health contra llm_daily_cap_usd (0037 §5.3). Sin un
-- propósito propio, la llamada del perfil tendría que hacerse pasar por
-- 'generate' (el generador de mensajes de VEN-12) y el gasto del día no
-- diría en qué se fue.
--
-- 'profile' = la narrativa del perfil comercial. touch_id y message_id
-- quedan NULL: no sirve a ningún toque ni a ningún mensaje recibido.
-- La tabla sigue siendo una bitácora (0037 §7.4: mc_app no la actualiza
-- ni la borra); aquí solo se ensancha el CHECK.
-- =====================================================================

ALTER TABLE outbound_llm_call DROP CONSTRAINT IF EXISTS outbound_llm_call_purpose_check;
ALTER TABLE outbound_llm_call ADD CONSTRAINT outbound_llm_call_purpose_check
  CHECK (purpose IN ('generate', 'judge', 'classify', 'recommend', 'profile'));
