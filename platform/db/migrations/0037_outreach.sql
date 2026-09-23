-- =====================================================================
-- 0037 · Outreach: canales, cadencias, cola, revisión, límites y baja
--        (VEN-9, la migración que docs/ventas-outreach.md §5.2 llama
--        «0015_outreach»; el 0015 lo tomó connection_secret y las fases
--        1 a 3 llegaron hasta 0036, así que es la 0037)
-- ---------------------------------------------------------------------
-- Es el esquema del que cuelgan las demás piezas de Ventas B y C: el
-- conector de canales (VEN-9), el motor de cadencias (VEN-10), la
-- entregabilidad (VEN-15) y la generación con revisión (VEN-12). Aquí
-- no hay pantallas ni jobs: solo tablas, reglas en la base y funciones
-- atómicas que esas piezas llaman.
--
-- Lo que ya existía y se queda (0007): company, contact (con opted_out
-- y source), company_link, signal, deal, activity, outbound_brief,
-- outbound_policy, outbound_sequence, outbound_touch con claims, y el
-- disparador que impide programar a quien pidió la baja.
--
-- Vocabulario de canales: el de 0007 (email, linkedin, instagram_dm,
-- whatsapp), el mismo de outbound_sequence, outbound_touch y
-- outbound_policy.allowed_channels. El documento escribe «instagram» en
-- la tabla de cuentas; aquí es instagram_dm en todas partes para que una
-- cuenta, un paso y un toque se comparen sin traducir.
--
-- ÍNDICE
--   1 · Catálogos: ángulos, rúbrica y plantillas de secuencia
--   2 · Cuentas de canal (outreach_channel_account)
--   3 · Secuencia, pasos y enrolamiento
--   4 · La cola: outbound_touch extendida
--   5 · Mensajes por hilo y revisiones de calidad
--   6 · Límites: política, contadores y disyuntores
--   7 · Aislamiento de las tablas nuevas, referencias y privilegios
--   8 · Funciones del motor (límites, apagado, salud, días hábiles)
--   9 · La baja desde el enlace público (public_optout)
--
-- Nada de esto crea ni altera un rol. La sección 9 usa mc_public_share,
-- que existe desde 0030 (en Supabase lo creó supabase-admin.sh).
-- =====================================================================


-- =====================================================================
-- 1 · Catálogos: ángulos, rúbrica y plantillas de secuencia
-- ---------------------------------------------------------------------
-- outbound_angle y outbound_step_rubric son catálogos CON DUEÑO, como
-- pipeline_stage y feature_flag (0020 §3): workspace_id NULL es la fila
-- por defecto de la plataforma, y un uuid es la versión que un
-- workspace editó. Se leen las dos; se escribe solo la propia. El
-- generador y el revisor toman la del workspace si existe y, si no, la
-- global (misma clave).
--
-- outbound_sequence_template es global y sin dueño: las plantillas que
-- propone el recomendador (VEN-13). Lleva RLS con una sola política de
-- LECTURA abierta a todos, así que ni con un GRANT de más se podría
-- escribir desde la aplicación; la llena una migración.
-- =====================================================================

-- Los ángulos de la sección 5.3: el «dueño» de cada toque. Cada fila
-- dice qué busca el toque, qué puede decir, qué se le prohíbe y qué
-- cifra o prueba puede citar (y de qué tabla sale). El texto es
-- contenido para el generador y para el revisor, en el idioma del
-- producto; por eso las columnas llevan _es, como signal_source.label_es.
CREATE TABLE outbound_angle (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid REFERENCES workspace(id) ON DELETE CASCADE,  -- NULL = por defecto
  key                 text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  position            int  NOT NULL CHECK (position BETWEEN 0 AND 100),
  default_day_offset  int  CHECK (default_day_offset BETWEEN 0 AND 60),
  label_es            text NOT NULL,
  goal_es             text NOT NULL,
  allowed_es          text[] NOT NULL DEFAULT '{}',
  forbidden_es        text[] NOT NULL DEFAULT '{}',
  proof_es            text,
  -- De dónde puede salir una cifra de este toque. Vacío = ninguna cifra.
  proof_sources       text[] NOT NULL DEFAULT '{}'
                           CHECK (proof_sources <@ ARRAY['creator_profile','creator_baseline','post_score',
                                                         'media_kit','campaign_result','signal','quote']::text[]),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX outbound_angle_key_idx ON outbound_angle (workspace_id, key) NULLS NOT DISTINCT;
CREATE TRIGGER outbound_angle_updated BEFORE UPDATE ON outbound_angle
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Los tipos de paso. El canal sale del tipo (CHECK de outbound_step):
--   email, email_reply                              → email
--   linkedin_connect, linkedin_message,
--   linkedin_comment, linkedin_like                 → linkedin
--   instagram_dm, instagram_comment, instagram_like → instagram_dm
--   whatsapp_message                                → whatsapp
--   manual_task: lo hace la persona; el motor solo lo recuerda.

-- Umbral del juez por tipo de paso y, si hace falta, por día. day_offset
-- NULL vale para cualquier día de ese tipo; una fila con día gana a la
-- que no lo tiene. Escala 0–10 como en Chief: por encima del umbral
-- pasa; entre el mínimo y el umbral se regenera con una pista, hasta
-- max_attempts; si ninguno llega, se envía el mejor que supere el
-- mínimo («enviar el mejor»); por debajo del mínimo, a revisión humana.
-- dead_band evita regenerar por décimas: a menos de esa distancia del
-- umbral, el mensaje pasa.
CREATE TABLE outbound_step_rubric (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid REFERENCES workspace(id) ON DELETE CASCADE,  -- NULL = por defecto
  step_type           text NOT NULL
                           CHECK (step_type IN ('email','email_reply','linkedin_connect','linkedin_message',
                                                'linkedin_comment','instagram_dm','instagram_comment',
                                                'whatsapp_message')),
  day_offset          int  CHECK (day_offset BETWEEN 0 AND 60),
  threshold           numeric(3,1) NOT NULL DEFAULT 8.0 CHECK (threshold BETWEEN 0 AND 10),
  min_acceptable      numeric(3,1) NOT NULL DEFAULT 4.5 CHECK (min_acceptable BETWEEN 0 AND 10),
  dead_band           numeric(3,1) NOT NULL DEFAULT 0.3 CHECK (dead_band BETWEEN 0 AND 2),
  max_attempts        int NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  -- Peso de cada dimensión en la nota (relevance, quality, structure,
  -- voice). Suman 1.
  weights             jsonb NOT NULL DEFAULT '{"relevance":0.3,"quality":0.25,"structure":0.25,"voice":0.2}'::jsonb,
  -- Qué mira el juez en cada dimensión para este paso.
  criteria_es         jsonb NOT NULL DEFAULT '{}'::jsonb,
  max_chars           int CHECK (max_chars BETWEEN 1 AND 10000),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (min_acceptable <= threshold)
);
CREATE UNIQUE INDEX outbound_step_rubric_step_idx
  ON outbound_step_rubric (workspace_id, step_type, day_offset) NULLS NOT DISTINCT;
CREATE TRIGGER outbound_step_rubric_updated BEFORE UPDATE ON outbound_step_rubric
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Plantillas de secuencia. Los pasos van en jsonb porque una plantilla
-- no se programa ni se mide: se COPIA a outbound_step al crear la
-- secuencia, y ahí sí son filas. Cada paso:
--   { "day_offset": 1, "order_in_day": 0, "step_type": "email",
--     "channel": "email", "angle_key": "encaje_audiencia",
--     "scheduled_time": "09:30", "generate_with_ai": true,
--     "requires_asset": null, "guidance_es": "…" }
CREATE TABLE outbound_sequence_template (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9-]{1,60}$'),
  name_es             text NOT NULL,
  description_es      text NOT NULL,
  -- Para qué señal está pensada (VEN-13 filtra por esto). NULL = cualquiera.
  signal_kind         text CHECK (signal_kind IN ('active_campaign','launch','season','ads','collab','manual')),
  niche_slug          text,
  steps               jsonb NOT NULL
                           CHECK (jsonb_typeof(steps) = 'array'
                                  AND jsonb_array_length(steps) BETWEEN 1 AND 12),
  version             int NOT NULL DEFAULT 1 CHECK (version >= 1),
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 1.1 · Los seis ángulos de un creador que le escribe a una marca (§5.3)
-- ---------------------------------------------------------------------
-- Van antes de la sección 7, que les pone RLS: sin workspace fijado,
-- estas filas globales se escriben sin rodeos.
INSERT INTO outbound_angle
  (key, position, default_day_offset, label_es, goal_es, allowed_es, forbidden_es, proof_es, proof_sources)
VALUES
  ('presencia', 0, 0,
   'Presencia',
   'Que la marca vea el nombre del creador antes del primer correo, con un gesto público y genuino.',
   ARRAY['Comentar algo concreto de su último post', 'Reaccionar al post'],
   ARRAY['Vender', 'Mencionar tarifas', 'Pedir una reunión', 'Poner enlaces'],
   NULL,
   ARRAY[]::text[]),
  ('encaje_audiencia', 1, 1,
   'Encaje de audiencia',
   'Explicar quién ve los videos del creador y por qué esa audiencia es cliente de la marca.',
   ARRAY['Demografía de la audiencia', 'Alcance en no seguidores', 'Países y ciudades principales'],
   ARRAY['Hablar de tarifas', 'Adjuntar el media kit completo', 'Más de una pregunta de cierre'],
   'Demografía de audiencia y alcance en no seguidores, con su origen.',
   ARRAY['creator_profile', 'creator_baseline']),
  ('prueba_desempeno', 2, 3,
   'Prueba de desempeño',
   'Mostrar un video concreto, parecido a lo que la marca necesita, con sus cifras.',
   ARRAY['Un video propio con su enlace', 'Views a 7 días frente a la mediana propia', 'Guardados por mil',
         'Un post atípico'],
   ARRAY['Repetir la demografía ya dicha', 'Cifras sin origen', 'Promedios inventados'],
   'Views a 7 días frente a la mediana propia, guardados por mil y un post atípico.',
   ARRAY['post_score', 'creator_baseline']),
  ('concepto_creativo', 3, 5,
   'Concepto creativo',
   'Proponer una idea específica para su producto o su temporada.',
   ARRAY['Una idea de video concreta', 'La señal que originó el contacto: campaña, lanzamiento o temporada'],
   ARRAY['Cifras de audiencia ya dichas', 'Ideas genéricas que sirvan para cualquier marca'],
   'La señal del radar: campaña activa, lanzamiento o temporada.',
   ARRAY['signal']),
  ('prueba_social', 4, 7,
   'Prueba social',
   'Citar una marca del mismo sector con un resultado medido.',
   ARRAY['Una campaña pasada con su resultado', 'El nombre de la marca, si el creador lo puede decir'],
   ARRAY['Inventar clientes', 'Resultados sin campaña detrás', 'Nombrar a la competencia directa de la marca'],
   'Una campaña con campaign_result calculado.',
   ARRAY['campaign_result']),
  ('sintesis', 5, 9,
   'Síntesis y siguiente paso',
   'Cerrar con el media kit y la cotización, y una sola propuesta de siguiente paso.',
   ARRAY['Enlace al media kit', 'Enlace a la cotización', 'Una fecha concreta para hablar'],
   ARRAY['Presión', 'Urgencia falsa', 'Descuentos que caducan hoy'],
   'El media kit congelado y la cotización pública.',
   ARRAY['media_kit', 'quote']);

-- ---------------------------------------------------------------------
-- 1.2 · La rúbrica por defecto
-- ---------------------------------------------------------------------
-- Umbral 8,0, mínimo 4,5 y cinco intentos para lo que se lee con calma
-- (correo y directos). La solicitud de conexión y el comentario público
-- son cortos y su trabajo es otro: umbral 7,0 y mínimo 4,0.
INSERT INTO outbound_step_rubric (step_type, threshold, min_acceptable, max_attempts, max_chars, criteria_es) VALUES
  ('email', 8.0, 4.5, 5, 1200, jsonb_build_object(
     'relevance', 'Usa la señal y el ángulo del día; la primera frase habla de la marca, no del creador.',
     'quality',   'Suena a una persona: sin muletillas de IA, sin clichés, sin mayúsculas sostenidas.',
     'structure', 'Un solo tema y una sola pregunta de cierre; no repite el toque anterior.',
     'voice',     'Coincide con el perfil comercial del creador y con su forma de hablar.')),
  ('email_reply', 8.0, 4.5, 5, 700, jsonb_build_object(
     'relevance', 'Aporta algo nuevo al hilo (el concepto creativo o la señal), no un recordatorio vacío.',
     'quality',   'Breve y natural, como una respuesta en el mismo hilo.',
     'structure', 'No repite el correo anterior; una sola pregunta.',
     'voice',     'La misma voz del primer correo.')),
  ('linkedin_message', 8.0, 4.5, 5, 600, jsonb_build_object(
     'relevance', 'Un video concreto o una marca del mismo sector, según el ángulo del día.',
     'quality',   'Conversacional; nada de plantilla de ventas.',
     'structure', 'Corto, una sola pregunta, sin enlaces de calendario.',
     'voice',     'Coincide con el perfil del creador.')),
  ('instagram_dm', 8.0, 4.5, 5, 500, jsonb_build_object(
     'relevance', 'Un video concreto o una idea para su cuenta.',
     'quality',   'Natural y corto.',
     'structure', 'Una sola pregunta, sin enlaces de calendario.',
     'voice',     'Coincide con el perfil del creador.')),
  ('whatsapp_message', 8.0, 4.5, 5, 500, jsonb_build_object(
     'relevance', 'Solo con quien ya respondió: retoma lo que dijo.',
     'quality',   'Breve y cordial.',
     'structure', 'Una sola pregunta.',
     'voice',     'Coincide con el perfil del creador.')),
  ('linkedin_connect', 7.0, 4.0, 5, 300, jsonb_build_object(
     'relevance', 'Dice por qué conectar con esta persona en concreto.',
     'quality',   'No vende en la nota.',
     'structure', 'Cabe en 300 caracteres.',
     'voice',     'Coincide con el perfil del creador.')),
  ('linkedin_comment', 7.0, 4.0, 5, 400, jsonb_build_object(
     'relevance', 'Comenta algo específico del post, no un elogio genérico.',
     'quality',   'Aporta; no vende ni menciona tarifas.',
     'structure', 'Una o dos frases.',
     'voice',     'Coincide con el perfil del creador.')),
  ('instagram_comment', 7.0, 4.0, 5, 300, jsonb_build_object(
     'relevance', 'Comenta algo específico del post.',
     'quality',   'Aporta; no vende ni menciona tarifas.',
     'structure', 'Una frase.',
     'voice',     'Coincide con el perfil del creador.'));

-- ---------------------------------------------------------------------
-- 1.3 · La plantilla «Marca con campaña activa» (§5.3 y §5.5)
-- ---------------------------------------------------------------------
INSERT INTO outbound_sequence_template (slug, name_es, description_es, signal_kind, steps) VALUES
  ('marca-con-campana-activa',
   'Marca con campaña activa',
   'Seis toques en nueve días para una marca que ya está invirtiendo: presencia, encaje de audiencia, prueba '
   'de desempeño, concepto creativo, prueba social y cierre con media kit y cotización.',
   'active_campaign',
   jsonb_build_array(
     jsonb_build_object('day_offset', 0, 'order_in_day', 0, 'step_type', 'linkedin_comment', 'channel', 'linkedin',
       'angle_key', 'presencia', 'scheduled_time', '10:00', 'generate_with_ai', true, 'requires_asset', NULL,
       'guidance_es', 'Comenta algo concreto de su último post. No vendas, no menciones tarifas, no pongas enlaces.'),
     jsonb_build_object('day_offset', 1, 'order_in_day', 0, 'step_type', 'email', 'channel', 'email',
       'angle_key', 'encaje_audiencia', 'scheduled_time', '09:30', 'generate_with_ai', true, 'requires_asset', NULL,
       'guidance_es', 'Abre con la coincidencia entre tu audiencia y su cliente, con una cifra de tu perfil. '
                      'No menciones precio. Cierra con una sola pregunta.'),
     jsonb_build_object('day_offset', 3, 'order_in_day', 0, 'step_type', 'linkedin_message', 'channel', 'linkedin',
       'angle_key', 'prueba_desempeno', 'scheduled_time', '10:30', 'generate_with_ai', true, 'requires_asset', NULL,
       'guidance_es', 'Enséñale un video tuyo parecido a lo que su campaña necesita, con sus views frente a tu '
                      'mediana. No repitas la demografía del correo.'),
     jsonb_build_object('day_offset', 5, 'order_in_day', 0, 'step_type', 'email_reply', 'channel', 'email',
       'angle_key', 'concepto_creativo', 'scheduled_time', '09:30', 'generate_with_ai', true, 'requires_asset', NULL,
       'guidance_es', 'Responde en el mismo hilo con una idea de video concreta para su campaña activa. '
                      'Sin cifras de audiencia.'),
     jsonb_build_object('day_offset', 7, 'order_in_day', 0, 'step_type', 'linkedin_message', 'channel', 'linkedin',
       'angle_key', 'prueba_social', 'scheduled_time', '10:30', 'generate_with_ai', true, 'requires_asset', NULL,
       'guidance_es', 'Cuenta el resultado de una campaña tuya con una marca del mismo sector. '
                      'Solo campañas con resultado medido.'),
     jsonb_build_object('day_offset', 9, 'order_in_day', 0, 'step_type', 'email', 'channel', 'email',
       'angle_key', 'sintesis', 'scheduled_time', '09:30', 'generate_with_ai', true, 'requires_asset', 'media_kit',
       'guidance_es', 'Resume en tres líneas, enlaza el media kit y la cotización y propón una fecha concreta '
                      'para hablar. Sin urgencia falsa.')
   ));


-- =====================================================================
-- 2 · Cuentas de canal
-- ---------------------------------------------------------------------
-- Una cuenta conectada por canal y creador: el Gmail del creador por
-- OAuth, su LinkedIn o su Instagram por Unipile. En Chief la tabla de
-- cuentas no tenía organización y el refresh token vivía en cuatro
-- sitios; aquí nace con workspace_id y RLS, y el token NO está en la
-- fila: secret_ref apunta a connection_secret (0015), cifrado con una
-- clave que no está en la base. Una fila por concesión: refrescar el
-- token reescribe el secreto con la misma ref, nunca crea otra fila.
--
-- daily_cap y weekly_cap son los de la CUENTA (el proveedor castiga a
-- la cuenta, no al workspace); NULL = el de outbound_policy.
-- warmup_started_at arranca el calentamiento progresivo (VEN-15).
-- =====================================================================
CREATE TABLE outreach_channel_account (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  creator_id          uuid REFERENCES creator_profile(id) ON DELETE CASCADE,
  channel             text NOT NULL CHECK (channel IN ('email','linkedin','instagram_dm','whatsapp')),
  provider            text NOT NULL CHECK (provider IN ('gmail_oauth','unipile')),
  -- El id de la cuenta en el proveedor: la dirección de Gmail, o el
  -- account_id de Unipile.
  provider_account_id text NOT NULL CHECK (length(provider_account_id) BETWEEN 1 AND 256),
  -- Lo que se enseña: la dirección o el nombre del perfil.
  display_name        text,
  secret_ref          text REFERENCES connection_secret(secret_ref) ON DELETE SET NULL
                           CHECK (secret_ref LIKE 'enc:%'),
  status              text NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','connected','needs_reconnect','error','disconnected')),
  daily_cap           int CHECK (daily_cap BETWEEN 0 AND 2000),
  weekly_cap          int CHECK (weekly_cap BETWEEN 0 AND 10000),
  warmup_started_at   timestamptz,
  last_ok_at          timestamptz,
  last_error_at       timestamptz,
  last_error          text,
  -- Alcances concedidos (gmail.send, gmail.modify…), para saber si hay
  -- que volver a pedir permiso.
  scopes              text[] NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Gmail es correo; Unipile es LinkedIn, Instagram o WhatsApp.
  CHECK ((provider = 'gmail_oauth') = (channel = 'email'))
);
CREATE UNIQUE INDEX outreach_channel_account_provider_idx
  ON outreach_channel_account (workspace_id, provider, provider_account_id);
CREATE INDEX ON outreach_channel_account (workspace_id, channel, status);
CREATE INDEX ON outreach_channel_account (creator_id);
CREATE TRIGGER outreach_channel_account_updated BEFORE UPDATE ON outreach_channel_account
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =====================================================================
-- 3 · Secuencia, pasos y enrolamiento
-- ---------------------------------------------------------------------
-- Plantilla → secuencia → paso → enrolamiento → toque. outbound_sequence
-- (0007) guardaba los pasos en un jsonb; aquí se normalizan en
-- outbound_step para poder programar y medir cada paso. La columna
-- `steps` queda por compatibilidad y el motor ya no la lee; `channel`
-- sigue siendo el canal principal de la secuencia, y `active` convive
-- con `status` hasta que la pantalla de secuencias (VEN-13) la retire.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 3.1 · outbound_sequence: zona, modo, estado y plantilla de origen
-- ---------------------------------------------------------------------
--   timezone         la zona de la cadencia (horarios de cada paso). NULL
--                    = la del workspace. Solo nombres IANA, igual que
--                    workspace.timezone (0035).
--   automation_mode  manual: la persona envía cada toque; review: la
--                    máquina propone y la persona aprueba (lo que pide
--                    require_human_review, y el valor por defecto); auto:
--                    sale solo lo que pasa el juez.
--   status           draft, active, paused, archived.
ALTER TABLE outbound_sequence
  ADD COLUMN timezone        text,
  ADD COLUMN automation_mode text NOT NULL DEFAULT 'review'
                                  CHECK (automation_mode IN ('manual','review','auto')),
  ADD COLUMN status          text NOT NULL DEFAULT 'draft'
                                  CHECK (status IN ('draft','active','paused','archived')),
  ADD COLUMN template_id     uuid REFERENCES outbound_sequence_template(id) ON DELETE SET NULL,
  ADD COLUMN updated_at      timestamptz NOT NULL DEFAULT now();

CREATE TRIGGER outbound_sequence_updated BEFORE UPDATE ON outbound_sequence
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Las secuencias que ya existan conservan lo que decía `active`. La
-- tabla tiene RLS forzada y la migración corre sin workspace: se quita
-- FORCE un momento, como en 0033 y 0035.
DO $$
DECLARE
  forzada boolean;
BEGIN
  SELECT c.relforcerowsecurity INTO forzada
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'outbound_sequence';
  IF forzada THEN
    ALTER TABLE outbound_sequence NO FORCE ROW LEVEL SECURITY;
  END IF;
  UPDATE outbound_sequence SET status = CASE WHEN active THEN 'active' ELSE 'paused' END;
  IF forzada THEN
    ALTER TABLE outbound_sequence FORCE ROW LEVEL SECURITY;
  END IF;
END $$;

CREATE FUNCTION outbound_sequence_timezone_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.timezone IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.timezone IS NOT DISTINCT FROM OLD.timezone THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'zona horaria desconocida: «%»', NEW.timezone
      USING ERRCODE = 'invalid_parameter_value',
            HINT = 'Usa un nombre IANA, como America/Bogota o Europe/Madrid, o NULL para la del espacio.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbound_sequence_timezone_check
  BEFORE INSERT OR UPDATE OF timezone ON outbound_sequence
  FOR EACH ROW EXECUTE FUNCTION outbound_sequence_timezone_check();

-- ---------------------------------------------------------------------
-- 3.2 · outbound_step: los pasos normalizados
-- ---------------------------------------------------------------------
-- scheduled_time es la hora LOCAL en la zona de la secuencia; el motor
-- la convierte con next_business_day y la zona (sección 8). El mensaje
-- de un paso sale del generador (generate_with_ai) o de la plantilla
-- fija del paso (subject_template, body_template), que es lo que usa
-- el motor mientras no hay generación (VEN-10). guidance_es es la guía
-- por paso del recomendador (§5.5). requires_asset: el toque adjunta o
-- enlaza el media kit o la cotización.
CREATE TABLE outbound_step (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  sequence_id         uuid NOT NULL REFERENCES outbound_sequence(id) ON DELETE CASCADE,
  day_offset          int NOT NULL CHECK (day_offset BETWEEN 0 AND 60),
  order_in_day        int NOT NULL DEFAULT 0 CHECK (order_in_day BETWEEN 0 AND 20),
  step_type           text NOT NULL
                           CHECK (step_type IN ('email','email_reply','linkedin_connect','linkedin_message',
                                                'linkedin_comment','linkedin_like','instagram_dm',
                                                'instagram_comment','instagram_like','whatsapp_message',
                                                'manual_task')),
  channel             text NOT NULL CHECK (channel IN ('email','linkedin','instagram_dm','whatsapp')),
  scheduled_time      time NOT NULL DEFAULT '09:30',
  angle_id            uuid REFERENCES outbound_angle(id) ON DELETE SET NULL,
  guidance_es         text,
  subject_template    text,
  body_template       text,
  generate_with_ai    boolean NOT NULL DEFAULT true,
  requires_asset      text CHECK (requires_asset IN ('media_kit','quote')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- El canal sale del tipo de paso (ver la lista de la sección 1).
  CHECK (
    CASE
      WHEN step_type IN ('email','email_reply') THEN channel = 'email'
      WHEN step_type LIKE 'linkedin\_%' THEN channel = 'linkedin'
      WHEN step_type LIKE 'instagram\_%' THEN channel = 'instagram_dm'
      WHEN step_type = 'whatsapp_message' THEN channel = 'whatsapp'
      ELSE true
    END
  ),
  -- Sin IA, el paso necesita su plantilla (salvo los que no llevan texto).
  CHECK (generate_with_ai OR body_template IS NOT NULL
         OR step_type IN ('linkedin_like','instagram_like','manual_task'))
);
CREATE UNIQUE INDEX outbound_step_order_idx ON outbound_step (sequence_id, day_offset, order_in_day);
CREATE INDEX ON outbound_step (angle_id);
CREATE TRIGGER outbound_step_updated BEFORE UPDATE ON outbound_step
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- 3.3 · outbound_enrollment: un contacto dentro de una secuencia
-- ---------------------------------------------------------------------
--   active     el motor programa su siguiente paso
--   paused     parado a mano, o por un «fuera de la oficina» hasta
--              resume_at
--   completed  hizo todos los pasos
--   replied    respondió: se cancela lo pendiente (VEN-10, VEN-14)
--   opted_out  pidió la baja (public_optout, o la intención unsubscribe)
--   cooldown   «ahora no»: vuelve en resume_at (90 días, §5.7)
-- context guarda lo que el generador necesita recordar entre toques,
-- empezando por los ángulos ya usados: {"angles_used": ["presencia"]}.
CREATE TABLE outbound_enrollment (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  sequence_id         uuid NOT NULL REFERENCES outbound_sequence(id) ON DELETE CASCADE,
  contact_id          uuid NOT NULL REFERENCES contact(id) ON DELETE CASCADE,
  deal_id             uuid REFERENCES deal(id) ON DELETE SET NULL,
  current_step_id     uuid REFERENCES outbound_step(id) ON DELETE SET NULL,
  status              text NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','paused','completed','replied','opted_out','cooldown')),
  resume_at           timestamptz,
  context             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context) = 'object'),
  enrolled_by         uuid REFERENCES app_user(id) ON DELETE SET NULL,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'cooldown' OR resume_at IS NOT NULL)
);
-- Un contacto entra una vez en cada secuencia; si vuelve tras un
-- enfriamiento, es la misma fila la que se reanuda.
CREATE UNIQUE INDEX outbound_enrollment_contact_idx ON outbound_enrollment (sequence_id, contact_id);
CREATE INDEX ON outbound_enrollment (workspace_id, status, resume_at);
CREATE INDEX ON outbound_enrollment (contact_id);
CREATE INDEX ON outbound_enrollment (deal_id);
CREATE TRIGGER outbound_enrollment_updated BEFORE UPDATE ON outbound_enrollment
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =====================================================================
-- 4 · La cola: outbound_touch extendida
-- ---------------------------------------------------------------------
-- outbound_touch deja de ser solo el registro del envío y pasa a ser la
-- cola: una fila por enrolamiento y paso, con una máquina de estados.
--
--   draft       propuesto, sin programar (borrador de VEN-6, o lo que
--               el generador dejó para aprobar)
--   scheduled   en la cola, sale en scheduled_for (o en next_retry_at
--               si un intento falló)
--   processing  un despachador lo reclamó (claimed_at) y lo está
--               enviando. Si pasa de cinco minutos es un zombi y el
--               motor lo devuelve a scheduled
--   held        retenido para revisión humana; held_reason dice por qué
--   sent        salió (sent_at, provider_message_id)
--   failed      agotó los reintentos, o el proveedor lo rechazó
--   skipped     el paso ya no aplica (sin canal, sin correo, deal cerrado)
--   canceled    lo canceló una respuesta, una baja o el apagado
--
-- Los estados de 0007 que desaparecen se traducen: cancelled → canceled
-- (se unifica la ortografía con el resto del motor), bounced → failed,
-- blocked → held, opted_out → canceled y replied → sent, que es lo que
-- era (replied_at ya dice que respondió).
--
-- Reintentos (Chief no reintentaba: un fallo de red mataba el paso):
-- attempt_count cuenta los intentos y next_retry_at dice cuándo toca el
-- siguiente, con espera creciente (VEN-10).
--
-- Hilos: provider_message_id es el id del proveedor (Gmail o Unipile);
-- thread_ref, el hilo del proveedor; message_id_rfc, la cabecera
-- Message-ID real, que es lo que va en In-Reply-To y References (Chief
-- ponía el threadId de Gmail y rompía los hilos fuera de Gmail).
--
-- La baja: el enlace de un correo lleva un token al azar que solo va en
-- el correo; aquí se guarda su sha256 (optout_token_hash), así que quien
-- lee la tabla no puede fabricar el enlace. public_optout (sección 9) lo
-- busca por ese resumen.
-- =====================================================================
ALTER TABLE outbound_touch
  ADD COLUMN enrollment_id       uuid REFERENCES outbound_enrollment(id) ON DELETE SET NULL,
  ADD COLUMN step_id             uuid REFERENCES outbound_step(id) ON DELETE SET NULL,
  ADD COLUMN attempt_count       int NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
  ADD COLUMN next_retry_at       timestamptz,
  ADD COLUMN claimed_at          timestamptz,
  ADD COLUMN provider_message_id text,
  ADD COLUMN thread_ref          text,
  ADD COLUMN message_id_rfc      text,
  ADD COLUMN opened_at           timestamptz,
  ADD COLUMN held_reason         text,
  ADD COLUMN optout_token_hash   text CHECK (optout_token_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN updated_at          timestamptz NOT NULL DEFAULT now();

CREATE TRIGGER outbound_touch_updated BEFORE UPDATE ON outbound_touch
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Los estados. El CHECK de 0007 se llama como lo nombró Postgres.
DO $$
DECLARE
  forzada boolean;
BEGIN
  SELECT c.relforcerowsecurity INTO forzada
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'outbound_touch';
  IF forzada THEN
    ALTER TABLE outbound_touch NO FORCE ROW LEVEL SECURITY;
  END IF;

  ALTER TABLE outbound_touch DROP CONSTRAINT outbound_touch_status_check;
  UPDATE outbound_touch
     SET status = CASE status
                    WHEN 'cancelled' THEN 'canceled'
                    WHEN 'opted_out' THEN 'canceled'
                    WHEN 'bounced'   THEN 'failed'
                    WHEN 'blocked'   THEN 'held'
                    WHEN 'replied'   THEN 'sent'
                  END,
         held_reason = CASE WHEN status = 'blocked' THEN coalesce(blocked_reason, 'blocked') END
   WHERE status IN ('cancelled', 'opted_out', 'bounced', 'blocked', 'replied');
  ALTER TABLE outbound_touch ADD CONSTRAINT outbound_touch_status_check
    CHECK (status IN ('draft','scheduled','processing','held','sent','failed','skipped','canceled'));

  IF forzada THEN
    ALTER TABLE outbound_touch FORCE ROW LEVEL SECURITY;
  END IF;
END $$;

ALTER TABLE outbound_touch
  ADD CONSTRAINT outbound_touch_held_reason_check CHECK (status <> 'held' OR held_reason IS NOT NULL),
  ADD CONSTRAINT outbound_touch_processing_claimed_check CHECK (status <> 'processing' OR claimed_at IS NOT NULL);

-- Índices de la cola.
--   · Un enrolamiento no tiene dos toques vivos del mismo paso: es la
--     tercera capa de deduplicación de Chief y la que para el doble
--     avance de paso de su process-queue.
--   · (workspace_id, status, scheduled_for) ya existe desde 0007 y es el
--     que usan las pantallas; no se duplica.
--   · El reclamo del worker cruza workspaces: lo que toca salir, por hora.
--   · Los zombis: lo que lleva reclamado demasiado tiempo.
--   · Las búsquedas por id del proveedor (webhooks, respuestas, baja).
CREATE UNIQUE INDEX outbound_touch_live_step_idx ON outbound_touch (enrollment_id, step_id)
  WHERE status IN ('scheduled', 'processing');
CREATE INDEX outbound_touch_due_idx ON outbound_touch (coalesce(next_retry_at, scheduled_for))
  WHERE status = 'scheduled';
CREATE INDEX outbound_touch_claimed_idx ON outbound_touch (claimed_at) WHERE status = 'processing';
CREATE INDEX outbound_touch_enrollment_idx ON outbound_touch (enrollment_id);
CREATE INDEX outbound_touch_provider_message_idx ON outbound_touch (provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX outbound_touch_message_id_rfc_idx ON outbound_touch (message_id_rfc) WHERE message_id_rfc IS NOT NULL;
CREATE INDEX outbound_touch_optout_token_idx ON outbound_touch (optout_token_hash)
  WHERE optout_token_hash IS NOT NULL;

-- La regla dura de 0007 (no se programa ni se envía a quien pidió la
-- baja) cubre también lo que un despachador tiene reclamado: si la baja
-- llega entre el reclamo y el envío, el UPDATE a processing o a sent
-- falla y el toque no sale.
CREATE OR REPLACE FUNCTION enforce_outbound_optout() RETURNS trigger AS $$
DECLARE
  is_out boolean;
BEGIN
  IF NEW.status IN ('scheduled','processing','sent') AND NEW.contact_id IS NOT NULL THEN
    SELECT opted_out INTO is_out FROM contact WHERE id = NEW.contact_id;
    IF is_out THEN
      RAISE EXCEPTION 'El contacto % pidió no ser contactado (opt-out).', NEW.contact_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- =====================================================================
-- 5 · Mensajes por hilo y revisiones de calidad
-- =====================================================================

-- ---------------------------------------------------------------------
-- 5.1 · outbound_message: lo que entra y lo que sale, por hilo
-- ---------------------------------------------------------------------
-- La bandeja unificada (VEN-14) lee de aquí: correo, LinkedIn e
-- Instagram en un solo lugar. Lo que sale también se copia aquí (el
-- toque es la cola; el mensaje es la conversación). intent la pone el
-- clasificador barato (§5.7) solo a lo que entra; resume_at es la fecha
-- de vuelta de un «fuera de la oficina».
CREATE TABLE outbound_message (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_account_id  uuid REFERENCES outreach_channel_account(id) ON DELETE SET NULL,
  enrollment_id       uuid REFERENCES outbound_enrollment(id) ON DELETE SET NULL,
  touch_id            uuid REFERENCES outbound_touch(id) ON DELETE SET NULL,
  contact_id          uuid REFERENCES contact(id) ON DELETE SET NULL,
  deal_id             uuid REFERENCES deal(id) ON DELETE SET NULL,
  direction           text NOT NULL CHECK (direction IN ('inbound','outbound')),
  channel             text NOT NULL CHECK (channel IN ('email','linkedin','instagram_dm','whatsapp')),
  thread_ref          text,
  provider_message_id text,
  message_id_rfc      text,
  in_reply_to         text,
  from_address        text,
  subject             text,
  body                text NOT NULL,
  intent              text CHECK (intent IN ('interested','not_now','ooo','unsubscribe','referral','ambiguous')),
  intent_confidence   numeric(4,3) CHECK (intent_confidence BETWEEN 0 AND 1),
  classified_at       timestamptz,
  resume_at           timestamptz,
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  read_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (direction = 'inbound' OR intent IS NULL)
);
-- Un webhook que llega dos veces no crea dos mensajes.
CREATE UNIQUE INDEX outbound_message_provider_idx
  ON outbound_message (workspace_id, channel, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX ON outbound_message (workspace_id, thread_ref, occurred_at);
CREATE INDEX ON outbound_message (workspace_id, occurred_at DESC) WHERE direction = 'inbound' AND read_at IS NULL;
CREATE INDEX ON outbound_message (enrollment_id);
CREATE INDEX ON outbound_message (contact_id);

-- ---------------------------------------------------------------------
-- 5.2 · outbound_review: cada evaluación de la puerta de calidad
-- ---------------------------------------------------------------------
-- Una fila por intento: lo que dijo el pre-vuelo (gates), la nota por
-- dimensión (scores: relevance, quality, structure, voice, de 0 a 10),
-- la nota ponderada, la pista para regenerar, los disparadores de riesgo
-- que fuerzan revisión humana y la decisión. Registra el modelo, los
-- tokens y el costo de cada llamada (0 si el intento no llegó al juez).
-- Es una bitácora: se inserta y no se corrige.
--
-- El costo va en numeric(14,6) y no en (14,2): una llamada cuesta
-- fracciones de centavo y redondeada a dos decimales sumaría cero. La
-- moneda va aparte, como en el resto del esquema.
CREATE TABLE outbound_review (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  touch_id            uuid NOT NULL REFERENCES outbound_touch(id) ON DELETE CASCADE,
  attempt             int NOT NULL CHECK (attempt BETWEEN 1 AND 10),
  subject             text,
  body                text NOT NULL,
  gates               jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(gates) = 'object'),
  scores              jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(scores) = 'object'),
  total_score         numeric(4,2) CHECK (total_score BETWEEN 0 AND 10),
  regenerate_hint     text CHECK (regenerate_hint IN ('shorter','more_specific','other_angle','other_signal',
                                                      'soften','add_proof')),
  risk_triggers       text[] NOT NULL DEFAULT '{}'
                           CHECK (risk_triggers <@ ARRAY['unsourced_figure','invented_client','false_urgency',
                                                         'pressure','competitor_mention','missing_disclosure']::text[]),
  decision            text NOT NULL CHECK (decision IN ('pass','regenerate','send_best','hold','reject')),
  model               text,
  input_tokens        int NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens       int NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost                numeric(14,6) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  cost_currency       char(3) NOT NULL DEFAULT 'USD',
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (touch_id, attempt)
);
CREATE INDEX ON outbound_review (workspace_id, created_at);
