-- =====================================================================
-- 0029 · La supresión global la llena solo una baja verificada, borrar
--        un inquilino no publica nada, y una fila global no nombra una
--        privada
--        (CIM-1 / CIM-2, endurecimiento ronda 5)
-- ---------------------------------------------------------------------
-- Por qué 0029 y no 0027: 0027 y 0028 ya están tomadas por la rama de
-- CIM-3 (rasheed/CIM-3-auth-workspaces-r4: sesion_correo_verificado y
-- membership_alta_propia). Un número repetido en dos ramas choca al
-- integrar, y el runner ordena por nombre de archivo.
--
-- 0024–0026 no se han aplicado en ninguna base persistente (Supabase va
-- por 0022_public_profile_access), pero el integrador ya las revisó con
-- su checksum: una migración se corrige con la siguiente.
--
-- Los revisores de la ronda 4 encontraron la misma clase —un camino que
-- rodea el muro sin que la guardia lo vea— en cuatro sitios, y la
-- guardia invertida (src/esquema.ts), ya con los ojos que le faltaban,
-- encontró dos más que nadie había nombrado:
--
--   · Cualquier workspace escribía en la lista de supresión GLOBAL
--     (0026 §3). Bastaba un contacto propio con opted_out = true: el
--     disparador SECURITY DEFINER metía el correo en contact_suppression
--     y desde entonces el contacto de A con ese correo nacía dado de
--     baja, con un motivo inventado («Pidió la baja de la plataforma»).
--     Una agencia saboteaba el outreach de otra con cualquier correo, y
--     no había forma de deshacerlo. Sección 1.
--
--   · Borrar un workspace PUBLICABA su CRM: company.owner_workspace_id
--     era ON DELETE SET NULL, y sin dueño una empresa es catálogo
--     compartido para company_read. La guardia encontró la misma forma
--     en external_post.analysis_id: al borrar el análisis de A —o el
--     workspace entero, que lo borra en cascada— el post que A analizó
--     pasaba a ser dato global del radar. Sección 2.
--
--   · Una fila GLOBAL nombraba una PRIVADA: brand_account_snapshot sin
--     campaña se leía desde cualquier workspace, con el company_id, el
--     handle y los seguidores de una empresa que ese workspace no ve. La
--     guardia encontró la misma forma en contact_read: un contacto del
--     catálogo (sin dueño) de una empresa que 0026 §1 adjudicó a un
--     workspace sigue diciendo a todos que esa empresa existe. Sección 3.
--
-- Nada de esto crea ni altera un rol.
--
-- ÍNDICE
--   1 · contact_suppression: solo la llena el worker, con una baja verificada
--   2 · borrar el padre no convierte una fila privada en global
--   3 · la rama «sin dueño» de una lectura mira también a qué apunta la fila
-- =====================================================================


-- =====================================================================
-- 1 · contact_suppression: solo la llena el worker, con una baja verificada
-- ---------------------------------------------------------------------
-- La promesa de 0007 —si alguien pide no ser contactado, nadie en la
-- plataforma lo vuelve a contactar— tiene que venir de ESA PERSONA, no de
-- lo que un inquilino escribe en su CRM. Un opted_out de contact es la
-- palabra de un workspace sobre una persona; la plataforma no puede
-- comprobarla, así que no puede aplicarla a los demás.
--
-- Lo que sí se puede comprobar, y lo procesa el worker (mc_worker):
--   unsubscribe_link   la persona pulsó el enlace de baja de un correo
--                      que la plataforma le mandó (el token lo firma la
--                      plataforma; quien envía no lo ve)
--   hard_bounce        el servidor de correo dijo que la dirección no
--                      existe
--   complaint          la persona marcó el correo como spam (el aviso
--                      llega del proveedor de envío)
--
-- Así queda:
--   · la baja que marca un workspace se queda en SU contact.opted_out,
--     y es definitiva para él (0020), no para los demás;
--   · desaparece contact_suppression_record: ninguna escritura de mc_app
--     llega a la lista. mc_app sigue sin NINGÚN privilegio sobre ella
--     (0026 §3); la escribe el worker, que tiene los suyos por 0014;
--   · lo que ya había se borra: lo metió el disparador desde un
--     opted_out de CRM, y esa procedencia es justo la que no vale. En
--     ninguna base persistente hay filas (0026 no está aplicada);
--   · contact_suppression_apply se queda: un contacto que nace con un
--     correo suprimido de verdad nace dado de baja en cualquier
--     workspace. Es SECURITY DEFINER porque mc_app no puede leer la
--     lista, y está declarado con su motivo en la guardia
--     (DISPARADORES_DEFINER_DECLARADOS y FUNCIONES_DEFINER_DECLARADAS).
--
-- 0026 §3 decía que quitarle EXECUTE a mc_app sobre las dos funciones
-- dejaba a la guardia «sin nada que declarar». Era el punto ciego:
-- Postgres no comprueba EXECUTE al disparar, así que un disparador
-- definer corre con los privilegios de su dueño para cualquiera que
-- escriba en la tabla. La guardia ahora inventaría toda función
-- SECURITY DEFINER de public y todo disparador que llame a una, se
-- puedan ejecutar o no.
-- =====================================================================
DROP TRIGGER contact_suppression_record ON contact;
DROP FUNCTION contact_suppression_record();

DELETE FROM contact_suppression WHERE reason NOT IN ('unsubscribe_link', 'hard_bounce', 'complaint');

ALTER TABLE contact_suppression DROP CONSTRAINT contact_suppression_reason_check;
ALTER TABLE contact_suppression ADD CONSTRAINT contact_suppression_reason_check
  CHECK (reason IN ('unsubscribe_link', 'hard_bounce', 'complaint'));

COMMENT ON TABLE contact_suppression IS
  'Baja global (0007): correos que nadie en la plataforma vuelve a contactar. Solo la llena el worker con una baja '
  'verificable de la propia persona (enlace de baja, rebote duro o queja), nunca el opted_out que un workspace '
  'escribe en su CRM (0029 §1). Sin workspace a propósito.';

COMMENT ON FUNCTION contact_suppression_apply() IS
  'Disparador BEFORE de contact: un correo suprimido por una baja verificada nace dado de baja en cualquier workspace '
  '(0026 §3, 0029 §1). SECURITY DEFINER porque mc_app no lee contact_suppression; solo lee la lista y cambia NEW.';


-- =====================================================================
-- 2 · Borrar el padre no convierte una fila privada en global
-- ---------------------------------------------------------------------
-- En una tabla cuya lectura dice «sin padre, o con un padre que veo»
-- (company_read, external_post_ws_isolation…), NULL en esa columna
-- quiere decir «es de todos». Una clave ajena ON DELETE SET NULL sobre
-- esa misma columna convierte cada borrado en una publicación.
-- Reproducido por los revisores: C crea «Prospecto secreto de C», se
-- borra el workspace C, y B lee la empresa con owner_workspace_id NULL.
--
-- La guardia ahora cruza cada rama «col IS NULL» de una lectura con la
-- acción de borrado de la clave ajena de esa columna (borradosQuePublican)
-- y encontró dos:
--
--   company.owner_workspace_id → workspace       SET NULL → CASCADE,
--                                                como contact en 0020.
--                                                Si algún día hay que
--                                                conservar una empresa,
--                                                el worker la pasa al
--                                                catálogo a propósito
--                                                ANTES de borrar.
--   external_post.analysis_id  → video_analysis  SET NULL → CASCADE. Un
--                                                post con análisis es el
--                                                que un workspace pidió
--                                                analizar; sin el
--                                                análisis no es dato del
--                                                radar, es un resto.
--
-- Los nombres de las restricciones se buscan en pg_constraint en vez de
-- darlos por supuestos: si una base los tuviera con otro nombre, esto
-- falla con un mensaje en vez de dejar la clave vieja puesta.
-- =====================================================================
DO $$
DECLARE
  r      record;
  nombre text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('company',       'owner_workspace_id', 'workspace'),
      ('external_post', 'analysis_id',        'video_analysis')
    ) AS t(hija, col, padre)
  LOOP
    SELECT k.conname INTO nombre
      FROM pg_constraint k
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
     WHERE k.contype = 'f'
       AND k.conrelid = format('public.%I', r.hija)::regclass
       AND k.confrelid = format('public.%I', r.padre)::regclass
       AND array_length(k.conkey, 1) = 1
       AND a.attname = r.col;
    IF nombre IS NULL THEN
      RAISE EXCEPTION 'No encuentro la clave ajena %.% → %: no puedo cambiarle el borrado', r.hija, r.col, r.padre;
    END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.hija, nombre);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(id) ON DELETE CASCADE',
      r.hija, nombre, r.col, r.padre);
  END LOOP;
END $$;


-- =====================================================================
-- 3 · La rama «sin dueño» de una lectura mira también a qué apunta la fila
-- ---------------------------------------------------------------------
-- «col IS NULL OR <el padre se ve>» abre a todos la fila sin padre. Eso
-- está bien si la fila no nombra NADA privado; pero si tiene otra clave
-- ajena hacia una tabla con RLS, la fila global enseña el id —y lo que
-- la acompañe— de algo que quien lee no puede ver.
--
--   brand_account_snapshot   sin campaña, se leía el company_id, el
--                            handle y los seguidores de cualquier
--                            empresa, también las privadas de otro
--                            (reproducido por los revisores con
--                            «@Café Alma» desde B)
--   contact                  un contacto del catálogo (sin dueño, fuente
--                            pública) de una empresa que 0026 §1
--                            adjudicó a un workspace dice a todos que esa
--                            empresa existe y a quién pertenece su correo
--
-- Las dos ramas pasan a exigir que la empresa se vea. La guardia exige
-- ahora esa correlación en toda rama «IS NULL» aceptada en lectura, para
-- cada otra clave ajena de la tabla hacia una tabla con RLS.
--
-- brand_account_snapshot pasa además de FOR ALL a FOR SELECT: mc_app
-- solo tiene SELECT (0024 §7.2), y una política de escritura que no
-- usa nadie es una que alguien reutiliza sin mirar. Quien sí inserta,
-- además del worker (BYPASSRLS), es el seed de demostración (db/seed/
-- 0003), que corre como el rol que migra y con FORCE pasa por la
-- política: su alta va TO CURRENT_USER, como las de 0025 §4, y no
-- alcanza a mc_app.
-- =====================================================================
DROP POLICY brand_account_snapshot_ws_isolation ON brand_account_snapshot;

CREATE POLICY brand_account_snapshot_read ON brand_account_snapshot FOR SELECT
  USING (
    (campaign_id IS NULL AND EXISTS (SELECT 1 FROM company c WHERE c.id = brand_account_snapshot.company_id))
    OR EXISTS (SELECT 1 FROM campaign p WHERE p.id = brand_account_snapshot.campaign_id)
  );

CREATE POLICY brand_account_snapshot_seed ON brand_account_snapshot FOR INSERT TO CURRENT_USER
  WITH CHECK (
    (campaign_id IS NULL AND EXISTS (SELECT 1 FROM company c WHERE c.id = brand_account_snapshot.company_id))
    OR EXISTS (SELECT 1 FROM campaign p WHERE p.id = brand_account_snapshot.campaign_id)
  );

DROP POLICY contact_read ON contact;

CREATE POLICY contact_read ON contact FOR SELECT
  USING (
    owner_workspace_id = current_workspace_id()
    OR (
      owner_workspace_id IS NULL
      AND source IN ('public_website', 'public_profile', 'press')
      AND EXISTS (SELECT 1 FROM company c WHERE c.id = contact.company_id)
    )
  );
