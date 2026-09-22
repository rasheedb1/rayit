-- =====================================================================
-- 0022 · El correo verificado de la sesión (CIM-3)
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
CREATE POLICY app_user_read_self_email ON app_user FOR SELECT
  USING (email = current_user_email());

CREATE POLICY app_user_update_self_email ON app_user FOR UPDATE
  USING (email = current_user_email())
  WITH CHECK (email = current_user_email());
