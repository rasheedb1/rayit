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
-- Este archivo es una PLANTILLA con un solo marcador, el de APP_URL
-- entre llaves dobles, donde va la URL. El SECRETO NO pasa por aquí: va
-- en su propia llamada (db/ops/cron-tick-secreto.sql), para que ni un
-- fallo de este lote lo arrastre al log de Postgres ni un bloque DO lo
-- deje en claro en pg_stat_statements. db/ops/render.mjs rellena la URL
-- desde el entorno (nunca por argumentos) después de validarla: un
-- origen https. El texto rellenado va por la entrada estándar a
-- scripts/supabase-admin.sh sql-stdin y no se escribe en ningún archivo.
--
-- El secreto vive en Supabase Vault (cifrado en reposo) y la tarea lo
-- LEE al disparar, de vault.decrypted_secrets: en cron.job solo queda la
-- consulta, nunca el valor. Rotarlo es volver a correr
-- `make cron.install` con el nuevo (y ponerlo igual en Vercel).
--
-- Idempotente: crea las extensiones si faltan y retira la tarea
-- `on-cue-tick` si ya existía antes de programarla otra vez. Correrlo dos
-- veces deja una sola tarea.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ---------------------------------------------------------------------
-- 1 · Vault tiene que estar (Supabase lo trae): lo comprueba este lote,
--     que no lleva secretos, para que la llamada del secreto no tenga de
--     qué fallar.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF to_regproc('vault.create_secret') IS NULL OR to_regproc('vault.update_secret') IS NULL THEN
    RAISE EXCEPTION 'Supabase Vault no está instalado (extensión supabase_vault): el secreto del turno no tiene dónde guardarse';
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
