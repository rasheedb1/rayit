-- =====================================================================
-- 0002 · Cuentas sociales conectadas, tokens y estado de sincronización
-- ---------------------------------------------------------------------
-- Este es el punto más delicado del producto: de aquí sale TODO el dato
-- interno. Reglas que el esquema impone:
--   1. El token nunca se guarda en claro. Solo se guarda una referencia
--      al secreto (KMS / Vault / Supabase Vault) y los metadatos.
--   2. Cada conexión sabe exactamente qué scopes concedió el creador,
--      porque de eso depende qué métricas podemos pedir.
--   3. El estado de sincronización es explícito y observable: si una
--      cuenta lleva días sin refrescar, tiene que verse en la UI.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Plataformas soportadas. Tabla y no enum porque los límites cambian
-- y queremos versionarlos sin desplegar código.
-- ---------------------------------------------------------------------
CREATE TABLE platform (
  id                  text PRIMARY KEY
                           CHECK (id IN ('tiktok','instagram','facebook','youtube')),
  name                text NOT NULL,
  -- Límites verificados de cada API (posts/día, req/min, cuotas).
  limits              jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Capacidades: qué sabemos que SÍ entrega esta API. La UI lee esto
  -- para no prometer métricas que la plataforma no da.
  capabilities        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform (id, name, capabilities) VALUES
  ('tiktok',    'TikTok',    '{"demographics_per_post": false, "demographics_per_account": "business_only", "retention_curve": false, "skip_rate": false, "file_download": "unknown"}'),
  ('instagram', 'Instagram', '{"demographics_per_post": false, "demographics_per_account": true, "retention_curve": false, "skip_rate": true, "file_download": "own_media_only"}'),
  ('facebook',  'Facebook',  '{"demographics_per_post": "classic_video_only", "demographics_per_account": false, "retention_curve": false, "skip_rate": false}'),
  ('youtube',   'YouTube',   '{"demographics_per_post": true, "demographics_per_account": true, "retention_curve": true, "skip_rate": false}');

-- ---------------------------------------------------------------------
-- Conexión OAuth. Una fila por (creador × plataforma × cuenta).
-- ---------------------------------------------------------------------
CREATE TABLE social_connection (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  creator_id            uuid NOT NULL REFERENCES creator_profile(id) ON DELETE CASCADE,
  platform_id           text NOT NULL REFERENCES platform(id),

  -- Identidad en la plataforma
  external_account_id   text NOT NULL,        -- open_id / ig_user_id / channel_id / page_id
  handle                text,
  display_name          text,
  avatar_url            text,
  profile_url           text,

  -- Tipo de cuenta: condiciona qué métricas existen.
  -- TikTok: 'personal' monetiza con Creator Rewards pero NO da demografía
  -- por API; 'business' da demografía pero pierde Creator Rewards.
  account_type          text CHECK (account_type IN
                             ('personal','creator','business','page','channel','unknown'))
                             DEFAULT 'unknown',

  -- Credenciales: SOLO referencias. Nunca el token.
  secret_ref            text NOT NULL,        -- ruta en el vault
  scopes                text[] NOT NULL DEFAULT '{}',
  access_expires_at     timestamptz,
  refresh_expires_at    timestamptz,

  -- Vía de acceso: influye en qué podemos pedir y a quién culpar si falla.
  access_mode           text NOT NULL DEFAULT 'direct_oauth'
                             CHECK (access_mode IN
                             ('direct_oauth','business_portfolio','aggregator','manual_csv')),
  aggregator            text,                 -- 'phyllo' | 'ayrshare' | null

  -- Estado de salud de la conexión
  status                text NOT NULL DEFAULT 'active'
                             CHECK (status IN
                             ('active','expired','revoked','error','needs_reauth','disabled')),
  status_detail         text,
  last_synced_at        timestamptz,
  last_error_at         timestamptz,
  consecutive_failures  int NOT NULL DEFAULT 0,

  connected_at          timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,

  UNIQUE (platform_id, external_account_id, workspace_id)
);
CREATE INDEX ON social_connection (workspace_id, status) WHERE deleted_at IS NULL;
CREATE INDEX ON social_connection (creator_id) WHERE deleted_at IS NULL;
-- Cola de refresco: qué conexiones toca renovar pronto.
CREATE INDEX ON social_connection (access_expires_at)
  WHERE status = 'active' AND deleted_at IS NULL;
CREATE TRIGGER social_connection_updated BEFORE UPDATE ON social_connection
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Consentimiento explícito del creador. Requisito legal (habeas data en
-- Colombia, GDPR si hay usuarios en Europa) y requisito de las propias
-- plataformas para tratar datos de audiencia.
-- ---------------------------------------------------------------------
CREATE TABLE data_consent (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  creator_id        uuid NOT NULL REFERENCES creator_profile(id) ON DELETE CASCADE,
  connection_id     uuid REFERENCES social_connection(id) ON DELETE CASCADE,
  purpose           text NOT NULL
                         CHECK (purpose IN
                         ('analytics','publishing','audience_demographics',
                          'brand_reporting','ai_analysis','data_sharing_with_brands')),
  granted           boolean NOT NULL,
  granted_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  policy_version    text NOT NULL,
  evidence          jsonb NOT NULL DEFAULT '{}'::jsonb   -- ip, user agent, texto mostrado
);
CREATE INDEX ON data_consent (creator_id, purpose);

-- ---------------------------------------------------------------------
-- Bitácora de cada llamada saliente a una API de plataforma.
-- Sin esto es imposible depurar rate limits ni demostrar por qué falta
-- un dato en un reporte que una marca cuestiona.
-- ---------------------------------------------------------------------
CREATE TABLE api_call_log (
  id                bigserial PRIMARY KEY,
  connection_id     uuid REFERENCES social_connection(id) ON DELETE SET NULL,
  platform_id       text NOT NULL REFERENCES platform(id),
  endpoint          text NOT NULL,
  http_status       int,
  ok                boolean NOT NULL,
  error_code        text,
  error_message     text,
  request_units     int NOT NULL DEFAULT 1,   -- cuota consumida (YouTube cobra por unidades)
  duration_ms       int,
  rate_limited      boolean NOT NULL DEFAULT false,
  retry_after_s     int,
  called_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON api_call_log (platform_id, called_at DESC);
CREATE INDEX ON api_call_log (connection_id, called_at DESC);
-- Particionable por mes cuando crezca; por ahora un índice basta.

-- ---------------------------------------------------------------------
-- Cuota consumida por día y plataforma. Se actualiza con un upsert desde
-- el worker; permite frenar antes de que la API nos corte.
-- ---------------------------------------------------------------------
CREATE TABLE api_quota_usage (
  id                bigserial PRIMARY KEY,
  platform_id       text NOT NULL REFERENCES platform(id),
  -- NULL = cuota a nivel de app/proyecto (YouTube cobra por proyecto).
  connection_id     uuid REFERENCES social_connection(id) ON DELETE CASCADE,
  day               date NOT NULL,
  units_used        bigint NOT NULL DEFAULT 0,
  units_limit       bigint,
  calls             bigint NOT NULL DEFAULT 0
);
-- Dos índices únicos parciales en vez de una PK con expresión: Postgres
-- no admite COALESCE en una PRIMARY KEY, y esto además deja el upsert
-- explícito para los dos casos (cuota por conexión y cuota por app).
CREATE UNIQUE INDEX api_quota_usage_conn_uk
  ON api_quota_usage (platform_id, connection_id, day)
  WHERE connection_id IS NOT NULL;
CREATE UNIQUE INDEX api_quota_usage_app_uk
  ON api_quota_usage (platform_id, day)
  WHERE connection_id IS NULL;
