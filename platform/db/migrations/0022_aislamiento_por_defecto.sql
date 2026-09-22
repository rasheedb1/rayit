-- =====================================================================
-- 0022 · Aislamiento por defecto: se cierra la CLASE, no los casos
--        (CIM-1 / CIM-2, endurecimiento ronda 1)
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
-- guardia reporta. Son nueve tablas con política nueva y una rebaja
-- general de privilegios de mc_app.
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
-- =====================================================================
DROP POLICY membership_ws_isolation ON membership;

CREATE POLICY membership_read ON membership FOR SELECT
  USING (workspace_id = current_workspace_id() OR user_id = current_user_id());

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

-- Lectura: el directorio es de todos, a propósito y por escrito.
CREATE POLICY company_read ON company FOR SELECT USING (true);

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

-- external_post_score y external_post_snapshot consultan a su padre por
-- fila: el índice por la FK deja de ser opcional.
CREATE INDEX IF NOT EXISTS external_post_snapshot_post_id_idx
  ON external_post_snapshot (external_post_id, captured_at DESC);


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
