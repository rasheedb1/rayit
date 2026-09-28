-- Apaga el disparador del worker por turnos (CIM-7): `make cron.uninstall`.
-- Es el paso para pasar a Vercel Cron (opción A; apps/worker/README.md):
-- con los dos encendidos, la ruta recibiría dos turnos por minuto (no
-- correría nada dos veces —cada corrida se reclama—, pero sí gastaría el
-- doble de invocaciones). Retira la tarea y su purga del historial
-- (on-cue-tick-purga) y borra el secreto de Vault; deja las extensiones,
-- que pueden usar otras cosas. Idempotente.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'on-cue-tick';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'on-cue-tick-purga';
DELETE FROM vault.secrets WHERE name = 'on_cue_cron_secret';
SELECT count(*) AS tareas_restantes FROM cron.job WHERE jobname IN ('on-cue-tick', 'on-cue-tick-purga');
