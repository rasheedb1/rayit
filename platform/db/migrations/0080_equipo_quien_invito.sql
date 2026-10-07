-- =====================================================================
-- 0080 · Equipo, tercera vuelta: quién lee las invitaciones, y que
--        quien invitó siga pudiendo dar lo que dio (ACC-4)
-- ---------------------------------------------------------------------
-- Número: 0080, detrás de 0079_equipo_cerrojos (misma pieza). Si el
-- integrador renumera 0078 y 0079, esta va detrás; la guardia de §0 lo
-- comprueba.
--
-- La cuarta revisión de ACC-4 encontró dos huecos que 0078 y 0079 no
-- cerraban:
--
--   · Leer las invitaciones. 0078 puso permiso a invitar (INSERT) y a
--     revocar (UPDATE), pero el SELECT seguía siendo el de 0034: cualquier
--     miembro del espacio. Un Editor o un Solo lectura, que no tienen
--     equipo.miembro.ver, podían leer los correos invitados (datos
--     personales) desde cualquier consulta futura de la aplicación; hoy
--     solo lo frenaba la puerta de /accesos, no la base. Aquí (§1).
--   · Aceptar no volvía a mirar a quien invitó. Si una Administradora
--     invitaba a alguien como Administradora y después la degradaban a
--     Solo lectura (o la quitaban del espacio), el enlace seguía dando
--     Administradora durante siete días: «nadie otorga lo que no tiene»
--     se cumplía al invitar y se olvidaba al aceptar. Aquí (§2 y §3).
--
-- ÍNDICE
--   0 · guardia: 0079 aplicada
--   1 · invitation_read: solo quien ve el equipo o invita
--   2 · invitation_inviter_can_grant(): ¿quien invitó todavía podría darlo?
--   3 · invitation_lookup e invitation_accept la preguntan
--
-- Re-ejecutable: DROP … IF EXISTS y CREATE OR REPLACE.
-- Comprobado dos veces seguidas en PGlite (packages/db/test/equipo.test.ts).
-- =====================================================================


-- =====================================================================
-- 0 · Guardia
-- =====================================================================
DO $$
BEGIN
  IF to_regprocedure('session_has_scope()') IS NULL
     OR to_regprocedure('invitation_daily_cap()') IS NULL
     OR to_regprocedure('invitation_lookup(text)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = '0080_equipo_quien_invito necesita 0079_equipo_cerrojos aplicada antes (session_has_scope, invitation_daily_cap, invitation_lookup).',
      HINT = 'Aplica las migraciones en orden con make db.migrate.';
  END IF;
END $$;


-- =====================================================================
-- 1 · invitation_read: solo quien ve el equipo o invita
-- ---------------------------------------------------------------------
-- A quién se invitó es del equipo, como quién está en él: lo ve quien
-- tiene equipo.miembro.ver (el permiso mínimo del módulo, ACC-5). Y
-- también quien tiene equipo.miembro.invitar aunque no lo vea (un rol a
-- medida de ACC-9 podría separarlos): invitar necesita leer lo que
-- toca —reemplazar la pendiente del mismo correo, revocar, el RETURNING
-- del alta— y el techo diario (invitation_daily_cap, 0079 §7) cuenta
-- con la RLS de quien escribe; si no viera las del día, el techo
-- contaría cero.
--
-- Las tres políticas TO CURRENT_USER de las funciones del rol que migra
-- (invitation_accept_read, invitation_accept_mark, 0078 §5;
-- invitation_pending_probe, 0079 §1) no cambian: abren una fila por su
-- hash o por el correo de la sesión, nunca la lista.
--
-- Sin identidad, session_can() solo vale con app.auth_disabled (la copia
-- sin Supabase Auth, que la web trata como Dueño): igual que antes.
-- =====================================================================
DROP POLICY IF EXISTS invitation_read ON invitation;
CREATE POLICY invitation_read ON invitation FOR SELECT
  USING (
    workspace_id = current_workspace_id()
    AND (session_can('equipo.miembro.ver') OR session_can('equipo.miembro.invitar'))
  );


-- =====================================================================
-- 2 · ¿Quien invitó todavía podría darlo?
-- ---------------------------------------------------------------------
-- La misma pregunta que session_can_grant() (0078 §2, 0079 §6) y que
-- invitation_write, hecha sobre quien FIRMÓ la invitación
-- (invited_by) y no sobre la sesión: ¿sigue siendo miembro del espacio,
-- sin alcance limitado, con equipo.miembro.invitar y con todos los
-- permisos del rol y de las casillas de la invitación (los de su rol
-- más sus propias casillas)?
--
-- Sin invited_by no hay a quién volver a preguntar, y manda lo que
-- comprobó la política de alta: es la invitación de la copia sin
-- Supabase Auth (la demo, donde nadie firma) o la de una cuenta borrada
-- entera (la clave ajena es ON DELETE SET NULL). Con sesión, invited_by
-- es siempre quien invitó (invitation_write lo exige).
--
-- SECURITY INVOKER: lee membership, membership_scope y role_permission
-- con la RLS de quien pregunta y con el workspace fijado. La llaman las
-- dos funciones de §3 (del rol que migra, con app.workspace_id puesto en
-- el de la invitación) y la aplicación al degradar o quitar a alguien,
-- para revocar en la misma transacción las invitaciones que esa persona
-- ya no podría dar (@mc/db/queries/equipo). Si p_workspace no es el
-- fijado, la RLS esconde las filas y la respuesta es false: lo seguro.
-- LANGUAGE sql con SET search_path, como session_can_grant: no se
-- inlinea dentro de una política de membership.
-- =====================================================================
CREATE OR REPLACE FUNCTION invitation_inviter_can_grant(p_workspace uuid, p_inviter uuid, p_role uuid, p_extras text[])
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT p_inviter IS NULL OR (
    EXISTS (SELECT 1 FROM membership m WHERE m.workspace_id = p_workspace AND m.user_id = p_inviter)
    AND NOT EXISTS (SELECT 1 FROM membership_scope s WHERE s.workspace_id = p_workspace AND s.user_id = p_inviter)
    AND NOT EXISTS (
      SELECT 'equipo.miembro.invitar'::text
      UNION
      SELECT rp.permission_key FROM role_permission rp WHERE rp.role_id = p_role
      UNION
      SELECT x.k FROM unnest(coalesce(p_extras, '{}'::text[])) AS x(k)
      EXCEPT
      SELECT rp.permission_key
        FROM membership m
        JOIN role_permission rp ON rp.role_id = m.role_id
       WHERE m.workspace_id = p_workspace AND m.user_id = p_inviter
      EXCEPT
      SELECT x.k
        FROM membership m
        CROSS JOIN LATERAL unnest(m.extra_permissions) AS x(k)
       WHERE m.workspace_id = p_workspace AND m.user_id = p_inviter
    )
  )
$$;
COMMENT ON FUNCTION invitation_inviter_can_grant(uuid, uuid, uuid, text[]) IS
  'Nadie otorga lo que no tiene, también al aceptar: ¿quien invitó sigue en el espacio, sin alcance, con equipo.miembro.invitar y con todo lo que da la invitación? Sin invited_by, sí (0080 §2, ACC-4).';
REVOKE ALL ON FUNCTION invitation_inviter_can_grant(uuid, uuid, uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_inviter_can_grant(uuid, uuid, uuid, text[]) TO mc_app, mc_worker;


-- =====================================================================
-- 3 · invitation_lookup e invitation_accept la preguntan
-- ---------------------------------------------------------------------
-- Si quien invitó ya no podría dar lo que dio, el enlace dice
-- 'revoked': la invitación murió con el permiso de quien la firmó. Las
-- dos funciones lo dicen igual, para que la página del enlace no ofrezca
-- «Aceptar» y el botón conteste otra cosa.
--
-- Ninguna de las dos escribe la revocación: abrir el enlace no toca
-- nada (0078 §5) y aceptar no revoca en nombre de nadie. La fila la
-- marca revocada la aplicación en la misma transacción que degrada o
-- quita a quien invitó (changeMemberRole y removeMember); si alguien
-- cambia el rol a mano, la pendiente se queda en la lista pero su enlace
-- ya no sirve, que es lo que importa.
--
-- El resto, idéntico a 0079 §5 (lookup) y 0078 §5 (accept).
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
  IF NOT invitation_inviter_can_grant(inv.workspace_id, inv.invited_by, inv.role_id, inv.extra_permissions) THEN
    PERFORM set_config('app.workspace_id', ws_antes, true);
    RETURN jsonb_build_object('status', 'revoked');
  END IF;

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
  'Qué dice el enlace de una invitación (por el SHA-256 del token), sin tocar nada: estado y, si está pendiente, espacio (con su locale y su zona), rol, casillas y vencimiento. Si quien invitó ya no podría darlo, revoked (0078 §5, 0079 §5, 0080 §3, ACC-4).';

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

  -- Quien invitó tiene que poder dar HOY lo que dio (§2): si lo
  -- degradaron o lo quitaron después de invitar, el enlace no sirve.
  IF NOT invitation_inviter_can_grant(inv.workspace_id, inv.invited_by, inv.role_id, inv.extra_permissions) THEN
    PERFORM set_config('app.workspace_id', ws_antes, true);
    PERFORM set_config('app.invitation_token_hash', '', true);
    RETURN jsonb_build_object('status', 'revoked');
  END IF;

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
  'Acepta una invitación por el SHA-256 de su token: un solo uso, antes de vencer, solo si el correo de la sesión es el invitado y solo si quien invitó todavía podría darlo. Da de alta la membresía con el rol y las casillas de la invitación y deja invitation.accepted en audit_log (0078 §5, 0080 §3, ACC-4).';

REVOKE ALL ON FUNCTION invitation_accept(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_accept(text) TO mc_app;
