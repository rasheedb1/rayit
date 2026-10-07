-- =====================================================================
-- 0078 · Equipo: invitar, aceptar, cambiar el rol y quitar (ACC-4)
-- ---------------------------------------------------------------------
-- Número: 0078, la siguiente libre detrás de 0077 al 4-oct. Otras
-- piezas de la fase 9 corren en paralelo; si dos eligen el mismo
-- número, el integrador renumera (esta no depende de ninguna de ellas).
--
-- 0034 (ACC-3) dejó las tablas —role, role_permission, invitation— y
-- tres huecos que eran de ACC-4 (docs/propuestas/ACC-3.md §4):
--
--   · Aceptar. Quien acepta todavía no es miembro, así que no puede
--     fijar el workspace de la invitación, e invitation lleva RLS por
--     workspace_id. Aquí: invitation_accept(token_hash), SECURITY
--     DEFINER, que encuentra la fila por el hash y SOLO por el hash
--     (una política TO CURRENT_USER que lee el hash que la propia
--     función fija y borra), comprueba que la persona de la sesión es
--     el correo invitado, y la da de alta con el alta propia de 0028.
--   · Cambiar el rol y quitar a alguien. membership no tenía UPDATE ni
--     DELETE para mc_app. Aquí se abren por COLUMNA (role_id y
--     extra_permissions) y con política por permiso: hay que tener
--     equipo.rol.editar o equipo.miembro.revocar, y además todo lo que
--     la persona tocada tiene y todo lo que se le da.
--   · Las casillas del mánager («también puede ver mis finanzas»,
--     «también puede conectar mis cuentas»). El modelo no tenía permisos
--     por persona fuera del rol. Aquí: membership.extra_permissions e
--     invitation.extra_permissions, un text[] limitado por CHECK a los
--     cinco permisos de esas dos casillas (EXTRA_PERMISOS de
--     packages/core/src/equipo.ts; test/equipo.test.ts compara la
--     lista). El rol sigue siendo «Mánager»: la casilla es una decisión
--     a la vista, no un rol a medida que nadie pidió (eso es ACC-9).
--
-- Y dos reglas que la base hace cumplir, no solo la pantalla:
--
--   · Nadie otorga lo que no tiene (fase 5 de ACC-accesos-y-roles.md):
--     session_can_grant(rol, extras) en el WITH CHECK de invitar, de
--     cambiar el rol y de quitar. Sin ella, un Administrador de agencia
--     se hacía Dueño en dos clics, o daba finanzas sin verlas.
--   · El último dueño no se quita ni se degrada: el disparador
--     membership_keeps_an_owner, con un candado por workspace para que
--     dos degradaciones a la vez no dejen el espacio sin dueño. Un
--     workspace sin dueño no lo puede recuperar nadie.
--
-- ÍNDICE
--   0 · guardia: 0034 aplicada
--   1 · las casillas: extra_permissions en membership e invitation
--   2 · lo que puede la sesión, en SQL
--   3 · membership: cambiar el rol, quitar y el último dueño
--   4 · invitation: invitar y revocar con permiso; solo se revoca
--   5 · aceptar: invitation_lookup e invitation_accept
--
-- Re-ejecutable: IF NOT EXISTS, DROP … IF EXISTS y CREATE OR REPLACE.
-- Comprobado dos veces seguidas en PGlite (packages/db/test/equipo.test.ts).
-- =====================================================================


-- =====================================================================
-- 0 · Guardia
-- ---------------------------------------------------------------------
-- Todo lo de abajo cuenta con 0034: membership.role_id, role,
-- role_permission, invitation y system_role_id(). Sobre una base sin
-- ella los ALTER fallarían a medias; mejor parar con el motivo.
-- =====================================================================
DO $$
BEGIN
  IF to_regprocedure('system_role_id(text,text)') IS NULL
     OR to_regclass('invitation') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'membership' AND column_name = 'role_id'
     ) THEN
    RAISE EXCEPTION USING
      MESSAGE = '0078_equipo necesita 0034_access_control aplicada antes (membership.role_id, invitation, system_role_id).',
      HINT = 'Aplica las migraciones en orden con make db.migrate.';
  END IF;
END $$;


-- =====================================================================
-- 1 · Las casillas del mánager
-- ---------------------------------------------------------------------
-- Lo que una persona puede además de su rol. La lista es CERRADA y
-- corta a propósito: son exactamente las dos casillas de ACC-4, y nada
-- más cabe en la columna. Un permiso por persona cualquiera sería un rol
-- a medida sin nombre, y eso es ACC-9.
--
--   «también puede ver mis finanzas»     finanzas.factura.ver
--                                        finanzas.gasto.ver
--                                        finanzas.flujo.ver
--   «también puede conectar mis cuentas» conexiones.cuenta.conectar
--                                        conexiones.cuenta.desconectar
--
-- (Ver, no operar: la casilla de finanzas no da crear facturas ni
-- registrar pagos. El cobro de sus campañas, finanzas.cobro.ver, ya lo
-- trae el rol de Mánager.)
--
-- La invitación lleva la misma columna: lo que se decidió al invitar es
-- lo que recibe la persona al aceptar, sin pasar por nadie más.
-- =====================================================================
ALTER TABLE membership ADD COLUMN IF NOT EXISTS extra_permissions text[] NOT NULL DEFAULT '{}';
ALTER TABLE membership DROP CONSTRAINT IF EXISTS membership_extra_permissions_allowed;
ALTER TABLE membership ADD CONSTRAINT membership_extra_permissions_allowed CHECK (
  extra_permissions <@ ARRAY[
    'finanzas.factura.ver', 'finanzas.gasto.ver', 'finanzas.flujo.ver',
    'conexiones.cuenta.conectar', 'conexiones.cuenta.desconectar'
  ]::text[]
);
COMMENT ON COLUMN membership.extra_permissions IS
  'Permisos de esta persona además de los de su rol: solo los de las dos casillas de ACC-4 (ver finanzas, conectar cuentas). 0078 §1.';

ALTER TABLE invitation ADD COLUMN IF NOT EXISTS extra_permissions text[] NOT NULL DEFAULT '{}';
ALTER TABLE invitation DROP CONSTRAINT IF EXISTS invitation_extra_permissions_allowed;
ALTER TABLE invitation ADD CONSTRAINT invitation_extra_permissions_allowed CHECK (
  extra_permissions <@ ARRAY[
    'finanzas.factura.ver', 'finanzas.gasto.ver', 'finanzas.flujo.ver',
    'conexiones.cuenta.conectar', 'conexiones.cuenta.desconectar'
  ]::text[]
);
COMMENT ON COLUMN invitation.extra_permissions IS
  'Lo que la persona invitada recibirá además del rol (membership.extra_permissions) al aceptar. 0078 §1.';


-- =====================================================================
-- 2 · Lo que puede la sesión, en SQL
-- ---------------------------------------------------------------------
-- Una sola definición de «los permisos de quien abrió la transacción en
-- el workspace fijado»: los de su rol (role_permission) MÁS sus
-- casillas (extra_permissions). La leen las políticas de abajo y las
-- dos consultas de la aplicación que ya preguntaban lo mismo con su
-- propio JOIN (getSessionPermissions de ACC-5 y sessionHasPermission de
-- ACC-8): si cada una sumara las casillas a su manera, una de ellas se
-- olvidaría.
--
--   session_permission_keys()   el conjunto. Sin identidad, vacío: nadie
--                               recibe permisos por omisión.
--   session_can(permiso)        para las POLÍTICAS: lo mismo, más la
--                               bandera explícita app.auth_disabled sin
--                               identidad (la copia sin Supabase Auth y
--                               las pruebas, que la web trata como Dueño),
--                               igual que outreach_can_manage (0055 §7).
--   session_can_grant(rol, extras)  ¿tengo TODO lo que ese rol y esas
--                               casillas dan? Es «nadie otorga lo que no
--                               tiene»; un rol que no veo no se otorga.
--
-- LANGUAGE sql con SET search_path: Postgres no inlinea una función con
-- SET, y eso importa. Las políticas de membership llaman a estas
-- funciones, que leen membership; inlineadas, el planificador vería una
-- política de membership que consulta membership y pararía con
-- «infinite recursion detected in policy». Sin inlinear, la consulta de
-- dentro corre con las políticas de LECTURA de membership (membership_read,
-- 0028), que no llaman a nada.
--
-- SECURITY INVOKER: leen con la RLS de quien pregunta (membership_read,
-- role_permission_ws_isolation). STABLE: dentro de una sentencia, la
-- misma respuesta.
-- =====================================================================
CREATE OR REPLACE FUNCTION session_permission_keys() RETURNS SETOF text
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT rp.permission_key
    FROM membership m
    JOIN role_permission rp ON rp.role_id = m.role_id
   WHERE m.workspace_id = current_workspace_id()
     AND m.user_id = current_user_id()
  UNION
  SELECT x.k
    FROM membership m
    CROSS JOIN LATERAL unnest(m.extra_permissions) AS x(k)
   WHERE m.workspace_id = current_workspace_id()
     AND m.user_id = current_user_id()
$$;
COMMENT ON FUNCTION session_permission_keys() IS
  'Los permisos de la persona de la transacción en el workspace fijado: los de su rol más sus casillas (0078 §2). Sin identidad, ninguno.';

CREATE OR REPLACE FUNCTION session_can(p_key text) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT (current_user_id() IS NULL AND coalesce(current_setting('app.auth_disabled', true), '') = 'on')
      OR EXISTS (SELECT 1 FROM session_permission_keys() AS k WHERE k = p_key)
$$;
COMMENT ON FUNCTION session_can(text) IS
  'Para las políticas: ¿la sesión tiene este permiso? Sin identidad, solo con app.auth_disabled (0078 §2).';

CREATE OR REPLACE FUNCTION session_can_grant(p_role uuid, p_extras text[]) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM role r WHERE r.id = p_role)
     AND (
       (current_user_id() IS NULL AND coalesce(current_setting('app.auth_disabled', true), '') = 'on')
       OR NOT EXISTS (
         SELECT rp.permission_key FROM role_permission rp WHERE rp.role_id = p_role
         UNION
         SELECT x.k FROM unnest(coalesce(p_extras, '{}'::text[])) AS x(k)
         EXCEPT
         SELECT session_permission_keys()
       )
     )
$$;
COMMENT ON FUNCTION session_can_grant(uuid, text[]) IS
  'Nadie otorga lo que no tiene: ¿la sesión tiene todos los permisos de ese rol y de esas casillas? Un rol que no ve, no (0078 §2).';

REVOKE ALL ON FUNCTION session_permission_keys() FROM PUBLIC;
REVOKE ALL ON FUNCTION session_can(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION session_can_grant(uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION session_permission_keys() TO mc_app, mc_worker;
GRANT EXECUTE ON FUNCTION session_can(text) TO mc_app, mc_worker;
GRANT EXECUTE ON FUNCTION session_can_grant(uuid, text[]) TO mc_app, mc_worker;


-- =====================================================================
-- 3 · membership: cambiar el rol, quitar y el último dueño
-- ---------------------------------------------------------------------
-- Privilegios por COLUMNA (0024 §7.6): con UPDATE de tabla, quien puede
-- cambiar un rol podría mover la membresía a otro workspace o a otra
-- persona. Solo role_id y extra_permissions; y DELETE.
--
-- Las dos políticas piden, además del workspace fijado:
--   cambio  equipo.rol.editar, y session_can_grant() sobre la fila
--           VIEJA (USING: no se toca a quien tiene algo que yo no tengo,
--           así un Administrador no degrada a un Dueño) y sobre la NUEVA
--           (WITH CHECK: no se da lo que no se tiene).
--   baja    equipo.miembro.revocar, y session_can_grant() sobre la fila
--           (tampoco se echa a quien tiene más que yo).
--
-- El alta sigue siendo la de 0028 (membership_alta: solo yo, en el
-- espacio fijado): la usan createCreatorWorkspace y la aceptación de una
-- invitación (sección 5).
-- =====================================================================
GRANT UPDATE (role_id, extra_permissions) ON membership TO mc_app;
GRANT DELETE ON membership TO mc_app;

DROP POLICY IF EXISTS membership_cambio ON membership;
CREATE POLICY membership_cambio ON membership FOR UPDATE
  USING (
    workspace_id = current_workspace_id()
    AND session_can('equipo.rol.editar')
    AND session_can_grant(role_id, extra_permissions)
  )
  WITH CHECK (
    workspace_id = current_workspace_id()
    AND session_can('equipo.rol.editar')
    AND session_can_grant(role_id, extra_permissions)
  );

DROP POLICY IF EXISTS membership_baja ON membership;
CREATE POLICY membership_baja ON membership FOR DELETE
  USING (
    workspace_id = current_workspace_id()
    AND session_can('equipo.miembro.revocar')
    AND session_can_grant(role_id, extra_permissions)
  );

-- El último dueño. Se mira al cambiar el rol y al borrar; una cascada
-- (pg_trigger_depth() > 1: se está borrando el workspace o la persona
-- entera, y con ella sus membresías) no se frena, porque ahí no queda
-- un espacio huérfano: no queda espacio.
--
-- El candado por workspace (pg_advisory_xact_lock) hace que dos
-- degradaciones a la vez se pongan en fila: la segunda espera a que la
-- primera termine y entonces cuenta (en READ COMMITTED cada sentencia de
-- la función ve lo ya confirmado), así que ve que ya no quedan otros
-- dueños. Sin él, dos dueños que se degradan el uno al otro a la vez
-- dejaban el espacio sin ninguno.
--
-- SECURITY INVOKER: cuenta con la RLS de quien escribe, que es la del
-- workspace fijado (las políticas de arriba exigen que sea ese).
-- Mensaje en español y CONSTRAINT con nombre: la aplicación lo
-- reconoce por ahí (UltimoDuenoError de @mc/core) y no por el texto.
CREATE OR REPLACE FUNCTION membership_keeps_an_owner() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  era_dueno   boolean;
  sigue_dueno boolean := false;
  otros       integer;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT r.key = 'owner' AND r.workspace_id IS NULL INTO era_dueno FROM role r WHERE r.id = OLD.role_id;
  IF NOT coalesce(era_dueno, false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT r.key = 'owner' AND r.workspace_id IS NULL INTO sigue_dueno FROM role r WHERE r.id = NEW.role_id;
    IF coalesce(sigue_dueno, false) THEN
      RETURN NEW;
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('membership.owner:' || OLD.workspace_id::text, 0));
  SELECT count(*) INTO otros
    FROM membership m
    JOIN role r ON r.id = m.role_id
   WHERE m.workspace_id = OLD.workspace_id
     AND m.user_id <> OLD.user_id
     AND r.key = 'owner'
     AND r.workspace_id IS NULL;
  IF otros = 0 THEN
    RAISE EXCEPTION 'No se puede quitar ni degradar al último dueño del espacio.'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'membership_last_owner',
            HINT = 'Un espacio sin dueño no lo puede recuperar nadie: nombra antes a otra persona como Dueño (0078 §3).';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
COMMENT ON FUNCTION membership_keeps_an_owner() IS
  'Disparador BEFORE UPDATE OF role_id OR DELETE de membership: el último dueño no se quita ni se degrada (0078 §3, ACC-4).';
REVOKE ALL ON FUNCTION membership_keeps_an_owner() FROM PUBLIC;

DROP TRIGGER IF EXISTS membership_keeps_an_owner ON membership;
CREATE TRIGGER membership_keeps_an_owner
  BEFORE UPDATE OF role_id OR DELETE ON membership
  FOR EACH ROW EXECUTE FUNCTION membership_keeps_an_owner();


-- =====================================================================
-- 4 · invitation: invitar y revocar con permiso; lo único que cambia es
--     revoked_at
-- ---------------------------------------------------------------------
-- 0034 dejó invitar y cambiar una invitación a cualquier miembro del
-- espacio (lo señaló su /security-review: «ACC-4 debe cerrarlo con una
-- política por permiso»). Aquí:
--
--   alta    equipo.miembro.invitar, nadie otorga lo que no tiene, y
--           invited_by es la persona de la sesión (no se atribuye una
--           invitación a otro; sin identidad, NULL).
--   cambio  equipo.miembro.invitar, y mc_app solo escribe revoked_at
--           (privilegio de COLUMNA): revocar. Reabrir una revocada,
--           cambiarle el rol o alargarle el plazo no se puede; para eso
--           se invita de nuevo, con un token nuevo.
--
-- El disparador invitation_pending_only dice lo mismo para cualquiera
-- que escriba (también la función de aceptar, que es del rol que
-- migra): una invitación solo cambia mientras está pendiente, y solo
-- para quedar aceptada o revocada.
-- =====================================================================
DROP POLICY IF EXISTS invitation_write ON invitation;
CREATE POLICY invitation_write ON invitation FOR INSERT
  WITH CHECK (
    workspace_id = current_workspace_id()
    AND session_can('equipo.miembro.invitar')
    AND session_can_grant(role_id, extra_permissions)
    AND invited_by IS NOT DISTINCT FROM current_user_id()
  );

DROP POLICY IF EXISTS invitation_update ON invitation;
CREATE POLICY invitation_update ON invitation FOR UPDATE
  USING (workspace_id = current_workspace_id() AND session_can('equipo.miembro.invitar'))
  WITH CHECK (workspace_id = current_workspace_id() AND session_can('equipo.miembro.invitar'));

REVOKE UPDATE ON invitation FROM mc_app;
GRANT UPDATE (revoked_at) ON invitation TO mc_app;

CREATE OR REPLACE FUNCTION invitation_pending_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF OLD.accepted_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'La invitación ya no está pendiente: se aceptó o se revocó.'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invitation_pending_only';
  END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.email IS DISTINCT FROM OLD.email
     OR NEW.role_id IS DISTINCT FROM OLD.role_id
     OR NEW.extra_permissions IS DISTINCT FROM OLD.extra_permissions
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.invited_by IS DISTINCT FROM OLD.invited_by
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Una invitación no se edita: se revoca y se invita de nuevo.'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invitation_pending_only';
  END IF;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION invitation_pending_only() IS
  'Disparador BEFORE UPDATE de invitation: solo cambia una pendiente, y solo accepted_at o revoked_at (0078 §4).';
REVOKE ALL ON FUNCTION invitation_pending_only() FROM PUBLIC;

DROP TRIGGER IF EXISTS invitation_pending_only ON invitation;
CREATE TRIGGER invitation_pending_only
  BEFORE UPDATE ON invitation
  FOR EACH ROW EXECUTE FUNCTION invitation_pending_only();


-- =====================================================================
-- 5 · Aceptar: invitation_lookup e invitation_accept
-- ---------------------------------------------------------------------
-- La persona que abre el enlace tiene sesión (current_user_id()) pero
-- no es miembro del espacio que la invita, así que ninguna transacción
-- suya puede fijarlo ni leer la invitación (RLS por workspace_id). Las
-- dos funciones son SECURITY DEFINER, del rol que migra —como
-- outreach_channel_connect (0048)— y, como las tablas llevan FORCE ROW
-- LEVEL SECURITY, ese rol también pasa por las políticas. Lo que les
-- abre la fila es una política TO CURRENT_USER que solo deja ver la
-- invitación cuyo hash fijó la propia función en
-- app.invitation_token_hash, y la función lo borra antes de salir. Un
-- mc_app que fije ese parámetro a mano no gana nada: la política no es
-- suya.
--
-- Encontrada la fila, la función fija app.workspace_id al de la
-- invitación (y lo devuelve al salir) y hace lo que haría cualquier
-- transacción de ese espacio, con sus políticas: el alta propia de
-- membership (0028), la marca de aceptada y la fila de bitácora.
--
--   invitation_lookup(hash)  qué dice el enlace, sin tocar nada: el
--                            estado y, si está pendiente, el espacio, el
--                            rol, las casillas, quién invita, cuándo
--                            vence y si el correo de la sesión es el
--                            invitado (el invitado, enmascarado).
--   invitation_accept(hash)  la acepta. Un solo uso: FOR UPDATE sobre la
--                            fila y accepted_at, así que dos clics a la
--                            vez dan un 'ok' y un 'used'. Exige sesión y
--                            que su correo sea el invitado: el enlace
--                            reenviado a otra persona no le sirve.
--
-- Estados: ok · not_found · revoked · used · expired · wrong_email ·
-- already_member (ya es miembro: no se consume, quien invitó la revoca).
-- =====================================================================
DROP POLICY IF EXISTS invitation_accept_read ON invitation;
CREATE POLICY invitation_accept_read ON invitation FOR SELECT TO CURRENT_USER
  USING (token_hash = current_setting('app.invitation_token_hash', true));

DROP POLICY IF EXISTS invitation_accept_mark ON invitation;
CREATE POLICY invitation_accept_mark ON invitation FOR UPDATE TO CURRENT_USER
  USING (token_hash = current_setting('app.invitation_token_hash', true))
  WITH CHECK (token_hash = current_setting('app.invitation_token_hash', true));

CREATE OR REPLACE FUNCTION invitation_lookup(p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  inv      invitation%ROWTYPE;
  ws_antes text := coalesce(current_setting('app.workspace_id', true), '');
  estado   text;
  res      jsonb;
  correo   citext;
  hay      boolean;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  PERFORM set_config('app.invitation_token_hash', p_token_hash, true);
  SELECT * INTO inv FROM invitation WHERE token_hash = p_token_hash;
  -- FOUND hay que leerlo ya: el PERFORM de abajo lo vuelve a escribir.
  hay := FOUND;
  PERFORM set_config('app.invitation_token_hash', '', true);
  IF NOT hay THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  estado := CASE
    WHEN inv.revoked_at IS NOT NULL THEN 'revoked'
    WHEN inv.accepted_at IS NOT NULL THEN 'used'
    WHEN inv.expires_at <= now() THEN 'expired'
    ELSE 'pending'
  END;
  IF estado <> 'pending' THEN
    RETURN jsonb_build_object('status', estado);
  END IF;

  SELECT u.email INTO correo FROM app_user u WHERE u.id = current_user_id() AND u.deleted_at IS NULL;

  PERFORM set_config('app.workspace_id', inv.workspace_id::text, true);
  SELECT jsonb_build_object(
           'status', 'pending',
           'workspaceName', w.name,
           'roleKey', r.key,
           'roleLabel', r.label_es,
           'extraPermissions', to_jsonb(inv.extra_permissions),
           'expiresAt', inv.expires_at,
           'invitedByName', (SELECT coalesce(nullif(btrim(u.name), ''), NULL) FROM app_user u WHERE u.id = inv.invited_by),
           'invitedEmailMasked', left(split_part(inv.email::text, '@', 1), 1) || '•••@' || split_part(inv.email::text, '@', 2),
           'emailMatches', CASE WHEN correo IS NULL THEN NULL ELSE correo = inv.email END
         )
    INTO res
    FROM workspace w, role r
   WHERE w.id = inv.workspace_id AND r.id = inv.role_id;
  PERFORM set_config('app.workspace_id', ws_antes, true);
  RETURN coalesce(res, jsonb_build_object('status', 'not_found'));
END $$;
COMMENT ON FUNCTION invitation_lookup(text) IS
  'Qué dice el enlace de una invitación (por el SHA-256 del token), sin tocar nada: estado y, si está pendiente, espacio, rol, casillas y vencimiento (0078 §5, ACC-4).';

REVOKE ALL ON FUNCTION invitation_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_lookup(text) TO mc_app;

CREATE OR REPLACE FUNCTION invitation_accept(p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  yo       uuid := current_user_id();
  inv      invitation%ROWTYPE;
  ws_antes text := coalesce(current_setting('app.workspace_id', true), '');
  hay      boolean;
  correo   citext;
  clave    text;
BEGIN
  IF yo IS NULL THEN
    RAISE EXCEPTION 'invitation_accept necesita una sesión: la persona que acepta es la de la transacción.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- La fila, bloqueada: dos aceptaciones a la vez se ponen en fila y la
  -- segunda ya la ve aceptada.
  PERFORM set_config('app.invitation_token_hash', p_token_hash, true);
  SELECT * INTO inv FROM invitation WHERE token_hash = p_token_hash FOR UPDATE;
  hay := FOUND;
  IF NOT hay THEN
    PERFORM set_config('app.invitation_token_hash', '', true);
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF inv.revoked_at IS NOT NULL OR inv.accepted_at IS NOT NULL OR inv.expires_at <= now() THEN
    PERFORM set_config('app.invitation_token_hash', '', true);
    RETURN jsonb_build_object('status', CASE
      WHEN inv.revoked_at IS NOT NULL THEN 'revoked'
      WHEN inv.accepted_at IS NOT NULL THEN 'used'
      ELSE 'expired'
    END);
  END IF;

  -- El correo de la sesión tiene que ser el invitado (citext: sin
  -- distinguir mayúsculas). La fila de app_user es la propia.
  SELECT u.email INTO correo FROM app_user u WHERE u.id = yo AND u.deleted_at IS NULL;
  IF correo IS NULL OR correo <> inv.email THEN
    PERFORM set_config('app.invitation_token_hash', '', true);
    RETURN jsonb_build_object('status', 'wrong_email');
  END IF;

  -- Desde aquí, una transacción del espacio que invita.
  PERFORM set_config('app.workspace_id', inv.workspace_id::text, true);

  IF EXISTS (SELECT 1 FROM membership m WHERE m.workspace_id = inv.workspace_id AND m.user_id = yo) THEN
    PERFORM set_config('app.workspace_id', ws_antes, true);
    PERFORM set_config('app.invitation_token_hash', '', true);
    RETURN jsonb_build_object('status', 'already_member');
  END IF;

  -- El alta propia de 0028 (membership_alta): yo, en el espacio fijado.
  INSERT INTO membership (workspace_id, user_id, role_id, extra_permissions)
  VALUES (inv.workspace_id, yo, inv.role_id, inv.extra_permissions);

  UPDATE invitation SET accepted_at = now() WHERE id = inv.id;

  -- La bitácora (ACC-2): quién entró, con qué rol y qué casillas. Sin
  -- correo: la bitácora no lleva PII (sanitizeForAudit lo taparía).
  SELECT r.key INTO clave FROM role r WHERE r.id = inv.role_id;
  INSERT INTO audit_log (workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id, before, after)
  VALUES (inv.workspace_id, yo, 'user', 'invitation.accepted', 'invitation', inv.id, NULL,
          jsonb_build_object('userId', yo, 'roleKey', clave, 'extraPermissions', to_jsonb(inv.extra_permissions),
                             'invitedBy', inv.invited_by));

  PERFORM set_config('app.workspace_id', ws_antes, true);
  PERFORM set_config('app.invitation_token_hash', '', true);
  RETURN jsonb_build_object('status', 'ok', 'workspaceId', inv.workspace_id, 'roleKey', clave);
END $$;
COMMENT ON FUNCTION invitation_accept(text) IS
  'Acepta una invitación por el SHA-256 de su token: un solo uso, antes de vencer, y solo si el correo de la sesión es el invitado. Da de alta la membresía con el rol y las casillas de la invitación y deja invitation.accepted en audit_log (0078 §5, ACC-4).';

REVOKE ALL ON FUNCTION invitation_accept(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_accept(text) TO mc_app;
