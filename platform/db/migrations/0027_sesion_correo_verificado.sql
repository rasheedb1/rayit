-- =====================================================================
-- 0027 · La identidad de la sesión: correo verificado e id de Auth (CIM-3)
-- ---------------------------------------------------------------------
-- NUMERACIÓN (ronda 4). Nació como 0022 en rasheed/CIM-3-auth-workspaces
-- y nunca se aplicó en ninguna base persistente. Los números de delante
-- ya tienen dueño:
--
--   0022  main: 0022_public_profile_access.sql (CON-10), YA APLICADA en
--         Supabase.
--   0023  reservada en main para ACC-3 (accesos y roles).
--   0024  rasheed/endurecer-db: 0024_aislamiento_por_defecto.sql
--   0025  rasheed/endurecer-db: 0025_referencias_visibles.sql
--   0026  rasheed/COT-1-cotizar: hoy 0022_public_share.sql en su rama,
--         pendiente de renumerar (choca con la de main).
--
-- Estas dos de CIM-3 van DETRÁS de todas, y el orden importa de verdad,
-- no solo por no chocar: 0024 §7 hace REVOKE INSERT ON membership FROM
-- mc_app y 0028 lo vuelve a conceder (el alta del primer espacio). Si
-- 0028 corriera antes, el REVOKE ganaría y el primer inicio de sesión
-- fallaría contra Supabase. Si al integrar algún número de delante
-- cambia, estas se mueven con él, SIEMPRE antes de `make db.migrate`: el
-- runner guarda el nombre del archivo y una aplicada ya no se renombra.
-- El código no cita estos números (lib/auth/sincronizar.ts nombra la
-- migración por lo que crea), así que renumerar es mover dos archivos.
-- ---------------------------------------------------------------------
-- 0019 dejó current_user_id() leyendo app.user_id y 0020/0021 cerraron
-- app_user con tres políticas: SELECT («soy yo, o comparto workspace
-- conmigo»), INSERT abierto y UPDATE («soy yo»). Todas necesitan saber
-- el id ANTES de consultar, y en el PRIMER inicio de sesión ese id es
-- justo lo que no se sabe: Supabase Auth verifica un CORREO y la web
-- tiene que encontrar —o crear— la fila de app_user que le corresponde.
--
-- Sin esta migración ese paso no se puede dar como mc_app:
--
--   SELECT id FROM app_user WHERE email = 'laura@…'
--
-- devuelve cero filas (la política de SELECT no tiene rama por correo),
-- y el alta a ciegas choca contra el único de app_user.email. La salida
-- fácil sería mirar la tabla con un rol que salte RLS o con una función
-- SECURITY DEFINER; las dos abren la PII de TODAS las personas para
-- resolver un caso en el que la sesión ya demostró ser dueña de UN
-- correo.
--
-- Así que se fija el correo en la transacción, igual que el workspace y
-- el id, y las políticas lo miran. La sesión solo puede fijar el correo
-- que Supabase verificó (apps/web/lib/auth), del mismo modo que solo
-- puede fijar un workspace en el que tiene membresía: el permiso no
-- nace de esta migración, nace de la sesión.
--
-- Mientras nadie fije app.user_email —el seed, el worker, las
-- migraciones, toda la web fuera del inicio de sesión—
-- current_user_email() es NULL, `email = NULL` es NULL, y estas dos
-- políticas no dejan ver ni tocar ninguna fila. No cambian nada de lo
-- que ya existe.
--
-- DELETE sigue sin política: borrar una persona es otra historia.
-- =====================================================================

-- ---------------------------------------------------------------------
-- El correo de la sesión, como current_user_id() es la persona.
-- ---------------------------------------------------------------------
-- citext, para que la comparación con app_user.email sea la misma que
-- usa su índice único: nadie entra dos veces por escribir su correo con
-- mayúsculas.
CREATE OR REPLACE FUNCTION current_user_email() RETURNS citext AS $$
  SELECT nullif(current_setting('app.user_email', true), '')::citext;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------
-- app_user: mi fila, por el correo que la sesión verificó
-- ---------------------------------------------------------------------
-- Dos políticas nuevas, permisivas, que se suman por OR a las de 0020 y
-- 0021. Son la MISMA regla que aquellas —cada quien ve y edita su
-- fila— dicha con la otra llave, la que existe antes de que haya id.
--
-- El WITH CHECK del UPDATE repite la condición a propósito: con él,
-- quien entra con su correo no puede cambiarse el correo por el de otra
-- persona (la fila resultante tendría que seguir siendo suya).
DROP POLICY IF EXISTS app_user_read_self_email ON app_user;
CREATE POLICY app_user_read_self_email ON app_user FOR SELECT
  USING (email = current_user_email());

DROP POLICY IF EXISTS app_user_update_self_email ON app_user;
CREATE POLICY app_user_update_self_email ON app_user FOR UPDATE
  USING (email = current_user_email())
  WITH CHECK (email = current_user_email());

-- ---------------------------------------------------------------------
-- app_user.auth_user_id: de qué cuenta de Supabase Auth es esta fila
-- ---------------------------------------------------------------------
-- Con el correo como única llave, la identidad era «quien tenga hoy ese
-- buzón». Dos casos reales lo rompen: un buzón de empresa que se
-- reasigna (la cuenta de Auth de la persona anterior se borra y la
-- nueva se registra con el mismo correo) y un dominio que caduca y
-- compra otro. En los dos, la cuenta nueva heredaba la fila de app_user
-- y todas sus membresías sin que nada lo notara.
--
-- Ahora la fila recuerda el id de auth.users con el que entró la
-- PRIMERA vez (/auth/callback lo fija si está vacío) y, desde entonces,
-- solo esa cuenta la puede usar:
--
--   · lectura   packages/db/src/queries/identidad.ts compara el id de
--               la sesión con el guardado y lanza AuthIdentityMismatchError
--               si no coinciden (queda en el log del servidor).
--   · alta      el upsert por correo solo toca la fila si está vacía o es
--               de la misma cuenta (ON CONFLICT … DO UPDATE … WHERE), así
--               que una cuenta ajena no la reclama ni aunque llegue por
--               el callback.
--
-- NULL a propósito: las filas que crean el seed o una invitación existen
-- antes de que esa persona tenga cuenta de Auth. El correo sigue
-- sirviendo para enlazarlas la primera vez.
--
-- UNIQUE: una cuenta de Auth es una persona. Si alguien cambia su correo
-- en Supabase (hoy no se puede desde On Cue), la fila vieja conserva su
-- id y el alta con el correo nuevo choca contra este índice en vez de
-- crear una segunda identidad para la misma cuenta. Es un fallo
-- ruidoso a propósito: cambiar de correo pide mover la fila, y eso es
-- una historia propia.
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS auth_user_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_user_auth_user_id_key'
  ) THEN
    ALTER TABLE app_user ADD CONSTRAINT app_user_auth_user_id_key UNIQUE (auth_user_id);
  END IF;
END $$;

COMMENT ON COLUMN app_user.auth_user_id IS
  'Id de auth.users de la cuenta de Supabase Auth dueña de esta fila. NULL hasta el primer inicio de sesión (filas del seed o de una invitación).';
