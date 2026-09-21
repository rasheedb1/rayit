-- =====================================================================
-- 0008 · Cotizaciones, campañas, reportes y finanzas
-- ---------------------------------------------------------------------
-- La cadena completa: tarifario → cotización → campaña → medición →
-- reporte → factura → cobro. Todo enlazado, de forma que el reporte que
-- recibe la marca se pueda auditar hasta el snapshot que lo produjo.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tarifario del creador
-- ---------------------------------------------------------------------
CREATE TABLE rate_card (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  creator_id          uuid NOT NULL REFERENCES creator_profile(id) ON DELETE CASCADE,
  currency            char(3) NOT NULL DEFAULT 'COP',
  version             int NOT NULL DEFAULT 1,
  is_current          boolean NOT NULL DEFAULT true,
  computed_at         timestamptz NOT NULL DEFAULT now(),
  -- Entradas de la fórmula, guardadas para poder explicar el precio.
  basis               jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (creator_id, version)
);
CREATE INDEX ON rate_card (creator_id) WHERE is_current;

CREATE TABLE rate_card_item (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_card_id        uuid NOT NULL REFERENCES rate_card(id) ON DELETE CASCADE,
  deliverable         text NOT NULL,           -- 'reel' | 'tiktok' | 'historia' | 'dedicado'
  platform_id         text REFERENCES platform(id),
  label_es            text NOT NULL,
  -- Rango, no precio único: es lo que hace negociable la cotización.
  price_low           numeric(14,2),
  price_high          numeric(14,2),
  -- Modificadores que se suman como porcentaje.
  is_modifier         boolean NOT NULL DEFAULT false,
  modifier_pct        numeric(6,4),            -- derechos de uso +35 %
  -- Trazabilidad del cálculo: views promedio y CPM usados.
  avg_views           bigint,
  cpm_low             numeric(14,2),
  cpm_high            numeric(14,2),
  adjustments         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Si el creador editó el precio sugerido, se respeta y se marca.
  overridden          boolean NOT NULL DEFAULT false,
  position            int NOT NULL DEFAULT 0
);
CREATE INDEX ON rate_card_item (rate_card_id, position);

-- ---------------------------------------------------------------------
-- Media kit: foto fija de los números del creador en un momento dado.
-- Se congela al generarlo para que un PDF enviado hace tres meses siga
-- coincidiendo con lo que la marca vio.
-- ---------------------------------------------------------------------
CREATE TABLE media_kit (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  creator_id          uuid NOT NULL REFERENCES creator_profile(id) ON DELETE CASCADE,
  rate_card_id        uuid REFERENCES rate_card(id) ON DELETE SET NULL,
  slug                text NOT NULL UNIQUE,    -- enlace público
  snapshot            jsonb NOT NULL,          -- cifras congeladas
  theme               text NOT NULL DEFAULT 'studio',
  is_public           boolean NOT NULL DEFAULT false,
  password_hash       text,
  expires_at          timestamptz,
  view_count          int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Cotización
-- ---------------------------------------------------------------------
CREATE TABLE quote (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  deal_id             uuid REFERENCES deal(id) ON DELETE SET NULL,
  company_id          uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  creator_id          uuid NOT NULL REFERENCES creator_profile(id) ON DELETE CASCADE,
  media_kit_id        uuid REFERENCES media_kit(id) ON DELETE SET NULL,

  number              text NOT NULL,           -- 'COT-2026-014'
  slug                text NOT NULL UNIQUE,
  currency            char(3) NOT NULL DEFAULT 'COP',
  subtotal            numeric(14,2) NOT NULL DEFAULT 0,
  discount            numeric(14,2) NOT NULL DEFAULT 0,
  tax                 numeric(14,2) NOT NULL DEFAULT 0,
  total               numeric(14,2) NOT NULL DEFAULT 0,

  -- Lo que se acuerda ANTES de publicar. Es lo que hace defendible el
  -- reporte final, y por eso vive en la cotización, no en la campaña.
  agreed_metrics      text[] NOT NULL DEFAULT '{}',
  report_cuts_hours   int[]  NOT NULL DEFAULT '{24,168,720}',
  usage_rights_days   int,
  exclusivity_days    int,
  exclusivity_scope   text,
  payment_terms_days  int NOT NULL DEFAULT 30,

  status              text NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','sent','viewed','accepted','rejected','expired')),
  valid_until         date,
  sent_at             timestamptz,
  viewed_at           timestamptz,
  accepted_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, number)
);
CREATE INDEX ON quote (workspace_id, status);
CREATE TRIGGER quote_updated BEFORE UPDATE ON quote
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE quote_item (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id            uuid NOT NULL REFERENCES quote(id) ON DELETE CASCADE,
  deliverable         text NOT NULL,
  platform_id         text REFERENCES platform(id),
  description         text NOT NULL,
  quantity            int NOT NULL DEFAULT 1,
  unit_price          numeric(14,2) NOT NULL,
  total               numeric(14,2) NOT NULL,
  position            int NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------
-- Campaña
-- ---------------------------------------------------------------------
CREATE TABLE campaign (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  company_id          uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  creator_id          uuid REFERENCES creator_profile(id) ON DELETE SET NULL,
  deal_id             uuid REFERENCES deal(id) ON DELETE SET NULL,
  quote_id            uuid REFERENCES quote(id) ON DELETE SET NULL,

  name                text NOT NULL,
  brief               text,
  starts_on           date,
  ends_on             date,
  -- Medición acordada, copiada de la cotización al aceptarla.
  tracking_code       text,                    -- 'LAURA15'
  tracking_url        text,
  utm                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Línea base de seguidores de la MARCA: se empieza a medir 14 días
  -- antes de publicar. Sin esto el crecimiento no es demostrable.
  brand_baseline_from date,
  brand_accounts      jsonb NOT NULL DEFAULT '[]'::jsonb,

  amount              numeric(14,2),
  currency            char(3) NOT NULL DEFAULT 'COP',
  status              text NOT NULL DEFAULT 'planned'
                           CHECK (status IN ('planned','live','measuring','reported','closed','cancelled')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON campaign (workspace_id, status);
CREATE TRIGGER campaign_updated BEFORE UPDATE ON campaign
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE campaign_post (
  campaign_id         uuid NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  post_id             uuid NOT NULL REFERENCES post(id) ON DELETE CASCADE,
  deliverable         text,
  is_primary          boolean NOT NULL DEFAULT false,
  PRIMARY KEY (campaign_id, post_id)
);

-- Lo que la marca aporta y que no podemos medir solos.
CREATE TABLE campaign_brand_input (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- workspace_id va desnormalizado a propósito: RLS filtra por índice
  -- en vez de hacer un join en cada fila leída.
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  campaign_id         uuid NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN
                           ('code_redemptions','orders','revenue','signups','csv_sales','postback')),
  day                 date,
  value_num           numeric(16,2),
  currency            char(3),
  source              text NOT NULL CHECK (source IN ('brand_manual','brand_csv','integration','postback')),
  received_at         timestamptz NOT NULL DEFAULT now(),
  notes               text
);
CREATE INDEX ON campaign_brand_input (campaign_id, kind, day);

-- Crecimiento público de la cuenta de la marca durante la campaña.
CREATE TABLE brand_account_snapshot (
  id                  bigserial PRIMARY KEY,
  campaign_id         uuid REFERENCES campaign(id) ON DELETE CASCADE,
  company_id          uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  platform_id         text NOT NULL REFERENCES platform(id),
  external_account_id text,
  handle              text,
  day                 date NOT NULL,
  followers           bigint,
  media_count         bigint,
  source              text NOT NULL DEFAULT 'business_discovery',
  captured_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, platform_id, day)
);
CREATE INDEX ON brand_account_snapshot (campaign_id, day);

-- Resultado consolidado de la campaña, materializado para el reporte.
CREATE TABLE campaign_result (
  campaign_id         uuid PRIMARY KEY REFERENCES campaign(id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  computed_at         timestamptz NOT NULL DEFAULT now(),
  cut_hours           int NOT NULL DEFAULT 720,

  views               bigint,
  reach               bigint,
  interactions        bigint,
  saves               bigint,
  shares              bigint,
  link_clicks         bigint,
  reach_non_followers_pct numeric(6,5),
  -- Comparación contra la propia mediana del creador.
  views_vs_median     numeric(8,3),
  -- Lo que le pasó a la marca.
  brand_followers_gained   bigint,
  brand_followers_baseline_rate numeric(10,4),   -- seguidores/día antes
  brand_followers_campaign_rate numeric(10,4),
  code_redemptions    bigint,
  attributed_revenue  numeric(16,2),
  currency            char(3),
  -- Eficiencia
  cpm                 numeric(14,2),
  cost_per_follower   numeric(14,2),
  cpa                 numeric(14,2),
  emv                 numeric(16,2),
  -- Qué falta para que el reporte sea completo.
  missing_inputs      text[] NOT NULL DEFAULT '{}'
);

-- ---------------------------------------------------------------------
-- Reportes (creador → marca, y agencia → cliente)
-- ---------------------------------------------------------------------
CREATE TABLE report (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  campaign_id         uuid REFERENCES campaign(id) ON DELETE CASCADE,
  company_id          uuid REFERENCES company(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('campaign','monthly','weekly','custom')),
  period_start        date,
  period_end          date,
  slug                text NOT NULL UNIQUE,
  -- Datos congelados: el reporte no cambia si las métricas se mueven.
  payload             jsonb NOT NULL,
  white_label         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status              text NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','sent','viewed')),
  sent_at             timestamptz,
  sent_via            text CHECK (sent_via IN ('email','whatsapp','link','pdf')),
  viewed_at           timestamptz,
  view_count          int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON report (workspace_id, created_at DESC);

CREATE TABLE report_schedule (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  company_id          uuid REFERENCES company(id) ON DELETE CASCADE,
  kind                text NOT NULL,
  cron                text NOT NULL,           -- '0 9 1 * *'
  timezone            text NOT NULL DEFAULT 'America/Bogota',
  channel             text NOT NULL CHECK (channel IN ('email','whatsapp','link')),
  recipients          text[] NOT NULL DEFAULT '{}',
  active              boolean NOT NULL DEFAULT true,
  last_run_at         timestamptz,
  next_run_at         timestamptz
);
CREATE INDEX ON report_schedule (next_run_at) WHERE active;

-- =====================================================================
-- Finanzas
-- =====================================================================
CREATE TABLE invoice (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  company_id          uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  campaign_id         uuid REFERENCES campaign(id) ON DELETE SET NULL,
  quote_id            uuid REFERENCES quote(id) ON DELETE SET NULL,
  number              text NOT NULL,
  currency            char(3) NOT NULL DEFAULT 'COP',
  subtotal            numeric(14,2) NOT NULL,
  tax                 numeric(14,2) NOT NULL DEFAULT 0,
  withholding         numeric(14,2) NOT NULL DEFAULT 0,   -- retención en la fuente
  total               numeric(14,2) NOT NULL,
  issued_on           date NOT NULL,
  due_on              date NOT NULL,
  status              text NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','sent','partial','paid','overdue','void')),
  paid_amount         numeric(14,2) NOT NULL DEFAULT 0,
  paid_at             timestamptz,
  reminders_sent      int NOT NULL DEFAULT 0,
  last_reminder_at    timestamptz,
  external_ref        text,                    -- factura electrónica DIAN
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, number)
);
CREATE INDEX ON invoice (workspace_id, status, due_on);
CREATE TRIGGER invoice_updated BEFORE UPDATE ON invoice
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payment (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  invoice_id          uuid REFERENCES invoice(id) ON DELETE SET NULL,
  direction           text NOT NULL CHECK (direction IN ('in','out')),
  amount              numeric(14,2) NOT NULL,
  currency            char(3) NOT NULL,
  method              text,
  received_at         timestamptz NOT NULL DEFAULT now(),
  reference           text,
  notes               text
);
CREATE INDEX ON payment (workspace_id, received_at DESC);

CREATE TABLE expense (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  category            text NOT NULL,           -- 'edicion' | 'software' | 'equipo' | 'viajes'
  vendor              text,
  description         text,
  amount              numeric(14,2) NOT NULL,
  currency            char(3) NOT NULL,
  incurred_on         date NOT NULL,
  is_recurring        boolean NOT NULL DEFAULT false,
  recurrence          text,
  receipt_url         text,
  deductible          boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON expense (workspace_id, incurred_on DESC);

-- Ingresos de las propias plataformas (Creator Rewards, AdSense, bonos).
CREATE TABLE platform_payout (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  creator_id          uuid REFERENCES creator_profile(id) ON DELETE SET NULL,
  platform_id         text NOT NULL REFERENCES platform(id),
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  amount              numeric(14,2) NOT NULL,
  currency            char(3) NOT NULL,
  source              text NOT NULL CHECK (source IN ('api','csv_import','manual')),
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Reserva de impuestos: porcentaje que se aparta de cada cobro.
CREATE TABLE tax_reserve (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  payment_id          uuid REFERENCES payment(id) ON DELETE CASCADE,
  rate                numeric(6,4) NOT NULL,
  amount              numeric(14,2) NOT NULL,
  currency            char(3) NOT NULL,
  period              text,                    -- '2026-Q3'
  released_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
