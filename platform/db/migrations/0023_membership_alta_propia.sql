-- =====================================================================
-- 0023 · membership: leer lo mío, escribir solo en el espacio fijado (CIM-3)
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
-- CONVIVENCIA con el pase de endurecimiento (rama rasheed/endurecer-db,
-- su 0022_aislamiento_por_defecto.sql): parte esta misma política con
-- los MISMOS nombres y las MISMAS condiciones. Por eso aquí todo va con
-- DROP … IF EXISTS antes de crear: da igual cuál de las dos se aplique
-- primero, el estado final es uno solo (comprobado en PGlite con las
-- dos). NUMERACIÓN: en esta rama las de CIM-3 son 0022 y 0023 porque
-- db/migrations no admite huecos (packages/db/test/aplicar.test.ts),
-- pero endurecer-db y COT-1 también reclaman el 0022. En la
-- integración van DETRÁS de esas dos, renumeradas al siguiente número
-- libre, y ANTES de aplicar nada en Supabase: el runner guarda el
-- nombre del archivo y una aplicada ya no se renombra.
-- =====================================================================

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
-- (En Postgres embebido no se nota: packages/db/src/embedded.ts vuelve a
-- conceder los cuatro privilegios a mc_app DESPUÉS de migrar. Contra
-- Supabase, sí.)
GRANT INSERT ON membership TO mc_app;

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
