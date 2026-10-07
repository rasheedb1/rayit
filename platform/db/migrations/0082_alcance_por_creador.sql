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
-- Aquí cuatro de las tablas que llevan creator_id —social_connection,
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
--   la fila: ¿esta persona NO tiene alcance por creador? Es, letra por
--   letra, la negación de lo que scopeFilter() pregunta para el tipo
--   'creator' (scopeHas en scope.ts). Va dentro de un (SELECT …) para
--   que el planificador la evalúe UNA vez por consulta (InitPlan) y no
--   por fila: en el MVP nadie tiene alcance y el OR corta ahí, sin
--   llamar a scope_allows() en ninguna fila.
-- · Sin persona (modo demo, current_user_id() NULL) no hay filas de
--   alcance: se ve todo el espacio, como hasta hoy.
-- · FOR ALL y sin WITH CHECK: la misma condición vale para la fila
--   nueva de un INSERT o un UPDATE. Quien está acotado a Laura no crea
--   ni mueve una fila a nombre de Sofía; es D4 de ACC-6 («no se crea lo
--   que no se podría leer») también en la base. Las consultas de ACC-6
--   ya lo rechazan antes, con ScopeError; esto es la red.
--
-- Una sola regla de «quién ve a todos» (§2). La regla es la de ACC-6:
-- ve a todos quien no tiene filas de alcance. La matriz de 0034 §4 dice
-- que Dueño y Administrador ven «todo» y «toda la agencia»; en vez de
-- eximirlos aquí por su rol (y tener una regla en la base y otra en
-- scopeFilter() y en session_has_scope() de 0079), la base no deja que
-- lleven alcance: un disparador rechaza una fila de membership_scope
-- para una membresía con rol Dueño o Administrador, y el cambio de rol
-- a uno de esos dos mientras la persona tenga alcance. Así las tres
-- preguntas —la política, scopeFilter() y session_has_scope()— dicen lo
-- mismo para la misma persona. Un rol a medida ve a todos exactamente
-- igual que cualquiera: si no tiene filas de alcance.
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
--   · Los alcances por marca y por campaña: siguen siendo de
--     scopeFilter(). Esta red es la del tipo que tiene columna.
--
-- Qué cubre la red, con exactitud (comprobado en alcance-rls.test.ts):
--   · las cuatro tablas;
--   · las tablas cuya política de workspace es un EXISTS sobre una de
--     ellas, porque ese EXISTS ya pasa por la política de la madre:
--     campaign_post (por su campaña, 0018), deal_stage_history (por su
--     negocio), y api_call_log y api_quota_usage en las filas que tienen
--     cuenta (connection_id);
--   · las vistas con security_invoker que leen de ellas:
--     creator_post_board, connection_health, deal_pipeline y
--     second_by_second.
-- Qué NO cubre, y sigue protegido solo por su workspace y por
-- scopeFilter() donde una consulta lo compone:
--   · las métricas: post_metric_snapshot y account_metric_snapshot, y
--     las vistas que leen de ellas (post_metrics_latest,
--     post_metrics_daily_delta, post_metrics_at_cut…). Llevan
--     connection_id o post_id, pero su política es solo de workspace;
--   · el dinero: quote (con su total), invoice y payment;
--   · data_consent, y las demás tablas con su propio creator_id que no
--     están en la lista (TABLAS_CON_CREADOR_SIN_POLITICA de la guardia,
--     cada una con su motivo).
-- Extender la red a las métricas, a quote, a invoice y payment y a
-- data_consent es la historia ACC-10 del backlog: una restrictiva por
-- su propio creator_id o por EXISTS sobre post, campaign o deal.
--
-- Lo que la política esconde y el código necesita saber. ACC-6 buscaba
-- sin filtro «la fila ya existe, pero no es tuya» antes de escribir, para
-- decir ScopeError en vez de chocar con un índice o duplicar una cuenta.
-- Esa búsqueda ya no ve la fila. Donde lo sabe un índice único (la
-- campaña viva de una cotización, el id externo de una cuenta), lo dice
-- el choque: writeOrScopeError en packages/db/src/scope.ts. Donde no hay
-- índice (el @ de una cuenta agregada a mano), §4 trae una función que
-- responde solo sí o no.
--
-- La guardia (packages/db/src/esquema.ts) exige en cada arranque que las
-- cuatro tengan esta política, restrictiva, para mc_app, en todos los
-- comandos y con esta forma; que toda tabla de public con creator_id
-- esté en la lista de las cuatro o declarada sin política con su
-- motivo; que los cuerpos de session_sees_all_creators() y de
-- scope_allows() sean los de aquí (un CREATE OR REPLACE que devuelva
-- true apagaría la red sin tocar ninguna política); y que los
-- disparadores de §2 existan y disparen.
--
-- Hoy no hay ninguna fila de alcance (mc_app solo LEE membership_scope,
-- 0034 §10, y ninguna pantalla lo escribe), así que nada cambia para
-- nadie: la política está para que el primer alcance real no dependa de
-- que todas las consultas se acuerden.
--
-- Re-ejecutable: CREATE OR REPLACE FUNCTION, DROP POLICY/TRIGGER IF
-- EXISTS, REVOKE y GRANT idempotentes. No crea roles ni necesita el
-- token de administración. Depende de 0034 (role, membership.role_id,
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
-- scope_allows). Es exactamente NOT scopeHas('creator') de scope.ts: la
-- misma pregunta que hace scopeFilter(), para que una consulta con
-- scopeFilter() y una cruda den las mismas filas a la misma persona.
-- Dueño y Administrador ven a todos porque no pueden tener filas (§2),
-- no porque esta función los exima.
--
-- Solo mira el alcance por CREADOR: un ejecutivo acotado por marca o por
-- campaña no tiene aquí camino a una cuenta conectada ni a un post, y
-- esos tipos los sigue aplicando scopeFilter() en las consultas
-- (ACC-6 §0.3, D3). ACC-7 es la red del tipo que sí tiene columna.
--
-- SECURITY INVOKER: lee membership_scope con la RLS de quien pregunta
-- (mc_app la puede leer en su espacio). STABLE. Sin argumentos, para que
-- la política la envuelva en un (SELECT …) que se evalúa una vez por
-- consulta. Su cuerpo lo fija la guardia (CUERPOS_DEL_ALCANCE).
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
$$;
COMMENT ON FUNCTION session_sees_all_creators() IS
  '¿La persona de la transacción ve a todos los creadores del espacio fijado? Sí si no tiene alcance por creador: la misma pregunta que scopeFilter(). La piden las políticas por creador de social_connection, post, campaign y deal (0082, ACC-7).';

-- Como en 0040: sin EXECUTE para PUBLIC (anon y authenticated lo heredan
-- en Supabase), y con nombre para los dos roles que la pueden necesitar.
REVOKE ALL ON FUNCTION session_sees_all_creators() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION session_sees_all_creators() TO mc_app, mc_worker;


-- =====================================================================
-- 2 · Dueño y Administrador no llevan alcance: una sola regla
-- ---------------------------------------------------------------------
-- La matriz de fábrica (0034 §4) da a Dueño y Administrador el espacio
-- entero. Si una de esas dos personas tuviera una fila en
-- membership_scope, tres sitios responderían distinto: scopeFilter() la
-- acotaría, session_has_scope() (0079 §6) le quitaría la administración
-- del equipo, y una exención por rol en la base le enseñaría todo en una
-- consulta cruda. En vez de repetir la excepción en los tres, el caso no
-- puede existir:
--
--   · una fila de membership_scope (de cualquier tipo) para una
--     membresía con rol de sistema Dueño o Administrador se rechaza;
--   · cambiar a Dueño o Administrador el rol de quien tiene filas de
--     alcance se rechaza: antes hay que quitarle el alcance (lo que
--     decida la pantalla que lo escriba, CIERRE-ACC §5.6).
--
-- Mensaje en español y CONSTRAINT con nombre (check_violation,
-- membership_full_role_unscoped): la aplicación lo reconoce por ahí,
-- como membership_last_owner de 0078 §3, y no por el texto.
--
-- SECURITY INVOKER, con la RLS de quien escribe: lee membership, role y
-- membership_scope, que mc_app puede leer en el espacio fijado. Una fila
-- de alcance cuya membresía no se ve se rechaza también (fallar cerrado:
-- quien escribe alcance lo hace con el espacio fijado). Hoy solo escriben
-- membership_scope los seeds y las pruebas, como dueño de la tabla.
-- La guardia exige los dos disparadores (DISPARADORES_DE_CANDADO) y fija
-- el cuerpo de la función (CUERPOS_DEL_ALCANCE).
-- =====================================================================
CREATE OR REPLACE FUNCTION membership_full_role_unscoped() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  rol_completo boolean;
BEGIN
  IF TG_TABLE_NAME = 'membership_scope' THEN
    SELECT r.workspace_id IS NULL AND r.key IN ('owner', 'admin') INTO rol_completo
      FROM membership m
      JOIN role r ON r.id = m.role_id
     WHERE m.workspace_id = NEW.workspace_id
       AND m.user_id = NEW.user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'No se puede dar alcance a una membresía que esta transacción no ve.'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'membership_full_role_unscoped',
              HINT = 'Escribe el alcance con el espacio fijado (0082 §2).';
    END IF;
  ELSE
    SELECT r.workspace_id IS NULL AND r.key IN ('owner', 'admin') INTO rol_completo
      FROM role r
     WHERE r.id = NEW.role_id;
    rol_completo := coalesce(rol_completo, false)
      AND EXISTS (SELECT 1 FROM membership_scope s
                   WHERE s.workspace_id = NEW.workspace_id
                     AND s.user_id = NEW.user_id);
  END IF;
  IF coalesce(rol_completo, false) THEN
    RAISE EXCEPTION 'Dueño y Administrador ven todo el espacio: no llevan alcance.'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'membership_full_role_unscoped',
            HINT = 'Quita antes el alcance de esa persona, o dale otro rol (0082 §2).';
  END IF;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION membership_full_role_unscoped() IS
  'Disparador de membership_scope (alta y cambio) y de membership (cambio de rol): Dueño y Administrador no llevan alcance, para que «ve a todos» sea una sola regla en la política, en scopeFilter() y en session_has_scope() (0082 §2, ACC-7).';
REVOKE ALL ON FUNCTION membership_full_role_unscoped() FROM PUBLIC;

-- Antes de crear los disparadores: si ya hubiera filas así, se para con
-- un mensaje claro en vez de dejar el caso que §2 prohíbe.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM membership_scope s
               JOIN membership m ON m.workspace_id = s.workspace_id AND m.user_id = s.user_id
               JOIN role r ON r.id = m.role_id
              WHERE r.workspace_id IS NULL AND r.key IN ('owner', 'admin')) THEN
    RAISE EXCEPTION USING
      MESSAGE = '0082: hay filas de membership_scope de personas con rol Dueño o Administrador.',
      HINT = 'Bórralas (esas personas ven todo el espacio) o cámbiales el rol, y vuelve a aplicar.';
  END IF;
END $$;

DROP TRIGGER IF EXISTS membership_scope_full_role_unscoped ON membership_scope;
CREATE TRIGGER membership_scope_full_role_unscoped
  BEFORE INSERT OR UPDATE ON membership_scope
  FOR EACH ROW EXECUTE FUNCTION membership_full_role_unscoped();

DROP TRIGGER IF EXISTS membership_full_role_unscoped ON membership;
CREATE TRIGGER membership_full_role_unscoped
  BEFORE UPDATE OF role_id ON membership
  FOR EACH ROW EXECUTE FUNCTION membership_full_role_unscoped();


-- =====================================================================
-- 3 · Las cuatro políticas, una por tabla, todas iguales
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
-- 4 · public_account_out_of_scope(): «ese @ ya es de otro creador»
-- ---------------------------------------------------------------------
-- La única pregunta que la política de §3 deja sin respuesta y que el
-- código necesita. «Agregar por @» y el regreso de OAuth (Conexiones,
-- CON-10) buscan la cuenta por @ que ya exista con ese handle para
-- convertir ESA fila en autorizada (mismo id, mismo historial). Si la
-- fila es de una creadora fuera del alcance de quien conecta, ACC-6
-- respondía ScopeError (ACC-6 §6, hallazgos 1, 2 y 7): devolver «no
-- existe» crearía una segunda fila para la misma cuenta real bajo otra
-- creadora. Con §3 la fila ya no se ve, así que la consulta normal no
-- distingue «no existe» de «existe y no es tuya».
--
-- Esta función responde solo sí o no, para UN handle de UNA red, dentro
-- del espacio fijado y para la persona de la transacción: ¿hay una
-- cuenta viva por @ con ese handle que NO cae en su alcance por creador?
-- No devuelve la fila, ni su creadora, ni su id. No enseña nada nuevo:
-- es lo que ACC-6 ya decía con ScopeError.
--
-- SECURITY DEFINER porque tiene que mirar por debajo de §3 (la política
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
  'Sí o no: ¿hay en el espacio fijado una cuenta viva por @ de esa red con ese handle fuera del alcance por creador de la sesión? Para que Conexiones diga ScopeError en vez de duplicar la cuenta (0082 §4, ACC-7).';

REVOKE ALL ON FUNCTION public_account_out_of_scope(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_account_out_of_scope(text, text) TO mc_app;
