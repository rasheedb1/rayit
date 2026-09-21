-- =====================================================================
-- 0007 · Ventas: radar de prospección, CRM y outbound
-- ---------------------------------------------------------------------
-- El flujo es: señal pública → empresa → deal → cotización → campaña →
-- factura → cobro. Cada paso deja su fila, y la cadena se puede
-- reconstruir hacia atrás desde un pago hasta la señal que lo originó.
--
-- Sobre el outbound: el esquema hace cumplir los límites éticos en la
-- BASE, no solo en la interfaz. Frecuencia de contacto, baja voluntaria
-- y procedencia del dato son columnas, no buenas intenciones. Un
-- outbound que se pasa de la raya quema la reputación del creador, que
-- es su único activo.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Empresa. Global y deduplicada por dominio: si dos creadores prospectan
-- la misma marca, el enriquecimiento se hace una vez. La RELACIÓN con
-- esa empresa sí es por workspace (tabla company_link).
-- ---------------------------------------------------------------------
CREATE TABLE company (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  legal_name          text,
  domain              citext,
  country             char(2),
  city                text,
  industry            text,
  niche_slugs         text[] NOT NULL DEFAULT '{}',
  size_bucket         text CHECK (size_bucket IN ('micro','pyme','mediana','grande','enterprise')),
  logo_url            text,
  socials             jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Señales de que tiene presupuesto de marketing.
  runs_ads            boolean,
  ads_first_seen_at   timestamptz,
  ads_platforms       text[] NOT NULL DEFAULT '{}',
  enriched_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON company (domain) WHERE domain IS NOT NULL;
CREATE INDEX ON company USING gin (name gin_trgm_ops);
CREATE TRIGGER company_updated BEFORE UPDATE ON company
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE contact (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  full_name           text,
  role_title          text,
  email               citext,
  phone               text,
  linkedin_url        text,
  instagram_handle    text,
  -- Procedencia del dato de contacto. Obligatorio: si no sabemos de
  -- dónde salió un correo, no lo usamos para outbound.
  source              text NOT NULL
                           CHECK (source IN ('public_website','public_profile','user_provided',
                                             'inbound','enrichment_vendor','press')),
  source_url          text,
  -- Baja voluntaria. Global: si alguien pide no ser contactado, ningún
  -- creador de la plataforma lo vuelve a contactar.
  opted_out           boolean NOT NULL DEFAULT false,
  opted_out_at        timestamptz,
  opted_out_reason    text,
  bounced             boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON contact (company_id);
CREATE UNIQUE INDEX ON contact (email) WHERE email IS NOT NULL;
CREATE INDEX ON contact (opted_out) WHERE opted_out;

-- Relación entre un workspace y una empresa (su "cuenta" en el CRM).
CREATE TABLE company_link (
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  company_id          uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  owner_user_id       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  relationship        text NOT NULL DEFAULT 'prospect'
                           CHECK (relationship IN ('prospect','contacted','client','past_client','blocked')),
  -- Encaje entre la audiencia de la marca y la del creador: 0..1
  fit_score           numeric(5,4),
  fit_explain         jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, company_id)
);
CREATE INDEX ON company_link (workspace_id, relationship);

-- =====================================================================
-- RADAR: señales públicas de que una empresa está invirtiendo
-- =====================================================================
CREATE TABLE signal_source (
  id                  text PRIMARY KEY,        -- 'meta_ad_library'
  label_es            text NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('ads','collab','marketplace','jobs','press','season','manual')),
  is_public_data      boolean NOT NULL DEFAULT true,
  terms_url           text,
  enabled             boolean NOT NULL DEFAULT true,
  default_interval_h  int NOT NULL DEFAULT 24
);

INSERT INTO signal_source (id, label_es, kind) VALUES
  ('meta_ad_library',    'Biblioteca de anuncios de Meta',        'ads'),
  ('tiktok_top_ads',     'TikTok Creative Center · Top Ads',      'ads'),
  ('watchlist_collab',   'Colaboraciones pagadas en cuentas vigiladas', 'collab'),
  ('creator_marketplace','Marketplaces de creadores',             'marketplace'),
  ('job_posts',          'Vacantes de influencer marketing',      'jobs'),
  ('press_launches',     'Prensa y lanzamientos del sector',      'press'),
  ('season_calendar',    'Calendario de temporada',               'season'),
  ('manual',             'Añadida a mano',                        'manual');

CREATE TABLE signal (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  company_id          uuid REFERENCES company(id) ON DELETE CASCADE,
  source_id           text NOT NULL REFERENCES signal_source(id),

  headline_es         text NOT NULL,           -- '4 anuncios activos en Meta desde el 14 sep'
  detected_at         timestamptz NOT NULL DEFAULT now(),
  evidence_url        text,
  evidence            jsonb NOT NULL DEFAULT '{}'::jsonb,

  fit_score           numeric(5,4),
  budget_estimate     numeric(14,2),
  budget_currency     char(3),
  -- Dedup: la misma señal no debe aparecer dos veces en la bandeja.
  dedupe_key          text NOT NULL,

  status              text NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','accepted','discarded','expired','duplicate')),
  reviewed_by         uuid REFERENCES app_user(id) ON DELETE SET NULL,
  reviewed_at         timestamptz,
  discard_reason      text,
  UNIQUE (workspace_id, dedupe_key)
);
CREATE INDEX ON signal (workspace_id, status, fit_score DESC);
CREATE INDEX ON signal (company_id, detected_at DESC);

-- =====================================================================
-- Pipeline
-- =====================================================================
CREATE TABLE pipeline_stage (
  id                  text PRIMARY KEY,
  workspace_id        uuid REFERENCES workspace(id) ON DELETE CASCADE,  -- NULL = por defecto
  label_es            text NOT NULL,
  position            int  NOT NULL,
  default_probability numeric(5,4) NOT NULL,
  is_won              boolean NOT NULL DEFAULT false,
  is_lost             boolean NOT NULL DEFAULT false
);

INSERT INTO pipeline_stage (id, label_es, position, default_probability, is_won, is_lost) VALUES
  ('nuevo',        'Nuevo',             1, 0.05, false, false),
  ('contactado',   'Contactado',        2, 0.15, false, false),
  ('conversacion', 'En conversación',   3, 0.35, false, false),
  ('propuesta',    'Propuesta enviada', 4, 0.55, false, false),
  ('negociacion',  'Negociación',       5, 0.80, false, false),
  ('ganado',       'Ganado',            6, 1.00, true,  false),
  ('perdido',      'Perdido',           7, 0.00, false, true);

CREATE TABLE deal (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  company_id          uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  creator_id          uuid REFERENCES creator_profile(id) ON DELETE SET NULL,
  owner_user_id       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  origin_signal_id    uuid REFERENCES signal(id) ON DELETE SET NULL,

  name                text NOT NULL,           -- 'Lanzamiento desayunos'
  stage_id            text NOT NULL REFERENCES pipeline_stage(id),
  amount              numeric(14,2),
  currency            char(3) NOT NULL DEFAULT 'COP',
  probability         numeric(5,4),            -- si es NULL se usa la de la etapa
  expected_close_date date,

  -- Siguiente acción: el corazón operativo del CRM. Un deal sin
  -- siguiente acción es un deal muerto, y la UI lo señala.
  next_action         text,
  next_action_due     timestamptz,
  next_action_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,

  last_contact_at     timestamptz,
  won_at              timestamptz,
  lost_at             timestamptz,
  lost_reason         text CHECK (lost_reason IN
                           ('sin_presupuesto','eligio_otro_creador','sin_respuesta',
                            'fuera_de_tiempo','precio','no_encaja','otro')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON deal (workspace_id, stage_id);
CREATE INDEX ON deal (workspace_id, next_action_due) WHERE won_at IS NULL AND lost_at IS NULL;
CREATE INDEX ON deal (company_id);
CREATE TRIGGER deal_updated BEFORE UPDATE ON deal
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Historia de etapas: sin esto no se puede calcular ciclo de venta ni
-- tasa de conversión por etapa.
CREATE TABLE deal_stage_history (
  id                  bigserial PRIMARY KEY,
  deal_id             uuid NOT NULL REFERENCES deal(id) ON DELETE CASCADE,
  from_stage_id       text REFERENCES pipeline_stage(id),
  to_stage_id         text NOT NULL REFERENCES pipeline_stage(id),
  changed_by          uuid REFERENCES app_user(id) ON DELETE SET NULL,
  changed_at          timestamptz NOT NULL DEFAULT now(),
  days_in_stage       numeric(8,2)
);
CREATE INDEX ON deal_stage_history (deal_id, changed_at);

CREATE TABLE activity (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  company_id          uuid REFERENCES company(id) ON DELETE CASCADE,
  deal_id             uuid REFERENCES deal(id) ON DELETE CASCADE,
  contact_id          uuid REFERENCES contact(id) ON DELETE SET NULL,
  user_id             uuid REFERENCES app_user(id) ON DELETE SET NULL,
  kind                text NOT NULL CHECK (kind IN
                           ('note','email_sent','email_received','dm_sent','dm_received',
                            'call','meeting','proposal_sent','contract_sent','signal_detected',
                            'stage_change','report_sent','payment_received')),
  subject             text,
  body                text,
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  external_ref        text,                    -- message-id del correo
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX ON activity (deal_id, occurred_at DESC);
CREATE INDEX ON activity (company_id, occurred_at DESC);

-- =====================================================================
-- OUTBOUND con límites éticos aplicados en la base
-- =====================================================================

-- Lo que el creador carga: qué busca, qué acepta y qué no. El radar y
-- el generador de pitch trabajan a partir de esto.
CREATE TABLE outbound_brief (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  creator_id          uuid NOT NULL REFERENCES creator_profile(id) ON DELETE CASCADE,
  title               text NOT NULL,
  -- Qué busca
  wanted_categories   text[] NOT NULL DEFAULT '{}',
  wanted_countries    text[] NOT NULL DEFAULT '{}',
  min_budget          numeric(14,2),
  currency            char(3) NOT NULL DEFAULT 'COP',
  deliverables        jsonb NOT NULL DEFAULT '[]'::jsonb,
  availability_from   date,
  availability_to     date,
  -- Qué NO acepta: se respeta siempre, tanto en el radar como en el pitch.
  excluded_categories text[] NOT NULL DEFAULT '{}',
  excluded_companies  uuid[] NOT NULL DEFAULT '{}',
  requires_disclosure boolean NOT NULL DEFAULT true,
  notes               text,
  status              text NOT NULL DEFAULT 'active'
                           CHECK (status IN ('draft','active','paused','closed')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON outbound_brief (workspace_id, status);

-- Política de contacto del workspace. Los valores por defecto son
-- deliberadamente conservadores.
CREATE TABLE outbound_policy (
  workspace_id        uuid PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  max_touches_per_company   int NOT NULL DEFAULT 4,
  min_days_between_touches  int NOT NULL DEFAULT 3,
  max_emails_per_day        int NOT NULL DEFAULT 20,
  cooldown_days_after_no    int NOT NULL DEFAULT 180,
  require_optout_link       boolean NOT NULL DEFAULT true,
  require_human_review      boolean NOT NULL DEFAULT true,
  -- Prohibido inventar cifras: todo dato de desempeño en un pitch debe
  -- poder trazarse a una campaña o métrica real.
  claims_must_be_sourced    boolean NOT NULL DEFAULT true,
  allowed_channels          text[] NOT NULL DEFAULT '{email,linkedin,instagram_dm}',
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbound_sequence (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  brief_id            uuid REFERENCES outbound_brief(id) ON DELETE SET NULL,
  name                text NOT NULL,
  channel             text NOT NULL CHECK (channel IN ('email','linkedin','instagram_dm','whatsapp')),
  steps               jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{day:0,template:'pitch'},…]
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Cada toque enviado. Es la tabla que hace cumplir los límites.
CREATE TABLE outbound_touch (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  company_id          uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  contact_id          uuid REFERENCES contact(id) ON DELETE SET NULL,
  deal_id             uuid REFERENCES deal(id) ON DELETE SET NULL,
  sequence_id         uuid REFERENCES outbound_sequence(id) ON DELETE SET NULL,
  step_index          int,

  channel             text NOT NULL,
  subject             text,
  body                text NOT NULL,
  -- Trazabilidad de las afirmaciones del pitch: cada cifra citada
  -- apunta a la campaña o métrica de la que salió.
  claims              jsonb NOT NULL DEFAULT '[]'::jsonb,
  approved_by         uuid REFERENCES app_user(id) ON DELETE SET NULL,
  approved_at         timestamptz,

  status              text NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','scheduled','sent','bounced',
                                             'replied','opted_out','blocked','cancelled')),
  scheduled_for       timestamptz,
  sent_at             timestamptz,
  replied_at          timestamptz,
  -- Motivo por el que el sistema bloqueó el envío, si lo bloqueó.
  blocked_reason      text,
  external_ref        text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON outbound_touch (workspace_id, status, scheduled_for);
CREATE INDEX ON outbound_touch (company_id, sent_at DESC);
CREATE INDEX ON outbound_touch (contact_id, sent_at DESC);

-- Regla dura: no se puede enviar a un contacto que pidió la baja.
CREATE OR REPLACE FUNCTION enforce_outbound_optout() RETURNS trigger AS $$
DECLARE
  is_out boolean;
BEGIN
  IF NEW.status IN ('scheduled','sent') AND NEW.contact_id IS NOT NULL THEN
    SELECT opted_out INTO is_out FROM contact WHERE id = NEW.contact_id;
    IF is_out THEN
      RAISE EXCEPTION 'El contacto % pidió no ser contactado (opt-out).', NEW.contact_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outbound_touch_optout
  BEFORE INSERT OR UPDATE ON outbound_touch
  FOR EACH ROW EXECUTE FUNCTION enforce_outbound_optout();

-- Vista de control: toques por empresa en los últimos 90 días. El worker
-- la consulta antes de programar un envío.
CREATE VIEW outbound_touch_recent AS
SELECT workspace_id,
       company_id,
       count(*) FILTER (WHERE sent_at > now() - interval '90 days') AS touches_90d,
       max(sent_at) AS last_touch_at
FROM outbound_touch
WHERE status = 'sent'
GROUP BY workspace_id, company_id;
