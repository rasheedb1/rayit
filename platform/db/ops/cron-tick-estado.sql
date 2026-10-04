-- El estado del disparador del worker por turnos (CIM-7): lo lee
-- `make cron.status`, con el token de administración. Solo lectura, y
-- sin el valor del secreto: de Vault se mira que exista y cuándo cambió.
-- Una sola fila JSON (la API de administración devuelve la última consulta).
-- Supone pg_cron y pg_net instalados; scripts/cron-tick.sh lo comprueba antes.
-- Que el secreto no haya quedado en claro en pg_stat_statements lo mira
-- aparte db/ops/cron-tick-huellas.sql: la vista puede no existir.
-- El veredicto (verde o rojo, y qué hacer) lo saca de esta fila
-- db/ops/cron-tick-veredicto.mjs.
SELECT jsonb_build_object(
  -- El reloj de la base: «en los últimos 5 min» se mide con él, no con el de quien mira.
  'ahora', now(),
  'tarea', (
    -- primera_corrida: cron.job no guarda cuándo se creó la tarea; su
    -- corrida más antigua que queda dice si acaba de empezar (el veredicto
    -- no da error a una instalación de hace un minuto sin respuestas aún).
    SELECT jsonb_agg(jsonb_build_object('jobid', j.jobid, 'schedule', j.schedule, 'active', j.active, 'command', j.command,
             'primera_corrida', (SELECT min(d.start_time) FROM cron.job_run_details d WHERE d.jobid = j.jobid)))
      FROM cron.job j WHERE j.jobname = 'on-cue-tick'),
  'purga', (
    SELECT jsonb_agg(jsonb_build_object('jobid', jobid, 'schedule', schedule, 'active', active))
      FROM cron.job WHERE jobname = 'on-cue-tick-purga'),
  'filas_en_historial', (SELECT count(*) FROM cron.job_run_details),
  'secreto_en_vault', (
    SELECT jsonb_agg(jsonb_build_object('name', name, 'created_at', created_at, 'updated_at', updated_at))
      FROM vault.secrets WHERE name = 'on_cue_cron_secret'),
  'ultimas_corridas', (
    SELECT jsonb_agg(r ORDER BY r.start_time DESC) FROM (
      SELECT d.status, d.start_time, d.end_time, d.return_message
        FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
       WHERE j.jobname = 'on-cue-tick'
       ORDER BY d.start_time DESC LIMIT 5) r),
  -- Las respuestas de pg_net (de TODAS sus llamadas: hoy solo este cron
  -- la usa). El cuerpo es el resumen del turno: jobs y conteos, sin datos.
  'ultimas_respuestas', (
    SELECT jsonb_agg(r ORDER BY r.created DESC) FROM (
      SELECT id, status_code, timed_out, error_msg, created, left(content, 500) AS content
        FROM net._http_response ORDER BY created DESC LIMIT 5) r),
  -- Peticiones que pg_net aún no ha mandado. Cada una lleva la cabecera
  -- Authorization con el secreto en claro hasta que sale (normalmente
  -- milisegundos; pg_net se la concede a PUBLIC, ver db/ops/cron-tick.sql).
  -- Si crece, pg_net está atascado y el secreto se queda ahí más tiempo.
  'cola_pg_net', (SELECT count(*) FROM net.http_request_queue),
  -- La última pasada buena de outbound.dispatch: si el turno responde 200
  -- pero esto no avanza, el despacho no está corriendo.
  'dispatch_ultimo_ok', (
    SELECT max(started_at) FROM public.job_run
     WHERE job_id = 'outbound.dispatch' AND status = 'ok' AND workspace_id IS NULL),
  -- Lo que dura un turno de media en lo que guarda pg_net (unas 6 h): con
  -- esto el veredicto proyecta la memoria del mes contra el cupo de Hobby.
  'turno_medio', (
    SELECT jsonb_build_object('respuestas', count(*), 'elapsed_ms', round(avg((substring(content FROM '"elapsedMs":([0-9]+)'))::numeric)))
      FROM net._http_response
     WHERE status_code = 200 AND content ~ '"elapsedMs":[0-9]+'),
  -- Jobs que no caben en el turno: 20 o más cortes (MAX_TICK_CUTS de
  -- @mc/db/queries/worker, metadata.tickCut) desde su última corrida
  -- buena. Cada tick del cron agotan sus cortes y esperan al siguiente,
  -- sin terminar nunca: hay que partirlos o pasar a Pro (opción A).
  -- Lo que va entre las marcas lo corre también la prueba contra
  -- Postgres embebido (apps/worker/test/cron-tick-sql.test.ts).
  'no_caben', (
    -- no_caben:inicio
    SELECT jsonb_agg(jsonb_build_object('job_id', x.job_id, 'cortes', x.cortes) ORDER BY x.job_id)
      FROM (
        SELECT c.job_id, count(*) AS cortes
          FROM public.job_run c
         WHERE c.workspace_id IS NULL AND c.status = 'failed'
           AND (c.metadata->>'tickCut')::boolean IS TRUE
           AND c.started_at > coalesce((
                 SELECT max(b.started_at) FROM public.job_run b
                  WHERE b.job_id = c.job_id AND b.workspace_id IS NULL AND b.status IN ('ok', 'partial')),
               '-infinity'::timestamptz)
         GROUP BY c.job_id
        HAVING count(*) >= 20) x
    -- no_caben:fin
  )
) AS cron_tick;
