-- =====================================================================
-- 0026 · Dueños de lo que ya existe, unicidad por inquilino y
--        secuencias que no cuentan lo ajeno
--        (CIM-1 / CIM-2, endurecimiento ronda 4)
-- ---------------------------------------------------------------------
-- 0024 y 0025 no se han aplicado en ninguna base persistente, pero ya
-- las revisó el integrador con su checksum: una migración se corrige con
-- la siguiente, no reescribiéndola. Las tres se aplican juntas y en
-- orden (make db.migrate), así que el resultado es el mismo que si 0024
-- hubiera nacido con esto.
--
-- Los revisores de la ronda 3 encontraron la misma clase en cuatro
-- sitios, y aquí se cierran los cuatro:
--
--   · Las empresas que YA existen se quedaban sin dueño. 0024 §4 dijo
--     que adjudicarlas por company_link «no se puede hacer desde una
--     migración», y era falso: el rol que migra es dueño de las tablas y
--     puede quitarles FORCE dentro de la transacción. Con 0024 + 0025
--     tal cual, las 11 empresas de Supabase —todas en el company_link
--     del único workspace— pasaban al catálogo compartido: cualquier
--     workspace nuevo leía qué marcas trabaja la agencia, y la agencia
--     ya no podía editar ninguna. Sección 1.
--
--   · Un índice ÚNICO global sobre una tabla con dueño es un oráculo.
--     0025 §2 lo cerró para company.domain y dejó abierto contact.email
--     y video_asset.content_hash: desde B, guardar un contacto con el
--     correo de un contacto de A fallaba con «duplicate key
--     contact_email_idx», y B aprendía que otra agencia tiene a esa
--     persona en su CRM —la PII que 0020 cerró— y además no podía
--     guardar el suyo. Sección 2. La guardia ahora recorre todos los
--     índices únicos (src/esquema.ts, unicosSinInquilino).
--
--   · Con el correo único por dueño, la baja deja de ser global por
--     construcción: pasa a una lista de supresión. Sección 3.
--
--   · mc_app tenía SELECT sobre todas las secuencias: desde B,
--     `SELECT last_value FROM audit_log_id_seq` decía cuántas entradas de
--     auditoría o cuántas llamadas a las API tiene la plataforma entera.
--     Sección 4.
--
-- Nada de esto crea ni altera un rol.
--
-- ÍNDICE
--   1 · company: cada empresa que ya existe, a su workspace
--   2 · la unicidad es por inquilino (contact.email, video_asset.content_hash,
--       pipeline_stage.id)
--   3 · la baja global, en una lista de supresión
--   4 · las secuencias no se leen
-- =====================================================================


-- =====================================================================
-- 1 · company: cada empresa que ya existe, a su workspace
-- ---------------------------------------------------------------------
-- Quién «trabaja» con una empresa no hay que adivinarlo: lo dicen las
-- filas que la nombran. Toda tabla con una clave ajena hacia company y
-- una columna de inquilino (workspace_id u owner_workspace_id) es un
-- voto: company_link, deal, campaign, invoice, quote, report,
-- report_schedule, signal, activity, outbound_touch y contact. Se
-- recorren en un bucle sobre pg_constraint, no en una lista, por la
-- misma razón que 0025 §7.
--
-- Las reglas, por empresa SIN dueño:
--   · nadie la nombra        se queda sin dueño: es catálogo compartido
--                            (lo escribió una migración o el worker)
--   · la nombra UN workspace pasa a ser suya. Es el caso de las 11 de
--                            Supabase, todas de Laura.
--   · la nombran VARIOS      es la misma marca en dos CRM. Adjudicarla a
--                            uno le quitaría al otro su propia ficha, y
--                            dejarla sin dueño la publicaría para todos.
--                            Así que cada workspace se queda con SU
--                            copia —la original para el primero, por id,
--                            para que la migración sea determinista; una
--                            copia idéntica para los demás— y sus filas
--                            pasan a apuntar a ella. Es el modelo que
--                            0025 §1 fijó para lo nuevo: si B trabaja con
--                            la marca de A, tiene su propia ficha. Si un
--                            workspace ya tuviera una ficha propia con el
--                            mismo dominio (0024 aplicada y usada sin
--                            esta), sus filas pasan a esa en vez de
--                            crear otra.
--
-- Las filas que nombran a la empresa SIN columna de inquilino
-- (brand_account_snapshot, del worker) y los contactos del catálogo
-- (sin dueño) se quedan con la original: no son de nadie.
--
-- Cómo, sin fingir que la RLS no existe: la migración corre sin
-- workspace fijado, y con FORCE las políticas le esconden todo. El rol
-- que migra es dueño de las tablas, así que les quita FORCE solo
-- mientras dura este bloque y se lo vuelve a poner —a las mismas, y
-- solo a las que lo tenían— antes de salir. Todo es una transacción:
-- si algo falla, no queda ninguna tabla sin FORCE.
-- =====================================================================
DO $$
DECLARE
  votos        text := '';
  fk           record;
  e            record;
  destino      uuid;
  original_tomada boolean;
  dominio      text;
  sin_force    text[] := ARRAY[]::text[];
  t            text;
BEGIN
  -- Las tablas que el bloque lee o escribe enteras: company, workspace
  -- (el disparador de 0025 §3 comprueba que el dueño nuevo se vea) y
  -- cada tabla que vota.
  FOR t IN
    SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relforcerowsecurity
       AND (c.relname IN ('company', 'workspace') OR c.oid IN (
             SELECT k.conrelid FROM pg_constraint k
              WHERE k.contype = 'f' AND k.confrelid = 'public.company'::regclass))
  LOOP
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    sin_force := sin_force || t;
  END LOOP;

  -- Los votos: (empresa, workspace) por cada fila que la nombra.
  FOR fk IN
    SELECT hija.relname AS hija, a.attname AS col, ten.attname AS tenant
      FROM pg_constraint k
      JOIN pg_class hija     ON hija.oid = k.conrelid
      JOIN pg_namespace n    ON n.oid = hija.relnamespace
      JOIN pg_attribute a    ON a.attrelid = hija.oid AND a.attnum = k.conkey[1]
      JOIN pg_attribute ten  ON ten.attrelid = hija.oid AND NOT ten.attisdropped
                            AND ten.attname IN ('workspace_id', 'owner_workspace_id')
     WHERE n.nspname = 'public' AND k.contype = 'f'
       AND k.confrelid = 'public.company'::regclass
       AND array_length(k.conkey, 1) = 1
     ORDER BY 1
  LOOP
    votos := votos || CASE WHEN votos = '' THEN '' ELSE ' UNION ' END || format(
      'SELECT %1$I AS company_id, %2$I AS workspace_id FROM %3$I WHERE %1$I IS NOT NULL AND %2$I IS NOT NULL',
      fk.col, fk.tenant, fk.hija);
  END LOOP;

  IF votos <> '' THEN
    FOR e IN EXECUTE format(
      'SELECT v.company_id, array_agg(DISTINCT v.workspace_id ORDER BY v.workspace_id) AS ws
         FROM (%s) v JOIN company co ON co.id = v.company_id
        WHERE co.owner_workspace_id IS NULL
        GROUP BY v.company_id', votos)
    LOOP
      SELECT domain::text INTO dominio FROM company WHERE id = e.company_id;
      original_tomada := false;

      FOR i IN 1 .. array_length(e.ws, 1) LOOP
        destino := NULL;
        IF dominio IS NOT NULL THEN
          SELECT id INTO destino FROM company
           WHERE owner_workspace_id = e.ws[i] AND domain = dominio::citext;
        END IF;

        IF destino IS NULL AND NOT original_tomada THEN
          UPDATE company SET owner_workspace_id = e.ws[i] WHERE id = e.company_id;
          original_tomada := true;
          CONTINUE; -- sus filas ya apuntan a la original
        END IF;

        IF destino IS NULL THEN
          destino := gen_random_uuid();
          INSERT INTO company
          SELECT (jsonb_populate_record(co, jsonb_build_object('id', destino, 'owner_workspace_id', e.ws[i]))).*
            FROM company co WHERE co.id = e.company_id;
        END IF;

        -- Las filas de ESE workspace pasan a su ficha.
        FOR fk IN
          SELECT hija.relname AS hija, a.attname AS col, ten.attname AS tenant
            FROM pg_constraint k
            JOIN pg_class hija     ON hija.oid = k.conrelid
            JOIN pg_namespace n    ON n.oid = hija.relnamespace
            JOIN pg_attribute a    ON a.attrelid = hija.oid AND a.attnum = k.conkey[1]
            JOIN pg_attribute ten  ON ten.attrelid = hija.oid AND NOT ten.attisdropped
                                  AND ten.attname IN ('workspace_id', 'owner_workspace_id')
           WHERE n.nspname = 'public' AND k.contype = 'f'
             AND k.confrelid = 'public.company'::regclass
             AND array_length(k.conkey, 1) = 1
        LOOP
          EXECUTE format('UPDATE %1$I SET %2$I = $1 WHERE %2$I = $2 AND %3$I = $3', fk.hija, fk.col, fk.tenant)
            USING destino, e.company_id, e.ws[i];
        END LOOP;
      END LOOP;
    END LOOP;
  END IF;

  -- Los contactos privados sin dueño: 0020 intentó el mismo relleno con
  -- company_link bajo FORCE y vio cero filas, así que los que existieran
  -- antes de 0020 siguen sin dueño y, desde 0025 §6, no los ve NADIE
  -- —ni quien los guardó—. Pasan al dueño de su empresa. Los de fuente
  -- pública sin dueño son el catálogo compartido y se quedan así.
  UPDATE contact ct
     SET owner_workspace_id = co.owner_workspace_id
    FROM company co
   WHERE co.id = ct.company_id
     AND ct.owner_workspace_id IS NULL
     AND co.owner_workspace_id IS NOT NULL
     AND ct.source NOT IN ('public_website', 'public_profile', 'press');

  FOREACH t IN ARRAY sin_force LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;


-- =====================================================================
-- 2 · La unicidad es por inquilino
-- ---------------------------------------------------------------------
-- Un índice único se comprueba contra TODAS las filas de la tabla, las
-- vea quien escribe o no. Sobre una tabla con dueño, un único global es
-- un oráculo («ese valor ya lo tiene alguien») y un bloqueo (B no puede
-- guardar lo suyo porque A lo guardó antes). Mismo arreglo que 0025 §2
-- para company.domain: una unicidad por dueño y otra, parcial, dentro
-- de las filas sin dueño.
--
-- contact.email      reproducido por los revisores: desde un workspace
--                    X, guardar 'andrea.salazar@hogarlindo.co' daba
--                    23505 y uno que nadie tiene pasaba.
-- video_asset        content_hash (sha256 del archivo): B aprendía si A
--   .content_hash    había subido el mismo video, y no podía registrar
--                    el suyo. Las filas sin workspace (del worker) se
--                    siguen deduplicando entre sí.
--
-- Lo que la guardia deja como único GLOBAL a propósito, con su motivo,
-- está en UNICOS_GLOBALES_DECLARADOS (src/esquema.ts): el correo de una
-- persona, el slug de un workspace y los enlaces públicos.
-- =====================================================================
DROP INDEX contact_email_idx;

CREATE UNIQUE INDEX contact_owner_email_idx ON contact (owner_workspace_id, email)
  WHERE email IS NOT NULL AND owner_workspace_id IS NOT NULL;

CREATE UNIQUE INDEX contact_catalog_email_idx ON contact (email)
  WHERE email IS NOT NULL AND owner_workspace_id IS NULL;

-- El índice de 0007 servía también para buscar por correo, que es lo que
-- hará el outreach al procesar un rebote o una baja. El de dueño empieza
-- por owner_workspace_id y no sirve para eso.
CREATE INDEX contact_email_lookup_idx ON contact (email) WHERE email IS NOT NULL;

DROP INDEX video_asset_content_hash_idx;

CREATE UNIQUE INDEX video_asset_ws_content_hash_idx ON video_asset (workspace_id, content_hash)
  WHERE content_hash IS NOT NULL AND deleted_at IS NULL AND workspace_id IS NOT NULL;

CREATE UNIQUE INDEX video_asset_global_content_hash_idx ON video_asset (content_hash)
  WHERE content_hash IS NOT NULL AND deleted_at IS NULL AND workspace_id IS NULL;

-- pipeline_stage.id es text y es la clave primaria —deal.stage_id la
-- referencia—, así que no puede ser por inquilino. Y es un nombre:
-- 'nuevo', 'propuesta'… Una etapa PRIVADA con id 'cierre-cafe-alma'
-- le dice a quien intente el mismo id que otra agencia tiene esa etapa
-- (la destapó la guardia de índices únicos: nadie la había nombrado). Lo
-- que sí se puede es que el id de una etapa privada no lleve dato: la
-- base lo genera al azar y rechaza cualquier otro. Las globales siguen
-- con su nombre legible, que es público. Hoy no hay ninguna privada ni
-- en Supabase ni en el seed.
ALTER TABLE pipeline_stage ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
ALTER TABLE pipeline_stage ADD CONSTRAINT pipeline_stage_private_id_random
  CHECK (workspace_id IS NULL OR id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');


-- =====================================================================
-- 3 · La baja global, en una lista de supresión
-- ---------------------------------------------------------------------
-- 0007 declaró la baja GLOBAL («si alguien pide no ser contactado,
-- ningún creador de la plataforma lo vuelve a contactar») y lo cumplía
-- por construcción: con el correo único en toda la base había UNA fila
-- por persona y su opted_out valía para todos. Con el correo único por
-- dueño cada workspace tiene su fila, y la baja que registra uno no la
-- vería otro.
--
-- La lista de supresión es esa promesa separada del CRM:
--   · guarda solo el correo y por qué (nada del workspace que la
--     registró: eso sí sería un oráculo);
--   · se llena sola: cuando un contacto pasa a opted_out, su correo
--     entra, lo haga su dueño desde la web o el worker;
--   · y se aplica sola: un contacto que nace —o cambia de correo— con
--     un correo suprimido nace dado de baja, en cualquier workspace.
--
-- Lo que los disparadores NO hacen: marcar la fila que OTRO workspace ya
-- tenía con ese correo antes de la baja. Corren con los privilegios de
-- su dueño, que con FORCE también ve solo lo del workspace fijado, y
-- abrirles la RLS de contact sería abrir la PII. Esa fila la marca el
-- worker (BYPASSRLS), y el despachador del outreach (VEN-10) consulta
-- contact_suppression antes de enviar nada: la lista es la fuente de
-- verdad, opted_out su reflejo en cada CRM.
--
-- Qué aprende B de esto: que esa persona pidió no ser contactada por la
-- plataforma. Es exactamente lo que la baja global tiene que decirle
-- para que no la contacte; no aprende quién la tiene en su CRM.
--
-- La tabla no es de ningún inquilino, así que no lleva RLS y mc_app no
-- tiene NINGÚN privilegio sobre ella (como webhook_event): la escriben
-- y la leen los dos disparadores, que corren con los privilegios de su
-- dueño (SECURITY DEFINER), y el worker. A mc_app se le quita además
-- EXECUTE sobre las dos funciones: un disparador no necesita que quien
-- escribe pueda ejecutarlas, y así la guardia de funciones SECURITY
-- DEFINER (src/esquema.ts) no tiene nada que declarar.
-- =====================================================================
CREATE TABLE contact_suppression (
  email        citext PRIMARY KEY,
  reason       text NOT NULL CHECK (reason IN ('opted_out')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE contact_suppression IS
  'Baja global (0007): correos que nadie en la plataforma vuelve a contactar. Sin workspace a propósito; la llenan y la aplican los disparadores de contact y el worker (0026 §3).';

REVOKE ALL PRIVILEGES ON contact_suppression FROM mc_app;

-- Lo que ya estaba dado de baja.
INSERT INTO contact_suppression (email, reason, created_at)
SELECT DISTINCT ON (email) email, 'opted_out', coalesce(opted_out_at, now())
  FROM contact
 WHERE opted_out AND email IS NOT NULL
 ORDER BY email, opted_out_at
ON CONFLICT DO NOTHING;

CREATE FUNCTION contact_suppression_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO contact_suppression (email, reason) VALUES (NEW.email, 'opted_out')
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;

CREATE FUNCTION contact_suppression_apply() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM contact_suppression s WHERE s.email = NEW.email) THEN
    NEW.opted_out := true;
    NEW.opted_out_at := coalesce(NEW.opted_out_at, now());
    NEW.opted_out_reason := coalesce(NEW.opted_out_reason, 'Pidió la baja de la plataforma: no se le contacta desde ningún espacio.');
  END IF;
  RETURN NEW;
END $$;

REVOKE EXECUTE ON FUNCTION contact_suppression_record() FROM PUBLIC, mc_app;
REVOKE EXECUTE ON FUNCTION contact_suppression_apply() FROM PUBLIC, mc_app;

COMMENT ON FUNCTION contact_suppression_record() IS
  'Disparador AFTER de contact: un contacto dado de baja deja su correo en contact_suppression (0026 §3).';
COMMENT ON FUNCTION contact_suppression_apply() IS
  'Disparador BEFORE de contact: un correo suprimido nace dado de baja en cualquier workspace (0026 §3).';

CREATE TRIGGER contact_suppression_record
  AFTER INSERT OR UPDATE OF opted_out, email ON contact
  FOR EACH ROW WHEN (NEW.opted_out AND NEW.email IS NOT NULL)
  EXECUTE FUNCTION contact_suppression_record();

CREATE TRIGGER contact_suppression_apply
  BEFORE INSERT OR UPDATE OF email ON contact
  FOR EACH ROW WHEN (NEW.email IS NOT NULL AND NOT NEW.opted_out)
  EXECUTE FUNCTION contact_suppression_apply();


-- =====================================================================
-- 4 · Las secuencias no se leen
-- ---------------------------------------------------------------------
-- ALTER DEFAULT PRIVILEGES le daba a mc_app USAGE y SELECT sobre cada
-- secuencia al nacer. SELECT es leer last_value, y una secuencia es de
-- la tabla entera, no de un inquilino: desde B, `SELECT last_value FROM
-- account_metric_snapshot_id_seq` devolvía 360, y lo mismo audit_log y
-- api_call_log. Es el volumen de TODA la plataforma.
--
--   SELECT, UPDATE   fuera, en todas. nextval y el DEFAULT de una
--                    columna bigserial solo necesitan USAGE; UPDATE es
--                    setval, que una aplicación no usa nunca.
--   USAGE            solo en las secuencias de las tablas donde mc_app
--                    INSERTA. En las demás, nextval() solo sirve para
--                    medir cuánto escribe el worker.
--
-- Lo que queda, y por qué no se cierra aquí: en las tablas donde mc_app
-- sí inserta (audit_log, api_call_log, account_metric_snapshot,
-- deal_stage_history, idea_evidence, preflight_result,
-- video_onscreen_text), el id que devuelve el INSERT sigue siendo el
-- contador global (y el SELECT de sus propias filas también lo
-- enseña). Cerrarlo es cambiar esas claves a uuid, que es otra
-- migración con su propio plan; mientras tanto, ninguna consulta de
-- @mc/db le devuelve esos ids a la web (comprobado con grep el 22-sep).
-- Queda escrito, con el plan, en
-- docs/propuestas/CIM-2.md («Lo que queda abierto») y en la nota de
-- CIM-2 de apps/web/content/backlog.ts.
--
-- Y para las secuencias que nazcan mañana, lo mismo: se le quitan SELECT
-- y UPDATE a los privilegios por defecto del rol que migra. La guardia
-- (src/esquema.ts) mira además las secuencias igual que las tablas.
-- =====================================================================
REVOKE SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public FROM mc_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, UPDATE ON SEQUENCES FROM mc_app;

DO $$
DECLARE
  s record;
BEGIN
  FOR s IN
    SELECT seq.relname AS secuencia
      FROM pg_class seq
      JOIN pg_namespace n ON n.oid = seq.relnamespace
      LEFT JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = seq.oid
                           AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
     WHERE n.nspname = 'public' AND seq.relkind = 'S'
       AND (d.refobjid IS NULL OR NOT has_table_privilege('mc_app', d.refobjid, 'INSERT'))
  LOOP
    EXECUTE format('REVOKE USAGE ON SEQUENCE %I FROM mc_app', s.secuencia);
  END LOOP;
END $$;
