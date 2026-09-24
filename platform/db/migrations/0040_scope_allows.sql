-- =====================================================================
-- 0040 · scope_allows(): el predicado de alcance que compone cada
--        consulta de Campañas, Finanzas y Conexiones (ACC-6)
-- ---------------------------------------------------------------------
-- La tenencia la garantiza RLS: workspace_id = current_workspace_id().
-- El ALCANCE —«Ana ve solo lo de Camilo», «el ejecutivo ve solo las
-- marcas que tiene asignadas»— lo pone cada consulta de @mc/db con
-- scopeFilter() (packages/db/src/scope.ts), que llama a scope_allows()
-- para la persona de la transacción (current_user_id(), 0019). Sin filas
-- de alcance se ve todo el espacio: hoy nadie tiene filas y nada cambia.
--
-- Qué trae y qué NO. La tabla membership_scope, su RLS de lectura por
-- workspace y el «solo SELECT» de mc_app ya los crea 0034_access_control
-- (§6 y §10), con las mismas columnas que escribió ACC-6. La rama de
-- ACC-6 traía una 0035_membership_scope.sql con la tabla y las
-- funciones; ese número lo tomó CAM-3 y la tabla la absorbió ACC-3, así
-- que aquí queda solo lo que 0034 no tiene:
--   1. un índice de campaign_post por post_id (las anclas de un post por
--      marca y por campaña preguntan «las campañas de este post», y la
--      clave primaria empieza por campaign_id);
--   2. scope_allows(text, uuid) y scope_allows(text, uuid[]).
--
-- Convive con el código que hoy está en producción: solo AÑADE (un
-- índice y dos funciones que ese código no llama). El código nuevo sí
-- las llama y las declara en FUNCIONES_QUE_USA_EL_CODIGO, así que esta
-- migración se aplica ANTES del despliegue.
--
-- Re-ejecutable: CREATE INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
-- REVOKE y GRANT idempotentes. No crea roles ni necesita el token de
-- administración. Depende de 0019 (current_user_id) y 0034
-- (membership_scope).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · Índice para «las campañas de este post»
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS campaign_post_post_id_idx ON campaign_post (post_id);

-- ---------------------------------------------------------------------
-- 2 · scope_allows(): ¿ese id cae en mi alcance de ese tipo?
-- ---------------------------------------------------------------------
-- Verdadero si la persona de la transacción NO tiene filas de ese tipo
-- en el espacio fijado (sin filas = todo), o si el id está entre ellas.
-- Un target NULL nunca está en alcance: con alcance por creador, una
-- campaña sin creator_id no es de nadie y no se ve («un nulo no es un
-- cero»). Sin identidad fijada (modo demo) current_user_id() es NULL, no
-- hay filas, y todo se ve. El worker (mc_worker) no la usa: corre sin
-- persona y sin alcance (apps/worker/README.md).
--
-- SECURITY INVOKER a propósito: lee membership_scope bajo la RLS del
-- espacio fijado. LANGUAGE sql STABLE. No se expande en línea (lleva
-- subconsultas), así que se llama por fila; son dos búsquedas por la
-- clave primaria de una tabla pequeña, y scopeFilter() solo la llama
-- cuando la persona SÍ tiene filas de ese tipo: sin alcance, un EXISTS
-- sin correlación decide una vez por consulta.
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
