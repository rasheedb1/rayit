-- =====================================================================
-- 0035 · membership_scope: el alcance de un miembro dentro de su espacio,
--        y scope_allows(), el predicado que cada consulta compone (ACC-6)
-- ---------------------------------------------------------------------
-- La tenencia la garantiza RLS: workspace_id = current_workspace_id().
-- El ALCANCE —«Ana ve solo lo de Camilo», «el ejecutivo ve solo las
-- marcas que tiene asignadas»— lo pone cada consulta de @mc/db con
-- scope_allows(), que lee esta tabla para la persona de la transacción
-- (current_user_id(), 0019). Sin filas de alcance, se ve todo el espacio:
-- hoy nadie tiene filas y nada cambia.
--
-- Es SOLO la tabla del alcance de la propuesta ACC (fase 4), sin cambiar
-- una columna: permission, role, invitation y workspace_grant siguen
-- siendo de ACC-3. Cuando ACC-3 se escriba, la crea con CREATE TABLE IF
-- NOT EXISTS (esta migración es re-ejecutable) o quita esta tabla de su
-- archivo; si el integrador prefiere una sola migración de accesos, esta
-- se funde en ella antes de aplicar: nada de aquí está en Supabase.
--
-- Número: 0034 es la de ACC-3 (0034_access_control.sql, rama
-- nicolas/ACC-3-esquema-accesos), que crea esta misma tabla con IF NOT
-- EXISTS y la misma política. Las dos son re-ejecutables y no dependen
-- del orden: esta se aplicó primero (23-sep-2026) y la de ACC-3, al
-- llegar, encuentra la tabla hecha. Solo depende de 0028 (membership con
-- RLS y current_user_id()).
--
-- Quién puede qué:
--   mc_app     SELECT, por la política del espacio fijado. Escribir el
--              alcance es la pantalla de Equipo (ACC-4), que traerá sus
--              políticas de INSERT y DELETE.
--   mc_worker  todo, por los privilegios por defecto de 0014 (BYPASSRLS).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · La tabla
-- ---------------------------------------------------------------------
-- (workspace_id, user_id) apunta a membership: el alcance es de UNA
-- membresía y se va con ella. scope_type dice sobre qué se acota y
-- scope_id nombra la fila (creator_profile, company o campaign; no lleva
-- FK porque apunta a tres tablas distintas, y quien la escriba —el
-- worker o la política de ACC-4— comprueba que exista).
CREATE TABLE IF NOT EXISTS membership_scope (
  workspace_id  uuid NOT NULL,
  user_id       uuid NOT NULL,
  scope_type    text NOT NULL CHECK (scope_type IN ('creator', 'company', 'campaign')),
  scope_id      uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, scope_type, scope_id),
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES membership (workspace_id, user_id) ON DELETE CASCADE
);

COMMENT ON TABLE membership_scope IS
  'Alcance de un miembro dentro de su espacio (ACC-6). Sin filas = todo el espacio. Las consultas lo aplican con scope_allows(); la tenencia sigue siendo RLS por workspace_id.';
COMMENT ON COLUMN membership_scope.scope_type IS
  'creator: creator_profile.id · company: company.id · campaign: campaign.id. Entre tipos se intersecta; dentro de un tipo se une.';

-- Un post se acota por marca y por campaña a través de campaign_post
-- («las campañas de este post»). Su clave primaria empieza por
-- campaign_id, así que esa pregunta no tenía índice.
CREATE INDEX IF NOT EXISTS campaign_post_post_id_idx ON campaign_post (post_id);

-- ---------------------------------------------------------------------
-- 2 · RLS: se lee el alcance del espacio fijado
-- ---------------------------------------------------------------------
-- FOR SELECT y nada más: sin política de INSERT, UPDATE ni DELETE, y sin
-- el privilegio, mc_app no escribe aquí (ACC-4 decidirá quién puede).
-- La pantalla de Equipo lista el alcance de cada miembro del espacio,
-- por eso la lectura es por workspace y no «solo el mío».
ALTER TABLE membership_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_scope FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS membership_scope_read ON membership_scope;
CREATE POLICY membership_scope_read ON membership_scope
  FOR SELECT USING (workspace_id = current_workspace_id());

-- ALTER DEFAULT PRIVILEGES le dio a mc_app los cuatro al nacer; se le
-- deja solo SELECT (declarado en PRIVILEGIOS_DE_LA_APP de src/esquema.ts).
REVOKE INSERT, UPDATE, DELETE ON membership_scope FROM mc_app;
GRANT SELECT ON membership_scope TO mc_app;

-- ---------------------------------------------------------------------
-- 3 · scope_allows(): ¿ese id cae en mi alcance de ese tipo?
-- ---------------------------------------------------------------------
-- Verdadero si la persona de la transacción NO tiene filas de ese tipo
-- en el espacio fijado (sin filas = todo), o si el id está entre ellas.
-- Un target NULL nunca está en alcance: con alcance por creador, una
-- campaña sin creator_id no es de nadie y no se ve («un nulo no es un
-- cero»). Sin identidad fijada (modo demo, worker) current_user_id() es
-- NULL, no hay filas, y todo se ve.
--
-- SECURITY INVOKER a propósito: lee membership_scope bajo la RLS del
-- espacio fijado. LANGUAGE sql STABLE. No se expande en línea (lleva
-- subconsultas), así que se llama por fila; son dos búsquedas por la
-- clave primaria de una tabla pequeña, y scopeFilter() (src/scope.ts)
-- solo la llama cuando la persona SÍ tiene filas de ese tipo: sin
-- alcance, un EXISTS sin correlación decide una vez por consulta.
--
-- ACC-7 (RLS por creador) puede usar el mismo predicado como política
-- RESTRICTIVA: USING (scope_allows('creator', creator_id)).
CREATE OR REPLACE FUNCTION scope_allows(kind text, target uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (
           SELECT 1 FROM membership_scope s
            WHERE s.workspace_id = current_workspace_id()
              AND s.user_id = current_user_id()
              AND s.scope_type = kind)
      OR EXISTS (
           SELECT 1 FROM membership_scope s
            WHERE s.workspace_id = current_workspace_id()
              AND s.user_id = current_user_id()
              AND s.scope_type = kind
              AND s.scope_id = target);
$$;

-- La misma pregunta para una relación uno-a-muchos: «¿alguna de las
-- campañas de este post cae en mi alcance?». Un arreglo vacío o NULL no
-- cae en ninguno.
CREATE OR REPLACE FUNCTION scope_allows(kind text, targets uuid[]) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (
           SELECT 1 FROM membership_scope s
            WHERE s.workspace_id = current_workspace_id()
              AND s.user_id = current_user_id()
              AND s.scope_type = kind)
      OR EXISTS (
           SELECT 1 FROM membership_scope s
            WHERE s.workspace_id = current_workspace_id()
              AND s.user_id = current_user_id()
              AND s.scope_type = kind
              AND s.scope_id = ANY (targets));
$$;

COMMENT ON FUNCTION scope_allows(text, uuid) IS
  'ACC-6: verdadero si la persona de la transacción no tiene alcance de ese tipo, o si el id está en él. NULL nunca está en alcance.';
COMMENT ON FUNCTION scope_allows(text, uuid[]) IS
  'ACC-6: como scope_allows(text, uuid), para una relación uno-a-muchos: alguno de los ids está en el alcance.';

-- Como en 0031: sin EXECUTE para PUBLIC (anon y authenticated lo heredan
-- en Supabase), y con nombre para los dos roles que lo usan. mc_worker ya
-- lo recibe por los privilegios por defecto de 0014; se repite para que
-- se lea aquí.
REVOKE ALL ON FUNCTION scope_allows(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION scope_allows(text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scope_allows(text, uuid) TO mc_app, mc_worker;
GRANT EXECUTE ON FUNCTION scope_allows(text, uuid[]) TO mc_app, mc_worker;
