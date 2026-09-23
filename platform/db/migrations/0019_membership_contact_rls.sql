-- =====================================================================
-- 0019 · RLS en membership y contact (CIM-2, ronda 4)
-- ---------------------------------------------------------------------
-- 0010, 0011, 0017 y 0018 dejaron dos huecos, documentados como
-- test.todo en packages/db/test/schema.test.ts y aplazados a CIM-3 y a
-- VEN-1. Esta migración los cierra ahora, porque el aplazamiento no
-- compraba nada: hoy nadie lee esas dos tablas, así que activar la
-- política no rompe ningún camino, y en cambio la regla del proyecto
-- («toda tabla con workspace_id lleva RLS») deja de estar rota para el
-- primero que escriba una consulta de membresías o de contactos.
--
--   membership  tiene workspace_id NOT NULL y estaba sin RLS: cualquier
--               consulta como mc_app —incluso dentro de withWorkspace—
--               enumeraba user_id, workspace_id y rol de TODOS los
--               workspaces.
--   contact     guarda datos personales (correo, teléfono, LinkedIn) y
--               no tiene workspace_id: el aislamiento vive en
--               company_link. Sin RLS, un `select().from(contact)`
--               enumeraba la PII de todos los workspaces, y lo único
--               que lo impedía era un comentario en el README. Con
--               Ventas y outreach arrancando en paralelo, eso no basta.
--
-- Misma forma que 0010, 0011 y 0017: ENABLE + FORCE (aplica también al
-- dueño de la tabla, mc_migrator) y una política por tabla. mc_worker
-- sigue saltándolas por BYPASSRLS, que es como los jobs globales leen
-- membresías de todos.
--
-- app_user NO entra: no tiene workspace_id y su dueño natural es la
-- capa de sesión. Su política («soy yo, o comparto workspace conmigo»)
-- necesita app.user_id fijado ANTES del primer INSERT, y hoy el seed
-- crea app_user antes que su membership: con FORCE, ese INSERT fallaría.
-- Queda para CIM-3, junto con quien fije app.user_id; el test.todo de
-- schema.test.ts lo sigue mostrando en cada corrida.
-- =====================================================================

-- ---------------------------------------------------------------------
-- El usuario de la sesión, como current_workspace_id() es el workspace.
-- ---------------------------------------------------------------------
-- Devuelve NULL mientras nadie fije app.user_id, que es el caso hasta
-- CIM-3: la rama `user_id = current_user_id()` de la política de abajo
-- no existe todavía y nada cambia de comportamiento. Cuando CIM-3 fije
-- app.user_id por transacción (igual que withWorkspace fija
-- app.workspace_id), «a qué workspaces pertenezco» se responde como
-- mc_app, sin asWorker y sin una función SECURITY DEFINER.
CREATE OR REPLACE FUNCTION current_user_id() RETURNS uuid AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------
-- membership: por workspace, más las propias
-- ---------------------------------------------------------------------
ALTER TABLE membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_ws_isolation ON membership
  USING (workspace_id = current_workspace_id() OR user_id = current_user_id());

-- ---------------------------------------------------------------------
-- contact: público, o de una empresa vinculada a mi workspace
-- ---------------------------------------------------------------------
-- Los contactos de fuente pública (web de la empresa, perfil público,
-- prensa) son de todos: es el dato de prospección que comparte la
-- plataforma, y no es PII que un workspace haya escrito. Todo lo demás
-- —user_provided, inbound, enrichment_vendor— solo se ve desde un
-- workspace que tenga company_link con esa empresa, tabla que sí lleva
-- RLS desde 0010. La subconsulta corre con los privilegios de quien
-- consulta, así que es la RLS de company_link la que decide.
--
-- Sin WITH CHECK explícito, la escritura usa la misma condición: no se
-- puede colgar un contacto de una empresa que este workspace no tiene
-- vinculada, ni cambiarle la fuente a uno ajeno.
--
-- company sigue sin RLS a propósito: es el catálogo global de empresas
-- (nombre, dominio, sector) y ahí no hay PII.
ALTER TABLE contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact FORCE ROW LEVEL SECURITY;
CREATE POLICY contact_ws_isolation ON contact
  USING (
    source IN ('public_website', 'public_profile', 'press')
    OR EXISTS (
      SELECT 1 FROM company_link l
      WHERE l.company_id = contact.company_id
        AND l.workspace_id = current_workspace_id()
    )
  );
