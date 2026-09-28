-- =====================================================================
-- 0072 · Actividad y métricas del outreach (VEN-16)
-- ---------------------------------------------------------------------
-- Una función y cuatro vistas de solo lectura sobre la cola
-- (outbound_touch), para que ninguna pantalla sume, divida ni decida
-- (docs/ventas-outreach.md §6, VEN-16):
--
--   outbound_touch_retry_block  por qué un fallido NO puede volver a la
--                             cola, o NULL si puede. La usan la vista de
--                             la cola (qué fila ofrece «Reintentar»), el
--                             conteo de los botones por tipo y el propio
--                             reintento, dentro de su FOR UPDATE: una
--                             sola regla, en un solo sitio.
--   outbound_queue            un toque por fila, con su estado, su paso,
--                             su contacto, su cuenta, su motivo (el de la
--                             retención o el de por qué no salió) y su
--                             bloqueo de reintento; y si está en la cola
--                             o ya en el historial.
--   outbound_usage_daily      el uso de cada cuenta de canal viva en los
--                             últimos 14 días locales del workspace,
--                             contra los TRES topes que aplica el
--                             despachador: el diario y el semanal de la
--                             cuenta, y el diario de correos del espacio.
--   outbound_funnel_by_step   por secuencia y paso: enviados, abiertos,
--                             respondidos y positivos (y lo que sigue en
--                             cola, lo fallido y lo detenido), con sus
--                             tasas sobre lo enviado.
--   outbound_sequence_health  por secuencia: enrolamientos por estado,
--                             la cola viva, lo enviado y lo fallido en 7
--                             días, las tasas y un semáforo.
--
-- Y dos reglas que las vistas comparten, en un solo sitio (1b):
--   outbound_step_position    el número de cada paso en su secuencia;
--   outbound_touch_is_positive  enviado, respondido (replied_at) y con
--                             una respuesta entrante «interested». Por
--                             construcción, positivo ⊆ respondido ⊆
--                             enviado: el embudo nunca crece hacia abajo.
--
-- Número: 0072. La serie de integración va de 0043 a 0075, detrás de
-- la 0042 de main (0034–0042, ya aplicadas en Supabase); ninguna de la
-- serie está aplicada aún. Hasta el pulido r2 de ventas esta fue la
-- 0067. No depende de las bandejas (0069–0071) ni ellas de esta.
--
-- Una sola migración (pulido r1): las rondas 4 y 5 de VEN-16 habían
-- dejado dos más, 0068 (una sola regla para el número del paso y para
-- «positivo») y 0069 (la cola dice si la cadencia está en pausa), que
-- reemplazaban enteras estas vistas invocando que «una migración aplicada
-- es inmutable». Ninguna de las tres estaba aplicada en ningún sitio, así
-- que aquí van fundidas con su definición final: el historial del esquema
-- tiene una definición de cada vista y el integrador aplica un archivo.
-- Lo que decían sus cabeceras vive en las secciones 1b, 2, 4 y 5. Y de
-- esa misma ronda: el embudo cuenta los fallidos que SÍ se pueden
-- reintentar y la fracción de cada paso sobre el primero (4), y la base
-- rechaza que un rol de solo lectura cancele o reintente la cola (6).
--
-- Reglas que respetan todas:
--   · security_invoker = on en las vistas (la prueba de esquema lo exige)
--     y SECURITY INVOKER en la función: leen con la RLS de quien consulta,
--     así que cada workspace ve solo lo suyo;
--   · sin escritura para mc_app en las vistas (REVOKE, como
--     outreach_channel_account_limits);
--   · solo nombran estados que existen en los CHECK de 0046 y 0056:
--     outbound_touch  draft, scheduled, processing, held, sent, failed,
--                     skipped, canceled;
--     outbound_enrollment  active, paused, completed, replied, opted_out,
--                     cooldown, bounced;
--     outbound_sequence  draft, active, paused, archived;
--     outreach_channel_account  pending, connected, needs_reconnect,
--                     error, disconnected;
--     outbound_message.intent  interested es el «positivo»;
--   · «enviado» es status = 'sent'. Abierto, respondido y positivo se
--     cuentan DENTRO de lo enviado, para que el embudo nunca crezca hacia
--     abajo y cuadre fila a fila con outbound_touch (la prueba de VEN-16
--     lo compara toque por toque).
--
-- Lo que NO está aquí, a propósito:
--   · la curva de calentamiento (VEN-15): la regla vive solo en
--     @mc/core (warmupDailyLimit). outbound_usage_daily da el día del
--     calentamiento (warmup_day) y el tope sin curva (daily_limit); la
--     consulta tipada de @mc/db (listChannelUsage) pasa la curva con la
--     misma función que el despachador y decide el semáforo;
--   · el texto del proveedor de un fallo: docs/ventas-outreach.md §9.2
--     («nunca el texto de un proveedor, y nunca una frase en la base»).
--     El detalle de un fallido es su código, traducido en la pantalla;
--   · el reintento y la cancelación: son escrituras de la web con su RLS
--     y los disparadores de siempre (@mc/db/queries/actividad).
--
-- Índices: ninguno nuevo. El historial pagina por (status_changed_at,
-- touch_id) dentro de (workspace_id, status), que ya cubre
-- outbound_touch_status_changed_idx (0046); la cola, por la hora a la que
-- toca, que cubre outbound_touch_due_idx.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · outbound_touch_retry_block
-- ---------------------------------------------------------------------
-- Por qué un fallido no vuelve a la cola, en este orden (el primero que
-- aplica es el que se dice). NULL: se puede reintentar. Un toque que no
-- está fallido también da NULL (no hay nada que bloquear).
--
--   not_retryable      la dirección no sirve (bounced, invalid_recipient)
--                      o el envío quedó a medias con el proveedor ya
--                      llamado (zombie): volvería a fallar o podría salir
--                      dos veces. Es NOT_RETRYABLE_FAILURES de
--                      @mc/db/queries/actividad; la prueba compara las dos.
--   too_many_attempts  attempt_count ya está en 19: el siguiente reclamo
--                      lo sube a 20, el techo del CHECK de 0046. Uno más
--                      violaría el CHECK en el UPDATE del reclamo, que es
--                      uno solo por lote y para todos los workspaces: el
--                      despachador se pararía para todos.
--   sequence_archived  la secuencia está archivada.
--   enrollment_closed  la persona respondió, se dio de baja o rebotó en
--                      esa cadencia: el despachador lo cancelaría.
--   superseded         ya salió un paso posterior de la misma cadencia.
--   opted_out          la ficha pidió la baja, la dirección (la del envío
--                      o la de la ficha) está en la baja global
--                      (address_is_suppressed), o está en la baja de ESTE
--                      espacio (outbound_workspace_optout, 0055 §8.1: el
--                      enlace de un correo, que en una ficha pública
--                      compartida no marca contact.opted_out). Son las
--                      tres fuentes de enforce_outbound_optout: lo que
--                      esa regla frenaría no se ofrece.
--   email_invalid      un correo, y el correo de la ficha rebotó.
--   account_down       el fallo fue de la cuenta del canal
--                      (account_unavailable, account_auth, token_expired,
--                      secret_missing, not_configured) y el espacio no
--                      tiene ninguna cuenta conectada de ese canal: el
--                      reclamo no encontraría con qué enviarlo. Primero
--                      hay que reconectar.
CREATE FUNCTION outbound_touch_retry_block(t outbound_touch)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT CASE
    WHEN t.status <> 'failed' THEN NULL
    WHEN split_part(coalesce(t.blocked_reason, ''), ':', 1) IN ('bounced', 'invalid_recipient', 'zombie')
      THEN 'not_retryable'
    WHEN t.attempt_count >= 19 THEN 'too_many_attempts'
    WHEN EXISTS (SELECT 1 FROM outbound_sequence s WHERE s.id = t.sequence_id AND s.status = 'archived')
      THEN 'sequence_archived'
    WHEN EXISTS (SELECT 1 FROM outbound_enrollment e
                  WHERE e.id = t.enrollment_id AND e.status IN ('replied', 'opted_out', 'bounced'))
      THEN 'enrollment_closed'
    WHEN t.enrollment_id IS NOT NULL AND EXISTS (
           SELECT 1
             FROM outbound_step st
             JOIN outbound_touch o ON o.enrollment_id = t.enrollment_id AND o.status = 'sent'
             JOIN outbound_step so ON so.id = o.step_id
            WHERE st.id = t.step_id
              AND (so.day_offset, so.order_in_day) > (st.day_offset, st.order_in_day))
      THEN 'superseded'
    WHEN address_is_suppressed(t.recipient_address::citext)
         OR EXISTS (SELECT 1 FROM contact c
                     WHERE c.id = t.contact_id AND (c.opted_out OR address_is_suppressed(c.email)))
         OR EXISTS (SELECT 1 FROM outbound_workspace_optout o
                     WHERE o.workspace_id = t.workspace_id
                       AND (o.email = t.recipient_address::citext
                            OR o.email = (SELECT c.email FROM contact c WHERE c.id = t.contact_id)))
      THEN 'opted_out'
    WHEN t.channel = 'email' AND EXISTS (SELECT 1 FROM contact c WHERE c.id = t.contact_id AND c.email_invalid)
      THEN 'email_invalid'
    WHEN split_part(coalesce(t.blocked_reason, ''), ':', 1)
           IN ('account_unavailable', 'account_auth', 'token_expired', 'secret_missing', 'not_configured')
         AND NOT EXISTS (SELECT 1 FROM outreach_channel_account a
                          WHERE a.workspace_id = t.workspace_id AND a.channel = t.channel AND a.status = 'connected')
      THEN 'account_down'
  END;
$$;

REVOKE ALL ON FUNCTION outbound_touch_retry_block(outbound_touch) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbound_touch_retry_block(outbound_touch) TO mc_app, mc_worker;
COMMENT ON FUNCTION outbound_touch_retry_block(outbound_touch) IS
  'Por qué un toque fallido no puede volver a la cola (VEN-16, 0072), o NULL si puede: not_retryable, too_many_attempts, '
  'sequence_archived, enrollment_closed, superseded, opted_out, email_invalid, account_down. Con la RLS de quien llama.';

-- ---------------------------------------------------------------------
-- 1b · Una sola regla para el número del paso y para «positivo»
-- ---------------------------------------------------------------------
-- El número de un paso (row_number por sequence_id, en el orden
-- day_offset, order_in_day, id) y «positivo» estaban copiados en varias
-- vistas: si alguien cambiaba el orden en una, la cola decía «Paso 3» de
-- un toque que el embudo contaba como paso 2, y un «me interesa» sin
-- replied_at contaba como positivo sin contar como respondido.
-- outbound_step_order_idx (0046) hace única la pareja (sequence_id,
-- day_offset, order_in_day), así que el id solo desempata en teoría; el
-- orden es el de «un paso posterior» de outbound_touch_retry_block y el
-- de la línea de tiempo de /ventas/cadencias.
CREATE VIEW outbound_step_position WITH (security_invoker = on) AS
SELECT st.id AS step_id,
       st.workspace_id,
       st.sequence_id,
       row_number() OVER (PARTITION BY st.sequence_id ORDER BY st.day_offset, st.order_in_day, st.id)::int AS position
  FROM outbound_step st;

REVOKE INSERT, UPDATE, DELETE ON outbound_step_position FROM mc_app;
COMMENT ON VIEW outbound_step_position IS
  'El número de cada paso dentro de su secuencia (VEN-16), en el orden de la línea de tiempo: day_offset, '
  'order_in_day, id. Una sola definición: la usan outbound_queue y outbound_funnel_by_step.';

-- Positivo = enviado (status 'sent'), respondido (replied_at, que marca
-- la primera respuesta de verdad; un «fuera de oficina» no) y con al
-- menos una respuesta ENTRANTE de ese toque clasificada como interested
-- (outbound_message.intent). Pedir replied_at es lo que garantiza que el
-- embudo no crezca hacia abajo aunque una clasificación llegue sin él.
CREATE FUNCTION outbound_touch_is_positive(t outbound_touch)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT t.status = 'sent'
     AND t.replied_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM outbound_message m
                  WHERE m.touch_id = t.id AND m.direction = 'inbound' AND m.intent = 'interested');
$$;

REVOKE ALL ON FUNCTION outbound_touch_is_positive(outbound_touch) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbound_touch_is_positive(outbound_touch) TO mc_app, mc_worker;
COMMENT ON FUNCTION outbound_touch_is_positive(outbound_touch) IS
  'Un toque positivo (VEN-16, 0072): enviado, respondido (replied_at) y con una respuesta entrante clasificada como '
  'interested. Positivo ⊆ respondido ⊆ enviado. Con la RLS de quien llama.';

-- ---------------------------------------------------------------------
-- 2 · outbound_queue
-- ---------------------------------------------------------------------
-- bucket:
--   queue    lo que todavía puede salir o espera a una persona: draft,
--            scheduled, processing, held; y failed, que queda a la vista
--            hasta que alguien lo reintenta o lo descarta.
--   history  lo que terminó: sent, canceled, skipped.
-- reason: el código de por qué está así, nunca una frase (la pantalla lo
--   traduce): held_reason si está retenido (HOLD_CODES de @mc/core, con
--   su dato tras «:»), blocked_reason si falló, se canceló o se saltó, y
--   en un enviado solo la anomalía (opted_out_in_flight) o la
--   confirmación a mano (sent_confirmed_by_user). En la cola, un
--   programado no lleva motivo: un blocked_reason viejo de antes del
--   reintento no se enseña.
-- retry_block: outbound_touch_retry_block (§1), solo en lo fallido. Un
--   fallido con retry_block NULL se puede reintentar; la pantalla no
--   ofrece el botón a uno bloqueado y dice por qué.
-- account_status: el estado de la cuenta del canal con la que se intentó
--   (NULL si no llegó a tener una).
-- due_at: cuándo toca (el reintento manda sobre la hora original), como
--   el índice outbound_touch_due_idx y el reclamo del despachador.
-- step_position: el número del paso dentro de su secuencia, en el orden
--   de la línea de tiempo (día, orden en el día, id), igual que
--   listSequenceSteps de @mc/db/queries/cadencias.
--
-- sequence_status (al final): el despachador no manda lo de una cadencia
-- en pausa o en borrador (decideBeforeSend lo aplaza cada día), así que la
-- fila no promete «Sale mañana»; junto con enrollment_status ('paused',
-- 'cooldown') dice por qué espera.
CREATE VIEW outbound_queue WITH (security_invoker = on) AS
SELECT t.id AS touch_id,
       t.workspace_id,
       t.status,
       CASE WHEN t.status IN ('sent', 'canceled', 'skipped') THEN 'history' ELSE 'queue' END AS bucket,
       t.channel,
       t.subject,
       t.sequence_id,
       s.name AS sequence_name,
       t.step_id,
       st.step_type,
       sp.position AS step_position,
       st.day_offset AS step_day_offset,
       t.enrollment_id,
       e.status AS enrollment_status,
       t.contact_id,
       c.full_name AS contact_name,
       c.email AS contact_email,
       t.company_id,
       co.name AS company_name,
       t.channel_account_id,
       coalesce(a.display_name, a.provider_account_id) AS account_name,
       a.status AS account_status,
       t.attempt_count,
       t.scheduled_for,
       t.next_retry_at,
       coalesce(t.next_retry_at, t.scheduled_for) AS due_at,
       (t.status = 'scheduled' AND t.next_retry_at IS NOT NULL) AS retrying,
       t.status_changed_at,
       t.sent_at,
       t.opened_at,
       t.replied_at,
       t.created_at,
       CASE t.status
         WHEN 'held' THEN t.held_reason
         WHEN 'failed' THEN t.blocked_reason
         WHEN 'canceled' THEN t.blocked_reason
         WHEN 'skipped' THEN t.blocked_reason
         WHEN 'sent' THEN t.blocked_reason
       END AS reason,
       CASE WHEN t.status = 'failed' THEN outbound_touch_retry_block(t) END AS retry_block,
       -- El estado de la secuencia (draft, active, paused, archived); NULL si el toque no tiene.
       s.status AS sequence_status
  FROM outbound_touch t
  LEFT JOIN outbound_sequence s ON s.id = t.sequence_id
  LEFT JOIN outbound_step st ON st.id = t.step_id
  LEFT JOIN outbound_step_position sp ON sp.step_id = t.step_id
  LEFT JOIN outbound_enrollment e ON e.id = t.enrollment_id
  LEFT JOIN contact c ON c.id = t.contact_id
  LEFT JOIN company co ON co.id = t.company_id
  LEFT JOIN outreach_channel_account a ON a.id = t.channel_account_id;

REVOKE INSERT, UPDATE, DELETE ON outbound_queue FROM mc_app;
COMMENT ON VIEW outbound_queue IS
  'La cola y el historial del outreach (VEN-16, 0072): un toque por fila con su estado, su paso, su '
  'contacto, su cuenta (y el estado de esa cuenta), el estado de su secuencia (sequence_status) y de su inscripción '
  '(enrollment_status), el código de su motivo (reason) y, en lo fallido, por qué no se puede reintentar (retry_block, '
  'NULL si se puede). bucket = queue (draft, scheduled, processing, held, failed) o history (sent, canceled, skipped). '
  'La pantalla /ventas/actividad lee de aquí; nadie recalcula.';

-- ---------------------------------------------------------------------
-- 3 · outbound_usage_daily
-- ---------------------------------------------------------------------
-- Una fila por cuenta viva (connected, needs_reconnect, error) y por día
-- local del workspace, de hoy a 13 días atrás (el día de hoy es is_today).
-- El día es el de los contadores: outreach_local_date, la misma función
-- con la que outbound_counter_bump_at (0057 §3) elige la fila que suma.
-- La zona del workspace es siempre una zona IANA válida (0044), así que
-- aquí no se consulta pg_timezone_names.
--
-- Los tres topes del reclamo (claimDueTouches, 0057), en el mismo orden:
--   used / daily_limit          el día de la cuenta: outbound_counter
--                               period 'day' de la cuenta (todas sus
--                               acciones) contra effective_daily de
--                               outreach_channel_account_limits, SIN la
--                               curva de calentamiento. Un día sin fila
--                               es 0.
--   week_used / weekly_limit    la semana de la cuenta que contiene ese
--                               día (period 'week', el lunes local, como
--                               la fila que suma el reclamo) contra
--                               effective_weekly.
--   workspace_used /            solo el correo: el contador del espacio
--   workspace_daily_limit       entero (channel_account_id NULL, acción
--                               'email', ese día) contra
--                               outbound_policy.max_emails_per_day (20,
--                               el valor por defecto de la tabla, si no
--                               hay política). NULL en los demás canales.
--   provider_limit              el techo del proveedor (provider_daily):
--                               por encima, el proveedor castiga la cuenta.
--   warmup_day                  el día del calentamiento en ese día local
--                               (el día de la conexión es el 1, nunca
--                               menos), como warmupDay de @mc/core; NULL
--                               si la cuenta no calienta
--                               (warmup_started_at vacío). La prueba de
--                               VEN-16 lo compara con warmupDay.
--   warmup_days                 outbound_policy.warmup_days (14 sin
--                               política).
--   outreach_enabled            el interruptor del outreach del espacio:
--                               apagado, el reclamo no toma nada
--                               (claimDueTouches une outbound_policy con
--                               p.enabled), aunque haya cupo.
--
-- Los contadores se leen solo en la ventana que se pinta: los 14 días
-- (uso_dia, espacio) y las semanas que los contienen (uso_semana: el
-- lunes de la semana del día más viejo cae, como mucho, 6 días antes, así
-- que 13 + 6 = 19). Cada CTE lleva su filtro: sin él, el CTE que se usaba
-- dos veces se materializaba con TODO el historial de outbound_counter
-- en cada lectura del widget, y crecía sin límite.
--
-- provider: el servicio de la cuenta (gmail_oauth, unipile), para decir
-- quién pone el techo del proveedor.
--
-- Los límites son los de HOY aplicados a los 14 días: la base no guarda
-- el tope que regía cada día (es una foto, no una serie). La semana de un
-- día pasado es la cifra final de esa semana, no la de ese día.
CREATE VIEW outbound_usage_daily WITH (security_invoker = on) AS
WITH dias AS (
  SELECT w.id AS workspace_id, w.timezone AS tz, (outreach_local_date(w.id, now()) - g) AS day, (g = 0) AS is_today
    FROM workspace w CROSS JOIN generate_series(0, 13) AS g
),
uso_dia AS (
  SELECT c.channel_account_id, c.period_start, sum(c.count)::int AS used
    FROM outbound_counter c
   WHERE c.channel_account_id IS NOT NULL AND c.period = 'day'
     AND c.period_start >= outreach_local_date(c.workspace_id, now()) - 13
   GROUP BY c.channel_account_id, c.period_start
),
uso_semana AS (
  SELECT c.channel_account_id, c.period_start, sum(c.count)::int AS used
    FROM outbound_counter c
   WHERE c.channel_account_id IS NOT NULL AND c.period = 'week'
     AND c.period_start >= outreach_local_date(c.workspace_id, now()) - 19
   GROUP BY c.channel_account_id, c.period_start
),
espacio AS (
  SELECT c.workspace_id, c.period_start, sum(c.count)::int AS used
    FROM outbound_counter c
   WHERE c.channel_account_id IS NULL AND c.period = 'day' AND c.action_type = 'email'
     AND c.period_start >= outreach_local_date(c.workspace_id, now()) - 13
   GROUP BY c.workspace_id, c.period_start
)
SELECT a.id AS channel_account_id,
       a.workspace_id,
       a.channel,
       a.status AS account_status,
       a.provider,
       coalesce(a.display_name, a.provider_account_id) AS account_name,
       d.day,
       d.is_today,
       coalesce(u.used, 0) AS used,
       l.effective_daily AS daily_limit,
       coalesce(wk.used, 0) AS week_used,
       l.effective_weekly AS weekly_limit,
       CASE WHEN a.channel = 'email' THEN coalesce(ws.used, 0) END AS workspace_used,
       CASE WHEN a.channel = 'email' THEN coalesce(p.max_emails_per_day, 20) END AS workspace_daily_limit,
       l.provider_daily AS provider_limit,
       CASE WHEN a.warmup_started_at IS NOT NULL
            THEN greatest(1, d.day - (a.warmup_started_at AT TIME ZONE d.tz)::date + 1)
       END AS warmup_day,
       coalesce(p.warmup_days, 14) AS warmup_days,
       coalesce(p.enabled, false) AS outreach_enabled
  FROM outreach_channel_account a
  JOIN outreach_channel_account_limits l ON l.channel_account_id = a.id
  JOIN dias d ON d.workspace_id = a.workspace_id
  LEFT JOIN uso_dia u ON u.channel_account_id = a.id AND u.period_start = d.day
  LEFT JOIN uso_semana wk ON wk.channel_account_id = a.id
                         AND wk.period_start = d.day - (extract(isodow FROM d.day)::int - 1)
  LEFT JOIN espacio ws ON ws.workspace_id = a.workspace_id AND ws.period_start = d.day
  LEFT JOIN outbound_policy p ON p.workspace_id = a.workspace_id
 WHERE a.status IN ('connected', 'needs_reconnect', 'error');

REVOKE INSERT, UPDATE, DELETE ON outbound_usage_daily FROM mc_app;
COMMENT ON VIEW outbound_usage_daily IS
  'El uso de cada cuenta de canal viva en los últimos 14 días locales del workspace (VEN-16, 0072), contra los tres topes '
  'del reclamo: el diario de la cuenta sin calentamiento (used, daily_limit), el semanal de la cuenta (week_used, '
  'weekly_limit) y, en el correo, el diario del espacio (workspace_used, workspace_daily_limit); más el techo del '
  'proveedor, el día del calentamiento y el interruptor del outreach. La curva y el semáforo los pone listChannelUsage '
  'con warmupDailyLimit de @mc/core.';

-- ---------------------------------------------------------------------
-- 4 · outbound_funnel_by_step
-- ---------------------------------------------------------------------
-- Una fila por paso de cada secuencia (también los pasos sin toques, en
-- cero), en el orden de la línea de tiempo. Cuenta los toques del paso
-- (outbound_touch.step_id); un toque sin paso (los de 0007) no entra en
-- ningún embudo.
--
--   sent       status = 'sent'
--   opened     enviados con opened_at (solo el correo tiene píxel:
--              opens_tracked dice si el número significa algo)
--   replied    enviados con replied_at (lo marca la primera respuesta de
--              verdad; un «fuera de oficina» no, inbound.ts)
--   positive   enviados con al menos una respuesta ENTRANTE de ese toque
--              clasificada como interested (outbound_message.intent)
--   pending    draft, scheduled, processing, held: todavía pueden salir
--   failed     failed
--   stopped    canceled o skipped: no salieron ni van a salir
--   *_rate     sobre lo enviado, con cuatro decimales; NULL sin envíos
--              (0 de 0 no es 0 %)
--
-- pending + failed + stopped + sent = touches: cada toque cae en uno.
--
-- failed_retryable: de lo fallido, lo que outbound_touch_retry_block deja
-- volver a la cola (un rebote o una cuenta caída no): el embudo no promete
-- un «Reintentar» que la actividad no ofrece.
-- sent_share_of_first, opened_share_of_first, replied_share_of_first: lo
-- de este paso sobre lo enviado en el primero, para la barra de la vista
-- de flujo (cuánto retiene cada paso), sin aritmética en la pantalla.
CREATE VIEW outbound_funnel_by_step WITH (security_invoker = on) AS
WITH toques AS (
  SELECT t.step_id,
         count(*)::int AS touches,
         count(*) FILTER (WHERE t.status = 'sent')::int AS sent,
         count(*) FILTER (WHERE t.status = 'sent' AND t.opened_at IS NOT NULL)::int AS opened,
         count(*) FILTER (WHERE t.status = 'sent' AND t.replied_at IS NOT NULL)::int AS replied,
         count(*) FILTER (WHERE outbound_touch_is_positive(t))::int AS positive,
         count(*) FILTER (WHERE t.status IN ('draft', 'scheduled', 'processing', 'held'))::int AS pending,
         count(*) FILTER (WHERE t.status = 'failed')::int AS failed,
         count(*) FILTER (WHERE t.status IN ('canceled', 'skipped'))::int AS stopped,
         count(*) FILTER (WHERE t.status = 'failed' AND outbound_touch_retry_block(t) IS NULL)::int AS failed_retryable
    FROM outbound_touch t
   WHERE t.step_id IS NOT NULL
   GROUP BY t.step_id
)
SELECT st.workspace_id,
       st.sequence_id,
       s.name AS sequence_name,
       st.id AS step_id,
       sp.position AS step_position,
       st.step_type,
       st.channel,
       st.day_offset,
       st.order_in_day,
       (st.channel = 'email') AS opens_tracked,
       coalesce(x.touches, 0) AS touches,
       coalesce(x.sent, 0) AS sent,
       coalesce(x.opened, 0) AS opened,
       coalesce(x.replied, 0) AS replied,
       coalesce(x.positive, 0) AS positive,
       coalesce(x.pending, 0) AS pending,
       coalesce(x.failed, 0) AS failed,
       coalesce(x.stopped, 0) AS stopped,
       CASE WHEN coalesce(x.sent, 0) > 0 THEN round(x.opened::numeric / x.sent, 4) END AS open_rate,
       CASE WHEN coalesce(x.sent, 0) > 0 THEN round(x.replied::numeric / x.sent, 4) END AS reply_rate,
       CASE WHEN coalesce(x.sent, 0) > 0 THEN round(x.positive::numeric / x.sent, 4) END AS positive_rate,
       coalesce(x.failed_retryable, 0) AS failed_retryable,
       -- La caída de un paso al siguiente: lo enviado, abierto y respondido de ESTE paso como fracción de lo
       -- enviado en el primero de su secuencia (entre 0 y 1; NULL si el primero no envió nada). La pantalla lo
       -- pinta como una barra fina sin hacer la división.
       CASE WHEN first_value(coalesce(x.sent, 0)) OVER w > 0
            THEN least(1, round(coalesce(x.sent, 0)::numeric / first_value(coalesce(x.sent, 0)) OVER w, 4)) END AS sent_share_of_first,
       CASE WHEN first_value(coalesce(x.sent, 0)) OVER w > 0
            THEN least(1, round(coalesce(x.opened, 0)::numeric / first_value(coalesce(x.sent, 0)) OVER w, 4)) END AS opened_share_of_first,
       CASE WHEN first_value(coalesce(x.sent, 0)) OVER w > 0
            THEN least(1, round(coalesce(x.replied, 0)::numeric / first_value(coalesce(x.sent, 0)) OVER w, 4)) END AS replied_share_of_first
  FROM outbound_step st
  JOIN outbound_step_position sp ON sp.step_id = st.id
  JOIN outbound_sequence s ON s.id = st.sequence_id
  LEFT JOIN toques x ON x.step_id = st.id
WINDOW w AS (PARTITION BY st.sequence_id ORDER BY sp.position ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING);

COMMENT ON VIEW outbound_funnel_by_step IS
  'El embudo de cada paso de cada secuencia (VEN-16, 0072): enviados, abiertos, respondidos y positivos (dentro '
  'de lo enviado; positivo = outbound_touch_is_positive, siempre dentro de lo respondido), lo que sigue en cola, lo '
  'fallido (y cuánto de eso se puede reintentar, failed_retryable) y lo detenido, con las tasas sobre lo enviado y la '
  'fracción de lo enviado, abierto y respondido sobre lo enviado en el primer paso (*_share_of_first, entre 0 y 1). '
  'El número del paso sale de outbound_step_position. Cuadra con outbound_touch fila a fila.';
REVOKE INSERT, UPDATE, DELETE ON outbound_funnel_by_step FROM mc_app;

-- ---------------------------------------------------------------------
-- 5 · outbound_sequence_health
-- ---------------------------------------------------------------------
-- Una fila por secuencia. Cuenta los toques por outbound_touch.sequence_id
-- (todos, tengan paso o no) y los enrolamientos por su estado.
--
--   enrolled_*        active; paused (paused y cooldown); replied;
--                     completed; stopped (opted_out y bounced)
--   pending           draft, scheduled y processing (lo que sale solo)
--   held              retenidos: esperan a una persona
--   failed            fallidos que siguen a la vista (nadie los reintentó
--                     ni los descartó)
--   sent_7d, failed_7d  enviados (sent_at) y fallidos (status_changed_at)
--                     en los últimos 7 días
--   failure_rate_7d   failed_7d / (sent_7d + failed_7d); NULL sin nada
--   health            el semáforo, en este orden:
--                       inactive   la secuencia no está 'active'
--                       failing    3 o más fallidos en 7 días y al menos
--                                  el 20 % de lo intentado
--                       attention  algún fallido a la vista o algún
--                                  retenido: hay algo que hacer
--                       healthy    lo demás
CREATE VIEW outbound_sequence_health WITH (security_invoker = on) AS
WITH toques AS (
  SELECT t.sequence_id,
         count(*) FILTER (WHERE t.status IN ('draft', 'scheduled', 'processing'))::int AS pending,
         count(*) FILTER (WHERE t.status = 'held')::int AS held,
         count(*) FILTER (WHERE t.status = 'failed')::int AS failed,
         count(*) FILTER (WHERE t.status = 'sent')::int AS sent,
         count(*) FILTER (WHERE t.status = 'sent' AND t.replied_at IS NOT NULL)::int AS replied,
         count(*) FILTER (WHERE outbound_touch_is_positive(t))::int AS positive,
         count(*) FILTER (WHERE t.status = 'sent' AND t.sent_at >= now() - interval '7 days')::int AS sent_7d,
         count(*) FILTER (WHERE t.status = 'failed' AND t.status_changed_at >= now() - interval '7 days')::int AS failed_7d,
         max(t.sent_at) FILTER (WHERE t.status = 'sent') AS last_sent_at,
         min(coalesce(t.next_retry_at, t.scheduled_for)) FILTER (WHERE t.status = 'scheduled') AS next_due_at
    FROM outbound_touch t
   WHERE t.sequence_id IS NOT NULL
   GROUP BY t.sequence_id
),
enrolados AS (
  SELECT e.sequence_id,
         count(*)::int AS enrolled,
         count(*) FILTER (WHERE e.status = 'active')::int AS active,
         count(*) FILTER (WHERE e.status IN ('paused', 'cooldown'))::int AS paused,
         count(*) FILTER (WHERE e.status = 'replied')::int AS replied,
         count(*) FILTER (WHERE e.status = 'completed')::int AS completed,
         count(*) FILTER (WHERE e.status IN ('opted_out', 'bounced'))::int AS stopped
    FROM outbound_enrollment e
   GROUP BY e.sequence_id
),
pasos AS (
  SELECT st.sequence_id, count(*)::int AS steps FROM outbound_step st GROUP BY st.sequence_id
),
todo AS (
  SELECT s.id AS sequence_id, s.workspace_id, s.name, s.status,
         coalesce(p.steps, 0) AS steps,
         coalesce(e.enrolled, 0) AS enrolled,
         coalesce(e.active, 0) AS enrolled_active,
         coalesce(e.paused, 0) AS enrolled_paused,
         coalesce(e.replied, 0) AS enrolled_replied,
         coalesce(e.completed, 0) AS enrolled_completed,
         coalesce(e.stopped, 0) AS enrolled_stopped,
         coalesce(x.pending, 0) AS pending,
         coalesce(x.held, 0) AS held,
         coalesce(x.failed, 0) AS failed,
         coalesce(x.sent, 0) AS sent,
         coalesce(x.replied, 0) AS replied,
         coalesce(x.positive, 0) AS positive,
         coalesce(x.sent_7d, 0) AS sent_7d,
         coalesce(x.failed_7d, 0) AS failed_7d,
         x.last_sent_at,
         x.next_due_at
    FROM outbound_sequence s
    LEFT JOIN pasos p ON p.sequence_id = s.id
    LEFT JOIN enrolados e ON e.sequence_id = s.id
    LEFT JOIN toques x ON x.sequence_id = s.id
)
SELECT t.*,
       CASE WHEN t.sent > 0 THEN round(t.replied::numeric / t.sent, 4) END AS reply_rate,
       CASE WHEN t.sent > 0 THEN round(t.positive::numeric / t.sent, 4) END AS positive_rate,
       CASE WHEN t.sent_7d + t.failed_7d > 0 THEN round(t.failed_7d::numeric / (t.sent_7d + t.failed_7d), 4) END AS failure_rate_7d,
       CASE
         WHEN t.status <> 'active' THEN 'inactive'
         WHEN t.failed_7d >= 3 AND t.failed_7d * 5 >= t.sent_7d + t.failed_7d THEN 'failing'
         WHEN t.failed > 0 OR t.held > 0 THEN 'attention'
         ELSE 'healthy'
       END AS health
  FROM todo t;

COMMENT ON VIEW outbound_sequence_health IS
  'La salud de cada secuencia (VEN-16, 0072): enrolamientos por estado, la cola viva, lo retenido y lo fallido, '
  'lo enviado y lo fallido en 7 días, las tasas sobre lo enviado (positivo = outbound_touch_is_positive, lo mismo que '
  'el embudo) y un semáforo (health: inactive, failing, attention, healthy).';
REVOKE INSERT, UPDATE, DELETE ON outbound_sequence_health FROM mc_app;

-- ---------------------------------------------------------------------
-- 6 · La base también dice quién opera la cola
-- ---------------------------------------------------------------------
-- Cancelar mensajes a marcas o devolver a la cola lo fallido es de quien
-- trabaja las cadencias ('owner', 'admin', 'member'). La web lo mira en
-- cada Server Action (PUEDEN_OPERAR_LA_COLA, PUEDEN_OPERAR_VENTAS), pero
-- la RLS de outbound_touch es por workspace: otro camino de escritura con
-- la sesión de un 'viewer' o un 'client' (una acción futura, una ruta
-- API) podía mover la cola. Como la política de envío (0055,
-- outreach_can_manage), la base falla cerrada:
--
--   · solo mira a mc_app con una persona en la sesión (app.user_id). El
--     worker (mc_worker), el enlace de baja (mc_public_share) y quien
--     migra no cambian; sin sesión, la bandera app.auth_disabled
--     (desarrollo sin Supabase Auth, pruebas) tampoco;
--   · rechaza (42501) pasar un toque a 'canceled' y devolver a
--     'scheduled' uno 'failed' si esa persona no es owner, admin o member
--     del workspace del toque.
-- ---------------------------------------------------------------------
-- Con y sin los roles de main (pulido r2), como outreach_can_manage
-- (0055 §7): con 0034_access_control, «owner, admin o member» es todo rol
-- que no sea de solo lectura ni de finanzas (el relleno llevó member a
-- editor en un creador y a manager en una agencia).
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'membership' AND column_name = 'role_id') THEN
    EXECUTE $f$
      CREATE FUNCTION outreach_can_operate(p_workspace uuid)
      RETURNS boolean
      LANGUAGE sql
      STABLE
      SET search_path = public, extensions, pg_temp
      AS $b$
        SELECT (current_user_id() IS NULL AND coalesce(current_setting('app.auth_disabled', true), '') = 'on')
            OR EXISTS (SELECT 1 FROM membership m JOIN role r ON r.id = m.role_id
                        WHERE m.workspace_id = p_workspace
                          AND m.user_id = current_user_id()
                          AND r.key IN ('owner', 'admin', 'manager', 'editor'));
      $b$
    $f$;
  ELSE
    EXECUTE $f$
      CREATE FUNCTION outreach_can_operate(p_workspace uuid)
      RETURNS boolean
      LANGUAGE sql
      STABLE
      SET search_path = public, extensions, pg_temp
      AS $b$
        SELECT (current_user_id() IS NULL AND coalesce(current_setting('app.auth_disabled', true), '') = 'on')
            OR EXISTS (SELECT 1 FROM membership m
                        WHERE m.workspace_id = p_workspace
                          AND m.user_id = current_user_id()
                          AND m.role IN ('owner', 'admin', 'member'));
      $b$
    $f$;
  END IF;
END
$do$;

REVOKE ALL ON FUNCTION outreach_can_operate(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outreach_can_operate(uuid) TO mc_app, mc_worker;
COMMENT ON FUNCTION outreach_can_operate(uuid) IS
  'Si quien está en la transacción puede operar la cola del outreach del workspace: owner, admin o member (VEN-16). '
  'Sin identidad responde que no, salvo con app.auth_disabled = ''on'' (desarrollo sin Supabase Auth, pruebas). '
  'Corre con los privilegios de quien llama: mc_app solo ve las membresías del workspace fijado y las suyas.';

CREATE FUNCTION outbound_touch_guard_operator()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  -- En dos pasos: una sola expresión no garantiza el orden de evaluación, y
  -- quien no es mc_app (el enlace de baja, mc_public_share) no puede llamar
  -- a outreach_can_operate.
  IF current_user <> 'mc_app' THEN
    RETURN NEW;
  END IF;
  IF current_user_id() IS NULL THEN
    RETURN NEW;
  END IF;
  IF ((NEW.status = 'canceled' AND OLD.status IS DISTINCT FROM 'canceled')
      OR (OLD.status = 'failed' AND NEW.status = 'scheduled')) THEN
    IF NOT outreach_can_operate(NEW.workspace_id) THEN
      RAISE EXCEPTION 'Solo quien opera Ventas en este espacio (owner, admin o member) puede cancelar o reintentar mensajes.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION outbound_touch_guard_operator() IS
  'Rechaza (42501) que mc_app, con una persona en la sesión, cancele un toque o devuelva a la cola uno fallido si esa '
  'persona no es owner, admin o member del workspace (VEN-16, pulido r1). El worker y el enlace de baja no pasan por aquí.';

CREATE TRIGGER outbound_touch_guard_operator BEFORE UPDATE OF status ON outbound_touch
  FOR EACH ROW EXECUTE FUNCTION outbound_touch_guard_operator();
