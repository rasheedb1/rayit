-- =====================================================================
-- 0009 · Trabajos en segundo plano, notificaciones y observabilidad
-- ---------------------------------------------------------------------
-- La cola vive en Postgres (pg-boss). Razón: con dos programadores, un
-- Redis más es una pieza más que mantener, y el volumen real (miles de
-- trabajos al día, no millones) cabe de sobra. Cuando deje de caber, se
-- cambia el adaptador sin tocar la lógica.
--
-- Estas tablas NO son las internas de pg-boss (que viven en su propio
-- esquema): son la capa de negocio que nos deja responder "¿por qué esta
-- cuenta no se ha sincronizado?" sin leer logs.
-- =====================================================================

CREATE TABLE job_definition (
  id                  text PRIMARY KEY,        -- 'collect.post_metrics'
  label_es            text NOT NULL,
  queue               text NOT NULL,
  default_cron        text,
  timeout_s           int NOT NULL DEFAULT 300,
  max_attempts        int NOT NULL DEFAULT 5,
  -- Concurrencia por plataforma: respeta el rate limit de cada API.
  max_concurrency     int NOT NULL DEFAULT 4,
  enabled             boolean NOT NULL DEFAULT true
);

INSERT INTO job_definition (id, label_es, queue, default_cron, timeout_s, max_concurrency) VALUES
  ('oauth.refresh',          'Refrescar tokens OAuth',              'connections', '*/15 * * * *', 60,  8),
  ('collect.posts',          'Descubrir posts nuevos',              'collect',     '0 */6 * * *',  300, 4),
  ('collect.post_metrics',   'Snapshot de métricas por post',       'collect',     '0 5 * * *',    600, 4),
  ('collect.account_metrics','Snapshot de métricas de cuenta',      'collect',     '10 5 * * *',   300, 4),
  ('collect.demographics',   'Demografía de audiencia',             'collect',     '20 5 * * *',   300, 2),
  ('compute.baseline',       'Recalcular mediana del creador',      'compute',     '40 5 * * *',   300, 2),
  ('compute.post_score',     'Puntaje de cada post',                'compute',     '45 5 * * *',   300, 2),
  ('watch.external',         'Vigilar cuentas y hashtags del nicho','watch',       '0 4 * * *',    900, 2),
  ('watch.trends',           'Sonidos y hashtags en alza',          'watch',       '30 4 * * *',   600, 1),
  ('compute.trait_lift',     'Lift de rasgos por nicho',            'compute',     '0 6 * * *',    600, 1),
  ('video.probe',            'Ficha técnica del archivo',           'video',       NULL,           120, 8),
  ('video.analyze',          'Análisis de video segundo a segundo', 'video',       NULL,           1800, 4),
  ('video.preflight',        'Semáforo listo para publicar',        'video',       NULL,           120, 8),
  ('video.predict',          'Predicción de desempeño',             'video',       NULL,           300, 4),
  ('radar.scan',             'Radar de prospección',                'sales',       '0 3 * * *',    900, 2),
  ('outbound.dispatch',      'Enviar toques programados',           'sales',       '*/10 * * * *', 120, 2),
  ('brand.snapshot',         'Seguidores de marcas en campaña',     'campaigns',   '0 7 * * *',    600, 2),
  ('campaign.compute',       'Resultado de campaña',                'campaigns',   '30 7 * * *',   300, 2),
  ('report.generate',        'Generar y enviar reportes',           'reports',     '0 9 * * *',    600, 2),
  ('finance.reminders',      'Recordatorios de cobro',              'finance',     '0 10 * * *',   120, 1),
  ('model.calibrate',        'Calibrar el predictor',               'ml',          '0 2 * * 1',    3600, 1);

-- Ejecución concreta de un trabajo. Complementa a pg-boss con contexto
-- de negocio (a qué workspace y a qué entidad afectó).
CREATE TABLE job_run (
  id                  bigserial PRIMARY KEY,
  job_id              text NOT NULL REFERENCES job_definition(id),
  workspace_id        uuid REFERENCES workspace(id) ON DELETE CASCADE,
  entity_type         text,
  entity_id           uuid,
  status              text NOT NULL DEFAULT 'running'
                           CHECK (status IN ('running','ok','failed','skipped','partial')),
  attempt             int NOT NULL DEFAULT 1,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  duration_ms         int,
  items_processed     int NOT NULL DEFAULT 0,
  items_failed        int NOT NULL DEFAULT 0,
  error               text,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX ON job_run (job_id, started_at DESC);
CREATE INDEX ON job_run (workspace_id, started_at DESC);
CREATE INDEX ON job_run (status) WHERE status IN ('running','failed');

-- ---------------------------------------------------------------------
-- Notificaciones: una sola bandeja para señales del radar, seguimientos
-- vencidos, outliers, pagos y errores de conexión.
-- ---------------------------------------------------------------------
CREATE TABLE notification (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  user_id             uuid REFERENCES app_user(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN
                           ('outlier','breakout','signal','deal_due','deal_overdue',
                            'payment_received','invoice_overdue','connection_error',
                            'analysis_ready','report_sent','trend')),
  severity            text NOT NULL DEFAULT 'info'
                           CHECK (severity IN ('info','success','warning','critical')),
  title_es            text NOT NULL,
  body_es             text,
  entity_type         text,
  entity_id           uuid,
  action_url          text,
  read_at             timestamptz,
  dismissed_at        timestamptz,
  -- Entrega por canal externo.
  emailed_at          timestamptz,
  pushed_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON notification (workspace_id, created_at DESC);
CREATE INDEX ON notification (user_id, read_at) WHERE read_at IS NULL;

-- ---------------------------------------------------------------------
-- Webhooks entrantes (TikTok, Meta, pasarela de pagos). Se guardan
-- crudos antes de procesarlos: si el procesamiento falla se puede
-- reproducir sin perder el evento.
-- ---------------------------------------------------------------------
CREATE TABLE webhook_event (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider            text NOT NULL,
  event_type          text,
  external_id         text,
  signature_valid     boolean,
  payload             jsonb NOT NULL,
  headers             jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at         timestamptz NOT NULL DEFAULT now(),
  processed_at        timestamptz,
  process_status      text NOT NULL DEFAULT 'pending'
                           CHECK (process_status IN ('pending','ok','failed','ignored')),
  process_error       text,
  attempts            int NOT NULL DEFAULT 0
);
CREATE INDEX ON webhook_event (provider, received_at DESC);
CREATE INDEX ON webhook_event (process_status) WHERE process_status = 'pending';
CREATE UNIQUE INDEX ON webhook_event (provider, external_id) WHERE external_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- Banderas de funcionalidad, por workspace. Permite desplegar a
-- producción con el módulo apagado y encenderlo para un cliente piloto.
-- ---------------------------------------------------------------------
CREATE TABLE feature_flag (
  key                 text NOT NULL,
  workspace_id        uuid REFERENCES workspace(id) ON DELETE CASCADE,  -- NULL = global
  enabled             boolean NOT NULL DEFAULT false,
  rollout_pct         int NOT NULL DEFAULT 0 CHECK (rollout_pct BETWEEN 0 AND 100),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX feature_flag_ws_uk ON feature_flag (key, workspace_id) WHERE workspace_id IS NOT NULL;
CREATE UNIQUE INDEX feature_flag_global_uk ON feature_flag (key) WHERE workspace_id IS NULL;

INSERT INTO feature_flag (key, enabled) VALUES
  ('video_lab', true),
  ('sales_radar', true),
  ('outbound_send', false),      -- apagado hasta tener dominio y SPF/DKIM
  ('prediction_model', false),   -- apagado hasta tener datos de calibración
  ('agency_workspace', true),
  ('brand_portal', false);
