-- =====================================================================
-- El disparador del worker por turnos (CIM-7, opción B).
--
-- pg_cron, dentro de Supabase, llama cada minuto a /api/cron/tick de la
-- web con net.http_post (pg_net). La ruta corre un turno del worker
-- (apps/worker/src/tick.ts) y responde con su resumen.
--
-- NO es una migración: pg_cron y pg_net piden superusuario, y ni
-- mc_migrator ni el runner de db/migrate.mjs lo son. Lo corre el dueño
-- del proyecto con el token de administración:
--
--     cd platform
--     make cron.install     # pide CRON_SECRET sin mostrarlo; APP_URL por defecto la de producción
--     make cron.status      # la tarea, el secreto (sin su valor) y las últimas corridas
--     make cron.uninstall   # para pasar a Vercel Cron (opción A)
--
-- Este archivo es una PLANTILLA: los marcadores APP_URL y CRON_SECRET,
-- entre llaves dobles, solo aparecen donde van los valores (aquí no, o el
-- secreto acabaría también en este comentario). Los
-- rellena db/ops/render.mjs desde el entorno (nunca por argumentos, para
-- que el secreto no salga en `ps`), después de validarlos: la URL, un
-- origen https; el secreto, solo [A-Za-z0-9_-]. El texto rellenado va
-- por la entrada estándar a scripts/supabase-admin.sh sql-stdin y no se
-- escribe en ningún archivo.
--
-- El secreto se guarda en Supabase Vault (cifrado en reposo) y la tarea
-- lo LEE al disparar, de vault.decrypted_secrets: en cron.job solo queda
-- la consulta, nunca el valor. Rotarlo es volver a correr
-- `make cron.install` con el nuevo (y ponerlo igual en Vercel).
--
-- Idempotente: crea las extensiones si faltan, crea o actualiza el
-- secreto, y retira la tarea `on-cue-tick` si ya existía antes de
-- programarla otra vez. Correrlo dos veces deja una sola tarea.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ---------------------------------------------------------------------
-- 1 · El secreto, en Vault. El mismo valor que CRON_SECRET en Vercel.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM vault.secrets WHERE name = 'on_cue_cron_secret';
  IF v_id IS NULL THEN
    PERFORM vault.create_secret('{{CRON_SECRET}}', 'on_cue_cron_secret',
      'Bearer de /api/cron/tick (CIM-7). El mismo valor que CRON_SECRET en Vercel.');
  ELSE
    PERFORM vault.update_secret(v_id, '{{CRON_SECRET}}');
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 2 · La tarea: fuera la anterior (si la hay) y otra vez, cada minuto.
--     timeout_milliseconds cubre el maxDuration de la ruta (60 s): el
--     turno dura 45 s y pg_net no se queda esperando más que eso.
-- ---------------------------------------------------------------------
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'on-cue-tick';

SELECT cron.schedule(
  'on-cue-tick',
  '* * * * *',
  $tick$
  SELECT net.http_post(
    url := '{{APP_URL}}/api/cron/tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'on_cue_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $tick$
);
