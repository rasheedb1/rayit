-- =====================================================================
-- 0020 · Cierra los tres huecos que dejó 0019 (CIM-2, ronda 5)
-- ---------------------------------------------------------------------
-- 0019 activó RLS en membership y contact, pero la revisión de la
-- ronda 4 reprodujo sobre pglite —con estas mismas migraciones— tres
-- caminos que siguen abiertos:
--
--   1. contact se aísla por company_link, y `company` es un catálogo
--      GLOBAL sin RLS: al workspace B le basta insertar UNA fila en
--      company_link hacia la empresa de A para leer el nombre, el
--      correo y el teléfono que A guardó. El candado estaba en una
--      tabla que cualquiera puede abrir desde dentro.
--   2. La política de 0019 es UNA sola, permisiva y FOR ALL, y sin
--      WITH CHECK propio su USING gobierna también la escritura. Su
--      rama pública (source IN ('public_website','public_profile',
--      'press')) se aplicaba por tanto a INSERT, UPDATE y DELETE: B
--      actualizaba el correo de un contacto de A, lo borraba, o le
--      colgaba uno nuevo a la empresa de A marcándolo 'press'. Y como
--      contact lleva opted_out, eso incluye devolver a false la baja
--      de alguien que pidió no ser contactado, que 0007 declara
--      GLOBAL.
--   3. app_user guarda el correo de todas las personas de la
--      plataforma y seguía sin RLS: desde B, un `select email from
--      app_user` dentro de withWorkspace devolvía los correos de A.
--      0019 lo aplazó a CIM-3 porque el seed inserta app_user ANTES
--      que su membership y, con FORCE, ese INSERT fallaría. Se resuelve
--      sin esperar a CIM-3: con una política de INSERT aparte.
--
--   4. Y, del mismo lote: pipeline_stage y feature_flag tienen
--      workspace_id y no llevaban RLS «a propósito», con el filtro por
--      workspace hecho en JavaScript. Reproducido: A creó la etapa
--      «Cierre con Café Alma» y B la leyó entera; y B insertó
--      feature_flag('outbound_send', workspace_id = A, enabled = true),
--      es decir, encendió el envío de correo de otro workspace.
--
-- Por qué una 0020 y no un cambio en 0019: 0019 está pendiente de
-- aplicar en Supabase, pero ya se entregó y el integrador la tiene en
-- su lista con su checksum. Una migración se corrige con la siguiente,
-- nunca reescribiendo la anterior; así el historial dice qué se creyó
-- cerrado y qué faltaba. Ninguna de las dos está aplicada todavía: el
-- integrador las aplica en orden (make db.migrate) y el resultado es el
-- mismo que si 0019 hubiera nacido así.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · contact: dueño explícito en vez de company_link
-- ---------------------------------------------------------------------
-- El aislamiento pasa a una columna de la propia fila, que solo puede
-- escribir quien la crea. company_link deja de ser el candado (sigue
-- siendo la relación comercial) y `company` puede seguir siendo el
-- catálogo global que es.
ALTER TABLE contact ADD COLUMN owner_workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE;

-- Relleno de las filas que ya existan: no hay columna de autor, así que
-- lo único honesto es el único workspace vinculado a su empresa. Si hay
-- varios —o ninguno— queda NULL, y entonces la fila solo se ve si su
-- fuente es pública. Preferir el silencio a adjudicar PII al workspace
-- equivocado. Hoy no hay ninguna fila en Supabase ni en el seed.
UPDATE contact c
   SET owner_workspace_id = l.workspace_id
  FROM (
    SELECT company_id, min(workspace_id::text)::uuid AS workspace_id, count(*) AS n
      FROM company_link GROUP BY company_id
  ) l
 WHERE l.company_id = c.company_id AND l.n = 1;

-- El dueño lo pone la base, no la pantalla: mismo patrón que
-- `workspaceId: CURRENT_WORKSPACE` en el resto del esquema.
ALTER TABLE contact ALTER COLUMN owner_workspace_id SET DEFAULT current_workspace_id();

CREATE INDEX ON contact (owner_workspace_id);

DROP POLICY contact_ws_isolation ON contact;

-- Lectura: lo público es de todos (es el dato de prospección que
-- comparte la plataforma y no lo escribió nadie en privado); lo demás
-- —user_provided, inbound, enrichment_vendor— solo su dueño.
CREATE POLICY contact_read ON contact FOR SELECT
  USING (
    source IN ('public_website', 'public_profile', 'press')
    OR owner_workspace_id = current_workspace_id()
  );

-- Escritura: solo sobre lo propio (USING, que gobierna UPDATE y DELETE)
-- y solo dejándolo propio (WITH CHECK, que gobierna INSERT y el
-- resultado del UPDATE). Y además, con la empresa vinculada a este
-- workspace: crear un contacto es una acción del CRM, no un apunte
-- suelto sobre una empresa cualquiera del catálogo.
CREATE POLICY contact_write ON contact FOR ALL
  USING (owner_workspace_id = current_workspace_id())
  WITH CHECK (
    owner_workspace_id = current_workspace_id()
    AND EXISTS (
      SELECT 1 FROM company_link l
      WHERE l.company_id = contact.company_id
        AND l.workspace_id = current_workspace_id()
    )
  );

-- La baja es definitiva: opted_out NUNCA vuelve a false. Es la
-- transición que el outreach de VEN/OUT respeta y la migración 0007
-- declara global, así que no la puede deshacer ni el dueño del
-- contacto. Va en un trigger porque una política RLS no ve la fila
-- ANTERIOR: WITH CHECK solo mira cómo queda.
--
-- Quien salta RLS (mc_worker, BYPASSRLS) salta también la guardia: los
-- jobs globales marcan rebotes y bajas de TODOS los workspaces, y es
-- justo el mismo criterio con el que se salta la política.
--
-- Y por eso la baja de un contacto que no es mío es cosa del worker,
-- no de otro workspace: en Postgres, un UPDATE con WHERE tiene que
-- poder LEER la fila, así que abrirle a cualquiera «solo para dar de
-- baja» exigiría abrirle también la lectura, que es justo la PII que
-- esta migración cierra. El outreach registra la baja con asWorker
-- (docs/ventas-outreach.md), no con el workspace de quien la recibió.
CREATE OR REPLACE FUNCTION contact_baja_definitiva() RETURNS trigger AS $$
BEGIN
  IF row_security_active('contact') AND OLD.opted_out AND NOT NEW.opted_out THEN
    RAISE EXCEPTION 'La baja de un contacto es definitiva: opted_out no vuelve a false (contact %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER contact_baja_definitiva BEFORE UPDATE ON contact
  FOR EACH ROW EXECUTE FUNCTION contact_baja_definitiva();

-- ---------------------------------------------------------------------
-- 2 · app_user: el correo de cada persona, solo para quien comparte
--     workspace con ella
-- ---------------------------------------------------------------------
-- Dos políticas en vez de una, que es lo que resuelve el orden del seed:
-- el alta la gobierna quien pueda escribir en la tabla (mc_app entra por
-- el registro, y hasta CIM-3 no hay app.user_id que comprobar), y la
-- lectura ya queda cerrada. Cuando CIM-3 fije app.user_id por
-- transacción, current_user_id() deja de ser NULL y la rama «soy yo»
-- empieza a valer sola, sin tocar esta migración.
--
-- UPDATE y DELETE se quedan sin política a propósito: nadie edita
-- app_user todavía, y una tabla sin política para un comando no admite
-- ese comando. CIM-3 abrirá el «edito mi propio perfil» con
-- id = current_user_id(), que es una línea.
ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_user FORCE ROW LEVEL SECURITY;

CREATE POLICY app_user_read ON app_user FOR SELECT
  USING (
    id = current_user_id()
    OR EXISTS (
      SELECT 1 FROM membership m
      WHERE m.user_id = app_user.id
        AND m.workspace_id = current_workspace_id()
    )
  );

CREATE POLICY app_user_insert ON app_user FOR INSERT WITH CHECK (true);

-- ---------------------------------------------------------------------
-- 3 · pipeline_stage y feature_flag: catálogos con dueño
-- ---------------------------------------------------------------------
-- Las dos tienen workspace_id NULL para la fila global y un uuid para
-- la fila propia de un workspace. Hasta ahora no llevaban RLS y el
-- filtro lo ponía quien llamaba, pasando el workspace como parámetro
-- suelto: exactamente lo que el resto del esquema no permite. Con estas
-- políticas el filtro lo pone la base y las funciones de
-- queries/catalogos.ts dejan de recibir workspaceId.
--
-- Tres políticas por tabla, y cada una responde a un caso real:
--   read    lo global y lo mío. Sin workspace fijado,
--           current_workspace_id() es NULL y quedan solo las globales,
--           que es como se leen los catálogos antes de la sesión.
--   write   solo lo mío: nadie edita ni borra las filas globales, ni
--           las de otro workspace, ni las crea a su nombre.
--   seed    una fila global solo se crea SIN workspace fijado, que es
--           el contexto de una migración o un seed. Desde una
--           transacción de la aplicación (withWorkspace, que es lo
--           único que la web puede abrir) no se puede.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pipeline_stage', 'feature_flag'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_read ON %I FOR SELECT '
      'USING (workspace_id IS NULL OR workspace_id = current_workspace_id())', t, t);
    EXECUTE format(
      'CREATE POLICY %I_write ON %I FOR ALL '
      'USING (workspace_id = current_workspace_id()) '
      'WITH CHECK (workspace_id = current_workspace_id())', t, t);
    EXECUTE format(
      'CREATE POLICY %I_seed ON %I FOR INSERT '
      'WITH CHECK (workspace_id IS NULL AND current_workspace_id() IS NULL)', t, t);
  END LOOP;
END $$;
