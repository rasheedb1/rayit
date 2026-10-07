-- =====================================================================
-- 0082 · Ninguna fila que mc_app lea lleva un contador global (CIM-11)
-- ---------------------------------------------------------------------
-- Número: 0082. La serie de esta rama acaba en 0077, pero
-- rasheed/integracion ya tiene 0078–0081 (ACC-4 y RES-3); se toma la
-- siguiente libre para no chocar. Si otra pieza en paralelo eligió el
-- mismo número, el integrador renumera: nada aquí depende del número.
-- No está aplicada en ningún sitio.
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
--   2 · Las quince claves pasan a `uuid DEFAULT gen_random_uuid()`,
--       CONSERVANDO las filas: cada fila existente recibe un uuid al
--       azar (USING gen_random_uuid() se evalúa fila a fila al
--       reescribir la tabla), la clave primaria y su índice se
--       reconstruyen con la tabla, y la secuencia se borra. Ninguna
--       clave ajena apunta a estas tablas (comprobado contra el esquema
--       completo), así que no hay referencias que traducir. Reescribir
--       la tabla no dispara los disparadores de fila ni pasa por la RLS:
--       las filas de todos los workspaces se convierten.
--   3 · El instante de los registros es el del reloj, no el de la
--       transacción: api_call_log.called_at, audit_log.created_at y
--       job_run.started_at pasan de DEFAULT now() a clock_timestamp().
--       El id era lo único que ordenaba dos llamadas, dos entradas de
--       bitácora o dos corridas de la MISMA transacción (now() es el
--       mismo para todas). Sin contador, el orden es la fecha, y la
--       fecha tiene que distinguirlas (como notification_ack en 0081).
--   4 · Una comprobación al final: si queda una columna con DEFAULT
--       nextval(…) o identity en una tabla de `public` donde mc_app
--       lee o escribe, la migración falla. La guardia de
--       packages/db/src/esquema.ts lo vigila después (clavesDeSecuencia).
--
-- Bloqueos. ALTER TABLE … TYPE toma ACCESS EXCLUSIVE y reescribe la
-- tabla. En Supabase (5-oct-2026) la mayor es job_run, ~10.000 filas:
-- milisegundos. lock_timeout corta si una transacción larga (un turno
-- del worker) tiene la tabla: se reintenta con el worker en pausa.
--
-- Despliegue. El código de esta rama lee job_run.id como texto (el
-- runId del runner) y el de antes como número: con el esquema nuevo y
-- el código viejo, Number(uuid) es NaN y la corrida no se cierra. Se
-- aplica con el turno del cron en pausa, y la web y el worker se
-- despliegan justo después (docs/ventas-outreach.md §5.2).
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
-- 2 · Las quince claves, a uuid, con sus filas
-- ---------------------------------------------------------------------
-- Por tabla: se suelta el DEFAULT (que es lo que ata la secuencia a la
-- columna para DROP SEQUENCE), se borra la secuencia, y se cambia el
-- tipo con un uuid nuevo por fila y el DEFAULT definitivo en la misma
-- sentencia (una sola reescritura). La clave primaria sigue llamándose
-- <tabla>_pkey: Postgres reconstruye su índice con el tipo nuevo.
-- =====================================================================
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
      EXECUTE format(
        'ALTER TABLE public.%I ALTER COLUMN id SET DATA TYPE uuid USING gen_random_uuid(), '
        '  ALTER COLUMN id SET DEFAULT gen_random_uuid()', t);
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
-- 5 · Comprobación: ningún contador global donde llega mc_app
-- ---------------------------------------------------------------------
-- La misma pregunta que la guardia (clavesDeSecuencia), aquí para que la
-- migración no termine dejando una. has_table_privilege mira también lo
-- heredado por PUBLIC y por membresía.
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
     AND (has_table_privilege('mc_app', c.oid, 'SELECT') OR has_table_privilege('mc_app', c.oid, 'INSERT'));
  IF quedan IS NOT NULL THEN
    RAISE EXCEPTION 'quedan claves de secuencia global donde llega mc_app: %', quedan
      USING HINT = 'Una clave que la base rellena sola va con uuid DEFAULT gen_random_uuid() (CIM-11).';
  END IF;
END $$;
