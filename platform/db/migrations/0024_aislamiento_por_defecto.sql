-- =====================================================================
-- 0024 · Aislamiento por defecto: se cierra la CLASE, no los casos
--        (CIM-1 / CIM-2, endurecimiento rondas 1 y 2)
-- ---------------------------------------------------------------------
-- Numeración: nació como 0022 en rasheed/endurecer-db y nunca se aplicó
-- en ninguna base persistente. Mientras tanto main aplicó en Supabase
-- 0022_public_profile_access (CON-10) y reservó 0023 para ACC-3, así
-- que esta pasa a 0024: con dos archivos 0022 el runner se niega a
-- correr (DuplicateMigrationNumberError).
--
-- La lectura de `company` de la sección 4 (las cuatro puertas) la
-- sustituye 0025 §1 por «sin dueño o mía»: ver allí por qué.
-- ---------------------------------------------------------------------
-- La fase 1 gastó cinco rondas tapando agujeros de RLS de uno en uno
-- (0017, 0018, 0019, 0020, 0021) y cada ronda encontró los siguientes,
-- siempre del mismo tipo. La causa raíz no era ninguno de ellos: era
-- que la guardia de packages/db/src/esquema.ts preguntaba «¿estas 53
-- tablas que yo enumero tienen RLS?» en vez de preguntárselo a la base.
-- Una tabla nueva sin política pasaba en verde por no estar en ninguna
-- lista, y así se colaron —entre otras— la raíz del inquilino misma.
--
-- Esta migración es la otra mitad del cambio: la guardia invertida
-- (esquema.ts, ahora sobre information_schema y pg_class) exige
-- aislamiento en TODAS las tablas de public salvo una lista corta de
-- excepciones con motivo escrito, y aquí se cierra todo lo que esa
-- guardia reporta. Son nueve tablas con política nueva, una rebaja
-- general de privilegios de mc_app y las diez vistas, que dejaban de
-- correr con los privilegios de su dueño (sección 8).
--
-- Nada de esto se aplica a mc_worker: sigue con BYPASSRLS y con los
-- GRANT de 0014, que es como los jobs globales cruzan workspaces.
--
-- ÍNDICE
--   1 · workspace            la raíz del inquilino, que se podía BORRAR
--   2 · membership           el alta deja de ser cosa de una pantalla
--   3 · app_user             el alta deja de ser WITH CHECK (true)
--   4 · company              se lee como catálogo, se escribe con dueño
--   5 · api_call_log · api_quota_usage   heredan de social_connection
--   6 · las hijas con clave ajena OPCIONAL, que 0018 aplazó
--   7 · privilegios mínimos de mc_app (lo que no se puede tapar con RLS)
--   8 · las vistas dejan de correr con los privilegios de su dueño
-- =====================================================================


-- =====================================================================
-- 1 · workspace: la raíz del inquilino
-- ---------------------------------------------------------------------
-- workspace no tenía RLS y mc_app conservaba SELECT/INSERT/UPDATE/DELETE
-- sobre ella. Desde CUALQUIER transacción de la aplicación se leían, se
-- renombraban y se BORRABAN los workspaces ajenos, y el DELETE arrastra
-- por ON DELETE CASCADE todos sus datos: creadores, conexiones, deals,
-- cotizaciones, facturas. Es el peor de los hallazgos de la fase 1 y el
-- que mejor explica por qué la lista de incluidos no servía: la prueba
-- «toda tabla con workspace_id lleva RLS» solo mira una columna llamada
-- workspace_id, y aquí la clave del inquilino se llama `id`.
--
-- Cuatro comandos, cuatro decisiones:
--   SELECT  solo el workspace de la transacción. Sin workspace fijado,
--           cero filas: no hay directorio de inquilinos.
--   UPDATE  el suyo, y que siga siendo el suyo (WITH CHECK): renombrar
--           un workspace es una pantalla de Cimientos, cambiarle el id
--           a otro no existe.
--   INSERT  el alta. Sin workspace fijado es el registro; con el
--           workspace fijado solo se admite crear ESE mismo id, que es
--           lo que hace el seed (fija app.workspace_id al principio,
--           como hará withWorkspace, y luego inserta su fila con
--           ON CONFLICT DO NOTHING). No da ningún poder nuevo: para
--           escribir un id hay que poder fijarlo, y si ya existe la
--           fila el INSERT choca con la clave primaria.
--   DELETE  ninguna política, y además REVOKE. Borrar un inquilino es
--           una operación del worker —con su copia de seguridad y su
--           orden de cascada—, nunca el efecto secundario de una
--           pantalla. Una tabla sin política para un comando no admite
--           ese comando.
-- =====================================================================
ALTER TABLE workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_read ON workspace FOR SELECT
  USING (id = current_workspace_id());

CREATE POLICY workspace_update ON workspace FOR UPDATE
  USING (id = current_workspace_id())
  WITH CHECK (id = current_workspace_id());

CREATE POLICY workspace_signup ON workspace FOR INSERT
  WITH CHECK (current_workspace_id() IS NULL OR id = current_workspace_id());


-- =====================================================================
-- 2 · membership: separar la lectura de la escritura
-- ---------------------------------------------------------------------
-- `membership_ws_isolation` (0019) es FOR ALL y sin WITH CHECK propio,
-- así que su USING gobernaba también el INSERT. Reproducido: desde el
-- workspace B se colgaba a CUALQUIER user_id dentro de B
--
--     INSERT INTO membership VALUES (current_workspace_id(), USER_A, 'owner')
--
-- sin error, y acto seguido `app_user_read` («comparto workspace con
-- esa persona», 0020) abría su correo y su nombre. Es decir: la PII que
-- 0020 cerró se volvía a abrir escribiendo una fila.
--
-- Se parte en dos políticas con el mismo criterio que 0020 usó para
-- contact:
--   read   mis membresías (por workspace) y las mías (por usuario,
--          que es la rama que CIM-3 encenderá al fijar app.user_id).
--   alta   solo yo, y solo en el workspace de la transacción. Hasta
--          CIM-3 current_user_id() es NULL, así que desde la web no se
--          puede insertar ninguna fila; el seed sí, porque fija
--          app.user_id (ver db/seed/0002).
-- Y no hay política de UPDATE ni de DELETE: cambiar el rol de alguien o
-- echarlo del workspace es del worker hasta que CIM-3 diga quién puede.
--
-- El candado de verdad, sin embargo, no es la política sino el
-- privilegio: el REVOKE de la sección 7 deja a mc_app sin INSERT sobre
-- membership, así que la web no puede escribirla ni aunque una política
-- futura se lo permita por descuido. La política existe para el seed y
-- para mc_migrator.
--
-- ORDEN con CIM-3 (0028_membership_alta_propia): 0028 parte esta misma
-- política con los mismos nombres y le DEVUELVE a mc_app el INSERT que
-- la sección 7.7 le quita. Si 0028 se hubiera aplicado antes (a mano:
-- el runner va en orden y 0028 tiene su propia guardia), este archivo
-- borraría ese GRANT y el primer inicio de sesión de cualquier persona
-- nueva fallaría. Por eso se para aquí con un mensaje claro, y por eso
-- todo lo de esta sección lleva IF EXISTS: el bloque es idempotente.
-- Misma forma que la guardia de 0028: schema_migrations es la tabla del
-- runner (db/lib/aplicar.mjs) y, si no existe, quien aplica no es él.
-- =====================================================================
DO $$
DECLARE
  posterior boolean;
BEGIN
  IF to_regclass('schema_migrations') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = $1)'
    INTO posterior
    USING '0028_membership_alta_propia.sql';
  IF posterior THEN
    RAISE EXCEPTION USING
      MESSAGE = '0024_aislamiento_por_defecto tiene que aplicarse ANTES que 0028_membership_alta_propia, y 0028 ya está aplicada.',
      HINT = 'Su REVOKE INSERT ON membership (§7.7) deshace el GRANT de 0028. Vuelve a aplicar 0028 después, o reconstruye la base en orden.';
  END IF;
END $$;

DROP POLICY IF EXISTS membership_ws_isolation ON membership;

DROP POLICY IF EXISTS membership_read ON membership;
CREATE POLICY membership_read ON membership FOR SELECT
  USING (workspace_id = current_workspace_id() OR user_id = current_user_id());

DROP POLICY IF EXISTS membership_alta ON membership;
CREATE POLICY membership_alta ON membership FOR INSERT
  WITH CHECK (workspace_id = current_workspace_id() AND user_id = current_user_id());


-- =====================================================================
-- 3 · app_user: el alta deja de ser WITH CHECK (true)
-- ---------------------------------------------------------------------
-- 0020 cerró la LECTURA de app_user y dejó el alta abierta a propósito,
-- para no romper el orden del seed. Pero `WITH CHECK (true)` con INSERT
-- concedido significa que desde una transacción cualquiera de la web se
-- crean filas de app_user con el correo que se quiera. Con el enlace
-- mágico de CIM-3, que casará por correo, una fila precreada con el
-- correo de la víctima es una primitiva de apropiación de cuenta: quien
-- la creó controla el id, y el enlace entraría en esa fila.
--
-- Mismo patrón de alta que 0020 ya usa para los catálogos —«sin
-- workspace fijado»— más la rama que el seed necesita: crear MI propia
-- fila. Desde withWorkspace (lo único que la web puede abrir) con
-- current_user_id() NULL, las dos ramas son falsas y no se inserta
-- nada; con CIM-3 fijando app.user_id, lo único que se puede crear es
-- la fila propia, que ya existe.
-- =====================================================================
DROP POLICY app_user_insert ON app_user;

CREATE POLICY app_user_insert ON app_user FOR INSERT
  WITH CHECK (current_workspace_id() IS NULL OR id = current_user_id());


-- =====================================================================
-- 4 · company: sigue siendo catálogo para leer, deja de serlo para escribir
-- ---------------------------------------------------------------------
-- `company` se describía como «el catálogo global de empresas (nombre,
-- dominio, sector) y ahí no hay PII», y por eso se quedó sin RLS con
-- INSERT/UPDATE/DELETE concedidos a mc_app. La mitad del argumento es
-- cierta y la otra mitad no:
--
--   LEER sí es de todos. El directorio de empresas es el dato de
--   prospección que comparte la plataforma —el mismo criterio con el
--   que 0019 dejó públicos los contactos de fuente pública—, y además
--   dos workspaces pueden trabajar con la MISMA marca: si B no pudiera
--   leer la empresa de su propia campaña, su pantalla se quedaría sin
--   el nombre del cliente. La PII no vive aquí: vive en `contact`, que
--   0020 ya cerró por dueño.
--
--   ESCRIBIR no. Desde B se renombraba y se BORRABA una empresa que
--   había dado de alta A, con su nombre legal, su dominio y sus redes;
--   y borrar una empresa arrastra por ON DELETE CASCADE sus contactos
--   —la PII que 0020 acababa de cerrar— y sus vínculos. Un DELETE no
--   necesita leer lo que la política oculta: necesita el privilegio, y
--   lo tenía.
--
-- Así que el dueño se guarda igual que en contact —lo pone la BASE con
-- DEFAULT current_workspace_id(), nunca la pantalla— pero solo gobierna
-- la escritura. owner NULL significa «fila del catálogo compartido»: es
-- lo que escribe una migración, un enriquecimiento o el worker, y nadie
-- la edita desde un workspace.
--
-- Las filas que ya existan se quedan con owner NULL, o sea en el
-- catálogo compartido, que es donde estaban. Es lo honesto: no hay
-- columna de autor, y adjudicarlas por company_link no se puede hacer
-- desde aquí —una migración corre sin workspace fijado y company_link
-- tiene RLS, así que la subconsulta vería cero filas; por eso el
-- relleno equivalente de 0020 para contact era ya un no-op—. Nadie
-- pierde nada: lo viejo sigue sin dueño y lo nuevo nace con uno.
-- =====================================================================
ALTER TABLE company
  ADD COLUMN owner_workspace_id uuid REFERENCES workspace(id) ON DELETE SET NULL;
ALTER TABLE company
  ALTER COLUMN owner_workspace_id SET DEFAULT current_workspace_id();

CREATE INDEX company_owner_workspace_id_idx ON company (owner_workspace_id);

ALTER TABLE company ENABLE ROW LEVEL SECURITY;
ALTER TABLE company FORCE ROW LEVEL SECURITY;

-- Lectura: ni el directorio entero, ni solo lo mío.
--
-- La ronda 1 escribió aquí `USING (true)` con el argumento de que el
-- directorio de empresas es compartido. La mitad es cierta —una fila de
-- company sin dueño es catálogo, y dos workspaces trabajan con la misma
-- marca— pero la consecuencia medida no lo era: desde un workspace
-- cualquiera se enumeraba la lista de prospectos de una agencia, con su
-- razón social, que es exactamente el dato que 0020 cerró en `contact`.
-- «Qué marcas trabaja la competencia» no es un catálogo público.
--
-- Y lo contrario —«solo lo mío y lo que tengo en company_link»— tampoco
-- sirve, y está medido: una campaña cuya empresa no esté vinculada
-- desaparece de su propia pantalla, porque listCampaigns hace
-- `JOIN company` y el JOIN interno tira la fila. El inquilino perdería
-- sus propios datos por una política pensada contra el vecino.
--
-- Así que la regla es «la empresa con la que TRABAJO», y trabajar con
-- una empresa tiene cuatro formas en este esquema:
--   sin dueño     catálogo compartido: lo llena una migración, un
--                 enriquecimiento o el worker, y no lo escribió nadie
--                 en privado
--   mía           la dio de alta este workspace
--   vinculada     está en mi company_link, que es LA tabla que 0007
--                 creó para decir «esta empresa es de este workspace»
--   con historia  tengo un deal, una campaña, una factura o un reporte
--                 con ella
--
-- Las cuatro tablas de la subconsulta llevan RLS por workspace_id desde
-- 0010, así que cada EXISTS solo ve MIS filas; el
-- `workspace_id = current_workspace_id()` explícito es cinturón y
-- tirantes, y deja la política legible sin ir a buscar la del padre.
--
-- Las demás tablas con company_id NO abren la empresa, y eso es
-- deliberado: `contact` se lee también por fuente pública, así que ver
-- un contacto no puede implicar ver su empresa —sería volver a abrir lo
-- que 0020 cerró—, y signal, activity, outbound_touch y
-- brand_account_snapshot cuelgan siempre de una de las de arriba. (Las
-- dos de reportes salieron de esa misma prueba: nadie las había
-- mencionado, y un reporte nombra al cliente igual que una factura.)
--
-- packages/db/test/rls.test.ts recorre pg_constraint y exige
-- que cada tabla que apunte a company esté nombrada aquí o declarada
-- allí con su motivo: si mañana alguien añade una y la une con JOIN a
-- company, la prueba lo dice en vez de que la fila desaparezca.
CREATE POLICY company_read ON company FOR SELECT
  USING (
    owner_workspace_id IS NULL
    OR owner_workspace_id = current_workspace_id()
    OR EXISTS (
      SELECT 1 FROM company_link l
      WHERE l.company_id = company.id AND l.workspace_id = current_workspace_id()
    )
    OR EXISTS (
      SELECT 1 FROM deal d
      WHERE d.company_id = company.id AND d.workspace_id = current_workspace_id()
    )
    OR EXISTS (
      SELECT 1 FROM campaign c
      WHERE c.company_id = company.id AND c.workspace_id = current_workspace_id()
    )
    OR EXISTS (
      SELECT 1 FROM invoice i
      WHERE i.company_id = company.id AND i.workspace_id = current_workspace_id()
    )
    OR EXISTS (
      SELECT 1 FROM report r
      WHERE r.company_id = company.id AND r.workspace_id = current_workspace_id()
    )
    OR EXISTS (
      SELECT 1 FROM report_schedule rs
      WHERE rs.company_id = company.id AND rs.workspace_id = current_workspace_id()
    )
  );

-- Escritura: solo sobre lo propio (USING gobierna UPDATE y DELETE) y
-- solo dejándolo propio (WITH CHECK gobierna INSERT y cómo queda el
-- UPDATE). Nadie renombra ni borra una empresa ajena, ni la del
-- catálogo compartido, ni crea una a nombre de otro workspace.
CREATE POLICY company_write ON company FOR ALL
  USING (owner_workspace_id = current_workspace_id())
  WITH CHECK (owner_workspace_id = current_workspace_id());

-- Y el alta del catálogo compartido, que es el mismo patrón que 0020
-- usa para pipeline_stage y feature_flag: una fila sin dueño solo se
-- crea SIN workspace fijado, es decir, desde una migración, un seed o
-- el worker. Desde withWorkspace —lo único que la web puede abrir— no.
CREATE POLICY company_seed ON company FOR INSERT
  WITH CHECK (owner_workspace_id IS NULL AND current_workspace_id() IS NULL);


-- =====================================================================
-- 5 · api_call_log y api_quota_usage: heredan de social_connection
-- ---------------------------------------------------------------------
-- Las dos cuelgan de social_connection, que sí está aislada desde 0010,
-- pero 0018 las dejó fuera porque su connection_id admite NULL (hay
-- llamadas y cuotas de la APLICACIÓN, no de una conexión). Sin política,
-- desde el workspace B se leían los endpoints, los códigos y los
-- MENSAJES DE ERROR de las llamadas de A —que incluyen handles, ids
-- externos y motivos de revocación— y su consumo diario.
--
-- api_call_log es una bitácora: se escribe y no se toca más.
--   read    solo las llamadas de mis conexiones. Las filas con
--           connection_id NULL son de la aplicación y no se atribuyen a
--           ningún inquilino: las ve el worker, no una pantalla.
--   insert  las mías, y también las de connection_id NULL, porque el
--           camino de OAuth que FALLA registra sus llamadas antes de
--           que exista la conexión (apps/web/.../oauth-handlers.ts).
--   sin UPDATE ni DELETE, y con el privilegio revocado en la sección 7.
--
-- api_quota_usage la persiste el worker (PostgresQuotaUsageStore) y la
-- web no la escribe nunca: se queda en solo lectura, tolerando la fila
-- de cuota global (connection_id NULL), que es un presupuesto de la
-- app —no un dato de inquilino— y el mismo para todos.
-- =====================================================================
ALTER TABLE api_call_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_call_log FORCE ROW LEVEL SECURITY;

CREATE POLICY api_call_log_read ON api_call_log FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM social_connection c WHERE c.id = api_call_log.connection_id
  ));

CREATE POLICY api_call_log_insert ON api_call_log FOR INSERT
  WITH CHECK (
    connection_id IS NULL
    OR EXISTS (SELECT 1 FROM social_connection c WHERE c.id = api_call_log.connection_id)
  );

ALTER TABLE api_quota_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_quota_usage FORCE ROW LEVEL SECURITY;

CREATE POLICY api_quota_usage_read ON api_quota_usage FOR SELECT
  USING (
    connection_id IS NULL
    OR EXISTS (SELECT 1 FROM social_connection c WHERE c.id = api_quota_usage.connection_id)
  );


-- =====================================================================
-- 6 · Las hijas con clave ajena OPCIONAL, que 0018 aplazó
-- ---------------------------------------------------------------------
-- 0018 cerró las hijas cuya FK al padre es NOT NULL y dejó las demás
-- «a decisión del dueño del módulo», con un test.todo que las enseñaba
-- en cada corrida. Un año de test.todo es una tabla abierta, así que se
-- cierran con la regla general, que además es la que la guardia
-- invertida exige: una FK hacia una tabla aislada, aunque admita NULL,
-- obliga a llevar política.
--
-- La forma es la de 0018 con una rama más: `fk IS NULL OR EXISTS(padre)`.
-- La fila sin padre es dato global de plataforma y se ve desde
-- cualquier workspace; la que tiene padre se ve solo si el padre se ve,
-- y de eso decide la RLS del padre porque la subconsulta corre con los
-- privilegios de quien consulta.
--
--   brand_account_snapshot → campaign        seguidores de la marca; sin
--                                            campaña es dato público
--   trait_lift             → creator_profile  scope 'niche' no tiene
--                                            creadora: es del nicho
--   external_post          → video_analysis   el radar ve posts ajenos;
--                                            con análisis, es MÍO
--   external_post_score    → external_post    (FK NOT NULL, hereda)
--   external_post_snapshot → external_post    (FK NOT NULL, hereda)
--
-- Las tres primeras las escribe el worker, no una pantalla: la sección 7
-- le quita a mc_app la escritura, así que aquí basta la lectura.
-- =====================================================================
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('brand_account_snapshot', 'campaign_id',     'campaign'),
      ('trait_lift',             'creator_id',      'creator_profile'),
      ('external_post',          'analysis_id',     'video_analysis'),
      ('external_post_score',    'external_post_id', 'external_post'),
      ('external_post_snapshot', 'external_post_id', 'external_post')
    ) AS t(child, fk, parent)
  LOOP
    -- Mismas guardias que 0018: mejor fallar aquí que dejar una
    -- política que no aísla porque la columna cambió de nombre.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = r.child AND column_name = r.fk
    ) THEN
      RAISE EXCEPTION 'La columna %.% no existe: no puede heredar la RLS de %', r.child, r.fk, r.parent;
    END IF;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.child);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.child);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (%I IS NULL OR EXISTS (SELECT 1 FROM %I p WHERE p.id = %I.%I))',
      r.child || '_ws_isolation', r.child, r.fk, r.parent, r.child, r.fk);
  END LOOP;
END $$;

-- Las dos hijas de external_post consultan a su padre por fila, así que
-- su FK tiene que estar indexada: lo está desde 0004, y por eso aquí no
-- se crea ningún índice. external_post_score tiene external_post_id como
-- PRIMARY KEY, y external_post_snapshot lo lleva en
-- external_post_snapshot_external_post_id_captured_at_idx. La ronda 1
-- añadió aquí un CREATE INDEX IF NOT EXISTS con OTRO nombre y la misma
-- definición: `IF NOT EXISTS` compara nombres, no definiciones, así que
-- creaba un duplicado exacto sobre la tabla que más escribe el radar.


-- =====================================================================
-- 7 · Privilegios mínimos de mc_app
-- ---------------------------------------------------------------------
-- RLS no lo cierra todo. Una tabla sin política no está protegida por
-- RLS: está protegida por el privilegio, y hasta ahora mc_app tenía
-- SELECT/INSERT/UPDATE/DELETE sobre las 89 tablas del esquema, incluidas
-- las que nunca escribe y una que ni siquiera debería leer.
--
-- Aquí se rebaja tabla por tabla, con el motivo escrito. Lo que NO se
-- toca: las tablas de inquilino, donde el privilegio es correcto y lo
-- que filtra es la política.
--
-- (mc_migrator no puede crear ni alterar roles, así que esto es todo lo
-- que se puede hacer desde una migración. No hace falta más: los GRANT
-- sobre tablas sí son suyos, porque es el dueño de las tablas.)
-- =====================================================================

-- 7.1 · Catálogos globales: los llena una migración o el worker, y la
--       aplicación solo los lee. Sin RLS —no hay nada que aislar, son
--       los mismos para todos— pero tampoco escritura: hoy cualquier
--       transacción de la web podía cambiar los límites de TikTok,
--       renombrar un nicho, mover un CPM de referencia, apagar un job o
--       reescribir una regla del preflight, para TODOS los workspaces.
REVOKE INSERT, UPDATE, DELETE ON
  platform,
  niche,
  niche_cpm_benchmark,
  signal_source,
  job_definition,
  preflight_rule,
  benchmark,
  blocked_claim,
  metric_requirement
FROM mc_app;

-- 7.2 · Radar y métricas de terceros: son observaciones, las calcula y
--       las escribe el worker. Las métricas se insertan, nunca se
--       actualizan; desde una pantalla, ni lo uno ni lo otro.
REVOKE INSERT, UPDATE, DELETE ON
  external_account_baseline,
  external_post,
  external_post_score,
  external_post_snapshot,
  trend_signal,
  trait_lift,
  brand_account_snapshot
FROM mc_app;

-- 7.3 · api_quota_usage la persiste el worker; api_call_log es una
--       bitácora que la web sí escribe (el camino de OAuth) pero que
--       nadie corrige ni borra.
REVOKE INSERT, UPDATE, DELETE ON api_quota_usage FROM mc_app;
REVOKE UPDATE, DELETE ON api_call_log FROM mc_app;

-- 7.4 · webhook_event guarda el cuerpo y las CABECERAS crudas de lo que
--       mandan las plataformas —firmas, tokens de verificación, datos
--       de otros inquilinos en el mismo lote—. No lo lee ninguna
--       pantalla y no debería poder: es del worker y de nadie más.
REVOKE ALL PRIVILEGES ON webhook_event FROM mc_app;

-- 7.5 · schema_migrations es la contabilidad del runner. La guardia de
--       esquema la LEE en cada arranque (assertSchemaUpToDate), así que
--       el SELECT se queda; escribirla desde la aplicación sería
--       hacerle creer a la base que se aplicó algo que no se aplicó.
--
--       Va con guardia porque esa tabla no la crea ninguna migración,
--       sino el runner (db/lib/aplicar.mjs), y hay un camino que aplica
--       los archivos sin él: db/seed/verify/run.mjs, que solo quiere
--       comprobar los seeds. Allí la tabla no existe y no hay nada que
--       revocar.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM mc_app;
  END IF;
END $$;

-- 7.6 · Borrar un inquilino no es una pantalla (ver sección 1). Sin
--       política de DELETE ya no se podría, pero el privilegio sobra
--       igual y dejarlo invita a escribir la política algún día.
REVOKE DELETE ON workspace FROM mc_app;

-- 7.7 · membership: el alta y la baja de personas las hace el worker
--       (y el seed, como mc_migrator) hasta que CIM-3 diga quién puede
--       invitar. Desde la web, membership es de solo lectura.
REVOKE INSERT, UPDATE, DELETE ON membership FROM mc_app;

-- 7.8 · app_user: nadie borra a una persona desde una pantalla. El
--       INSERT se queda para el registro de CIM-3 (y lo acota la
--       política de la sección 3); el UPDATE, para que cada quien
--       edite SU fila (política de 0021).
REVOKE DELETE ON app_user FROM mc_app;


-- =====================================================================
-- 8 · Las vistas dejan de correr con los privilegios de su dueño
-- ---------------------------------------------------------------------
-- La sección 7 levanta un muro de privilegios, y una vista lo rodea.
--
-- En Postgres una vista es SECURITY DEFINER por omisión: lee sus tablas
-- base con los privilegios de SU DUEÑO, que aquí es mc_migrator, el rol
-- que corre las migraciones y puede todo. Las diez vistas de `public`
-- (0007, 0010, 0011) nacieron así —reloptions NULL, comprobado en
-- pglite y en la Supabase real— y mc_app tiene los cuatro privilegios
-- sobre todas.
--
-- Reproducido: como mc_migrator, `CREATE VIEW v_niche AS SELECT * FROM
-- niche; GRANT ALL ON v_niche TO mc_app;` y luego, desde withWorkspace
-- como mc_app, `UPDATE v_niche SET slug = slug` toca las 12 filas de
-- `niche`, la tabla que 7.1 acaba de dejar de solo lectura. Lo mismo
-- valía para leer webhook_event, que 7.4 le quita entero.
--
-- Hoy ninguna vista apunta a un catálogo revocado, así que no hay fuga
-- abierta; lo que hay es la MISMA clase que esta migración vino a
-- cerrar —un objeto que nadie declaró pasa en verde— movida de las
-- tablas a las vistas. Con security_invoker la vista lee y escribe con
-- los privilegios y la RLS de quien consulta, así que el muro de la
-- sección 7 vale también por dentro de una vista.
--
-- Va como bucle sobre pg_class y no como lista de diez nombres a
-- propósito: es la forma de la guardia invertida. Una vista que alguien
-- añada en una migración posterior sí tendrá que declararse —la guardia
-- de packages/db/src/esquema.ts la exige con security_invoker o con su
-- motivo escrito—, pero ninguna de las que ya existen se queda fuera
-- por no estar en un renglón.
--
-- mc_app no pierde nada: ya tiene SELECT sobre todas las tablas base
-- que las diez leen. Lo único que cambia es de quién son los
-- privilegios con que se leen.
-- =====================================================================
DO $$
DECLARE
  v record;
BEGIN
  FOR v IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'v'
     ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER VIEW %I SET (security_invoker = on)', v.relname);
  END LOOP;
END $$;
