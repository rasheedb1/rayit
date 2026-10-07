-- =====================================================================
-- 0082 · Ninguna fila que mc_app lea lleva un contador global (CIM-11)
-- ---------------------------------------------------------------------
-- Número: 0082. Nació como 0078; al mezclar rasheed/integracion ese
-- número y los tres siguientes ya eran de ACC-4 (0078–0080) y RES-3
-- (0081), así que pasa detrás de la última. Ninguna de esas cuatro crea
-- una clave de secuencia (lo comprueba §5 y la guardia). La prueba de la
-- conversión la busca por el nombre, no por el número. No está aplicada
-- en ningún sitio.
--
-- El hallazgo (0026 §4, docs/propuestas/CIM-2.md §3). Quince tablas
-- tenían `id bigserial`: una secuencia de la tabla ENTERA, no de un
-- inquilino. 0026 le quitó a mc_app el SELECT de las secuencias, pero
-- el id de cualquier fila propia sigue siendo el valor del contador al
-- escribirla: insertar en audit_log a las 10:00 y a las 11:00 y restar
-- los dos ids dice cuántas filas escribió TODA la plataforma en esa
-- hora. Lo mismo leyendo: mc_app tiene SELECT (con su RLS) en las
-- quince, así que el id de una fila de job_run o de
-- post_retention_curve de su propio workspace dice cuántas escribió el
-- worker para todos. Es el oráculo de volumen que 0026 cerró en las
-- secuencias, abierto por la columna.
--
--   Inserta mc_app:  account_metric_snapshot, api_call_log, audit_log,
--                    brand_account_snapshot, deal_stage_history,
--                    idea_evidence, post_metric_snapshot,
--                    preflight_result, video_onscreen_text
--   Solo lee:        api_quota_usage, external_post_snapshot, job_run,
--                    post_engagement_curve, post_impression_source,
--                    post_retention_curve
--
-- Lo que deja esta migración:
--
--   1 · post_metrics_at_cut desempata sin el id. Es lo único del
--       esquema que dependía de post_metric_snapshot.id (0042: «id
--       desempata dos lecturas del mismo instante»), y una vista que
--       usa la columna impide cambiarle el tipo. Entre dos lecturas de
--       la misma edad y el mismo instante gana la de mejor fuente: la
--       API de la plataforma, su exportación (csv_import), un agregador
--       de terceros y, al final, lo escrito a mano. Es una regla que se
--       puede explicar, no el orden de llegada; con el id al azar, el
--       orden de llegada ya no existe.
--   1b · deal_stage_history.step: el orden de los pasos de UN negocio.
--       La conversión por etapa (VEN-8, queries/conversion.ts) ordena
--       la historia por (changed_at, id): un negocio que nace y se mueve
--       en la misma transacción deja dos filas con el mismo now(), y
--       solo el id decía cuál fue antes. Ese orden no puede salir de un
--       contador global; sale de uno POR NEGOCIO, que no dice nada de
--       nadie más: step = 1, 2, 3… dentro de cada deal_id, lo pone un
--       disparador al insertar, y un índice único (deal_id, step) hace
--       que un choque falle en vez de repetir el número. Las filas que
--       ya están lo reciben en el orden que tenían, (changed_at, id) con
--       el id bigint, ANTES de convertirlo. Después de insertarse, step
--       no cambia: otro disparador rechaza el UPDATE que lo mueva (la
--       historia es append-only; mc_app conserva UPDATE en la tabla y sin
--       ese cierre podría renumerar los pasos de un negocio).
--   2 · Las quince claves pasan a `uuid DEFAULT gen_random_uuid()`,
--       CONSERVANDO las filas: cada fila existente recibe un uuid al
--       azar (USING gen_random_uuid() se evalúa fila a fila al
--       reescribir la tabla), la clave primaria y su índice se
--       reconstruyen con la tabla, y la secuencia se borra. Ninguna
--       clave ajena apunta a estas tablas (comprobado contra el esquema
--       completo). Hay UNA referencia que no es clave ajena: auditAsJob
--       (packages/db/src/audit.ts) guarda el id de la corrida en
--       audit_log.after->'_job'->>'runId' (lo escribe
--       collect-account-metrics en connection.source_changed). job_run
--       no recibe un uuid cualquiera: §2a se lo asigna primero en una
--       columna aparte, reescribe esas entradas de bitácora con él y
--       solo entonces convierte la clave con ese mismo valor, así que
--       cada entrada sigue apuntando a su corrida. El número viejo no se
--       guarda en ningún sitio: mc_app lee job_run y volvería a ser el
--       contador. Reescribir la tabla no dispara los disparadores de
--       fila ni pasa por la RLS: las filas de todos los workspaces se
--       convierten.
--   3 · El instante de los registros es el del reloj, no el de la
--       transacción: api_call_log.called_at, audit_log.created_at y
--       job_run.started_at pasan de DEFAULT now() a clock_timestamp().
--       El id era lo único que ordenaba dos llamadas, dos entradas de
--       bitácora o dos corridas de la MISMA transacción (now() es el
--       mismo para todas). Sin contador, el orden es la fecha, y la
--       fecha tiene que distinguirlas (como notification_ack, de RES-3).
--       Postgres mide en microsegundos; PGlite, en milisegundos, así que
--       las pruebas no dan por hecho el orden de dos filas del mismo
--       milisegundo.
--   4b · outreach_writer_status (0062) y outreach_classifier_status
--       (0070) eligen la última corrida de outbound.generate y
--       outbound.intent por (started_at, id): con el id al azar, a igual
--       started_at ganaba cualquiera. Desempatan por finished_at, como
--       el runner y la salud del worker (ORDEN_ULTIMA_CORRIDA de
--       @mc/db/queries/worker).
--   5 · Una comprobación al final: si queda una columna con DEFAULT
--       nextval(…) o identity en una tabla de `public` donde mc_app o
--       mc_public_share leen o insertan (directo, por PUBLIC, por
--       membresía o por columna), la migración falla. La guardia de
--       packages/db/src/esquema.ts lo vigila después con el mismo
--       criterio (clavesDeSecuencia).
--
-- Bloqueos. ALTER TABLE … TYPE toma ACCESS EXCLUSIVE y reescribe la
-- tabla. En Supabase (7-oct-2026) la mayor es job_run, ~10.000 filas:
-- milisegundos. lock_timeout corta si una transacción larga (un turno
-- del worker) tiene la tabla: se reintenta con el worker en pausa.
--
-- Despliegue. El código de esta rama lee job_run.id como texto (el
-- runId del runner) y el de antes como número: con el esquema nuevo y
-- el código viejo, Number(uuid) es NaN y la corrida no se cierra. Se
-- aplica y se despliega seguido: make db.migrate, make db.guardia y
-- make vercel.deploy PROD=1. Un turno que caiga en medio falla y el
-- siguiente lo retoma; para que no caiga ninguno, make cron.uninstall
-- antes y make cron.install después (docs/ventas-outreach.md §5.2).
--
-- Re-ejecutable: CREATE OR REPLACE VIEW, y cada tabla se convierte solo
-- si su id sigue siendo bigint.
-- =====================================================================

SET LOCAL lock_timeout = '15s';

-- =====================================================================
-- 1 · post_metrics_at_cut, sin el id
-- ---------------------------------------------------------------------
-- Las mismas columnas, los mismos tipos y el mismo nombre que 0042; CREATE
-- OR REPLACE conserva los GRANT y security_invoker va explícito. El
-- desempate final por s.id vuelve en §4, ya sobre el uuid: no es un
-- orden con significado, solo hace que el resultado no dependa del plan
-- cuando dos lecturas coinciden en todo lo demás.
-- =====================================================================
CREATE OR REPLACE VIEW post_metrics_at_cut WITH (security_invoker = on) AS
SELECT DISTINCT ON (s.post_id, c.cut_hours)
       s.post_id,
       s.workspace_id,
       c.cut_hours,
       s.age_hours,
       s.views, s.reach, s.likes, s.comments, s.shares, s.saves,
       s.total_interactions, s.completion_rate, s.skip_rate_3s
FROM post_metric_snapshot s
CROSS JOIN (VALUES (24), (72), (168), (720)) AS c(cut_hours)
WHERE s.age_hours <= c.cut_hours
ORDER BY s.post_id, c.cut_hours, s.age_hours DESC, s.captured_at ASC,
         array_position(ARRAY['api', 'csv_import', 'aggregator', 'manual'], s.source);

-- =====================================================================
-- 1b · deal_stage_history.step, el orden dentro de cada negocio
-- ---------------------------------------------------------------------
-- El relleno va con FORCE ROW LEVEL SECURITY quitado un momento, dentro
-- de esta transacción: con él, quien migra (el dueño) no ve ninguna fila
-- (la política hereda de deal, y deal tampoco le enseña nada) y el
-- UPDATE no tocaría ninguna. Actualizar step no dispara los
-- disparadores de referencias (son UPDATE OF deal_id, changed_by y las
-- etapas). Al final, FORCE otra vez: la guardia lo exige.
--
-- El disparador es SECURITY INVOKER: quien inserta (mc_app desde Ventas,
-- mc_public_share al aceptar una cotización, el worker) ve la historia
-- del negocio por la misma política que la deja insertar. Dos pasos del
-- mismo negocio a la vez no se pisan: deal_move_stage (0031) toma la
-- fila del negocio FOR UPDATE antes de escribir la historia, y el índice
-- único (deal_id, step) hace fallar al que no lo haga en vez de repetir
-- el número.
-- =====================================================================
ALTER TABLE deal_stage_history ADD COLUMN IF NOT EXISTS step integer;

ALTER TABLE deal_stage_history NO FORCE ROW LEVEL SECURITY;
UPDATE deal_stage_history h
   SET step = o.n
  FROM (SELECT id, row_number() OVER (PARTITION BY deal_id ORDER BY changed_at, id) AS n
          FROM deal_stage_history) o
 WHERE o.id = h.id AND h.step IS NULL;
ALTER TABLE deal_stage_history FORCE ROW LEVEL SECURITY;

-- El DEFAULT 1 solo es para que un INSERT no tenga que nombrarla (Drizzle
-- la ve opcional): el disparador de abajo la reemplaza siempre.
ALTER TABLE deal_stage_history ALTER COLUMN step SET DEFAULT 1;
ALTER TABLE deal_stage_history ALTER COLUMN step SET NOT NULL;
ALTER TABLE deal_stage_history DROP CONSTRAINT IF EXISTS deal_stage_history_step_check;
ALTER TABLE deal_stage_history ADD CONSTRAINT deal_stage_history_step_check CHECK (step >= 1);
-- Único: max(step) + 1 solo es correcto si nadie más inserta en el mismo
-- negocio a la vez, y eso hoy lo garantizan los escritores (deal_move_stage
-- y la aceptación pública bloquean el negocio FOR UPDATE; radar.ts e
-- intent.ts escriben en negocios recién creados). Un escritor futuro que
-- no bloquee, o un rol cuya RLS vea solo parte de la historia, calcularía
-- el mismo step que otro: con el índice único, el segundo espera al
-- primero y falla (23505) en vez de dejar dos pasos con el mismo número.
-- Es por inquilino: deal_id apunta a deal, aislado por workspace, así que
-- el choque solo puede ser con la historia de un negocio propio.
DROP INDEX IF EXISTS deal_stage_history_deal_id_step_idx;
CREATE UNIQUE INDEX IF NOT EXISTS deal_stage_history_deal_id_step_key ON deal_stage_history (deal_id, step);

COMMENT ON COLUMN deal_stage_history.step IS
  'El orden del paso dentro de su negocio (1, 2, 3…): lo pone deal_stage_history_step() al insertar. '
  'Desempata dos pasos con la misma changed_at (CIM-11, 0082).';

CREATE OR REPLACE FUNCTION deal_stage_history_step()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Siempre lo calcula la base: quien inserta no elige su lugar en la historia.
  SELECT coalesce(max(h.step), 0) + 1 INTO NEW.step
    FROM deal_stage_history h
   WHERE h.deal_id = NEW.deal_id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION deal_stage_history_step() FROM PUBLIC;

DROP TRIGGER IF EXISTS deal_stage_history_step ON deal_stage_history;
CREATE TRIGGER deal_stage_history_step
  BEFORE INSERT ON deal_stage_history
  FOR EACH ROW EXECUTE FUNCTION deal_stage_history_step();

-- Y después de insertarse, nadie lo mueve. mc_app conserva UPDATE sobre
-- deal_stage_history (0025 solo le quitó UPDATE y DELETE de audit_log), y
-- el índice único impide repetir un número, no cambiar el orden: un
-- `UPDATE … SET step = step + 100` renumeraría la historia y el desempate
-- de la conversión (VEN-8) dejaría de ser el orden en que pasaron las
-- cosas. Se cierra con un disparador y no con un REVOKE para no tocar el
-- resto de la fila ni PRIVILEGIOS_DE_LA_APP; vale para todos los roles,
-- también el dueño (una corrección a mano desactiva el disparador a
-- propósito, a la vista). Sin lista de columnas (BEFORE UPDATE, no UPDATE
-- OF step), para que tampoco lo mueva otro disparador.
CREATE OR REPLACE FUNCTION deal_stage_history_step_fijo()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'deal_stage_history.step no cambia después de insertarse (de % a %)', OLD.step, NEW.step
    USING ERRCODE = 'check_violation',
          HINT = 'La historia de un negocio es append-only: un paso nuevo es un INSERT (CIM-11, 0082 §1b).';
END $$;
REVOKE ALL ON FUNCTION deal_stage_history_step_fijo() FROM PUBLIC;

DROP TRIGGER IF EXISTS deal_stage_history_step_fijo ON deal_stage_history;
CREATE TRIGGER deal_stage_history_step_fijo
  BEFORE UPDATE ON deal_stage_history
  FOR EACH ROW WHEN (NEW.step IS DISTINCT FROM OLD.step)
  EXECUTE FUNCTION deal_stage_history_step_fijo();

-- =====================================================================
-- 2 · Las quince claves, a uuid, con sus filas
-- ---------------------------------------------------------------------
-- Por tabla: se suelta el DEFAULT (que es lo que ata la secuencia a la
-- columna para DROP SEQUENCE), se borra la secuencia, y se cambia el
-- tipo con un uuid nuevo por fila y el DEFAULT definitivo en la misma
-- sentencia (una sola reescritura). La clave primaria sigue llamándose
-- <tabla>_pkey: Postgres reconstruye su índice con el tipo nuevo.
--
-- 2a · job_run, antes que nada: su uuid nuevo va primero a id_nuevo (un
-- DEFAULT volátil en ADD COLUMN se evalúa fila a fila), las entradas de
-- bitácora que nombran una corrida por su número pasan a nombrarla por
-- ese uuid, y el bucle de abajo convierte job_run.id USING id_nuevo. Con
-- FORCE ROW LEVEL SECURITY quitado un momento en las dos tablas, como en
-- §1b: el dueño no ve filas con él puesto. `->>` lee igual el runId que
-- se escribió como número (antes de esta rama) que como texto.
-- =====================================================================
DO $$
BEGIN
  IF (SELECT a.atttypid FROM pg_attribute a
       WHERE a.attrelid = 'public.job_run'::regclass AND a.attname = 'id' AND NOT a.attisdropped)
     = 'bigint'::regtype THEN
    ALTER TABLE public.job_run ADD COLUMN IF NOT EXISTS id_nuevo uuid NOT NULL DEFAULT gen_random_uuid();
    ALTER TABLE public.audit_log NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.job_run NO FORCE ROW LEVEL SECURITY;
    UPDATE public.audit_log a
       SET after = jsonb_set(a.after, '{_job,runId}', to_jsonb(j.id_nuevo::text))
      FROM public.job_run j
     WHERE jsonb_typeof(a.after -> '_job') = 'object'
       AND a.after -> '_job' ->> 'runId' = j.id::text;
    ALTER TABLE public.audit_log FORCE ROW LEVEL SECURITY;
    ALTER TABLE public.job_run FORCE ROW LEVEL SECURITY;
  END IF;
END $$;

DO $$
DECLARE
  t   text;
  seq text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'account_metric_snapshot', 'api_call_log', 'api_quota_usage', 'audit_log',
    'brand_account_snapshot', 'deal_stage_history', 'external_post_snapshot',
    'idea_evidence', 'job_run', 'post_engagement_curve', 'post_impression_source',
    'post_metric_snapshot', 'post_retention_curve', 'preflight_result',
    'video_onscreen_text'
  ] LOOP
    IF (SELECT a.atttypid FROM pg_attribute a
         WHERE a.attrelid = format('public.%I', t)::regclass AND a.attname = 'id' AND NOT a.attisdropped)
       = 'bigint'::regtype THEN
      seq := pg_get_serial_sequence(format('public.%I', t), 'id');
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN id DROP DEFAULT', t);
      IF seq IS NOT NULL THEN
        EXECUTE format('DROP SEQUENCE %s', seq);
      END IF;
      -- job_run conserva el uuid que §2a ya le dio a la bitácora.
      EXECUTE format(
        'ALTER TABLE public.%I ALTER COLUMN id SET DATA TYPE uuid USING %s, '
        '  ALTER COLUMN id SET DEFAULT gen_random_uuid()',
        t, CASE WHEN t = 'job_run' THEN 'id_nuevo' ELSE 'gen_random_uuid()' END);
      IF t = 'job_run' THEN
        ALTER TABLE public.job_run DROP COLUMN id_nuevo;
      END IF;
    END IF;
  END LOOP;
END $$;

-- =====================================================================
-- 3 · La fecha de un registro es la del reloj
-- ---------------------------------------------------------------------
-- Las filas que ya están no cambian (un DEFAULT nuevo solo vale para lo
-- que se inserte). Quien escribe la columna a mano (el runner pone
-- started_at en algunas corridas) sigue mandando.
-- =====================================================================
ALTER TABLE api_call_log ALTER COLUMN called_at SET DEFAULT clock_timestamp();
ALTER TABLE audit_log    ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE job_run      ALTER COLUMN started_at SET DEFAULT clock_timestamp();

-- =====================================================================
-- 4 · El desempate final de post_metrics_at_cut, ya sobre el uuid
-- =====================================================================
CREATE OR REPLACE VIEW post_metrics_at_cut WITH (security_invoker = on) AS
SELECT DISTINCT ON (s.post_id, c.cut_hours)
       s.post_id,
       s.workspace_id,
       c.cut_hours,
       s.age_hours,
       s.views, s.reach, s.likes, s.comments, s.shares, s.saves,
       s.total_interactions, s.completion_rate, s.skip_rate_3s
FROM post_metric_snapshot s
CROSS JOIN (VALUES (24), (72), (168), (720)) AS c(cut_hours)
WHERE s.age_hours <= c.cut_hours
ORDER BY s.post_id, c.cut_hours, s.age_hours DESC, s.captured_at ASC,
         array_position(ARRAY['api', 'csv_import', 'aggregator', 'manual'], s.source), s.id;

-- =====================================================================
-- 4b · La última corrida de outbound.generate y outbound.intent
-- ---------------------------------------------------------------------
-- Idénticas a 0062 §2.3 y 0070 §3 salvo el desempate: (started_at, id)
-- pasa a (started_at, finished_at). Solo miran corridas ok o partial,
-- que siempre están cerradas. CREATE OR REPLACE conserva el dueño, el
-- REVOKE de PUBLIC y el GRANT a mc_app; se repiten igual por si acaso.
-- =====================================================================
CREATE OR REPLACE FUNCTION outreach_writer_status()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT CASE
           WHEN r.writer IN ('anthropic','fake') THEN r.writer
           WHEN r.not_configured THEN 'off'
           ELSE 'unknown'
         END
    FROM (SELECT 1) x
    LEFT JOIN LATERAL (
      SELECT j.metadata->>'writer' AS writer, coalesce((j.metadata->>'notConfigured')::boolean, false) AS not_configured
        FROM job_run j
       WHERE j.job_id = 'outbound.generate' AND j.status IN ('ok','partial') AND j.started_at > now() - interval '1 day'
       ORDER BY j.started_at DESC, j.finished_at DESC NULLS FIRST
       LIMIT 1) r ON true
$$;
REVOKE ALL ON FUNCTION outreach_writer_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outreach_writer_status() TO mc_app;

CREATE OR REPLACE FUNCTION outreach_classifier_status()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT CASE
           WHEN r.classifier IN ('model', 'fake') THEN r.classifier
           WHEN r.not_configured THEN 'off'
           ELSE 'unknown'
         END
    FROM (SELECT 1) x
    LEFT JOIN LATERAL (
      SELECT j.metadata->>'classifier' AS classifier, coalesce((j.metadata->>'notConfigured')::boolean, false) AS not_configured
        FROM job_run j
       WHERE j.job_id = 'outbound.intent' AND j.status IN ('ok', 'partial') AND j.started_at > now() - interval '1 day'
       ORDER BY j.started_at DESC, j.finished_at DESC NULLS FIRST
       LIMIT 1) r ON true
$$;
REVOKE ALL ON FUNCTION outreach_classifier_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outreach_classifier_status() TO mc_app;

-- =====================================================================
-- 5 · Comprobación: ningún contador global donde llega mc_app
-- ---------------------------------------------------------------------
-- La misma pregunta que la guardia (clavesDeSecuencia), aquí para que la
-- migración no termine dejando una, con su mismo criterio: mc_app o el
-- rol de los enlaces públicos (mc_public_share) leen o insertan en la
-- tabla. has_any_column_privilege mira también lo heredado por PUBLIC y
-- por membresía, y lo concedido por columna.
-- =====================================================================
DO $$
DECLARE
  quedan text;
BEGIN
  SELECT string_agg(format('%s.%s', c.relname, a.attname), ', ' ORDER BY c.relname, a.attname)
    INTO quedan
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
     AND (a.attidentity <> '' OR pg_get_expr(d.adbin, d.adrelid) ~ '^nextval\(')
     AND EXISTS (SELECT 1 FROM pg_roles r
                  WHERE r.rolname IN ('mc_app', 'mc_public_share')
                    AND has_any_column_privilege(r.oid, c.oid, 'SELECT, INSERT'));
  IF quedan IS NOT NULL THEN
    RAISE EXCEPTION 'quedan claves de secuencia global donde llegan mc_app o mc_public_share: %', quedan
      USING HINT = 'Una clave que la base rellena sola va con uuid DEFAULT gen_random_uuid() (CIM-11).';
  END IF;
END $$;
