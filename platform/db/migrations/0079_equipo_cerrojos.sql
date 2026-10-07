-- =====================================================================
-- 0079 · Equipo, segunda vuelta: la invitación antes del primer
--        espacio, y tres reglas que 0078 dejaba a la aplicación (ACC-4)
-- ---------------------------------------------------------------------
-- Número: 0079, detrás de 0078_equipo (misma pieza). Si el integrador
-- renumera 0078, esta va detrás; la guardia de §0 lo comprueba.
--
-- La revisión de 0078 encontró cuatro huecos:
--
--   · Un mánager sin cuenta abría el enlace, iniciaba sesión y
--     /auth/callback le creaba su propio espacio de creador, vacío y con
--     él de Dueño, porque todavía no pertenecía a ninguno. Al aceptar
--     quedaba con dos. Aquí: has_pending_invitation_for_session_email(),
--     SECURITY DEFINER, para que el alta (lib/auth/sincronizar.ts) sepa
--     que a esa persona la esperan en otro espacio y no le cree uno.
--   · Revocar una invitación no aplicaba «nadie toca lo que no puede
--     dar»: una Administradora de agencia revocaba la invitación de
--     Dueño que había hecho la Dueña. Aquí: session_can_grant() en la
--     política invitation_update, como ya la tenía membership_baja.
--   · El disparador del último dueño se saltaba con pg_trigger_depth()
--     > 1, que deja pasar CUALQUIER cambio que venga de otro disparador
--     y también el borrado físico de un app_user que era la única dueña
--     de un espacio que sigue vivo. Aquí: solo se salta cuando el
--     workspace ya no existe (se está borrando entero).
--   · Las casillas solo van con el Mánager de creador, pero la base no
--     lo exigía: un UPDATE a mano como mc_app podía dejarle casillas a
--     un Editor. Aquí: el disparador extra_permissions_manager_only en
--     membership y en invitation.
--
-- Y la segunda revisión, tres más:
--
--   · «Nadie otorga lo que no tiene» solo miraba permisos, no el alcance
--     de ACC-6 (membership_scope: sin filas = todo el espacio). Un
--     miembro acotado con equipo.miembro.invitar podía invitar a alguien
--     que entraba sin alcance, viendo todo. Y invitation.scope (0034) se
--     ignoraba al aceptar. Aquí (§6): quien tiene alcance no administra
--     el equipo, y una invitación no lleva alcance, hasta que ACC-6/7
--     traiga la regla del subconjunto.
--   · El rol tenía que ser del tipo del espacio (un rol de agencia no va
--     en un espacio de creador), pero solo lo decía la aplicación. Aquí
--     (§7): el disparador role_fits_workspace.
--   · Invitar manda un correo de la plataforma con el nombre del espacio,
--     que pone quien invita, y no tenía techo. Aquí (§8): como mucho
--     INVITACIONES_POR_DIA (20) por espacio en 24 horas.
--
-- ÍNDICE
--   0 · guardia: 0078 aplicada
--   1 · ¿me esperan en algún espacio? has_pending_invitation_for_session_email()
--   2 · invitation_update: solo se revoca lo que se podría dar
--   3 · el último dueño, sin la excepción por profundidad
--   4 · las casillas, solo con el Mánager de creador
--   5 · invitation_lookup dice también el locale y la zona del espacio
--   6 · el alcance: quien lo tiene no administra el equipo
--   7 · el rol, del tipo del espacio
--   8 · el techo: 20 invitaciones por espacio en 24 horas
--
-- Re-ejecutable: IF NOT EXISTS, DROP … IF EXISTS y CREATE OR REPLACE.
-- Comprobado dos veces seguidas en PGlite (packages/db/test/equipo.test.ts).
-- =====================================================================


-- =====================================================================
-- 0 · Guardia
-- =====================================================================
DO $$
BEGIN
  IF to_regprocedure('session_can_grant(uuid,text[])') IS NULL
     OR to_regprocedure('membership_keeps_an_owner()') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'invitation' AND column_name = 'extra_permissions'
     ) THEN
    RAISE EXCEPTION USING
      MESSAGE = '0079_equipo_cerrojos necesita 0078_equipo aplicada antes (session_can_grant, membership_keeps_an_owner, invitation.extra_permissions).',
      HINT = 'Aplica las migraciones en orden con make db.migrate.';
  END IF;
END $$;


-- =====================================================================
-- 1 · ¿Me esperan en algún espacio?
-- ---------------------------------------------------------------------
-- La pregunta del alta: el correo verificado de la sesión
-- (current_user_email(), migración sesion_correo_verificado) ¿tiene una
-- invitación pendiente y vigente en algún espacio? Si sí, el primer
-- inicio de sesión NO le crea un espacio de creador: viene a otro.
--
-- La persona todavía no es miembro de ese espacio, así que no puede
-- leer la invitación (RLS por workspace_id). Mismo cerrojo que
-- invitation_lookup (0078 §5): la función es SECURITY DEFINER, del rol
-- que migra, y lo único que le abre filas es una política TO
-- CURRENT_USER que lee una bandera que la propia función fija y borra.
-- Un mc_app que fije la bandera a mano no gana nada: la política no es
-- suya.
--
-- Devuelve solo un booleano. No dice de qué espacio, ni con qué rol, ni
-- quién invitó: eso lo enseña el enlace, y solo a quien lo tiene.
-- Sin correo en la sesión, false.
-- =====================================================================
DROP POLICY IF EXISTS invitation_pending_probe ON invitation;
CREATE POLICY invitation_pending_probe ON invitation FOR SELECT TO CURRENT_USER
  USING (
    coalesce(current_setting('app.invitation_email_probe', true), '') = 'on'
    AND email = current_user_email()
  );

CREATE OR REPLACE FUNCTION has_pending_invitation_for_session_email() RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  correo citext := current_user_email();
  hay    boolean;
BEGIN
  IF correo IS NULL THEN
    RETURN false;
  END IF;
  PERFORM set_config('app.invitation_email_probe', 'on', true);
  SELECT EXISTS (
    SELECT 1 FROM invitation i
     WHERE i.email = correo
       AND i.accepted_at IS NULL
       AND i.revoked_at IS NULL
       AND i.expires_at > now()
  ) INTO hay;
  PERFORM set_config('app.invitation_email_probe', '', true);
  RETURN hay;
END $$;
COMMENT ON FUNCTION has_pending_invitation_for_session_email() IS
  '¿El correo verificado de la sesión tiene una invitación pendiente y vigente? Para que el primer inicio de sesión no le cree un espacio propio a quien viene invitado (0079 §1, ACC-4).';

REVOKE ALL ON FUNCTION has_pending_invitation_for_session_email() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION has_pending_invitation_for_session_email() TO mc_app;


-- =====================================================================
-- 2 · invitation_update: solo se revoca lo que se podría dar
-- ---------------------------------------------------------------------
-- Es la regla que membership_baja ya aplica a una persona: no se echa a
-- quien tiene algo que yo no tengo. Aquí, sobre la invitación: no se
-- revoca la invitación de un rol (o de unas casillas) que yo no podría
-- dar. Sin esto, una Administradora de agencia no podía invitar a nadie
-- como Dueño, pero sí deshacer la invitación de Dueño que hizo la Dueña.
-- =====================================================================
DROP POLICY IF EXISTS invitation_update ON invitation;
CREATE POLICY invitation_update ON invitation FOR UPDATE
  USING (
    workspace_id = current_workspace_id()
    AND session_can('equipo.miembro.invitar')
    AND session_can_grant(role_id, extra_permissions)
  )
  WITH CHECK (
    workspace_id = current_workspace_id()
    AND session_can('equipo.miembro.invitar')
    AND session_can_grant(role_id, extra_permissions)
  );


-- =====================================================================
-- 3 · El último dueño, sin la excepción por profundidad
-- ---------------------------------------------------------------------
-- 0078 se saltaba la cuenta cuando el cambio venía de otro disparador
-- (pg_trigger_depth() > 1), pensando en la cascada del borrado de un
-- workspace. Pero eso también dejaba pasar:
--   · el borrado físico de un app_user (su membresía se va en cascada):
--     si era la única dueña de un espacio que sigue vivo, el espacio
--     quedaba huérfano, y nadie lo podía recuperar;
--   · cualquier UPDATE o DELETE de membership hecho desde un disparador
--     futuro, sin que nadie lo hubiera decidido.
--
-- Ahora la única excepción es la que de verdad no deja huérfano a
-- nadie: el workspace ya no existe. En la cascada de su borrado, la
-- acción referencial corre después de borrar la fila padre, así que
-- aquí ya no se ve. En cualquier otro caso, se cuentan los dueños.
--
-- La comprobación corre con la RLS de quien escribe, como el resto del
-- disparador: mc_app solo toca membresías del espacio fijado, y ese
-- espacio lo ve (workspace_read); mc_worker y postgres no tienen RLS.
-- =====================================================================
CREATE OR REPLACE FUNCTION membership_keeps_an_owner() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  era_dueno   boolean;
  sigue_dueno boolean := false;
  otros       integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workspace w WHERE w.id = OLD.workspace_id) THEN
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
            HINT = 'Un espacio sin dueño no lo puede recuperar nadie: nombra antes a otra persona como Dueño (0079 §3).';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
COMMENT ON FUNCTION membership_keeps_an_owner() IS
  'Disparador BEFORE UPDATE OF role_id OR DELETE de membership: el último dueño no se quita ni se degrada, salvo que el workspace ya no exista (0078 §3, 0079 §3, ACC-4).';
REVOKE ALL ON FUNCTION membership_keeps_an_owner() FROM PUBLIC;


-- =====================================================================
-- 4 · Las casillas, solo con el Mánager de creador
-- ---------------------------------------------------------------------
-- El CHECK de 0078 §1 limita QUÉ permisos caben en extra_permissions;
-- este disparador dice A QUIÉN: solo al rol de sistema «manager» de un
-- espacio de creador (admiteCasillas de @mc/core). A un Dueño no le
-- añaden nada, a un Editor no se le ofrecen, y en una agencia no
-- existen. Un CHECK no puede mirar la tabla role; un disparador sí.
--
-- En membership y en invitation, al insertar y al cambiar el rol o las
-- casillas. Con las casillas vacías no mira nada: es el caso de casi
-- todas las filas.
--
-- SECURITY INVOKER: los roles de sistema los ve cualquiera (role_read,
-- 0034 §2). Un rol que no se ve no es el Mánager de creador, así que
-- con casillas se rechaza: es lo conservador.
-- =====================================================================
CREATE OR REPLACE FUNCTION extra_permissions_manager_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  es_manager boolean;
BEGIN
  IF cardinality(NEW.extra_permissions) = 0 THEN
    RETURN NEW;
  END IF;
  SELECT r.key = 'manager' AND r.workspace_kind = 'creator' AND r.workspace_id IS NULL
    INTO es_manager
    FROM role r WHERE r.id = NEW.role_id;
  IF NOT coalesce(es_manager, false) THEN
    RAISE EXCEPTION 'Las casillas («ver mis finanzas», «conectar mis cuentas») solo van con el rol de Mánager de un espacio de creador.'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'extra_permissions_manager_only',
            HINT = 'Cambia el rol y las casillas en la misma escritura, o deja extra_permissions vacío (0079 §4).';
  END IF;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION extra_permissions_manager_only() IS
  'Disparador de membership e invitation: extra_permissions solo con el rol de sistema manager de creador (0079 §4, ACC-4).';
REVOKE ALL ON FUNCTION extra_permissions_manager_only() FROM PUBLIC;

-- Las filas que ya existan tienen que cumplirla: si alguna no, se para
-- aquí con el motivo, en vez de dejar una regla que la base no cumple.
DO $$
DECLARE
  malas integer;
BEGIN
  SELECT (SELECT count(*) FROM membership m JOIN role r ON r.id = m.role_id
           WHERE cardinality(m.extra_permissions) > 0
             AND NOT (r.key = 'manager' AND r.workspace_kind = 'creator' AND r.workspace_id IS NULL))
       + (SELECT count(*) FROM invitation i JOIN role r ON r.id = i.role_id
           WHERE cardinality(i.extra_permissions) > 0
             AND NOT (r.key = 'manager' AND r.workspace_kind = 'creator' AND r.workspace_id IS NULL))
    INTO malas;
  IF malas > 0 THEN
    RAISE EXCEPTION USING
      MESSAGE = format('0079: hay %s filas de membership o invitation con casillas en un rol que no es el Mánager de creador.', malas),
      HINT = 'Vacía su extra_permissions (o cámbiales el rol) y vuelve a aplicar.';
  END IF;
END $$;

DROP TRIGGER IF EXISTS extra_permissions_manager_only ON membership;
CREATE TRIGGER extra_permissions_manager_only
  BEFORE INSERT OR UPDATE OF role_id, extra_permissions ON membership
  FOR EACH ROW EXECUTE FUNCTION extra_permissions_manager_only();

DROP TRIGGER IF EXISTS extra_permissions_manager_only ON invitation;
CREATE TRIGGER extra_permissions_manager_only
  BEFORE INSERT OR UPDATE OF role_id, extra_permissions ON invitation
  FOR EACH ROW EXECUTE FUNCTION extra_permissions_manager_only();


-- =====================================================================
-- 5 · invitation_lookup dice también el locale y la zona del espacio
-- ---------------------------------------------------------------------
-- La página del enlace ya no vive dentro del marco de la aplicación
-- (quien la abre puede no tener ningún espacio todavía: §1), así que no
-- hay «espacio actual» del que sacar el formato de la fecha de
-- vencimiento. La fecha es del espacio que invita —vence a su medianoche,
-- no a la de quien lee—, así que se pinta con su locale y su zona.
-- Igual que 0078 §5 en todo lo demás; solo se añaden las dos claves.
-- =====================================================================
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
           'emailMatches', CASE WHEN correo IS NULL THEN NULL ELSE correo = inv.email END,
           'locale', w.locale,
           'timezone', w.timezone
         )
    INTO res
    FROM workspace w, role r
   WHERE w.id = inv.workspace_id AND r.id = inv.role_id;
  PERFORM set_config('app.workspace_id', ws_antes, true);
  RETURN coalesce(res, jsonb_build_object('status', 'not_found'));
END $$;
COMMENT ON FUNCTION invitation_lookup(text) IS
  'Qué dice el enlace de una invitación (por el SHA-256 del token), sin tocar nada: estado y, si está pendiente, espacio (con su locale y su zona), rol, casillas y vencimiento (0078 §5, 0079 §5, ACC-4).';

REVOKE ALL ON FUNCTION invitation_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_lookup(text) TO mc_app;


-- =====================================================================
-- 6 · El alcance: quien lo tiene no administra el equipo
-- ---------------------------------------------------------------------
-- ACC-6 dejó el alcance (membership_scope, 0034 §6: sin filas = todo el
-- espacio) y le pasó a ACC-4 la pregunta de quién puede darlo (ACC-6
-- §4.5). La regla completa sería «solo se da un alcance que es
-- subconjunto del propio», y necesita la pantalla que escribe el
-- alcance y sus políticas de INSERT (CIERRE-ACC §5.6), que no existen.
-- Mientras tanto, lo conservador, en la base:
--
--   · session_has_scope(): ¿la persona de la sesión tiene alguna fila
--     de alcance en el espacio fijado?
--   · session_can_grant() pasa a ser falso para ella. Es la función que
--     piden las cuatro políticas del equipo (invitar, revocar, cambiar
--     el rol y quitar), así que quien está acotado no hace ninguna de
--     las cuatro: no abre todo el espacio desde un acceso parcial, ni
--     toca a quien ve más que ella.
--   · invitation.scope tiene que ser '[]': la aceptación no lo copiaba a
--     membership_scope y la persona entraba sin alcance, viéndolo todo.
--     Hasta que ACC-6/7 lo copie, una invitación no lleva alcance.
--
-- Hoy no hay ninguna fila de alcance (nadie las escribe), así que nada
-- cambia para nadie; la regla está para que el primer alcance real no
-- abra un hueco. Sin identidad (modo demo), sin filas: igual que antes.
-- =====================================================================
CREATE OR REPLACE FUNCTION session_has_scope() RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM membership_scope s
     WHERE s.workspace_id = current_workspace_id()
       AND s.user_id = current_user_id()
  )
$$;
COMMENT ON FUNCTION session_has_scope() IS
  '¿La persona de la transacción tiene alcance (filas en membership_scope) en el workspace fijado? Quien lo tiene no administra el equipo (0079 §6, ACC-4).';
REVOKE ALL ON FUNCTION session_has_scope() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION session_has_scope() TO mc_app, mc_worker;

CREATE OR REPLACE FUNCTION session_can_grant(p_role uuid, p_extras text[]) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM role r WHERE r.id = p_role)
     AND NOT session_has_scope()
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
  'Nadie otorga lo que no tiene: ¿la sesión tiene todos los permisos de ese rol y de esas casillas, y no está acotada por alcance? Un rol que no ve, no (0078 §2, 0079 §6).';
REVOKE ALL ON FUNCTION session_can_grant(uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION session_can_grant(uuid, text[]) TO mc_app, mc_worker;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM invitation WHERE scope IS DISTINCT FROM '[]'::jsonb) THEN
    RAISE EXCEPTION USING
      MESSAGE = '0079: hay invitaciones con alcance (invitation.scope distinto de []), y la aceptación no lo copia.',
      HINT = 'Revócalas y vacía su scope, o espera a ACC-6/7, que copiará el alcance al aceptar.';
  END IF;
END $$;
ALTER TABLE invitation DROP CONSTRAINT IF EXISTS invitation_scope_not_yet;
ALTER TABLE invitation ADD CONSTRAINT invitation_scope_not_yet
  CHECK (scope = '[]'::jsonb);
COMMENT ON CONSTRAINT invitation_scope_not_yet ON invitation IS
  'Una invitación no lleva alcance hasta que la aceptación lo copie a membership_scope (ACC-6/7): si no, la persona entraría viendo todo (0079 §6).';


-- =====================================================================
-- 7 · El rol, del tipo del espacio
-- ---------------------------------------------------------------------
-- Un rol de fábrica es de creador o de agencia (role.workspace_kind) y
-- solo va en un espacio de ese tipo; uno a medida (ACC-9), solo en su
-- propio espacio. listTeamRoles ya ofrece solo esos, pero un INSERT o
-- un UPDATE a mano como mc_app podía poner el Ejecutivo de cuenta de
-- una agencia en un espacio de creador.
--
-- Disparador y no WITH CHECK, como §4: así vale para todo el que
-- escribe —mc_app, la aceptación (que es del rol que migra), el alta de
-- un espacio, el worker y los seeds— con una sola definición. Lee role y
-- workspace con la RLS de quien escribe: el workspace es el fijado (las
-- políticas de alta lo exigen) y se ve; los roles de sistema los ve
-- cualquiera. Un rol que no se ve no encaja, y se rechaza. Un workspace
-- que no se ve solo le pasa a quien la política de alta va a rechazar
-- de todos modos, así que ahí no se decide nada.
-- =====================================================================
CREATE OR REPLACE FUNCTION role_fits_workspace() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  tipo   text;
  encaja boolean;
BEGIN
  SELECT w.kind INTO tipo FROM workspace w WHERE w.id = NEW.workspace_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  SELECT (r.workspace_id IS NULL AND r.workspace_kind = tipo) OR r.workspace_id = NEW.workspace_id
    INTO encaja
    FROM role r WHERE r.id = NEW.role_id;
  IF NOT coalesce(encaja, false) THEN
    RAISE EXCEPTION 'Ese rol no es de este espacio: los roles de fábrica van con su tipo de espacio (creador o agencia) y los a medida, con el suyo.'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'role_fits_workspace',
            HINT = 'Elige uno de los roles que lista listTeamRoles para este espacio (0079 §7).';
  END IF;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION role_fits_workspace() IS
  'Disparador de membership e invitation: el rol es de fábrica del tipo del espacio, o a medida del propio espacio (0079 §7, ACC-4).';
REVOKE ALL ON FUNCTION role_fits_workspace() FROM PUBLIC;

DO $$
DECLARE
  malas integer;
BEGIN
  SELECT (SELECT count(*) FROM membership m JOIN workspace w ON w.id = m.workspace_id JOIN role r ON r.id = m.role_id
           WHERE NOT ((r.workspace_id IS NULL AND r.workspace_kind = w.kind) OR r.workspace_id = m.workspace_id))
       + (SELECT count(*) FROM invitation i JOIN workspace w ON w.id = i.workspace_id JOIN role r ON r.id = i.role_id
           WHERE NOT ((r.workspace_id IS NULL AND r.workspace_kind = w.kind) OR r.workspace_id = i.workspace_id))
    INTO malas;
  IF malas > 0 THEN
    RAISE EXCEPTION USING
      MESSAGE = format('0079: hay %s filas de membership o invitation con un rol que no es del tipo de su espacio.', malas),
      HINT = 'Cámbiales el rol por el equivalente del tipo del espacio y vuelve a aplicar.';
  END IF;
END $$;

DROP TRIGGER IF EXISTS role_fits_workspace ON membership;
CREATE TRIGGER role_fits_workspace
  BEFORE INSERT OR UPDATE OF role_id, workspace_id ON membership
  FOR EACH ROW EXECUTE FUNCTION role_fits_workspace();

DROP TRIGGER IF EXISTS role_fits_workspace ON invitation;
CREATE TRIGGER role_fits_workspace
  BEFORE INSERT OR UPDATE OF role_id, workspace_id ON invitation
  FOR EACH ROW EXECUTE FUNCTION role_fits_workspace();


-- =====================================================================
-- 8 · El techo: 20 invitaciones por espacio en 24 horas
-- ---------------------------------------------------------------------
-- Invitar manda un correo desde el SMTP de la plataforma, y el asunto y
-- el cuerpo llevan el nombre del espacio, que pone quien invita. Sin
-- techo, cualquiera que se registrara podía bautizar su espacio con un
-- texto engañoso y mandar correos sin fin firmados por On Cue. La
-- aplicación recorta el nombre en el correo; la base pone el techo.
--
-- 20 por espacio en las últimas 24 horas, contando todas las que se
-- crearon (también las revocadas o reemplazadas: cada una pudo ser un
-- correo). «Nuevo enlace» crea otra y también cuenta. El número vive
-- aquí y en INVITACIONES_POR_DIA de @mc/core (para la frase); una
-- prueba exige que coincidan.
--
-- Para que la cuenta no se burle, la fecha de alta la pone la base:
-- created_at = now() pase lo que pase (un INSERT con una fecha vieja
-- no se cuela por debajo de la ventana). El candado por espacio pone en
-- fila dos invitaciones a la vez, como §3 con el último dueño.
--
-- SECURITY INVOKER: cuenta con la RLS de quien escribe. mc_app ve las
-- invitaciones del espacio fijado, que es el único donde puede insertar
-- (invitation_write); mc_worker y el rol que migra, todas.
-- =====================================================================
CREATE OR REPLACE FUNCTION invitation_daily_cap() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  hechas integer;
BEGIN
  NEW.created_at := now();
  PERFORM pg_advisory_xact_lock(hashtextextended('invitation.daily_cap:' || NEW.workspace_id::text, 0));
  SELECT count(*) INTO hechas
    FROM invitation i
   WHERE i.workspace_id = NEW.workspace_id
     AND i.created_at > now() - interval '24 hours';
  IF hechas >= 20 THEN
    RAISE EXCEPTION 'Este espacio ya creó 20 invitaciones en las últimas 24 horas.'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'invitation_daily_cap',
            HINT = 'Espera a que pasen 24 horas desde las primeras (0079 §8).';
  END IF;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION invitation_daily_cap() IS
  'Disparador BEFORE INSERT de invitation: como mucho 20 por espacio en 24 horas, con created_at puesto por la base (0079 §8, ACC-4).';
REVOKE ALL ON FUNCTION invitation_daily_cap() FROM PUBLIC;

DROP TRIGGER IF EXISTS invitation_daily_cap ON invitation;
CREATE TRIGGER invitation_daily_cap
  BEFORE INSERT ON invitation
  FOR EACH ROW EXECUTE FUNCTION invitation_daily_cap();
