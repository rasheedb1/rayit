-- =====================================================================
-- 0061 · El perfil comercial del creador registra su narrativa (VEN-11)
-- ---------------------------------------------------------------------
-- Número: nació como 0060 para no chocar con las ramas hermanas de la
-- fase C, pero VEN-12 llegó con su propia serie 0056–0060. Al integrar
-- la fase 5, VEN-12 conservó 0056–0060, esta pasó a 0061 y las dos de
-- VEN-13 (0056_recomendador_cadencias, 0057_comentario_sin_texto) a 0062
-- y 0063. Esta no depende de ninguna de ellas ni ellas de esta (ninguna
-- toca outbound_llm_call_purpose_check).
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
