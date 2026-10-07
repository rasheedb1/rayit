-- =====================================================================
-- 0082 · El alcance por creador también en la base (ACC-7)
-- ---------------------------------------------------------------------
-- Número: 0082, el siguiente libre detrás de 0081_lo_que_importa. No
-- está aplicada en ningún sitio: la aplica el integrador.
--
-- Qué cierra. Desde ACC-6 el alcance —«Ana ve solo lo de Camilo»— lo
-- pone cada consulta de @mc/db con scopeFilter() (packages/db/src/
-- scope.ts), y una prueba por módulo recorre las funciones exportadas
-- para que ninguna se lo salte. Pero una consulta CRUDA que se olvide
-- de scopeFilter() —una vista nueva, un módulo que todavía no lo
-- compone (Ventas, Cotizar y Resumen, CIERRE-ACC §5.4), un SELECT
-- escrito deprisa— veía todos los creadores del espacio. La tenencia
-- (workspace_id = current_workspace_id()) seguía en pie; el alcance no.
--
-- Aquí las cuatro tablas que llevan creator_id —social_connection,
-- post, campaign y deal— reciben además una política RESTRICTIVA por
-- creador. Se combina con AND con la de su workspace (las dos
-- condiciones, nunca una u otra): una restrictiva solo quita, así que no
-- abre nada que la de workspace no abriera.
--
--   USING ((SELECT session_sees_all_creators())
--          OR scope_allows('creator', creator_id))
--
-- · scope_allows('creator', …) es EL MISMO predicado que compone
--   scopeFilter() (0040): sin filas de alcance por creador, todo; con
--   ellas, solo esos creadores; y un creator_id NULL (una campaña o un
--   negocio sin creador) no cae en ningún alcance. Es el contrato que
--   ACC-6 dejó escrito (ACC-6.md §3, CIERRE-ACC §5.8).
-- · session_sees_all_creators() (§1) es la pregunta que no depende de
--   la fila: ¿esta persona ve a todos los creadores del espacio? Sí si
--   no tiene alcance por creador, y sí si su rol es de los que ven el
--   espacio entero (Dueño y Administrador, de fábrica: 0034 §4), aunque
--   alguien le hubiera dejado una fila de alcance. Va dentro de un
--   (SELECT …) para que el planificador la evalúe UNA vez por consulta
--   (InitPlan) y no por fila: en el MVP nadie tiene alcance y el OR
--   corta ahí, sin llamar a scope_allows() en ninguna fila.
-- · Sin persona (modo demo, current_user_id() NULL) no hay filas de
--   alcance: se ve todo el espacio, como hasta hoy.
-- · FOR ALL y sin WITH CHECK: la misma condición vale para la fila
--   nueva de un INSERT o un UPDATE. Quien está acotado a Laura no crea
--   ni mueve una fila a nombre de Sofía; es D4 de ACC-6 («no se crea lo
--   que no se podría leer») también en la base. Las consultas de ACC-6
--   ya lo rechazan antes, con ScopeError; esto es la red.
--
-- A quién NO toca, a propósito:
--   · TO mc_app: es el rol de la web, el único que trabaja en nombre de
--     una persona. mc_worker (BYPASSRLS) no pasa por ninguna política:
--     los jobs corren sin persona y sin alcance (apps/worker/README.md).
--     mc_public_share (los enlaces públicos, 0030) lee y mueve `deal`
--     dentro de funciones SECURITY DEFINER sin sesión, y no tiene —ni
--     debe tener— SELECT sobre membership_scope ni EXECUTE sobre estas
--     funciones: una política TO PUBLIC le habría roto la aceptación
--     pública de una cotización con «permission denied». Su cerradura
--     sigue siendo la de 0030 (POLITICAS_DEL_ENLACE_PUBLICO). El rol que
--     migra, igual: los seeds no tienen persona.
--   · Las hijas sin creator_id (campaign_post, invoice, payment,
--     data_consent, los snapshots…) no llevan política propia: las que
--     cuelgan de una de estas cuatro por EXISTS ya heredan el filtro, y
--     las demás las sigue acotando scopeFilter() en las consultas. La
--     historia es «las cuatro tablas que llevan creator_id» (backlog,
--     ACC-7).
--
-- La guardia (packages/db/src/esquema.ts, TABLAS_CON_ALCANCE_POR_CREADOR)
-- exige en cada arranque que las cuatro tengan esta política, restrictiva,
-- para mc_app, en todos los comandos y con esta forma; si a una se le
-- quita, la web no arranca y lo dice con el nombre de la tabla.
--
-- Hoy no hay ninguna fila de alcance (mc_app solo LEE membership_scope,
-- 0034 §10, y ninguna pantalla lo escribe), así que nada cambia para
-- nadie: la política está para que el primer alcance real no dependa de
-- que todas las consultas se acuerden.
--
-- Re-ejecutable: CREATE OR REPLACE FUNCTION, DROP POLICY IF EXISTS,
-- REVOKE y GRANT idempotentes. No crea roles ni necesita el token de
-- administración. Depende de 0034 (role, membership.role_id,
-- membership_scope) y 0040 (scope_allows).
-- =====================================================================

DO $$
BEGIN
  IF to_regprocedure('scope_allows(text,uuid)') IS NULL
     OR to_regclass('public.membership_scope') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = '0082_alcance_por_creador necesita 0034_access_control y 0040_scope_allows aplicadas antes (membership_scope, scope_allows).';
  END IF;
END $$;


-- =====================================================================
-- 1 · session_sees_all_creators(): ¿esta persona ve a todos los
--     creadores del espacio?
-- ---------------------------------------------------------------------
-- Verdadero si la persona de la transacción no tiene filas de alcance
-- por creador en el espacio fijado (sin filas = todo, como
-- scope_allows), o si su rol es Dueño o Administrador de fábrica. Esos
-- dos roles son los que la matriz de 0034 §4 describe como «todo» y
-- «toda la agencia»; un rol a medida no puede llamarse así
-- (role_custom_key_not_system), así que mirar la clave de un rol de
-- sistema basta.
--
-- Solo mira el alcance por CREADOR: un ejecutivo acotado por marca o por
-- campaña no tiene aquí camino a una cuenta conectada ni a un post, y
-- esos tipos los sigue aplicando scopeFilter() en las consultas
-- (ACC-6 §0.3, D3). ACC-7 es la red del tipo que sí tiene columna.
--
-- SECURITY INVOKER: lee membership_scope, membership y role con la RLS
-- de quien pregunta (las tres las puede leer mc_app para su propia
-- persona y su espacio). STABLE. Sin argumentos, para que la política
-- la envuelva en un (SELECT …) que se evalúa una vez por consulta.
-- =====================================================================
CREATE OR REPLACE FUNCTION session_sees_all_creators() RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT NOT EXISTS (
           SELECT 1 FROM membership_scope s
            WHERE s.workspace_id = current_workspace_id()
              AND s.user_id = current_user_id()
              AND s.scope_type = 'creator')
      OR EXISTS (
           SELECT 1 FROM membership m
             JOIN role r ON r.id = m.role_id
            WHERE m.workspace_id = current_workspace_id()
              AND m.user_id = current_user_id()
              AND r.is_system
              AND r.key IN ('owner', 'admin'))
$$;
COMMENT ON FUNCTION session_sees_all_creators() IS
  '¿La persona de la transacción ve a todos los creadores del espacio fijado? Sí sin alcance por creador, y sí con rol Dueño o Administrador. La piden las políticas por creador de social_connection, post, campaign y deal (0082, ACC-7).';

-- Como en 0040: sin EXECUTE para PUBLIC (anon y authenticated lo heredan
-- en Supabase), y con nombre para los dos roles que la pueden necesitar.
REVOKE ALL ON FUNCTION session_sees_all_creators() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION session_sees_all_creators() TO mc_app, mc_worker;


-- =====================================================================
-- 2 · Las cuatro políticas, una por tabla, todas iguales
-- ---------------------------------------------------------------------
-- RESTRICTIVE, FOR ALL, TO mc_app, sin WITH CHECK. El nombre es
-- <tabla>_creator_scope. Todas las tablas ya tienen RLS con FORCE
-- (0010, 0024): aquí no se toca eso.
-- =====================================================================
DROP POLICY IF EXISTS social_connection_creator_scope ON social_connection;
CREATE POLICY social_connection_creator_scope ON social_connection
  AS RESTRICTIVE FOR ALL TO mc_app
  USING ((SELECT session_sees_all_creators()) OR scope_allows('creator', creator_id));

DROP POLICY IF EXISTS post_creator_scope ON post;
CREATE POLICY post_creator_scope ON post
  AS RESTRICTIVE FOR ALL TO mc_app
  USING ((SELECT session_sees_all_creators()) OR scope_allows('creator', creator_id));

DROP POLICY IF EXISTS campaign_creator_scope ON campaign;
CREATE POLICY campaign_creator_scope ON campaign
  AS RESTRICTIVE FOR ALL TO mc_app
  USING ((SELECT session_sees_all_creators()) OR scope_allows('creator', creator_id));

DROP POLICY IF EXISTS deal_creator_scope ON deal;
CREATE POLICY deal_creator_scope ON deal
  AS RESTRICTIVE FOR ALL TO mc_app
  USING ((SELECT session_sees_all_creators()) OR scope_allows('creator', creator_id));


-- =====================================================================
-- 3 · public_account_out_of_scope(): «ese @ ya es de otro creador»
-- ---------------------------------------------------------------------
-- La única pregunta que la política de §2 deja sin respuesta y que el
-- código necesita. «Agregar por @» y el regreso de OAuth (Conexiones,
-- CON-10) buscan la cuenta por @ que ya exista con ese handle para
-- convertir ESA fila en autorizada (mismo id, mismo historial). Si la
-- fila es de una creadora fuera del alcance de quien conecta, ACC-6
-- respondía ScopeError (ACC-6 §6, hallazgos 1, 2 y 7): devolver «no
-- existe» crearía una segunda fila para la misma cuenta real bajo otra
-- creadora. Con §2 la fila ya no se ve, así que la consulta normal no
-- distingue «no existe» de «existe y no es tuya».
--
-- Esta función responde solo sí o no, para UN handle de UNA red, dentro
-- del espacio fijado y para la persona de la transacción: ¿hay una
-- cuenta viva por @ con ese handle que NO cae en su alcance por creador?
-- No devuelve la fila, ni su creadora, ni su id. No enseña nada nuevo:
-- es lo que ACC-6 ya decía con ScopeError.
--
-- SECURITY DEFINER porque tiene que mirar por debajo de §2 (la política
-- es TO mc_app; el dueño de la tabla solo pasa por la de workspace, que
-- con FORCE también le aplica). Aun así se ata al espacio a mano
-- (workspace_id = current_workspace_id()), y sin espacio fijado responde
-- falso. Sin EXECUTE para PUBLIC; solo mc_app la llama. Declarada en la
-- guardia (FUNCIONES_DEFINER_DECLARADAS).
-- =====================================================================
CREATE OR REPLACE FUNCTION public_account_out_of_scope(p_platform text, p_handle text) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT current_workspace_id() IS NOT NULL
     AND p_handle IS NOT NULL
     AND NOT session_sees_all_creators()
     AND EXISTS (
           SELECT 1 FROM social_connection c
            WHERE c.workspace_id = current_workspace_id()
              AND c.platform_id = p_platform
              AND c.access_mode IN ('public_profile', 'aggregator')
              AND c.deleted_at IS NULL
              AND lower(c.handle) = lower(p_handle)
              AND NOT scope_allows('creator', c.creator_id))
$$;
COMMENT ON FUNCTION public_account_out_of_scope(text, text) IS
  'Sí o no: ¿hay en el espacio fijado una cuenta viva por @ de esa red con ese handle fuera del alcance por creador de la sesión? Para que Conexiones diga ScopeError en vez de duplicar la cuenta (0082 §3, ACC-7).';

REVOKE ALL ON FUNCTION public_account_out_of_scope(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_account_out_of_scope(text, text) TO mc_app;
