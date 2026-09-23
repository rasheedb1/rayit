-- =====================================================================
-- 0025 · Referencias visibles, lecturas sin puertas laterales y
--        métricas que la aplicación no reescribe
--        (CIM-1 / CIM-2, endurecimiento ronda 3)
-- ---------------------------------------------------------------------
-- 0024 cerró las tablas sin política y los privilegios de más. Los
-- revisores de la ronda 2 encontraron la misma clase en tres sitios que
-- la guardia todavía no miraba, y los tres se cierran aquí:
--
--   · Una FILA puede nombrar otra que su transacción no ve. La clave
--     ajena no pasa por RLS, así que desde B se insertaba
--     company_link(B, <empresa de A>) y la rama «vinculada» de
--     company_read le abría la empresa de A: nombre, razón social y
--     dueño. Los ids no son secretos —los contactos de fuente pública
--     traen company_id—, y lo mismo pasaba con un deal, una campaña,
--     una factura o un reporte. No es un caso de company: es cualquier
--     clave ajena hacia una tabla con RLS (una etapa ajena en
--     deal.stage_id, un deal ajeno en quote.deal_id). Sección 3.
--
--   · Una política ABIERTA anula las cerradas. Las permisivas se
--     combinan con OR y la guardia daba una tabla por aislada si
--     alguna política aislaba. La guardia ahora evalúa cada política y
--     cada comando (src/politicas.ts), y lo que reporta en el esquema
--     de hoy se cierra en las secciones 1, 4 y 6.
--
--   · «Las métricas se insertan, nunca se actualizan» se aplicaba solo
--     a las de terceros. Sección 5.
--
-- Ninguna de estas secciones necesita crear ni alterar un rol.
--
-- ÍNDICE
--   1 · company: se lee lo mío y el catálogo, sin puertas laterales
--   2 · company: el dominio es único por dueño, no en toda la base
--   3 · una fila no puede apuntar a otra que su transacción no ve
--   4 · las altas «sin workspace fijado» dejan de ser de mc_app
--   5 · métricas append-only y lo que solo escribe el worker
--   6 · contact: lo público de un workspace deja de ser de todos
--   7 · los disparadores de la sección 3, en todas las claves ajenas
-- =====================================================================


-- =====================================================================
-- 1 · company: sin dueño o mía. Nada más.
-- ---------------------------------------------------------------------
-- 0024 §4 abrió cuatro puertas: sin dueño, mía, vinculada por
-- company_link y «con historia» (un deal, una campaña, una factura o un
-- reporte míos). Las dos últimas solo añaden empresas cuyo dueño es
-- OTRO workspace —las sin dueño y las propias ya entran por las dos
-- primeras— y se abrían escribiendo una fila, con un id que se
-- consigue. Reproducido en pglite, como mc_app, desde B:
--
--     SELECT DISTINCT company_id FROM contact;           -- los públicos
--     INSERT INTO company_link (workspace_id, company_id)
--       VALUES (current_workspace_id(), $1);            -- por cada id
--     SELECT name, owner_workspace_id FROM company;
--
-- antes 0 filas, después las seis empresas de A con owner = A. Es justo
-- lo que 0024 §4 dijo cerrar: qué marcas trabaja la competencia no es
-- un catálogo público.
--
-- ¿Y la campaña de B cuya empresa no se ve, que desaparecía del JOIN de
-- listCampaigns? Con la sección 3 no puede existir: B no puede nombrar
-- en campaign.company_id una empresa que no lee. Si B trabaja con la
-- misma marca que A, da de alta SU ficha (la sección 2 se lo permite
-- aunque A tenga el mismo dominio) o usa la del catálogo compartido.
-- =====================================================================
DROP POLICY company_read ON company;

CREATE POLICY company_read ON company FOR SELECT
  USING (owner_workspace_id IS NULL OR owner_workspace_id = current_workspace_id());


-- =====================================================================
-- 2 · company: el dominio es único por dueño
-- ---------------------------------------------------------------------
-- 0007 hizo el dominio único en toda la base, cuando company era un
-- catálogo sin dueño. Con dueño, ese índice es un oráculo: desde B,
--
--     INSERT INTO company (name, domain) VALUES ('x', 'cafealma.co')
--
-- fallaba con «duplicate key … company_domain_idx» y le confirmaba a B
-- que otra agencia tiene esa marca en su CRM, justo lo que company_read
-- oculta. Y además B no podía dar de alta su propia ficha de esa marca.
--
-- Ahora hay dos unicidades: una por dueño y otra dentro del catálogo
-- compartido. B choca solo con lo suyo; la deduplicación del catálogo
-- la sigue haciendo el índice parcial sin dueño, que es donde escribe
-- el enriquecimiento del worker.
-- =====================================================================
DROP INDEX company_domain_idx;

CREATE UNIQUE INDEX company_owner_domain_idx ON company (owner_workspace_id, domain)
  WHERE domain IS NOT NULL AND owner_workspace_id IS NOT NULL;

CREATE UNIQUE INDEX company_catalog_domain_idx ON company (domain)
  WHERE domain IS NOT NULL AND owner_workspace_id IS NULL;


-- =====================================================================
-- 3 · Una fila no puede apuntar a otra que su transacción no ve
-- ---------------------------------------------------------------------
-- La comprobación de una clave ajena la hace Postgres con los
-- privilegios del dueño de la tabla y SIN RLS: para él, «existe» es
-- «existe en la base», no «existe para quien escribe». Así que un
-- workspace puede nombrar en sus filas las filas de otro, siempre que
-- sepa el id. Tres consecuencias medidas o medibles:
--
--   · lectura por la puerta lateral: company_read de 0024 abría la
--     empresa a quien tuviera un vínculo, un deal o una factura con
--     ella (sección 1);
--   · cascada ajena: todas las claves hacia company son ON DELETE
--     CASCADE, así que cuando A borraba su empresa se llevaba por
--     delante los deals y las facturas de B;
--   · bloqueo ajeno: deal.stage_id → pipeline_stage es NO ACTION, así
--     que un deal de B con la etapa privada de A impide que A la borre.
--
-- La regla que lo cierra, para TODAS las claves y no para una lista:
-- una referencia solo puede nombrar una fila que quien escribe puede
-- LEER. La función de abajo lo comprueba con un EXISTS sobre el padre,
-- que corre con los privilegios y la RLS de quien consulta (SECURITY
-- INVOKER, la de siempre), así que el padre decide con su propia
-- política. La sección 7 la engancha a cada clave ajena hacia una
-- tabla con RLS en cada tabla que mc_app puede escribir, en un bucle
-- sobre pg_constraint; la guardia de esquema (src/esquema.ts) exige el
-- disparador en toda clave de ese tipo que exista mañana.
--
-- Por qué un disparador y no un WITH CHECK en cada política: son 110
-- claves en 70 tablas, casi todas con la política genérica de 0010 o
-- 0018 generada en bucle. Reescribir esas políticas una a una es la
-- lista escrita a mano que esta ronda existe para evitar; el disparador
-- es una sola función y la guardia lo puede comprobar.
--
-- Detalles que importan:
--   · El error es 23503 (foreign_key_violation), el mismo que da
--     Postgres cuando el id no existe, y corre ANTES de la comprobación
--     de la clave: «no existe» y «existe pero no es tuyo» dan el MISMO
--     error. Sin eso, el disparador sería un oráculo nuevo.
--   · En un UPDATE solo se comprueba si la columna cambió: una fila
--     vieja no se vuelve imposible de editar por una referencia que ya
--     tenía.
--   · El worker (mc_worker, BYPASSRLS) ve todo, así que para él el
--     disparador siempre pasa. Las migraciones y los seeds (mc_migrator,
--     con FORCE) ven lo que su workspace fijado les deja ver, que es
--     como ya escriben.
-- =====================================================================
CREATE FUNCTION assert_reference_visible() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  col    text := TG_ARGV[0];
  padre  text := TG_ARGV[1];
  pcol   text := TG_ARGV[2];
  ok     boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    EXECUTE format('SELECT ($1).%1$I IS NOT DISTINCT FROM ($2).%1$I', col) INTO ok USING NEW, OLD;
    IF ok THEN
      RETURN NEW;
    END IF;
  END IF;

  EXECUTE format(
    'SELECT ($1).%1$I IS NULL OR EXISTS (SELECT 1 FROM public.%2$I p WHERE p.%3$I = ($1).%1$I)',
    col, padre, pcol)
    INTO ok USING NEW;

  IF NOT ok THEN
    RAISE EXCEPTION 'la fila de % apunta en % a un % que no existe o que esta transacción no puede ver',
        TG_TABLE_NAME, col, padre
      USING ERRCODE = 'foreign_key_violation',
            HINT = 'Una referencia solo puede nombrar una fila que quien escribe puede leer (migración 0025 §3).';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION assert_reference_visible() IS
  'Disparador BEFORE INSERT OR UPDATE OF <col>: la fila solo puede apuntar a una fila del padre que quien escribe puede leer. Argumentos: columna, tabla padre, columna del padre (0025 §3).';


-- =====================================================================
-- 4 · Las altas «sin workspace fijado» dejan de ser de mc_app
-- ---------------------------------------------------------------------
-- 0020 y 0024 escribieron el alta de las filas globales —y el registro
-- de una persona o de un workspace— como «sin workspace fijado»:
--
--   pipeline_stage_seed, feature_flag_seed, company_seed
--       WITH CHECK (… IS NULL AND current_workspace_id() IS NULL)
--   app_user_insert    WITH CHECK (current_workspace_id() IS NULL OR id = current_user_id())
--   workspace_signup   WITH CHECK (current_workspace_id() IS NULL OR id = current_workspace_id())
--
-- con el argumento de que la web no abre transacciones sin workspace.
-- No es una frontera: withCatalogs existe en el objeto que la web
-- recibe (solo lo esconde el tipo de TypeScript), y un error en el
-- código de la aplicación es exactamente el caso contra el que se
-- separan los roles. Desde una transacción sin workspace, mc_app creaba
-- etapas y banderas globales para TODOS los inquilinos, empresas en el
-- catálogo compartido y personas con el correo que quisiera —la
-- primitiva de apropiación de cuenta que 0024 §3 quiso cerrar—.
--
-- Así que las ramas «sin workspace fijado» pasan a ser del rol que corre
-- las migraciones y los seeds (TO CURRENT_USER: mc_migrator en Supabase,
-- mc_migrator_embedded en pglite), que es para quien se escribieron. El
-- worker no las necesita: tiene BYPASSRLS. Y para mc_app quedan las
-- ramas que sí aíslan: su propia fila, su propio workspace.
-- =====================================================================
DROP POLICY pipeline_stage_seed ON pipeline_stage;
CREATE POLICY pipeline_stage_seed ON pipeline_stage FOR INSERT TO CURRENT_USER
  WITH CHECK (workspace_id IS NULL AND current_workspace_id() IS NULL);

DROP POLICY feature_flag_seed ON feature_flag;
CREATE POLICY feature_flag_seed ON feature_flag FOR INSERT TO CURRENT_USER
  WITH CHECK (workspace_id IS NULL AND current_workspace_id() IS NULL);

DROP POLICY company_seed ON company;
CREATE POLICY company_seed ON company FOR INSERT TO CURRENT_USER
  WITH CHECK (owner_workspace_id IS NULL AND current_workspace_id() IS NULL);

-- Registrarse es crear TU fila: la de current_user_id(), que con CIM-3
-- fija el cliente de base a partir de la sesión. Hasta entonces es
-- NULL y desde la web no se crea ninguna persona.
DROP POLICY app_user_insert ON app_user;
CREATE POLICY app_user_insert ON app_user FOR INSERT
  WITH CHECK (id = current_user_id());

-- Crear un workspace es crear el de la transacción. El seed ya fija
-- app.workspace_id antes de insertar su fila; el registro de CIM-3 hará
-- lo mismo con withWorkspace(nuevoId).
--
-- Y nace en el plan gratuito: el plan es facturación, no un campo del
-- alta. Sin esto, quien se registra elegía 'enterprise' en el INSERT
-- (0024 §7.6 ya le quita a mc_app el UPDATE de plan; esto cierra la otra
-- puerta). Los seeds, que corren como el rol que migra, siembran
-- espacios de demostración con otro plan: su alta va aparte, TO
-- CURRENT_USER, como las de arriba.
DROP POLICY workspace_signup ON workspace;
CREATE POLICY workspace_signup ON workspace FOR INSERT
  WITH CHECK (id = current_workspace_id() AND plan = 'free');

DROP POLICY IF EXISTS workspace_seed ON workspace;
CREATE POLICY workspace_seed ON workspace FOR INSERT TO CURRENT_USER
  WITH CHECK (id = current_workspace_id());


-- =====================================================================
-- 5 · Las métricas se insertan, nunca se actualizan; y las escribe
--     quien las mide
-- ---------------------------------------------------------------------
-- 0024 §7 aplicó la regla solo a las métricas de terceros. mc_app
-- conservaba UPDATE y DELETE sobre las propias —y sobre audit_log—, así
-- que dentro de su workspace una pantalla podía reescribir las vistas
-- de un post o borrar su propia bitácora de auditoría. Ni la web ni
-- @mc/db escriben estas tablas (comprobado con grep en esta rama y en
-- main, SQL crudo y Drizzle): las escribe el worker, que tiene sus
-- GRANT desde 0014 y corre como mc_worker.
--
--   solo SELECT        las métricas del worker, sus derivadas y la
--                      bitácora de trabajos
--   SELECT + INSERT    audit_log: la aplicación anota lo que hace, y
--                      nadie lo corrige ni lo borra
--   SELECT + INSERT    post_metric_snapshot: la web AÑADE lecturas al
--                      importar un CSV de Insights (RES-2, integrado
--                      con esta migración todavía sin aplicar). Se
--                      insertan, nunca se corrigen ni se borran; al
--                      conservar INSERT, la sección 7 le engancha
--                      assert_reference_visible en post_id
--   SELECT + INSERT    account_metric_snapshot: CON-10 (en main)
--                      registra desde la web el snapshot público del día
--                      (recordAccountSnapshot). Desde el pulido r7 lo
--                      hace con ON CONFLICT DO NOTHING: la primera
--                      lectura del día queda y la web no la corrige, así
--                      que pierde también UPDATE. El recolector diario la
--                      escribe como mc_worker, quien mide
-- =====================================================================
REVOKE INSERT, UPDATE, DELETE ON
  audience_breakdown,
  post_engagement_curve,
  post_retention_curve,
  post_impression_source,
  post_score,
  creator_baseline,
  campaign_result,
  job_run
FROM mc_app;

REVOKE UPDATE, DELETE ON audit_log FROM mc_app;

REVOKE UPDATE, DELETE ON post_metric_snapshot FROM mc_app;

REVOKE UPDATE, DELETE ON account_metric_snapshot FROM mc_app;


-- =====================================================================
-- 6 · contact: lo que guarda un workspace es suyo, aunque sea público
-- ---------------------------------------------------------------------
-- contact_read (0020) dejaba leer a CUALQUIERA los contactos de fuente
-- pública, fueran de quien fueran. Con company ya cerrada, esa rama es
-- la puerta lateral que queda: un contacto público que guardó A trae
-- company_id y owner_workspace_id = A, y su correo lleva el dominio de
-- la marca. «Qué marcas prospecta A» salía de ahí aunque company no lo
-- dijera. Es la vía por la que los revisores sacaron los ids del
-- guion de la sección 1.
--
-- El dato de prospección compartido sigue existiendo, igual que en
-- company: son las filas SIN dueño, las que llena el enriquecimiento
-- del worker. Lo que un workspace guarda, aunque lo haya sacado de una
-- web pública, es parte de su CRM.
-- =====================================================================
DROP POLICY contact_read ON contact;

CREATE POLICY contact_read ON contact FOR SELECT
  USING (
    owner_workspace_id = current_workspace_id()
    OR (owner_workspace_id IS NULL AND source IN ('public_website', 'public_profile', 'press'))
  );


-- =====================================================================
-- 7 · El disparador de la sección 3, en todas las claves ajenas que
--     mc_app puede escribir
-- ---------------------------------------------------------------------
-- Un bucle sobre pg_constraint, no una lista: toda clave ajena de
-- `public` hacia una tabla con RLS, en una tabla sobre la que mc_app
-- tiene INSERT o UPDATE (medido DESPUÉS de la sección 5, que le quita la
-- escritura de las métricas: ahí el disparador sobraría y le costaría
-- una consulta por fila al worker).
--
-- `UPDATE OF <col>`: solo dispara si la sentencia toca esa columna, y
-- `WHEN (NEW.col IS NOT NULL)`: una referencia vacía no apunta a nada.
-- El nombre lleva la columna para que haya uno por clave y se lea en
-- \d tabla.
--
-- Las claves compuestas no existen hoy en el esquema; si aparece una,
-- el bucle se niega en vez de comprobar solo su primera columna.
-- =====================================================================
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT hija.relname AS hija, a.attname AS col, padre.relname AS padre, pa.attname AS pcol,
           array_length(k.conkey, 1) AS columnas
      FROM pg_constraint k
      JOIN pg_class hija   ON hija.oid = k.conrelid
      JOIN pg_namespace n  ON n.oid = hija.relnamespace
      JOIN pg_class padre  ON padre.oid = k.confrelid
      JOIN pg_attribute a  ON a.attrelid = hija.oid AND a.attnum = k.conkey[1]
      JOIN pg_attribute pa ON pa.attrelid = padre.oid AND pa.attnum = k.confkey[1]
     WHERE n.nspname = 'public'
       AND k.contype = 'f'
       AND padre.relrowsecurity
       AND (has_table_privilege('mc_app', hija.oid, 'INSERT') OR has_table_privilege('mc_app', hija.oid, 'UPDATE'))
     ORDER BY 1, 2
  LOOP
    IF r.columnas > 1 THEN
      RAISE EXCEPTION 'La clave ajena de %.% hacia % es compuesta: assert_reference_visible solo sabe de una columna', r.hija, r.col, r.padre;
    END IF;
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %I ON %I FOR EACH ROW WHEN (NEW.%I IS NOT NULL) '
      'EXECUTE FUNCTION assert_reference_visible(%L, %L, %L)',
      'ref_visible_' || r.col, r.col, r.hija, r.col, r.col, r.padre, r.pcol);
  END LOOP;
END $$;
