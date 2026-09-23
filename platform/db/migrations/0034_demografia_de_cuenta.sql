-- =====================================================================
-- 0034 · Demografía de cuenta: idempotencia, y por qué falta (CON-7)
-- ---------------------------------------------------------------------
-- Número: 0033 es la última en todas las ramas (git ls-tree sobre cada
-- origin/*, 23-sep-2026). Ninguna de 0024–0033 está aplicada en
-- Supabase; esta va detrás de todas y no depende de ninguna: solo toca
-- audience_breakdown (0003), metric_requirement (0011) y una tabla
-- nueva. Si otra área eligió también 0034, el integrador renumera.
--
-- collect.demographics (cron 20 5, ya en job_definition de 0009) escribe
-- audience_breakdown con scope 'account'. Le faltaban dos cosas al
-- esquema:
--
--   1. IDEMPOTENCIA. 0003 dejó la tabla sin ninguna clave única: dos
--      corridas el mismo día duplicaban cada bucket, y la pantalla
--      sumaba el doble. La tabla es append-only y mc_app ni siquiera
--      tiene INSERT sobre ella (0025 §5), así que la salida no puede
--      ser «borrar y reinsertar»: es un UNIQUE que deja al worker
--      insertar con ON CONFLICT DO NOTHING.
--
--   2. DÓNDE DECIR POR QUÉ NO HAY DATO. La historia se resume en que
--      una celda vacía genera soporte por WhatsApp: si a la cuenta le
--      falta un prerrequisito (cien seguidores, cuenta profesional,
--      permiso de insights, o sencillamente que el dueño autorice),
--      hay que poder escribirlo donde la pantalla lo lea.
--
--      social_connection no tiene columna para eso. La única de texto
--      libre es status_detail, y NO sirve: la escribe
--      collect.account_metrics (CON-10) diez minutos antes (cron 10 5),
--      es UNA cadena para una cuenta que puede tener varios huecos a la
--      vez, y no lleva ni el día ni la referencia a metric_requirement
--      que la pantalla necesita para enlazar el arreglo. Escribir encima
--      borraría en /conexiones la nota de CON-10.
--
--      De ahí metric_gap: una fila viva por (conexión, grupo de
--      métricas), con el requisito que lo explica. Se reemplaza en cada
--      corrida y se borra en cuanto el dato llega. Razonado en
--      docs/propuestas/CON-7.md §0.2 (4).
--
-- Re-ejecutable entera: IF NOT EXISTS, DROP POLICY IF EXISTS, el CHECK
-- dentro de un DO que consulta pg_constraint y las filas con ON
-- CONFLICT DO NOTHING.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · La clave única que le faltaba a audience_breakdown
-- ---------------------------------------------------------------------
-- Parcial sobre scope = 'account' porque el scope 'post' (fase 2) se
-- identifica por post_id, no por connection_id, y su UNIQUE será otro.
-- population entra en la clave: la misma cuenta puede tener la
-- demografía de sus seguidores y la de quienes la vieron.
CREATE UNIQUE INDEX IF NOT EXISTS audience_breakdown_account_uniq
  ON audience_breakdown (connection_id, day, population, dimension, bucket)
  WHERE scope = 'account';

-- ---------------------------------------------------------------------
-- 2 · Un requisito más: que el dueño de la cuenta autorice
-- ---------------------------------------------------------------------
-- En el MVP una cuenta se agrega por su @ (access_mode 'public_profile',
-- 0022) y se lee con lo que la plataforma publica. Ninguna fuente
-- pública entrega demografía, y eso no es «le faltan seguidores» ni «no
-- es cuenta business»: es que nadie ha autorizado la lectura. Sin este
-- valor, las tres filas de abajo no podrían existir y el hueco más
-- común del MVP se quedaría sin explicación.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'metric_requirement'::regclass
       AND conname = 'metric_requirement_requirement_check'
  ) THEN
    ALTER TABLE metric_requirement DROP CONSTRAINT metric_requirement_requirement_check;
  END IF;
END $$;

ALTER TABLE metric_requirement ADD CONSTRAINT metric_requirement_requirement_check
  CHECK (requirement IN ('business_account','verified_business','min_followers_100',
                         'analytics_optin','scope_video_insights','app_audited',
                         'post_active_7d','owner_authorization'));

-- Las siete filas de 0011 se quedan como están. Estas cinco son las que
-- el MVP necesita y no existían. El texto es lo que lee la persona: se
-- escribe entero aquí para que cambiarlo sea una migración y no un JSX.
INSERT INTO metric_requirement (id, platform_id, metric_group, requirement, message_es) VALUES
  ('ig.demographics.auth',     'instagram', 'demografia_de_cuenta', 'owner_authorization',
   'Esta cuenta se agregó por su @, y lo que Instagram publica no incluye la audiencia. Para verla, el dueño tiene que autorizar la lectura de sus cifras.'),
  ('tt.audience.auth',         'tiktok',    'demografia_de_cuenta', 'owner_authorization',
   'Esta cuenta se agregó por su @. TikTok solo entrega la audiencia a la cuenta autorizada y con permiso de analítica; el dueño tiene que autorizarla.'),
  ('yt.demographics.auth',     'youtube',   'demografia_de_cuenta', 'owner_authorization',
   'Este canal se agregó por su @, y la API pública no da audiencia. Para verla, el dueño tiene que autorizar YouTube Analytics.'),
  ('ig.insights.account_type', 'instagram', 'demografia_de_cuenta', 'business_account',
   'Instagram solo entrega la audiencia de cuentas profesionales. Cambia la cuenta a Empresa o Creador en Instagram y vuelve a autorizarla.'),
  ('yt.analytics.scope',       'youtube',   'demografia_de_cuenta', 'scope_video_insights',
   'Falta el permiso de YouTube Analytics. Vuelve a autorizar el canal y acepta el acceso a las estadísticas.')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 3 · metric_gap: por qué no hay dato, donde la pantalla lo lea
-- ---------------------------------------------------------------------
-- Una fila VIVA por (conexión, grupo). No es una bitácora: el hueco de
-- ayer que hoy ya no existe no le sirve a nadie, y la historia de qué
-- se intentó vive en job_run y api_call_log. Por eso el UNIQUE y el
-- UPSERT, y por eso el job la borra en cuanto el dato llega.
CREATE TABLE IF NOT EXISTS metric_gap (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  connection_id   uuid NOT NULL REFERENCES social_connection(id) ON DELETE CASCADE,
  -- El mismo vocabulario de metric_requirement.metric_group
  -- ('demografia_de_cuenta', 'retencion_y_audiencia', …).
  metric_group    text NOT NULL,
  requirement_id  text NOT NULL REFERENCES metric_requirement(id),
  -- Día (UTC) de la corrida que lo detectó: la pantalla dice «hoy» o
  -- «desde el 12 de septiembre» sin restar timestamps.
  day             date NOT NULL,
  detected_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, metric_group)
);
CREATE INDEX IF NOT EXISTS metric_gap_workspace_idx ON metric_gap (workspace_id, metric_group);

-- Tabla con workspace_id: entra en RLS con su política, como el resto
-- (0010). El worker corre como mc_worker (BYPASSRLS) y filtra a mano.
ALTER TABLE metric_gap ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_gap FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS metric_gap_ws_isolation ON metric_gap;
CREATE POLICY metric_gap_ws_isolation ON metric_gap
  USING (workspace_id = current_workspace_id());

-- Quien mide es quien escribe (0025 §5): la web solo lee. Sin esto, la
-- tabla nace con los cuatro privilegios para mc_app (ALTER DEFAULT
-- PRIVILEGES) y una pantalla podría borrar la explicación de un hueco.
REVOKE INSERT, UPDATE, DELETE ON metric_gap FROM mc_app;
