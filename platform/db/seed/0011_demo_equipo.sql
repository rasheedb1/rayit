-- =====================================================================
-- Seed 11 · Equipo de la demo con historia (ACC-4)
-- ---------------------------------------------------------------------
-- La primera pantalla de Equipo que ve un cliente salía recién armada:
-- 0002 y 0003 dan de alta a Laura (la dueña) y a Andrés (su mánager)
-- sin fecha, así que membership.created_at era el día de la siembra y
-- /accesos decía de los dos «Desde el <hoy>». Y la sección de
-- invitaciones pendientes nacía vacía.
--
-- Este seed deja lo que tendría un espacio con historia:
--
--   · Laura es miembro desde hace un año y Andrés desde hace cinco
--     meses: antes de conectar la cuenta de Instagram de Laura, que 0003
--     fecha hace 140 días (ACC-8).
--   · Una invitación pendiente: Sofía Ríos, editora de video, invitada
--     por Laura como Editor. Su correo es de .test (no existe) y su hash
--     no sale de ningún enlace: el SHA-256 de una frase que no tiene la
--     forma de un token (isInvitationToken pide 43 caracteres base64url),
--     así que nadie la puede abrir ni aceptar. Es para verla en la lista,
--     con «Nuevo enlace» y «Revocar».
--
-- Reglas del archivo (las de 0002 y 0010):
--   * Idempotente. La invitación tiene un id fijo y solo se inserta si
--     no existe (ni la tocan las corridas siguientes: una invitación no
--     se edita, 0078 §4). Las fechas de alta solo se mueven HACIA ATRÁS
--     (WHERE created_at > la fecha nueva): la primera corrida las fija y
--     las siguientes, otro día, no las desplazan, porque la fecha ya
--     guardada es anterior. Lo que ya pasó se congela.
--   * Determinista. El reloj es la medianoche UTC de hoy,
--     date_trunc('day', now()), como en 0002.
--   * La invitación vence a los siete días, como cualquier otra
--     (INVITACION_VIGENCIA_DIAS de @mc/core). created_at lo pone la base
--     (invitation_daily_cap, 0079 §7) y no se puede refrescar, así que
--     una base sembrada hace más de una semana la enseña «Vencida», que
--     es el otro estado que la lista sabe pintar.
--   * El techo diario de invitaciones (0079 §7) cuenta también esta: si
--     la demo pública ya llegó a 20 en las últimas 24 horas, se salta en
--     vez de romper `make db.seed`.
--   * RLS en modo FORCE: el seed es Laura en su espacio. La fecha de alta
--     la cambia con la política membership_cambio (Dueña: tiene todo lo
--     que tiene cada miembro) y la invitación entra por invitation_write
--     (invited_by = ella).
--
-- Requiere las migraciones 0078 a 0080 y los seeds 0002 y 0003.
--
-- Mapa de identificadores (00000011-…):
--   …-0000000a0001    invitation (Sofía Ríos, Editor)
-- =====================================================================

SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);
SELECT set_config('app.user_id', '00000002-0000-4000-8000-000000000002', false);
SELECT set_config('TimeZone', 'UTC', false);


-- =====================================================================
-- 1 · Desde cuándo está cada quien
-- =====================================================================
WITH fechas (user_id, desde) AS (
  VALUES
    ('00000002-0000-4000-8000-000000000002'::uuid, date_trunc('day', now()) - interval '1 year'),
    ('00000002-0000-4000-8000-000000000004'::uuid, date_trunc('day', now()) - interval '5 months')
)
UPDATE membership m
   SET created_at = f.desde
  FROM fechas f
 WHERE m.workspace_id = '00000002-0000-4000-8000-000000000001'
   AND m.user_id = f.user_id
   AND m.created_at > f.desde;


-- =====================================================================
-- 2 · Una invitación pendiente
-- =====================================================================
INSERT INTO invitation (id, workspace_id, email, role_id, extra_permissions, token_hash, invited_by, expires_at)
SELECT '00000011-0000-4000-8000-0000000a0001',
       '00000002-0000-4000-8000-000000000001',
       'sofia.rios@ejemplo.test',
       system_role_id('creator', 'editor'),
       '{}',
       encode(sha256(convert_to('demo de On Cue: esta invitación no tiene enlace', 'UTF8')), 'hex'),
       '00000002-0000-4000-8000-000000000002',
       now() + interval '7 days'
 WHERE NOT EXISTS (SELECT 1 FROM invitation WHERE id = '00000011-0000-4000-8000-0000000a0001')
   AND (SELECT count(*) FROM invitation
         WHERE workspace_id = '00000002-0000-4000-8000-000000000001'
           AND created_at > now() - interval '24 hours') < 20
ON CONFLICT DO NOTHING;
