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
-- LA TAREA NO MANDA EL SECRETO: manda una FIRMA QUE CADUCA. pg_net deja
-- cada petición, CON sus cabeceras, en net.http_request_queue hasta que
-- su worker la manda (milisegundos), y esa tabla no es solo de postgres:
-- pg_net 0.20.4 se la concede entera a PUBLIC (otorgado por
-- supabase_admin, irrevocable con nuestras credenciales; medido el
-- 4-oct-2026), así que mc_app también la alcanza. La guardia de esquema lo
-- acepta declarado (ACCESOS_EN_ESQUEMAS_DECLARADOS en
-- packages/db/src/esquema.ts). Por eso la petición lleva:
--
--     X-On-Cue-Timestamp   el segundo del disparo (epoch, en decimal)
--     X-On-Cue-Signature   hex de HMAC-SHA256(timestamp, secreto), con
--                          extensions.hmac de pgcrypto
--
-- y la ruta (apps/web/app/api/cron/tick/_lib/turno.ts) solo la acepta a
-- ±90 s de su reloj, comparando en tiempo constante. Lo que alguien lea de
-- la cola sirve para pedir UN turno durante minuto y medio, que el cron
-- pide de todos modos, y un turno repetido no corre nada dos veces (cada
-- corrida se reclama con un candado por job). Ni Authorization ni Bearer:
-- el Bearer lo sigue aceptando la ruta solo para Vercel Cron (opción A) y
-- para probar a mano. `make cron.status` cuenta las filas de la cola
-- (cola_pg_net): si crece, pg_net está atascado y lo que llegue tarde,
-- con la firma caducada, la ruta lo rechaza con 401.
--
-- Orden de `make cron.install` (scripts/cron-tick.sh), para que la tarea
-- nunca dispare sin secreto: 1) cron-tick-vault.sql comprueba que Vault
-- está (sin secretos), 2) cron-tick-secreto.sql lo guarda, 3) este lote
-- programa la tarea. Y aun así la tarea no llama si el secreto falta (el
-- FROM vault.decrypted_secrets de abajo no da ninguna fila): un Vault
-- borrado a mano no deja peticiones sin firma ni 401 cada minuto en
-- cron.status.
--
-- Idempotente: crea las extensiones si faltan y retira las tareas
-- `on-cue-tick` y `on-cue-tick-purga` si ya existían antes de
-- programarlas otra vez. Correrlo dos veces deja una de cada.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ---------------------------------------------------------------------
-- 1 · La tarea: fuera la anterior (si la hay) y otra vez, cada minuto.
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
      'X-On-Cue-Timestamp', f.ts,
      'X-On-Cue-Signature', encode(extensions.hmac(f.ts, s.decrypted_secret, 'sha256'), 'hex')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  )
  FROM (SELECT floor(extract(epoch FROM now()))::bigint::text AS ts) f,
       vault.decrypted_secrets s
  WHERE s.name = 'on_cue_cron_secret' AND s.decrypted_secret IS NOT NULL;
  $tick$
);

-- ---------------------------------------------------------------------
-- 2 · La purga del historial de pg_cron. Cada disparo deja una fila en
--     cron.job_run_details (1.440 al día con la tarea de arriba) y nadie
--     la borra: crece sin límite y ocupa el disco del plan gratuito.
--     Supabase recomienda purgarla; se guarda una semana, que es lo que
--     mira `make cron.status`. Borra el historial de TODAS las tareas de
--     pg_cron (hoy solo existen estas dos). net._http_response ya caduca
--     sola (pg_net la limpia a las 6 h).
-- ---------------------------------------------------------------------
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'on-cue-tick-purga';

SELECT cron.schedule(
  'on-cue-tick-purga',
  '17 3 * * *',
  $purga$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days'$purga$
);
