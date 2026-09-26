-- =====================================================================
-- 0065 · Las bandejas, ronda 2 (VEN-14)
-- ---------------------------------------------------------------------
-- Número: va detrás de 0064_bandejas, de la misma historia, y no depende
-- de nada más. Si el integrador renumera 0064, esta va justo después.
--
-- 1 · outbound_message, lo que la clasificación necesitaba guardar
--
--   automatic         el lector del correo supo por las cabeceras
--                     (Auto-Submitted, X-Autoreply) que la respuesta es
--                     automática. NULL: el canal no lo dice (LinkedIn,
--                     Instagram) o llegó antes de 0065. El clasificador lo
--                     recibe en vez de un «no se sabe» fijo.
--   intent_reason     la frase del clasificador («Pide tarifas y una
--                     llamada»): la bandeja la enseña bajo la intención,
--                     el «por qué» de Stripe Radar para una respuesta.
--   intent_decision   la decisión ya PAGADA y todavía sin aplicar
--                     ({intent, confidence, returnDate, referral, reason,
--                     source}). El job la guarda en la misma transacción
--                     que registra el gasto; si aplicar los efectos falla,
--                     la siguiente corrida reintenta solo los efectos, sin
--                     volver a llamar al modelo. Se borra al aplicarse.
--   intent_attempts   cuántas veces falló aplicar esa decisión. Al tercer
--                     fallo el mensaje queda 'ambiguous' con confianza 0
--                     y una persona lo lee: nada queda en la cola para
--                     siempre (INTENT_MAX_ATTEMPTS en @mc/db).
--   done_at           la persona dio el hilo por atendido en la bandeja
--                     («Marcar como hecho», la «e» de Superhuman). Un hilo
--                     está hecho cuando todas sus respuestas lo están: una
--                     respuesta nueva lo devuelve a «Pendientes».
--
-- 2 · outbound_touch.inbox_dismissed_at
--
--   Una respuesta de la bandeja que no salió (cancelada o fallida) se
--   enseña con su motivo hasta que la persona la descarta. Solo la lee la
--   bandeja; el motor no la mira.
--
-- 3 · outreach_classifier_status(): ¿el worker clasifica con IA?
--
--   La web no tiene la llave (vive en el worker, como la del redactor,
--   0057). Lo sabe por la última corrida de outbound.intent: 'model',
--   'fake', 'off' (le falta ANTHROPIC_API_KEY) o 'unknown' (no corrió en
--   el último día). Sin clasificador, la bandeja dice «léela tú» en vez
--   de prometer que la IA la lee en unos minutos.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · outbound_message
-- ---------------------------------------------------------------------
ALTER TABLE outbound_message
  ADD COLUMN automatic boolean,
  ADD COLUMN intent_reason text CHECK (intent_reason IS NULL OR char_length(intent_reason) <= 300),
  ADD COLUMN intent_decision jsonb CHECK (intent_decision IS NULL OR jsonb_typeof(intent_decision) = 'object'),
  ADD COLUMN intent_attempts smallint NOT NULL DEFAULT 0 CHECK (intent_attempts >= 0),
  ADD COLUMN done_at timestamptz,
  ADD CONSTRAINT outbound_message_decision_pending_check CHECK (intent_decision IS NULL OR classified_at IS NULL);

COMMENT ON COLUMN outbound_message.automatic IS
  'La respuesta llegó con cabeceras de respuesta automática (Auto-Submitted, X-Autoreply). NULL: el canal no lo dice (0065).';
COMMENT ON COLUMN outbound_message.intent_reason IS
  'La frase del clasificador que explica la intención; la bandeja la enseña (0065).';
COMMENT ON COLUMN outbound_message.intent_decision IS
  'La clasificación ya pagada que falta aplicar: la siguiente corrida reintenta los efectos sin volver a llamar al modelo (0065).';
COMMENT ON COLUMN outbound_message.intent_attempts IS
  'Cuántas veces falló aplicar la intención de este mensaje; al tercer fallo queda ambigua para una persona (0065).';
COMMENT ON COLUMN outbound_message.done_at IS
  'La persona dio por atendida esta respuesta en la bandeja («Marcar como hecho», 0065).';

-- Lo que falta clasificar, por workspace y del más viejo al más nuevo: el
-- lote se reparte entre workspaces (listUnclassifiedInbound).
CREATE INDEX outbound_message_unclassified_ws_idx ON outbound_message (workspace_id, created_at)
  WHERE direction = 'inbound' AND classified_at IS NULL;

-- ---------------------------------------------------------------------
-- 2 · outbound_touch
-- ---------------------------------------------------------------------
ALTER TABLE outbound_touch ADD COLUMN inbox_dismissed_at timestamptz;

COMMENT ON COLUMN outbound_touch.inbox_dismissed_at IS
  'Una respuesta de la bandeja que no salió y la persona ya vio: deja de enseñarse con su motivo (0065).';

-- ---------------------------------------------------------------------
-- 3 · outreach_classifier_status
-- ---------------------------------------------------------------------
-- job_run de un cron no tiene workspace (la RLS se lo esconde a mc_app):
-- la función lee solo las filas de outbound.intent y devuelve una palabra,
-- como outreach_writer_status con las de outbound.generate (0057).
DROP POLICY IF EXISTS job_run_classifier_status_read ON job_run;
CREATE POLICY job_run_classifier_status_read ON job_run FOR SELECT TO CURRENT_USER
  USING (job_id = 'outbound.intent');

CREATE OR REPLACE FUNCTION outreach_classifier_status()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
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
       ORDER BY j.started_at DESC, j.id DESC
       LIMIT 1) r ON true
$$;

REVOKE ALL ON FUNCTION outreach_classifier_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outreach_classifier_status() TO mc_app;
COMMENT ON FUNCTION outreach_classifier_status() IS
  'model, fake, off o unknown: si el worker clasifica las respuestas con IA, según la última corrida de outbound.intent (0065).';
