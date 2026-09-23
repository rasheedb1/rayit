-- =====================================================================
-- 0028 · membership: leer lo mío, escribir solo en el espacio fijado (CIM-3)
-- ---------------------------------------------------------------------
-- 0019 dejó en membership UNA política, FOR ALL y sin WITH CHECK:
--
--   USING (workspace_id = current_workspace_id() OR user_id = current_user_id())
--
-- Sin WITH CHECK propio, Postgres usa el USING también para lo que se
-- escribe. Mientras nadie fijaba app.user_id, la rama «soy yo» estaba
-- muerta. CIM-3 la enciende: desde entonces TODAS las transacciones de
-- la web fijan app.user_id, y con eso
--
--   withIdentity({ userId: YO }) →
--     INSERT INTO membership VALUES ('<espacio ajeno>', YO, 'owner')
--
-- pasaba sin error (reproducido como mc_app sobre PGlite). Un fallo
-- futuro en el código de la app —o una inyección— bastaba para que
-- cualquiera se hiciera dueño de cualquier espacio, y la RLS ya no lo
-- paraba. La lectura también cambió: dentro de withWorkspace(A), un
-- SELECT de membership devuelve además MIS membresías de otros
-- espacios, y eso sí es intencionado (es «a qué espacios pertenezco»).
--
-- Se parte en dos, lectura y alta:
--
--   membership_read  SELECT  las del espacio fijado, y las mías.
--   membership_alta  INSERT  solo YO, y solo en el espacio fijado. Es
--                            lo que hace createCreatorWorkspace dentro
--                            de withWorkspace(idNuevo, …, {userId}), y
--                            lo que hacen los seeds (fijan app.user_id
--                            y app.workspace_id antes de insertar).
--
-- Y NINGUNA política de UPDATE ni de DELETE: cambiar el rol de alguien o
-- echarlo es del worker (BYPASSRLS) hasta que exista la pantalla de
-- equipo, que decidirá quién puede. Una tabla con RLS y sin política
-- para un comando no admite ese comando.
--
-- Lo que esto NO cierra, dicho en voz alta: con withWorkspace(X) y mi
-- id se puede insertar mi membresía en X. Para fijar X, sin embargo, la
-- app ya tiene que haber decidido servirme X, y ese fallo sería por sí
-- solo una fuga total del inquilino (todas sus tablas); la membresía no
-- es el daño marginal. La web solo fija un espacio que la base devolvió
-- como mío (lib/workspace/current.ts) o uno que acaba de crear.
--
-- CONVIVENCIA con el pase de endurecimiento
-- (0024_aislamiento_por_defecto.sql): parte esta misma política con
-- los MISMOS nombres y las MISMAS condiciones, pero la crea sin
-- IF EXISTS (DROP POLICY membership_ws_isolation a secas). Por eso esta
-- va DETRÁS: aquí todo lleva DROP … IF EXISTS antes de crear, así que
-- sobre una base con 0024 aplicada deja el mismo estado final, y el
-- GRANT INSERT de abajo es posterior al REVOKE de 0024 §7, que es lo
-- que el alta del primer espacio necesita. Comprobado en PGlite.
--
-- NUMERACIÓN: ver la cabecera de 0027_sesion_correo_verificado.sql. En
-- corto: 0022 ya está en Supabase (main), 0023 es de ACC-3, 0024–0026
-- del endurecimiento; las de CIM-3 van detrás, y 0029 (endurecimiento)
-- y 0030 (Cotizar) detrás de ellas.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Guardia: 0024 tiene que estar aplicada ANTES
-- ---------------------------------------------------------------------
-- Si esta corriera sobre una base sin 0024, el REVOKE INSERT de 0024 §7
-- llegaría después y dejaría el alta del primer espacio sin privilegio
-- (y 0024 fallaría además en su DROP POLICY sin IF EXISTS). El runner
-- aplica en orden y no debería pasar nunca; si pasa —alguien aplicó
-- este archivo a mano, o reordenó los números—, mejor parar aquí con un
-- mensaje claro que descubrirlo en el primer inicio de sesión.
-- schema_migrations es la tabla del runner (db/lib/aplicar.mjs); si no
-- existe, quien aplica no es el runner (p. ej. db/seed/verify/run.mjs)
-- y no hay nada que comprobar. La consulta va con EXECUTE porque un
-- SELECT estático sobre una tabla que no existe no llega ni a planearse.
DO $$
DECLARE
  aplicada boolean;
BEGIN
  IF to_regclass('schema_migrations') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = $1)'
    INTO aplicada
    USING '0024_aislamiento_por_defecto.sql';
  IF NOT aplicada THEN
    RAISE EXCEPTION USING
      MESSAGE = '0028_membership_alta_propia necesita 0024_aislamiento_por_defecto aplicada antes.',
      HINT = 'Aplica las migraciones en orden con make db.migrate (0024, 0025, 0026, 0027, 0028, …).';
  END IF;
END $$;

DROP POLICY IF EXISTS membership_ws_isolation ON membership;

DROP POLICY IF EXISTS membership_read ON membership;
CREATE POLICY membership_read ON membership FOR SELECT
  USING (workspace_id = current_workspace_id() OR user_id = current_user_id());

DROP POLICY IF EXISTS membership_alta ON membership;
CREATE POLICY membership_alta ON membership FOR INSERT
  WITH CHECK (workspace_id = current_workspace_id() AND user_id = current_user_id());

-- ---------------------------------------------------------------------
-- El privilegio: INSERT, y nada más
-- ---------------------------------------------------------------------
-- El pase de endurecimiento deja a mc_app sin INSERT/UPDATE/DELETE
-- sobre membership «hasta que CIM-3 diga quién puede». CIM-3 lo dice:
-- darse de alta a uno mismo en el espacio que acaba de crear (política
-- de arriba). Sin este GRANT, el primer inicio de sesión de una persona
-- nueva falla contra una base con el endurecimiento aplicado. En una
-- base sin él, mc_app ya tenía INSERT y esto no cambia nada. UPDATE y
-- DELETE se quedan como estén: sin política, no sirven de nada.
-- (El Postgres embebido da a mc_app sus privilegios con ALTER DEFAULT
-- PRIVILEGES, como Supabase, así que el REVOKE de 0024 y este GRANT se
-- notan igual en las pruebas.)
GRANT INSERT ON membership TO mc_app;

-- Y con el INSERT, el disparador de referencias de 0025 §3. El bucle de
-- 0025 §7 solo lo enganchó donde mc_app escribía entonces, y membership
-- estaba cerrada. Sin él, una membresía podría nombrar un workspace o
-- una persona que la transacción no ve (la guardia de esquema.ts lo
-- reporta como referencia sin comprobar). El alta propia pasa: el
-- espacio fijado se ve (workspace_read) y la propia fila de app_user
-- también (app_user_read, «soy yo»).
DROP TRIGGER IF EXISTS ref_visible_workspace_id ON membership;
CREATE TRIGGER ref_visible_workspace_id
  BEFORE INSERT OR UPDATE OF workspace_id ON membership
  FOR EACH ROW WHEN (NEW.workspace_id IS NOT NULL)
  EXECUTE FUNCTION assert_reference_visible('workspace_id', 'workspace', 'id');

DROP TRIGGER IF EXISTS ref_visible_user_id ON membership;
CREATE TRIGGER ref_visible_user_id
  BEFORE INSERT OR UPDATE OF user_id ON membership
  FOR EACH ROW WHEN (NEW.user_id IS NOT NULL)
  EXECUTE FUNCTION assert_reference_visible('user_id', 'app_user', 'id');

-- ---------------------------------------------------------------------
-- workspace: ver el nombre de los espacios a los que pertenezco
-- ---------------------------------------------------------------------
-- Hoy workspace no lleva RLS y esta política no hace nada: una política
-- sobre una tabla sin ROW LEVEL SECURITY no se evalúa. Existe para el
-- día en que se active (el pase de endurecimiento lo hace, con lectura
-- «solo el espacio fijado»): sin ella, «a qué espacios pertenezco»
-- devolvería las membresías sin el nombre de ningún espacio, y el
-- selector se quedaría vacío. Es la misma regla que membership_read,
-- vista desde workspace. No hay recursión: la política de membership
-- no mira workspace.
DROP POLICY IF EXISTS workspace_read_member ON workspace;
CREATE POLICY workspace_read_member ON workspace FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM membership m
      WHERE m.workspace_id = workspace.id
        AND m.user_id = current_user_id()
    )
  );
