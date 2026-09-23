-- =====================================================================
-- 0017 · RLS en outbound_policy (CIM-2)
-- ---------------------------------------------------------------------
-- La regla del proyecto es que toda tabla con workspace_id lleva RLS.
-- outbound_policy (0007) tiene workspace_id como clave primaria y no
-- entró en la lista de 0010: la única de las tablas por workspace que
-- se podía leer y escribir sin fijar el workspace. La prueba
-- packages/db/test/schema.test.ts lo detectó al comparar el esquema
-- con la base; esta migración la iguala a las demás.
--
-- membership queda sin RLS a propósito: se lee al entrar, antes de que
-- haya un workspace fijado (CIM-3). La prueba lo documenta.
--
-- Misma forma que 0010 y 0011: ENABLE + FORCE (aplica también al dueño
-- de la tabla) y una política por workspace. mc_worker sigue saltándola
-- por BYPASSRLS.
-- =====================================================================

ALTER TABLE outbound_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY outbound_policy_ws_isolation ON outbound_policy
  USING (workspace_id = current_workspace_id());
