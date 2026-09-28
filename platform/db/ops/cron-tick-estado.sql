-- El estado del disparador del worker por turnos (CIM-7): lo lee
-- `make cron.status`, con el token de administración. Solo lectura, y
-- sin el valor del secreto: de Vault se mira que exista y cuándo cambió.
-- Una sola fila JSON (la API de administración devuelve la última consulta).
-- Supone pg_cron y pg_net instalados; scripts/cron-tick.sh lo comprueba antes.
SELECT jsonb_build_object(
  'tarea', (
    SELECT jsonb_agg(jsonb_build_object('jobid', jobid, 'schedule', schedule, 'active', active, 'command', command))
      FROM cron.job WHERE jobname = 'on-cue-tick'),
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
        FROM net._http_response ORDER BY created DESC LIMIT 5) r)
) AS cron_tick;
