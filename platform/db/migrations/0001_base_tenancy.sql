-- =====================================================================
-- 0001 · Base, multi-tenencia e identidad
-- ---------------------------------------------------------------------
-- Todo el producto es multi-tenant desde el día 1. La unidad de
-- aislamiento es el WORKSPACE: puede ser un creador individual o una
-- agencia que gestiona varias marcas. Cada tabla de negocio lleva
-- workspace_id y está lista para Row Level Security.
-- =====================================================================

-- gen_random_uuid() es parte del núcleo desde Postgres 13: no hace falta
-- pgcrypto. Esto mantiene el esquema portable entre Neon, Supabase, RDS
-- y Postgres embebido sin depender de qué contribs tenga el proveedor.
CREATE EXTENSION IF NOT EXISTS "citext";      -- correos insensibles a mayúsculas
CREATE EXTENSION IF NOT EXISTS "pg_trgm";     -- búsqueda por similitud (nombres de marca)

-- ---------------------------------------------------------------------
-- Convenciones del proyecto
-- ---------------------------------------------------------------------
--  * Claves primarias: uuid v4 generado en la base.
--  * Fechas: SIEMPRE timestamptz. La app trabaja en UTC y presenta en
--    la zona del workspace.
--  * Enumerados: text + CHECK, no tipos ENUM de Postgres. Agregar un
--    valor nuevo es un ALTER de constraint y no bloquea la tabla.
--  * Dinero: numeric(14,2) + moneda ISO-4217 en columna aparte. Nunca float.
--  * Tablas de métricas: append-only. No se actualizan, se insertan.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- Workspaces
-- =====================================================================
CREATE TABLE workspace (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          citext NOT NULL UNIQUE,
  name          text   NOT NULL,
  kind          text   NOT NULL DEFAULT 'creator'
                       CHECK (kind IN ('creator', 'agency')),
  country       char(2),                       -- ISO-3166-1 alfa-2
  currency      char(3) NOT NULL DEFAULT 'COP', -- ISO-4217
  timezone      text    NOT NULL DEFAULT 'America/Bogota',
  locale        text    NOT NULL DEFAULT 'es-CO',
  plan          text    NOT NULL DEFAULT 'free'
                       CHECK (plan IN ('free', 'creator', 'agency', 'enterprise')),
  -- Nicho principal: alimenta el radar de ventas y las tendencias.
  niche_slugs   text[]  NOT NULL DEFAULT '{}',
  settings      jsonb   NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE TRIGGER workspace_updated BEFORE UPDATE ON workspace
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- Usuarios y membresías
-- =====================================================================
CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  name          text,
  avatar_url    text,
  locale        text NOT NULL DEFAULT 'es-CO',
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE TRIGGER app_user_updated BEFORE UPDATE ON app_user
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE membership (
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role          text NOT NULL DEFAULT 'member'
                     CHECK (role IN ('owner', 'admin', 'member', 'viewer', 'client')),
  -- 'client' es la marca de una agencia: solo ve su propio portal de reportes.
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX ON membership (user_id);

-- =====================================================================
-- Creadores dentro del workspace
-- ---------------------------------------------------------------------
-- Un workspace de creador tiene exactamente un creator_profile.
-- Un workspace de agencia tiene N (su roster). Las cuentas sociales
-- cuelgan del creador, no del workspace, para que una agencia pueda
-- mover un creador de espacio sin perder su historia.
-- =====================================================================
CREATE TABLE creator_profile (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  display_name  text NOT NULL,
  handle        text,                 -- handle principal, para mostrar
  bio           text,
  country       char(2),
  languages     text[] NOT NULL DEFAULT '{es}',
  niche_slugs   text[] NOT NULL DEFAULT '{}',
  -- Datos que alimentan el media kit y la cotización.
  media_kit     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text  NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'paused', 'archived')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX ON creator_profile (workspace_id) WHERE deleted_at IS NULL;
CREATE TRIGGER creator_profile_updated BEFORE UPDATE ON creator_profile
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- Catálogo de nichos (compartido entre workspaces)
-- =====================================================================
CREATE TABLE niche (
  slug          text PRIMARY KEY,
  name_es       text NOT NULL,
  name_en       text,
  parent_slug   text REFERENCES niche(slug),
  -- CPM de referencia para sugerir tarifas, por país. Se recalibra
  -- con los deals reales que pasen por la plataforma.
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE niche_cpm_benchmark (
  niche_slug    text  NOT NULL REFERENCES niche(slug) ON DELETE CASCADE,
  country       char(2) NOT NULL,
  platform      text  NOT NULL,
  currency      char(3) NOT NULL,
  cpm_low       numeric(14,2) NOT NULL,
  cpm_high      numeric(14,2) NOT NULL,
  source        text NOT NULL,        -- 'manual' | 'deals' | 'informe-externo'
  sample_size   int,
  valid_from    date NOT NULL DEFAULT CURRENT_DATE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (niche_slug, country, platform, valid_from)
);

-- =====================================================================
-- Auditoría
-- ---------------------------------------------------------------------
-- Toda acción que cambie dinero, publique contenido o toque una cuenta
-- conectada deja rastro. Sin esto no se puede depurar un reporte que
-- una marca discuta.
-- =====================================================================
CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  workspace_id  uuid REFERENCES workspace(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  actor_kind    text NOT NULL DEFAULT 'user'
                     CHECK (actor_kind IN ('user', 'system', 'job', 'webhook')),
  action        text NOT NULL,        -- 'deal.stage_changed', 'post.published'…
  entity_type   text NOT NULL,
  entity_id     uuid,
  before        jsonb,
  after         jsonb,
  ip            inet,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (workspace_id, created_at DESC);
CREATE INDEX ON audit_log (entity_type, entity_id, created_at DESC);
