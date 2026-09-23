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
--   5 · Mensajes por hilo, revisiones de calidad y llamadas al modelo
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
--
-- Los pesos se comprueban en la base, no en el juez: un workspace que
-- edita su rúbrica no puede dejar una nota ponderada fuera de 0–10 (con
-- pesos que no suman 1) ni sin alguna de las cuatro dimensiones.
CREATE FUNCTION outbound_rubric_weights_valid(p_weights jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  -- CASE y no AND: Postgres no promete el orden de un AND, y el cast a
  -- numeric de algo que no es un número lanzaría en vez de decir false.
  SELECT CASE
           WHEN jsonb_typeof(p_weights) <> 'object'
                OR NOT (p_weights ?& ARRAY['relevance','quality','structure','voice'])
                OR (p_weights - ARRAY['relevance','quality','structure','voice']) <> '{}'::jsonb
                OR jsonb_typeof(p_weights -> 'relevance') <> 'number'
                OR jsonb_typeof(p_weights -> 'quality') <> 'number'
                OR jsonb_typeof(p_weights -> 'structure') <> 'number'
                OR jsonb_typeof(p_weights -> 'voice') <> 'number'
             THEN false
           ELSE (p_weights ->> 'relevance')::numeric >= 0
                AND (p_weights ->> 'quality')::numeric >= 0
                AND (p_weights ->> 'structure')::numeric >= 0
                AND (p_weights ->> 'voice')::numeric >= 0
                AND abs((p_weights ->> 'relevance')::numeric + (p_weights ->> 'quality')::numeric
                        + (p_weights ->> 'structure')::numeric + (p_weights ->> 'voice')::numeric - 1) < 0.001
         END;
$$;

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
  -- voice): las cuatro, ninguna más, no negativas y sumando 1 (CHECK).
  weights             jsonb NOT NULL DEFAULT '{"relevance":0.3,"quality":0.25,"structure":0.25,"voice":0.2}'::jsonb
                           CONSTRAINT outbound_step_rubric_weights_check CHECK (outbound_rubric_weights_valid(weights)),
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
-- la cuenta, no al workspace); NULL = el de outbound_policy. Se cuentan
-- en outbound_counter con channel_account_id (6.2), así que tres
-- LinkedIn de una agencia en el mismo workspace no comparten plaza.
-- warmup_started_at arranca el calentamiento progresivo (VEN-15).
--
-- Un buzón, una cuenta viva EN TODA LA PLATAFORMA: (provider,
-- provider_account_id) es único entre las cuentas que no están
-- desconectadas, cruzando workspaces. Los topes se cuentan por
-- channel_account_id, así que el mismo Gmail conectado en el workspace
-- del creador y en el de su agencia tendría dos filas, dos contadores y
-- podría enviar el doble de lo que el proveedor aguanta. Contar por
-- (provider, provider_account_id) en vez de por fila obligaría a un
-- contador que cruza workspaces, que la RLS de outbound_counter no deja
-- ni leer ni escribir desde el workspace. Se elige la regla simple: el
-- buzón envía desde UN workspace; para moverlo, se desconecta en el
-- otro. Dentro del workspace la unicidad es completa (también con la
-- fila desconectada): reconectar reutiliza la fila, no crea otra.
--
-- El índice global es un oráculo aceptado (UNICOS_GLOBALES_DECLARADOS
-- en src/esquema.ts): la web solo escribe provider_account_id con lo
-- que devuelve el proveedor al terminar el OAuth de Google o el alta en
-- Unipile, así que chocar exige haber autenticado esa misma cuenta.
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
  CHECK ((provider = 'gmail_oauth') = (channel = 'email')),
  -- La dirección de Gmail se guarda normalizada: 'Laura@gmail.com' y
  -- 'laura@gmail.com' son el mismo buzón, y con dos filas el buzón
  -- tendría dos topes y podría enviar el doble. El account_id de
  -- Unipile distingue mayúsculas y se deja tal cual.
  CONSTRAINT outreach_channel_account_gmail_lower_check
    CHECK (provider <> 'gmail_oauth' OR provider_account_id = lower(btrim(provider_account_id)))
);
CREATE UNIQUE INDEX outreach_channel_account_provider_idx
  ON outreach_channel_account (workspace_id, provider, provider_account_id);
CREATE UNIQUE INDEX outreach_channel_account_live_idx
  ON outreach_channel_account (provider, provider_account_id)
  WHERE status <> 'disconnected';
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
-- Mientras convivan, `status` manda y `active` se deriva de él con un
-- disparador (3.1): no hay dos verdades que se puedan contradecir.
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

-- `active` es la sombra de `status` (active ⇔ status = 'active'):
--   · al crear, o si cambia status, active se recalcula desde status;
--   · si solo cambia active (código de antes de 0037), status lo sigue:
--     true → 'active', false → 'paused'. Así una pantalla que escribe
--     active = false para la secuencia también para el motor, que lee
--     status;
--   · si cambian los dos y no concuerdan, gana status.
-- Un alta que solo diga active (sin status) nace en 'draft' y, por
-- tanto, con active = false: una secuencia nueva no arranca sola.
CREATE FUNCTION outbound_sequence_sync_active()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.active IS DISTINCT FROM OLD.active THEN
    NEW.status := CASE WHEN NEW.active THEN 'active' ELSE 'paused' END;
  END IF;
  NEW.active := (NEW.status = 'active');
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbound_sequence_sync_active
  BEFORE INSERT OR UPDATE OF status, active ON outbound_sequence
  FOR EACH ROW EXECUTE FUNCTION outbound_sequence_sync_active();

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
-- Borrar un paso pone a NULL current_step_id (SET NULL): sin índice,
-- recorrería todos los enrolamientos.
CREATE INDEX ON outbound_enrollment (current_step_id);
CREATE TRIGGER outbound_enrollment_updated BEFORE UPDATE ON outbound_enrollment
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A quien pidió la baja no se le enrola, ni se le reanuda. Sin esto el
-- alta quedaba 'active' y el motor (VEN-10) chocaba con la regla de
-- outbound_touch (4.1) en cada vuelta, con el error lejos de su causa.
-- Mismo mensaje y mismo código que la regla de 0007. Vigila el alta y
-- los cambios de contacto o de estado hacia uno vivo (active, paused,
-- cooldown); pasar a opted_out, completed o replied siempre se puede, y
-- una anotación que no cambia ni el estado ni el contacto (context,
-- current_step_id) pasa aunque la baja ya esté puesta.
CREATE FUNCTION enforce_enrollment_optout()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  is_out boolean;
BEGIN
  IF NEW.status NOT IN ('active', 'paused', 'cooldown') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.contact_id IS NOT DISTINCT FROM OLD.contact_id THEN
    RETURN NEW;
  END IF;
  SELECT opted_out INTO is_out FROM contact WHERE id = NEW.contact_id;
  IF coalesce(is_out, false) THEN
    RAISE EXCEPTION 'El contacto % pidió no ser contactado (opt-out).', NEW.contact_id
      USING ERRCODE = 'check_violation',
            HINT = 'Un enrolamiento de quien pidió la baja solo puede estar en opted_out, completed o replied.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbound_enrollment_optout
  BEFORE INSERT OR UPDATE OF contact_id, status ON outbound_enrollment
  FOR EACH ROW EXECUTE FUNCTION enforce_enrollment_optout();


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
-- Los dos motivos (hasta que VEN-10 los necesite separados, no hay una
-- tercera columna):
--   held_reason     por qué está RETENIDO (status = 'held'): lo lee la
--                   persona que tiene que aprobarlo.
--   blocked_reason  (de 0007) por qué TERMINÓ sin salir: el motivo de la
--                   cancelación o del salto ('opted_out',
--                   'outreach_disabled', 'replied'…). Y una sola anomalía
--                   en un toque enviado: 'opted_out_in_flight', la baja
--                   llegó mientras el despachador lo enviaba (ver 4.2).
--
-- status_changed_at es la hora del último CAMBIO de estado, y solo se
-- mueve con él (4.2). La salud cuenta los fallos y las cancelaciones de
-- la ventana por esa hora, no por updated_at: anotar opened_at en un
-- toque que falló hace un mes no lo vuelve a contar como fallo de hoy.
--
-- La baja: el enlace de un correo lleva un token al azar que solo va en
-- el correo; aquí se guarda su sha256 (optout_token_hash), así que quien
-- lee la tabla no puede fabricar el enlace. public_optout (sección 9) lo
-- busca por ese resumen.
--
-- Y quien escribe la tabla tampoco puede fabricar un toque «enviado»
-- que sirva: optout_token_hash, provider_message_id, message_id_rfc y
-- recipient_address son las pruebas de que la PLATAFORMA envió el
-- mensaje, y solo las escribe el despachador (mc_worker) o quien migra
-- (4.2). Sin eso, un workspace inventaba un token, guardaba su sha256 en
-- un toque suyo en 'sent' a una ficha con el correo de otra persona y,
-- con public_optout, la daba de baja en toda la plataforma sin haberle
-- escrito nunca: el sabotaje que 0029 §1 cerró para el opted_out del CRM.
--
-- recipient_address es la dirección EXACTA a la que salió el mensaje,
-- escrita por el despachador en el momento del envío. La baja se anota
-- sobre ella y no sobre contact.email ni sobre el contact_id de hoy: la
-- ficha se puede editar, borrar o cambiar después del envío, y quien
-- pulsa el enlace es quien recibió ESE correo. Por la misma razón, un
-- toque con pruebas de envío no cambia de destinatario (ni de contacto
-- ni de empresa) desde la aplicación (4.2): antes de este candado, un
-- workspace se escribía un correo a sí mismo, movía el toque a una
-- ficha con el correo de otra persona (o le cambiaba el correo a su
-- propia ficha) y pulsaba su enlace, las veces que quisiera.
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
  ADD COLUMN recipient_address   citext CHECK (length(recipient_address) BETWEEN 3 AND 320),
  ADD COLUMN status_changed_at   timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at          timestamptz NOT NULL DEFAULT now(),
  -- En un correo, la dirección es una dirección (sin espacios, con una
  -- sola arroba): es lo que public_optout anota en la lista global.
  ADD CONSTRAINT outbound_touch_recipient_email_check
    CHECK (recipient_address IS NULL OR channel <> 'email' OR recipient_address ~ '^[^@\s]+@[^@\s]+$');

CREATE TRIGGER outbound_touch_updated BEFORE UPDATE ON outbound_touch
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- 4.1 · La regla de la baja, en las transiciones
-- ---------------------------------------------------------------------
-- La regla dura de 0007 (no se programa ni se envía a quien pidió la
-- baja) se reescribe ANTES de traducir los estados de abajo: la de 0007
-- saltaba en cualquier UPDATE de un toque en 'sent', y la traducción
-- misma (replied → sent) fallaría con un contacto dado de baja.
--
-- Vigila el alta y los CAMBIOS, no las anotaciones: un UPDATE que no
-- cambia ni el estado ni el contacto pasa siempre. Si no, después de una
-- baja ya no se podría anotar replied_at («bórrame» es una respuesta),
-- opened_at, thread_ref ni provider_message_id en un toque que ya salió.
--
--   · entrar en scheduled o processing con un contacto dado de baja: no.
--   · entrar en sent (un alta, o desde draft, scheduled o held): no; es
--     registrar como enviado algo que la regla no dejaba enviar.
--   · processing → sent: SÍ. El despachador ya llamó al proveedor y el
--     mensaje salió; negarlo dejaría la fila mintiendo (en processing, y
--     después zombi y reintento: un SEGUNDO envío). Se registra, y se
--     marca con blocked_reason = 'opted_out_in_flight' para que la salud
--     lo cuente y nadie lo confunda con un envío normal.
--
-- Por eso ni public_optout ni disable_outreach cancelan lo que está en
-- 'processing': es del despachador que lo reclamó. El contrato de ese
-- despachador (VEN-10), que esta regla hace cumplir:
--   1. antes de llamar al proveedor, relee el contacto y la política en
--      la transacción del envío; con la baja o el apagado, pasa el toque
--      a 'canceled' (processing → canceled siempre se puede) y no envía;
--   2. después de llamar, processing → sent, aunque la baja haya llegado
--      en medio;
--   3. al rescatar un zombi (processing de más de cinco minutos), el
--      que tenga el contacto dado de baja va a 'canceled' y no a
--      'scheduled', que la regla rechaza.
CREATE OR REPLACE FUNCTION enforce_outbound_optout()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  is_out boolean;
BEGIN
  IF NEW.contact_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.contact_id IS NOT DISTINCT FROM OLD.contact_id THEN
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('scheduled', 'processing', 'sent') THEN
    RETURN NEW;
  END IF;

  SELECT opted_out INTO is_out FROM contact WHERE id = NEW.contact_id;
  IF NOT coalesce(is_out, false) THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'sent' AND TG_OP = 'UPDATE' AND OLD.status = 'processing'
     AND NEW.contact_id IS NOT DISTINCT FROM OLD.contact_id THEN
    NEW.blocked_reason := 'opted_out_in_flight';
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'El contacto % pidió no ser contactado (opt-out).', NEW.contact_id
    USING ERRCODE = 'check_violation';
END;
$$;

-- ---------------------------------------------------------------------
-- 4.2 · Las columnas del despachador y la hora del cambio de estado
-- ---------------------------------------------------------------------
-- Candado por COLUMNA y por disparador, no por GRANT: Drizzle escribe
-- todas las columnas en cada INSERT (las que no lleva, como DEFAULT), y
-- un GRANT INSERT por columnas rompería cualquier alta de la web. Y un
-- disparador mira current_user, que es el rol efectivo aunque la
-- conexión herede otros (el mc_app_ci del CI es miembro de mc_worker).
--
-- Pueden escribirlas: mc_worker (el despachador, tras SET ROLE), y un
-- superusuario o un rol con BYPASSRLS (quien migra o siembra). mc_app,
-- no: ni al crear el toque ni después. Poner NULL donde ya había algo
-- también es escribir.
--
-- Y el destinatario de un toque con pruebas de envío (cualquiera de las
-- cuatro columnas) queda fijo para mc_app: ni contact_id ni company_id
-- cambian. La única excepción es contact_id → NULL, que es lo que hace
-- la clave ajena (ON DELETE SET NULL, 0007) al borrar la ficha, y no
-- redirige nada: public_optout ya no mira la ficha sino
-- recipient_address. De NULL a otra ficha, en cambio, sí es cambiar de
-- destinatario, y no se deja.
CREATE FUNCTION outbound_touch_worker_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  puede boolean;
  pruebas boolean;
  destinatario boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    pruebas := NEW.optout_token_hash IS NOT NULL OR NEW.provider_message_id IS NOT NULL
               OR NEW.message_id_rfc IS NOT NULL OR NEW.recipient_address IS NOT NULL;
  ELSE
    pruebas := NEW.optout_token_hash IS DISTINCT FROM OLD.optout_token_hash
               OR NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id
               OR NEW.message_id_rfc IS DISTINCT FROM OLD.message_id_rfc
               OR NEW.recipient_address IS DISTINCT FROM OLD.recipient_address;
    destinatario := (OLD.optout_token_hash IS NOT NULL OR OLD.provider_message_id IS NOT NULL
                     OR OLD.message_id_rfc IS NOT NULL OR OLD.recipient_address IS NOT NULL)
                    AND ((NEW.contact_id IS DISTINCT FROM OLD.contact_id AND NEW.contact_id IS NOT NULL)
                         OR NEW.company_id IS DISTINCT FROM OLD.company_id);
  END IF;
  IF NOT pruebas AND NOT destinatario THEN
    RETURN NEW;
  END IF;

  SELECT current_user = 'mc_worker' OR r.rolsuper OR r.rolbypassrls INTO puede
    FROM pg_catalog.pg_roles r
   WHERE r.rolname = current_user;
  IF coalesce(puede, false) THEN
    RETURN NEW;
  END IF;
  IF pruebas THEN
    RAISE EXCEPTION 'optout_token_hash, provider_message_id, message_id_rfc y recipient_address los escribe solo el '
                    'despachador (rol %).', current_user
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Son la prueba de que la plataforma envió el mensaje: la escribe el worker con asWorker.';
  END IF;
  RAISE EXCEPTION 'Un toque enviado no cambia de destinatario: contact_id y company_id son los del envío (rol %).',
                  current_user
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'La baja del enlace se anota sobre recipient_address; para otro destinatario, otro toque.';
END;
$$;

CREATE TRIGGER outbound_touch_worker_columns
  BEFORE INSERT OR UPDATE OF optout_token_hash, provider_message_id, message_id_rfc, recipient_address,
                             contact_id, company_id ON outbound_touch
  FOR EACH ROW EXECUTE FUNCTION outbound_touch_worker_columns();

-- status_changed_at solo se mueve cuando cambia el estado; lo que venga
-- escrito en un UPDATE que no lo cambia se ignora. Se crea después de
-- rellenar las filas que ya existen (abajo).
CREATE FUNCTION outbound_touch_status_changed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := now();
  ELSE
    NEW.status_changed_at := OLD.status_changed_at;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- 4.3 · Los estados
-- ---------------------------------------------------------------------
-- El CHECK de 0007 se llama como lo nombró Postgres. Las filas que ya
-- existen toman como hora de su último cambio la del envío o la del alta.
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
  -- Traducir no es enviar: replied → sent en un contacto que después
  -- pidió la baja es la misma fila de siempre con otro nombre, y la
  -- regla de 4.1 lo tomaría por un envío nuevo.
  ALTER TABLE outbound_touch DISABLE TRIGGER outbound_touch_optout;
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
  UPDATE outbound_touch SET status_changed_at = coalesce(sent_at, created_at);
  ALTER TABLE outbound_touch ENABLE TRIGGER outbound_touch_optout;

  IF forzada THEN
    ALTER TABLE outbound_touch FORCE ROW LEVEL SECURITY;
  END IF;
END $$;

CREATE TRIGGER outbound_touch_status_changed BEFORE UPDATE OF status, status_changed_at ON outbound_touch
  FOR EACH ROW EXECUTE FUNCTION outbound_touch_status_changed();

ALTER TABLE outbound_touch
  ADD CONSTRAINT outbound_touch_held_reason_check CHECK (status <> 'held' OR held_reason IS NOT NULL),
  ADD CONSTRAINT outbound_touch_processing_claimed_check CHECK (status <> 'processing' OR claimed_at IS NOT NULL);

-- Índices de la cola.
--   · Un enrolamiento no tiene dos toques vivos del mismo paso: es la
--     tercera capa de deduplicación de Chief y la que para el doble
--     avance de paso de su process-queue. «Vivo» es lo que todavía puede
--     salir: scheduled, processing y también held. Un retenido que se
--     aprueba vuelve a scheduled; si al lado hubiera otro scheduled del
--     mismo paso, saldrían los dos. Con held en el índice, el motor no
--     puede programar el paso otra vez mientras uno espera revisión: o
--     lo aprueba, o lo cancela y programa otro.
--   · (workspace_id, status, scheduled_for) ya existe desde 0007 y es el
--     que usan las pantallas; no se duplica.
--   · El reclamo del worker cruza workspaces: lo que toca salir, por hora.
--   · Los zombis: lo que lleva reclamado demasiado tiempo.
--   · Las búsquedas por id del proveedor (webhooks, respuestas, baja).
CREATE UNIQUE INDEX outbound_touch_live_step_idx ON outbound_touch (enrollment_id, step_id)
  WHERE status IN ('scheduled', 'processing', 'held');
CREATE INDEX outbound_touch_due_idx ON outbound_touch (coalesce(next_retry_at, scheduled_for))
  WHERE status = 'scheduled';
CREATE INDEX outbound_touch_claimed_idx ON outbound_touch (claimed_at) WHERE status = 'processing';
CREATE INDEX outbound_touch_enrollment_idx ON outbound_touch (enrollment_id);
-- El único de arriba empieza por enrollment_id y solo cubre lo vivo:
-- borrar un paso (step_id SET NULL) recorrería toda la cola.
CREATE INDEX outbound_touch_step_idx ON outbound_touch (step_id);
CREATE INDEX outbound_touch_provider_message_idx ON outbound_touch (provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX outbound_touch_message_id_rfc_idx ON outbound_touch (message_id_rfc) WHERE message_id_rfc IS NOT NULL;
CREATE INDEX outbound_touch_optout_token_idx ON outbound_touch (optout_token_hash)
  WHERE optout_token_hash IS NOT NULL;
-- La salud cuenta fallos y cancelaciones por la hora del cambio de estado.
CREATE INDEX outbound_touch_status_changed_idx ON outbound_touch (workspace_id, status, status_changed_at);


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
-- Borrar un toque o una cuenta pone a NULL estas claves (SET NULL).
CREATE INDEX ON outbound_message (touch_id);
CREATE INDEX ON outbound_message (channel_account_id);

-- ---------------------------------------------------------------------
-- 5.2 · outbound_review: cada evaluación de la puerta de calidad
-- ---------------------------------------------------------------------
-- Una fila por intento: lo que dijo el pre-vuelo (gates), la nota por
-- dimensión (scores: relevance, quality, structure, voice, de 0 a 10),
-- la nota ponderada, la pista para regenerar, los disparadores de riesgo
-- que fuerzan revisión humana y la decisión. Guarda el modelo, los
-- tokens y el costo de la llamada al JUEZ de ese intento (0 si no llegó
-- al juez), como detalle de la revisión. Lo que suma el presupuesto no
-- es esto: es outbound_llm_call (5.3), donde también está esa llamada.
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

-- ---------------------------------------------------------------------
-- 5.3 · outbound_llm_call: cada llamada al modelo, con su costo
-- ---------------------------------------------------------------------
-- La regla del proyecto: se registran los tokens y el costo de CADA
-- llamada. Una fila por llamada del outreach, sea cual sea el propósito:
--   generate   el generador (claude-sonnet), también la que no llega al juez
--   judge      el juez de la puerta de calidad (además de outbound_review)
--   classify   el clasificador de intención de lo que entra (haiku, §5.7)
--   recommend  el recomendador de secuencias (VEN-13)
-- outbound_health suma aquí el gasto del día contra llm_daily_cap_usd:
-- si una llamada no deja fila, el tope no la ve. Bitácora: se inserta,
-- no se corrige ni se borra (7.4). touch_id y message_id dicen a qué
-- toque o a qué mensaje recibido sirvió, si a alguno.
CREATE TABLE outbound_llm_call (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  purpose             text NOT NULL CHECK (purpose IN ('generate','judge','classify','recommend')),
  model               text NOT NULL CHECK (length(model) BETWEEN 1 AND 100),
  input_tokens        int NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens       int NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost                numeric(14,6) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  cost_currency       char(3) NOT NULL DEFAULT 'USD',
  touch_id            uuid REFERENCES outbound_touch(id) ON DELETE SET NULL,
  message_id          uuid REFERENCES outbound_message(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON outbound_llm_call (workspace_id, created_at);
CREATE INDEX ON outbound_llm_call (touch_id);
CREATE INDEX ON outbound_llm_call (message_id);


-- =====================================================================
-- 6 · Límites: política, contadores y disyuntores
-- =====================================================================

-- ---------------------------------------------------------------------
-- 6.1 · outbound_policy: interruptor, presupuesto, calentamiento y dirección
-- ---------------------------------------------------------------------
--   enabled              el interruptor de apagado del workspace. Nace
--                        APAGADO: el envío se enciende por workspace
--                        cuando hay un canal conectado y una política
--                        aceptada (decisión 2 de §8), y
--                        disable_outreach lo apaga cancelando lo pendiente.
--   disabled_reason/at   por qué y cuándo se apagó (lo enseña la pantalla).
--   llm_daily_cap_usd    presupuesto diario del juez y el generador, en
--                        dólares (la moneda de la factura del proveedor).
--   warmup_days          días de calentamiento progresivo de una cuenta nueva.
--   postal_address       la dirección postal del pie de baja (CAN-SPAM).
--                        Sin ella no se puede encender el envío: lo
--                        exige un CHECK, no una pantalla.
--   max_pending_touches  contrapresión: mide ATRASO, no volumen. Con más
--                        toques vencidos sin salir (scheduled con su hora
--                        ya pasada) o en processing que esto,
--                        should_pause_outreach dice que se pare. Lo
--                        programado para dentro de unos días no cuenta:
--                        una cadencia larga con muchas marcas no es un
--                        atasco.
ALTER TABLE outbound_policy
  ADD COLUMN enabled             boolean NOT NULL DEFAULT false,
  ADD COLUMN disabled_reason     text,
  ADD COLUMN disabled_at         timestamptz,
  ADD COLUMN llm_daily_cap_usd   numeric(14,2) NOT NULL DEFAULT 5.00 CHECK (llm_daily_cap_usd >= 0),
  ADD COLUMN warmup_days         int NOT NULL DEFAULT 14 CHECK (warmup_days BETWEEN 0 AND 90),
  ADD COLUMN postal_address      text,
  ADD COLUMN max_pending_touches int NOT NULL DEFAULT 200 CHECK (max_pending_touches BETWEEN 1 AND 10000),
  ADD CONSTRAINT outbound_policy_enabled_needs_address
    CHECK (NOT enabled OR (postal_address IS NOT NULL AND btrim(postal_address) <> ''));

CREATE TRIGGER outbound_policy_updated BEFORE UPDATE ON outbound_policy
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- 6.2 · outbound_counter: contadores atómicos por periodo y acción
-- ---------------------------------------------------------------------
-- Una fila por workspace, CUENTA, periodo y action_type ('email',
-- 'linkedin_invite', 'linkedin_message', 'instagram_dm', 'llm_call'…).
--
-- channel_account_id es la cuenta que envía. Los topes de §5.1 (80 a
-- 100 invitaciones de LinkedIn al día, el volumen de un Gmail nuevo) son
-- de la cuenta, porque el proveedor castiga a la cuenta: una agencia con
-- tres creadores y tres LinkedIn en el mismo workspace lleva tres
-- contadores de 'linkedin_invite', y una cuenta no se come la plaza de
-- otra. NULL es el contador del workspace entero, para los topes que sí
-- son del workspace (outbound_policy.max_emails_per_day, 'llm_call'). El
-- despachador cuenta los dos: primero el de la cuenta y después el del
-- workspace, en la misma transacción.
--
-- La clave es un id sustituto y la unicidad va en un índice NULLS NOT
-- DISTINCT: con NULL en una clave primaria no se podría, y con NULLS
-- DISTINCT dos filas del workspace entero para el mismo día no
-- chocarían y el INSERT … ON CONFLICT crearía una segunda en vez de
-- bloquear la primera.
--
-- La semana es SU PROPIA fila (period = 'week', period_start = el lunes)
-- y no la suma de siete filas diarias: Chief bloqueaba la fila de hoy y
-- sumaba la semana, así que dos despachadores en días distintos de la
-- misma semana se colaban a la vez. Aquí cada función bloquea la fila
-- del periodo que cuenta. El día y la semana son los de la zona del
-- workspace (la cuenta de «hoy» de un creador en Bogotá no se reinicia
-- a las 19:00).
--
-- No es una métrica: es un semáforo. Por eso se actualiza en su sitio.
CREATE TABLE outbound_counter (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_account_id  uuid REFERENCES outreach_channel_account(id) ON DELETE CASCADE,  -- NULL = el workspace
  period              text NOT NULL CHECK (period IN ('day','week')),
  period_start        date NOT NULL,
  action_type         text NOT NULL CHECK (action_type ~ '^[a-z][a-z0-9_]{1,40}$'),
  count               int NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (period = 'day' OR extract(isodow FROM period_start) = 1)
);
CREATE UNIQUE INDEX outbound_counter_period_idx
  ON outbound_counter (workspace_id, channel_account_id, period, period_start, action_type) NULLS NOT DISTINCT;
CREATE INDEX ON outbound_counter (channel_account_id);

-- ---------------------------------------------------------------------
-- 6.3 · outbound_breaker: disyuntor por tipo de paso
-- ---------------------------------------------------------------------
-- Si en los últimos window_size toques de un tipo (con al menos
-- min_samples) la tasa de fallos pasa de failure_threshold, el tipo se
-- abre y el motor deja de despacharlo hasta que alguien lo cierre o
-- pase al estado half_open de prueba. Lo calcula el worker.
CREATE TABLE outbound_breaker (
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  step_type           text NOT NULL
                           CHECK (step_type IN ('email','email_reply','linkedin_connect','linkedin_message',
                                                'linkedin_comment','linkedin_like','instagram_dm',
                                                'instagram_comment','instagram_like','whatsapp_message')),
  state               text NOT NULL DEFAULT 'closed' CHECK (state IN ('closed','open','half_open')),
  window_size         int NOT NULL DEFAULT 50 CHECK (window_size BETWEEN 5 AND 500),
  min_samples         int NOT NULL DEFAULT 20 CHECK (min_samples BETWEEN 1 AND 500),
  failure_threshold   numeric(4,3) NOT NULL DEFAULT 0.300 CHECK (failure_threshold BETWEEN 0 AND 1),
  failures            int NOT NULL DEFAULT 0 CHECK (failures >= 0),
  samples             int NOT NULL DEFAULT 0 CHECK (samples >= 0),
  opened_at           timestamptz,
  reason              text,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, step_type),
  CHECK (min_samples <= window_size),
  CHECK (state = 'closed' OR opened_at IS NOT NULL)
);
CREATE TRIGGER outbound_breaker_updated BEFORE UPDATE ON outbound_breaker
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =====================================================================
-- 7 · Aislamiento de las tablas nuevas, referencias y privilegios
-- =====================================================================

-- ---------------------------------------------------------------------
-- 7.1 · Las tablas con workspace_id: el patrón de 0010
-- ---------------------------------------------------------------------
-- ENABLE + FORCE y una política por workspace. Y la misma guardia: si
-- una tabla de la lista no tiene workspace_id, la migración falla en
-- vez de dejar una política que no aísla.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'outreach_channel_account', 'outbound_step', 'outbound_enrollment', 'outbound_message',
    'outbound_review', 'outbound_llm_call', 'outbound_counter', 'outbound_breaker'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'workspace_id'
    ) THEN
      RAISE EXCEPTION 'La tabla % está en la lista de RLS pero no tiene workspace_id', t;
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_ws_isolation ON %I USING (workspace_id = current_workspace_id())',
      t, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 7.2 · Ángulos y rúbrica: catálogos con dueño (0020 §3, 0025 §4)
-- ---------------------------------------------------------------------
--   read   lo global y lo mío
--   write  solo lo mío: nadie edita ni borra lo global ni lo de otro
--   seed   una fila global solo la crea quien migra (TO CURRENT_USER:
--          mc_migrator en Supabase, mc_migrator_embedded en pglite), sin
--          workspace fijado. Desde la aplicación, no.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['outbound_angle', 'outbound_step_rubric'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'workspace_id'
    ) THEN
      RAISE EXCEPTION 'La tabla % está en la lista de RLS pero no tiene workspace_id', t;
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_read ON %I FOR SELECT '
      'USING (workspace_id IS NULL OR workspace_id = current_workspace_id())', t, t);
    EXECUTE format(
      'CREATE POLICY %I_write ON %I FOR ALL '
      'USING (workspace_id = current_workspace_id()) '
      'WITH CHECK (workspace_id = current_workspace_id())', t, t);
    EXECUTE format(
      'CREATE POLICY %I_seed ON %I FOR INSERT TO CURRENT_USER '
      'WITH CHECK (workspace_id IS NULL AND current_workspace_id() IS NULL)', t, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 7.3 · Plantillas de secuencia: de todos para leer, de nadie para escribir
-- ---------------------------------------------------------------------
-- No hay nada de ningún inquilino que aislar: son las mismas para todos.
-- Aun así llevan RLS, con una política de lectura abierta (declarada con
-- su motivo en src/esquema.ts, POLITICAS_ABIERTAS_DECLARADAS) y ninguna
-- de escritura para la aplicación: sin política, ni un GRANT de más
-- dejaría escribir. El alta es de quien migra, como en 7.2.
ALTER TABLE outbound_sequence_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_sequence_template FORCE ROW LEVEL SECURITY;
CREATE POLICY outbound_sequence_template_read ON outbound_sequence_template FOR SELECT
  USING (true);
CREATE POLICY outbound_sequence_template_seed ON outbound_sequence_template FOR INSERT TO CURRENT_USER
  WITH CHECK (current_workspace_id() IS NULL);

-- ---------------------------------------------------------------------
-- 7.4 · Privilegios de mc_app (src/esquema.ts, PRIVILEGIOS_DE_LA_APP)
-- ---------------------------------------------------------------------
-- Las tablas nacen con los cuatro privilegios (ALTER DEFAULT PRIVILEGES)
-- y la política aísla la fila. Aquí se quita lo que una pantalla no
-- tiene por qué hacer aunque la fila sea suya:
--   · plantillas: catálogo global de solo lectura;
--   · contadores y disyuntores: los escribe el despachador (worker) con
--     increment_if_under_cap e increment_weekly; si la web pudiera
--     escribirlos, un workspace se reiniciaría sus propios límites y
--     quemaría su Gmail;
--   · revisiones y llamadas al modelo: bitácoras; se anotan y no se
--     corrigen ni se borran (un workspace que borrara sus llamadas de
--     hoy se devolvería el presupuesto).
REVOKE INSERT, UPDATE, DELETE ON outbound_sequence_template FROM mc_app;
REVOKE INSERT, UPDATE, DELETE ON outbound_counter FROM mc_app;
REVOKE INSERT, UPDATE, DELETE ON outbound_breaker FROM mc_app;
REVOKE UPDATE, DELETE ON outbound_review FROM mc_app;
REVOKE UPDATE, DELETE ON outbound_llm_call FROM mc_app;

-- ---------------------------------------------------------------------
-- 7.5 · Referencias visibles (0025 §3) en las claves ajenas nuevas
-- ---------------------------------------------------------------------
-- El mismo bucle de 0025 §7, sobre las claves que todavía no tienen su
-- disparador: toda clave ajena hacia una tabla con RLS, en una tabla
-- que mc_app puede escribir. Va después de 7.3 (las plantillas ya
-- tienen RLS) y de 7.4 (contadores y disyuntores ya no se escriben
-- desde la aplicación: ahí el disparador sobraría).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT hija.relname AS hija, a.attname AS col, padre.relname AS padre, pa.attname AS pcol,
           array_length(k.conkey, 1) AS columnas
      FROM pg_constraint k
      JOIN pg_class hija   ON hija.oid = k.conrelid
      JOIN pg_namespace n  ON n.oid = hija.relnamespace
      JOIN pg_class padre  ON padre.oid = k.confrelid
      JOIN pg_attribute a  ON a.attrelid = hija.oid AND a.attnum = k.conkey[1]
      JOIN pg_attribute pa ON pa.attrelid = padre.oid AND pa.attnum = k.confkey[1]
     WHERE n.nspname = 'public'
       AND k.contype = 'f'
       AND padre.relrowsecurity
       AND (has_table_privilege('mc_app', hija.oid, 'INSERT') OR has_table_privilege('mc_app', hija.oid, 'UPDATE'))
       AND NOT EXISTS (
         SELECT 1 FROM pg_trigger tg
          WHERE tg.tgrelid = hija.oid AND tg.tgname = 'ref_visible_' || a.attname
       )
     ORDER BY 1, 2
  LOOP
    IF r.columnas > 1 THEN
      RAISE EXCEPTION 'La clave ajena de %.% hacia % es compuesta: assert_reference_visible solo sabe de una columna', r.hija, r.col, r.padre;
    END IF;
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %I ON %I FOR EACH ROW WHEN (NEW.%I IS NOT NULL) '
      'EXECUTE FUNCTION assert_reference_visible(%L, %L, %L)',
      'ref_visible_' || r.col, r.col, r.hija, r.col, r.col, r.padre, r.pcol);
  END LOOP;
END $$;


-- =====================================================================
-- 8 · Funciones del motor
-- ---------------------------------------------------------------------
-- Todas SECURITY INVOKER: corren con los privilegios y la RLS de quien
-- llama. El despachador las llama como mc_worker (BYPASSRLS); desde la
-- web, withWorkspace solo alcanza las filas de su workspace, y pasar
-- otro p_workspace no toca nada ajeno (la política lo filtra o el
-- WITH CHECK lo rechaza). Contadores y disyuntores, además, solo los
-- escribe el worker (7.4).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 8.1 · El día local del workspace
-- ---------------------------------------------------------------------
-- La fecha de p_at en la zona del workspace. Si el workspace no se ve
-- (o no existe), UTC: nunca se inventa una zona.
CREATE FUNCTION outreach_local_date(p_workspace uuid, p_at timestamptz)
RETURNS date
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT (p_at AT TIME ZONE coalesce((SELECT w.timezone FROM workspace w WHERE w.id = p_workspace), 'UTC'))::date;
$$;

-- ---------------------------------------------------------------------
-- 8.2 · next_business_day: el siguiente día hábil, a la misma hora local
-- ---------------------------------------------------------------------
-- Estrictamente DESPUÉS del día local de p_ts, saltando sábado y
-- domingo, y a la misma hora de reloj en p_tz: viernes 10:00 → lunes
-- 10:00; lunes 10:00 → martes 10:00. Es lo que usa el motor cuando el
-- límite diario se agotó («reprograma al día siguiente»). La conversión
-- la hace Postgres con la base de zonas IANA, así que el cambio de
-- horario no corre la hora local. Una zona desconocida es un error, no
-- UTC: una cadencia con la zona mal escrita no debe salir a las 4 a. m.
-- Los festivos no están: dependen del país y no hay tabla de festivos
-- todavía.
CREATE FUNCTION next_business_day(p_ts timestamptz, p_tz text)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  local_ts timestamp;
  d date;
BEGIN
  IF p_ts IS NULL OR p_tz IS NULL THEN
    RETURN NULL;
  END IF;
  local_ts := p_ts AT TIME ZONE p_tz;
  d := local_ts::date + 1;
  WHILE extract(isodow FROM d) > 5 LOOP
    d := d + 1;
  END LOOP;
  RETURN (d + local_ts::time) AT TIME ZONE p_tz;
END;
$$;

-- ---------------------------------------------------------------------
-- 8.3 · increment_if_under_cap e increment_weekly
-- ---------------------------------------------------------------------
-- Suman uno al contador del periodo si todavía está por debajo del tope
-- y dicen si pudieron. Es UNA sentencia: el INSERT … ON CONFLICT DO
-- UPDATE bloquea la fila del periodo que cuenta (la del día, o la de la
-- semana), y quien llega segundo espera a ese bloqueo y vuelve a evaluar
-- el WHERE con el valor ya sumado. Dos despachadores a la vez con una
-- plaza libre: uno recibe true y el otro false, nunca los dos true.
--
-- Un tope de 0 o NULL no deja pasar nada. Quien necesite los dos
-- límites llama a las dos dentro de la MISMA transacción del reclamo y,
-- si la segunda dice false, deshace: así el día no se come una plaza
-- que la semana no dio.
--
-- Dos firmas por función (OUTREACH_FUNCTIONS las nombra):
--   (workspace, action_type, cap)           el contador del workspace
--                                           entero (channel_account_id NULL)
--   (workspace, account, action_type, cap)  el de UNA cuenta (6.2). La
--                                           cuenta tiene que ser de ese
--                                           workspace: si no, lanza.
-- Las cuatro pasan por outbound_counter_bump, que es la sentencia.
CREATE FUNCTION outbound_counter_bump(p_workspace uuid, p_account uuid, p_period text,
                                      p_action_type text, p_cap int)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  hoy date;
  inicio date;
  nuevo int;
BEGIN
  IF p_cap IS NULL OR p_cap <= 0 THEN
    RETURN false;
  END IF;
  IF p_account IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM outreach_channel_account a WHERE a.id = p_account AND a.workspace_id = p_workspace) THEN
    RAISE EXCEPTION 'La cuenta % no es del workspace %.', p_account, p_workspace
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  hoy := outreach_local_date(p_workspace, now());
  inicio := CASE p_period WHEN 'week' THEN hoy - (extract(isodow FROM hoy)::int - 1) ELSE hoy END;

  INSERT INTO outbound_counter AS c (workspace_id, channel_account_id, period, period_start, action_type, count)
  VALUES (p_workspace, p_account, p_period, inicio, p_action_type, 1)
  ON CONFLICT (workspace_id, channel_account_id, period, period_start, action_type)
  DO UPDATE SET count = c.count + 1, updated_at = now()
     WHERE c.count < p_cap
  RETURNING c.count INTO nuevo;
  RETURN nuevo IS NOT NULL;
END;
$$;

CREATE FUNCTION increment_if_under_cap(p_workspace uuid, p_account uuid, p_action_type text, p_cap int)
RETURNS boolean
LANGUAGE sql
VOLATILE
SET search_path = public, pg_temp
AS $$
  SELECT outbound_counter_bump(p_workspace, p_account, 'day', p_action_type, p_cap);
$$;

CREATE FUNCTION increment_if_under_cap(p_workspace uuid, p_action_type text, p_cap int)
RETURNS boolean
LANGUAGE sql
VOLATILE
SET search_path = public, pg_temp
AS $$
  SELECT outbound_counter_bump(p_workspace, NULL, 'day', p_action_type, p_cap);
$$;

CREATE FUNCTION increment_weekly(p_workspace uuid, p_account uuid, p_action_type text, p_cap int)
RETURNS boolean
LANGUAGE sql
VOLATILE
SET search_path = public, pg_temp
AS $$
  SELECT outbound_counter_bump(p_workspace, p_account, 'week', p_action_type, p_cap);
$$;

CREATE FUNCTION increment_weekly(p_workspace uuid, p_action_type text, p_cap int)
RETURNS boolean
LANGUAGE sql
VOLATILE
SET search_path = public, pg_temp
AS $$
  SELECT outbound_counter_bump(p_workspace, NULL, 'week', p_action_type, p_cap);
$$;

-- ---------------------------------------------------------------------
-- 8.4 · should_pause_outreach: ¿se para el despacho de este workspace?
-- ---------------------------------------------------------------------
-- Sí si el interruptor está apagado (o no hay política: nace apagado) o
-- si el ATRASO pasó la contrapresión (max_pending_touches): lo vencido
-- que no ha salido más lo que está en processing, que es lo que
-- outbound_health llama «due» + «processing». Lo programado para más
-- adelante no cuenta: 200 marcas en una cadencia de nueve días, con el
-- siguiente paso ya en cola, no son un atasco. El presupuesto de LLM no
-- para el ENVÍO de lo ya aprobado: lo mira el generador, con
-- outbound_health.
CREATE FUNCTION should_pause_outreach(p_workspace uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT NOT coalesce(p.enabled, false)
         OR (SELECT count(*) FROM outbound_touch t
              WHERE t.workspace_id = p_workspace
                AND (t.status = 'processing'
                     OR (t.status = 'scheduled' AND coalesce(t.next_retry_at, t.scheduled_for) <= now())))
            > coalesce(p.max_pending_touches, 200)
    FROM (SELECT 1) AS uno
    LEFT JOIN outbound_policy p ON p.workspace_id = p_workspace;
$$;

-- ---------------------------------------------------------------------
-- 8.5 · El interruptor: disable_outreach y enable_outreach
-- ---------------------------------------------------------------------
-- Apagar deja el motivo y la hora, y cancela lo que está en cola o
-- retenido. Lo que está en 'processing' es del despachador que lo
-- reclamó (4.1): antes de llamar al proveedor relee la política y lo
-- cancela él; si ya lo llamó, lo registra como enviado. Cancelarlo aquí
-- dejaría la fila diciendo 'canceled' de un mensaje que quizá ya salió.
-- Los borradores se quedan: son trabajo de una persona y no salen sin
-- programarse. Devuelve cuántos toques canceló.
--
-- Los enrolamientos NO se tocan, a propósito: apagar es una pausa del
-- workspace, no el fin de ninguna cadencia. Siguen en 'active' (sin
-- finished_at) y, al encender, el motor vuelve a planificar desde ellos
-- lo que se canceló. Por eso los toques cancelados llevan blocked_reason
-- 'outreach_disabled' y no 'opted_out': son reprogramables.
--
-- Encender no reprograma nada: el motor vuelve a planificar desde los
-- enrolamientos. Sin dirección postal no enciende: lo impide el CHECK
-- outbound_policy_enabled_needs_address (23514).
CREATE FUNCTION disable_outreach(p_workspace uuid, p_reason text)
RETURNS int
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  motivo text := coalesce(nullif(btrim(p_reason), ''), 'manual');
  cancelados int;
BEGIN
  INSERT INTO outbound_policy AS p (workspace_id, enabled, disabled_reason, disabled_at)
  VALUES (p_workspace, false, motivo, now())
  ON CONFLICT (workspace_id)
  DO UPDATE SET enabled = false, disabled_reason = motivo, disabled_at = now();

  UPDATE outbound_touch
     SET status = 'canceled', blocked_reason = 'outreach_disabled'
   WHERE workspace_id = p_workspace
     AND status IN ('scheduled', 'held');
  GET DIAGNOSTICS cancelados = ROW_COUNT;
  RETURN cancelados;
END;
$$;

CREATE FUNCTION enable_outreach(p_workspace uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $$
BEGIN
  -- UPDATE y no INSERT … ON CONFLICT: Postgres comprueba los CHECK de la
  -- fila PROPUESTA antes de ver el conflicto, así que un alta con
  -- enabled = true y sin dirección fallaría aunque la fila existente sí
  -- la tenga.
  UPDATE outbound_policy
     SET enabled = true, disabled_reason = NULL, disabled_at = NULL
   WHERE workspace_id = p_workspace;
  IF NOT FOUND THEN
    -- Sin política no hay dirección postal: el mismo error que daría el CHECK.
    RAISE EXCEPTION 'Sin dirección postal no se puede encender el envío (workspace %).', p_workspace
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'outbound_policy_enabled_needs_address',
            HINT = 'Guarda outbound_policy.postal_address antes de encender el outreach.';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------
-- 8.6 · outbound_health: la salud del outreach en una sola lectura
-- ---------------------------------------------------------------------
-- Lo que miran la pantalla de canales, las alertas diarias (VEN-15) y el
-- generador antes de gastar. Las cuentas salen aquí para que ninguna
-- pantalla las haga. p_hours es la ventana de lo ocurrido (1 a 720 h).
--
--   { "enabled", "disabledReason", "disabledAt", "shouldPause",
--     "since", "hours",
--     "queue":   { "draft", "scheduled", "due", "processing", "stuck", "held" },
--     "window":  { "sent", "failed", "canceled", "opened", "replied", "optedOut",
--                  "sentAfterOptOut" },
--     "byChannel": { "<canal>": { "sent", "failed" } },
--     "breakersOpen": ["<step_type>"],
--     "accountsDown": n, "lastSentAt",
--     "llm": { "spentToday", "dailyCap", "currency": "USD" } }
--
-- «stuck» es lo reclamado hace más de cinco minutos (el zombi de Chief).
-- «failed» y «canceled» se cuentan por status_changed_at, la hora en que
-- el toque llegó a ese estado; anotar opened_at después no lo mueve.
-- «optedOut» son PERSONAS, no toques: los contactos a los que este
-- workspace les envió algo y que pidieron la baja dentro de la ventana,
-- les quedara algo pendiente o no (lo normal es pulsar el enlace del
-- último correo, sin nada más en cola). «sentAfterOptOut» son los toques
-- que salieron con la baja ya puesta, porque llegó mientras el
-- despachador enviaba (4.1).
-- «spentToday» es el día LOCAL del workspace, el mismo de los contadores,
-- y suma outbound_llm_call: todas las llamadas al modelo, no solo las
-- del juez.
CREATE FUNCTION outbound_health(p_workspace uuid, p_hours int)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  horas int := greatest(1, least(coalesce(p_hours, 24), 720));
  desde timestamptz := now() - make_interval(hours => horas);
  zona text := coalesce((SELECT w.timezone FROM workspace w WHERE w.id = p_workspace), 'UTC');
  inicio_hoy timestamptz := date_trunc('day', now() AT TIME ZONE zona) AT TIME ZONE zona;
  pol outbound_policy%ROWTYPE;
  cola jsonb;
  ventana jsonb;
  por_canal jsonb;
  abiertos jsonb;
  caidas int;
  ultimo timestamptz;
  gastado numeric;
BEGIN
  SELECT * INTO pol FROM outbound_policy WHERE workspace_id = p_workspace;

  SELECT jsonb_build_object(
           'draft',      count(*) FILTER (WHERE status = 'draft'),
           'scheduled',  count(*) FILTER (WHERE status = 'scheduled'),
           'due',        count(*) FILTER (WHERE status = 'scheduled'
                                            AND coalesce(next_retry_at, scheduled_for) <= now()),
           'processing', count(*) FILTER (WHERE status = 'processing'),
           'stuck',      count(*) FILTER (WHERE status = 'processing'
                                            AND claimed_at < now() - interval '5 minutes'),
           'held',       count(*) FILTER (WHERE status = 'held')),
         jsonb_build_object(
           'sent',     count(*) FILTER (WHERE status = 'sent' AND sent_at >= desde),
           'failed',   count(*) FILTER (WHERE status = 'failed' AND status_changed_at >= desde),
           'canceled', count(*) FILTER (WHERE status = 'canceled' AND status_changed_at >= desde),
           'opened',   count(*) FILTER (WHERE opened_at >= desde),
           'replied',  count(*) FILTER (WHERE replied_at >= desde),
           'optedOut', (SELECT count(*)
                          FROM contact c
                         WHERE c.opted_out AND c.opted_out_at >= desde
                           AND EXISTS (SELECT 1 FROM outbound_touch s
                                        WHERE s.workspace_id = p_workspace AND s.contact_id = c.id
                                          AND s.status = 'sent')),
           'sentAfterOptOut', count(*) FILTER (WHERE status = 'sent' AND blocked_reason = 'opted_out_in_flight'
                                                 AND sent_at >= desde)),
         max(sent_at)
    INTO cola, ventana, ultimo
    FROM outbound_touch
   WHERE workspace_id = p_workspace;

  SELECT coalesce(jsonb_object_agg(channel, jsonb_build_object('sent', enviados, 'failed', fallidos)), '{}'::jsonb)
    INTO por_canal
    FROM (SELECT channel,
                 count(*) FILTER (WHERE status = 'sent' AND sent_at >= desde) AS enviados,
                 count(*) FILTER (WHERE status = 'failed' AND status_changed_at >= desde) AS fallidos
            FROM outbound_touch
           WHERE workspace_id = p_workspace
             AND ((status = 'sent' AND sent_at >= desde) OR (status = 'failed' AND status_changed_at >= desde))
           GROUP BY channel) AS c;

  SELECT coalesce(jsonb_agg(step_type ORDER BY step_type), '[]'::jsonb)
    INTO abiertos
    FROM outbound_breaker
   WHERE workspace_id = p_workspace AND state <> 'closed';

  SELECT count(*) INTO caidas
    FROM outreach_channel_account
   WHERE workspace_id = p_workspace AND status IN ('needs_reconnect', 'error');

  SELECT coalesce(sum(cost), 0) INTO gastado
    FROM outbound_llm_call
   WHERE workspace_id = p_workspace AND cost_currency = 'USD' AND created_at >= inicio_hoy;

  RETURN jsonb_build_object(
    'enabled',        coalesce(pol.enabled, false),
    'disabledReason', pol.disabled_reason,
    'disabledAt',     pol.disabled_at,
    'shouldPause',    should_pause_outreach(p_workspace),
    'since',          desde,
    'hours',          horas,
    'queue',          cola,
    'window',         ventana,
    'byChannel',      por_canal,
    'breakersOpen',   abiertos,
    'accountsDown',   caidas,
    'lastSentAt',     ultimo,
    'llm',            jsonb_build_object('spentToday', gastado,
                                         'dailyCap', coalesce(pol.llm_daily_cap_usd, 0),
                                         'currency', 'USD'));
END;
$$;


-- =====================================================================
-- 9 · La baja desde el enlace público: public_optout(token)
-- ---------------------------------------------------------------------
-- La página de baja (VEN-15) se abre SIN sesión y sin workspace, y lo
-- que tiene que hacer cruza workspaces: la persona que pide la baja deja
-- de recibir mensajes de TODA la plataforma (0007), así que se cancela
-- lo pendiente de ese contacto en cualquier workspace, y lo mismo con
-- las fichas de otros workspaces que tengan su mismo correo. Es la baja
-- verificable que 0029 §1 reservó para la lista global: la persona pulsó
-- el enlace de un correo que la plataforma envió de verdad, así que el
-- correo entra en contact_suppression con reason 'unsubscribe_link'.
--
-- «De verdad» quiere decir que el toque es un correo en 'sent' con ese
-- token, con provider_message_id y con recipient_address, y que esas
-- columnas solo las escribe el despachador (4.2): un workspace no puede
-- fabricarse un toque «enviado» con un token suyo para dar de baja el
-- correo de otra persona.
--
-- A QUIÉN se da de baja lo dice recipient_address, la dirección a la
-- que salió ese correo, y no la ficha tal como esté hoy:
--   · editar contact.email después del envío no mueve la baja a otra
--     dirección: se suprime la original;
--   · mover el toque a otra ficha no se puede (4.2);
--   · borrar la ficha no rompe el enlace (CAN-SPAM pide que funcione al
--     menos 30 días): sin contact_id, la dirección igual entra en la
--     lista global y se marcan las fichas con esa dirección en todos los
--     workspaces.
-- La ficha propia (contact_id, si sigue existiendo) también se marca,
-- tenga hoy el correo que tenga: es la que recibió ese mensaje.
--
-- Misma forma que los enlaces de Cotizar (0030): una función SECURITY
-- DEFINER cuyo dueño es mc_public_share (NOLOGIN, sin BYPASSRLS), y
-- políticas `TO mc_public_share` que abren solo las filas que la propia
-- función fija en parámetros de la transacción y restaura al salir:
--
--   app.public_optout           el sha256 del token: abre el toque
--   app.public_optout_contacts  los ids de los contactos que se dan de
--                               baja ('{…}'): abre sus fichas, sus
--                               toques y sus enrolamientos
--   app.public_optout_email     la dirección a la que salió el correo
--                               (recipient_address): abre las fichas
--                               con esa dirección en cualquier workspace
--
-- Para mc_app esos parámetros no significan nada: las políticas son solo
-- de mc_public_share, y fijarlos a mano en una transacción de la
-- aplicación no abre ninguna fila. Lo que el rol puede escribir va por
-- COLUMNA: el estado y el motivo de los toques, el estado y la hora de
-- fin de los enrolamientos y la baja del contacto; nunca su correo, su
-- nombre ni el cuerpo de un mensaje. La guardia (src/esquema.ts) exige ese
-- inventario exacto en cada arranque, igual que el de 0030.
--
-- La respuesta no dice a cuántos workspaces afectó (quien pulsa el
-- enlace no tiene por qué saber cuántos creadores le escriben):
--   {"status":"not_found"}
--   {"status":"ok","alreadyOptedOut":false,"workspaceId":"…","touchId":"…"}
-- workspaceId es para el servidor (avisar al creador), no para la página.
--
-- Lo que queda abierto y es de VEN-15: el correo sale del Gmail del
-- creador, así que el enlace también queda en SU carpeta de enviados;
-- quien lo pulse desde allí da de baja a esa persona en toda la
-- plataforma. Solo alcanza a alguien a quien la plataforma le escribió
-- de verdad (no a un correo cualquiera), pero es la persona equivocada
-- pulsando. Ver la nota de docs/ventas-outreach.md que deja VEN-9.
-- =====================================================================

GRANT CREATE ON SCHEMA public TO mc_public_share;   -- solo mientras dura la migración (ver 0030 §1)

-- ---------------------------------------------------------------------
-- 9.1 · Lo único que mc_public_share puede tocar para la baja
-- ---------------------------------------------------------------------
GRANT SELECT ON outbound_touch, outbound_enrollment, contact TO mc_public_share;
-- contact_read (0029 §3) pregunta por la empresa del contacto, y las
-- políticas sin TO también alcanzan a este rol: sin SELECT sobre company
-- ninguna lectura de contact se podría planificar. company_read le deja
-- ver solo el catálogo compartido (owner_workspace_id NULL), que no es
-- de nadie. Y contact_write (0020), que también le alcanza al marcar la
-- baja, pregunta en su WITH CHECK por company_link: su política es la de
-- 0010, y sin workspace fijado este rol no ve ninguna fila.
GRANT SELECT ON company, company_link TO mc_public_share;
GRANT UPDATE (status, blocked_reason) ON outbound_touch TO mc_public_share;
GRANT UPDATE (status, finished_at) ON outbound_enrollment TO mc_public_share;
GRANT UPDATE (opted_out, opted_out_at, opted_out_reason) ON contact TO mc_public_share;
GRANT INSERT ON contact_suppression TO mc_public_share;

-- ---------------------------------------------------------------------
-- 9.2 · La cerradura: políticas acotadas a lo que fija la función
-- ---------------------------------------------------------------------
CREATE POLICY outbound_touch_public_optout ON outbound_touch
  FOR SELECT TO mc_public_share
  USING (optout_token_hash = nullif(current_setting('app.public_optout', true), ''));

CREATE POLICY outbound_touch_public_optout_contacts ON outbound_touch
  FOR SELECT TO mc_public_share
  USING (contact_id = ANY (nullif(current_setting('app.public_optout_contacts', true), '')::uuid[]));

CREATE POLICY outbound_touch_public_optout_cancel ON outbound_touch
  FOR UPDATE TO mc_public_share
  USING (contact_id = ANY (nullif(current_setting('app.public_optout_contacts', true), '')::uuid[]))
  WITH CHECK (contact_id = ANY (nullif(current_setting('app.public_optout_contacts', true), '')::uuid[]));

CREATE POLICY outbound_enrollment_public_optout ON outbound_enrollment
  FOR SELECT TO mc_public_share
  USING (contact_id = ANY (nullif(current_setting('app.public_optout_contacts', true), '')::uuid[]));

CREATE POLICY outbound_enrollment_public_optout_cancel ON outbound_enrollment
  FOR UPDATE TO mc_public_share
  USING (contact_id = ANY (nullif(current_setting('app.public_optout_contacts', true), '')::uuid[]))
  WITH CHECK (contact_id = ANY (nullif(current_setting('app.public_optout_contacts', true), '')::uuid[]));

CREATE POLICY contact_public_optout ON contact
  FOR SELECT TO mc_public_share
  USING (id = ANY (nullif(current_setting('app.public_optout_contacts', true), '')::uuid[]));

CREATE POLICY contact_public_optout_email ON contact
  FOR SELECT TO mc_public_share
  USING (email = nullif(current_setting('app.public_optout_email', true), '')::citext);

CREATE POLICY contact_public_optout_mark ON contact
  FOR UPDATE TO mc_public_share
  USING (id = ANY (nullif(current_setting('app.public_optout_contacts', true), '')::uuid[]))
  WITH CHECK (id = ANY (nullif(current_setting('app.public_optout_contacts', true), '')::uuid[]));

-- ---------------------------------------------------------------------
-- 9.3 · La puerta
-- ---------------------------------------------------------------------
-- Los parámetros se fijan con set_config(…, true) —de la transacción— y
-- se restauran al salir, también si algo lanza. Por qué no con la
-- cláusula SET de CREATE FUNCTION: ver la cabecera de 0030.
CREATE FUNCTION public_optout(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  antes_token    text := coalesce(current_setting('app.public_optout', true), '');
  antes_contacts text := coalesce(current_setting('app.public_optout_contacts', true), '');
  antes_email    text := coalesce(current_setting('app.public_optout_email', true), '');
  resumen   text;
  toque     uuid;
  espacio   uuid;
  contacto  uuid;
  correo    citext;
  ya_baja   boolean;
  todas_de_baja boolean;
  ids       uuid[];
  r         jsonb;
BEGIN
  -- El token lo genera el despachador al azar (al menos 128 bits en
  -- base64url o hex); lo que no tenga esa forma no se busca.
  IF p_token IS NULL OR length(p_token) < 16 OR length(p_token) > 200 THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  resumen := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');

  BEGIN
    PERFORM set_config('app.public_optout', resumen, true);
    -- Ni contact_id ni la ficha hacen falta: la dirección del envío basta.
    SELECT t.id, t.workspace_id, t.contact_id, t.recipient_address
      INTO toque, espacio, contacto, correo
      FROM outbound_touch t
     WHERE t.optout_token_hash = resumen
       AND t.status = 'sent'
       AND t.channel = 'email'
       AND t.provider_message_id IS NOT NULL
       AND t.recipient_address IS NOT NULL
     ORDER BY t.sent_at DESC NULLS LAST
     LIMIT 1;

    IF toque IS NULL THEN
      r := jsonb_build_object('status', 'not_found');
    ELSE
      -- La ficha que recibió el correo (si no se borró) y las fichas con
      -- esa dirección en cualquier workspace. La de contact_id se abre
      -- primero para leer si ya estaba de baja.
      PERFORM set_config('app.public_optout_contacts', format('{%s}', contacto), true);
      PERFORM set_config('app.public_optout_email', correo::text, true);
      SELECT c.opted_out INTO ya_baja FROM contact c WHERE c.id = contacto;
      SELECT array_agg(DISTINCT c.id), bool_and(c.opted_out) INTO ids, todas_de_baja
        FROM contact c
       WHERE c.id = contacto OR c.email = correo;
      ids := coalesce(ids, '{}'::uuid[]);
      ya_baja := coalesce(ya_baja, todas_de_baja, false);
      PERFORM set_config('app.public_optout_contacts', format('{%s}', array_to_string(ids, ',')), true);

      -- Sin columna en ON CONFLICT a propósito: nombrarla pediría SELECT
      -- sobre la lista, y este rol solo inserta en ella.
      INSERT INTO contact_suppression (email, reason) VALUES (correo, 'unsubscribe_link')
      ON CONFLICT DO NOTHING;

      UPDATE contact
         SET opted_out = true,
             opted_out_at = coalesce(opted_out_at, now()),
             opted_out_reason = coalesce(opted_out_reason, 'Pidió la baja desde el enlace de un correo.')
       WHERE id = ANY (ids) AND NOT opted_out;

      UPDATE outbound_touch
         SET status = 'canceled', blocked_reason = 'opted_out'
       WHERE contact_id = ANY (ids)
         AND status IN ('draft', 'scheduled', 'held');

      UPDATE outbound_enrollment
         SET status = 'opted_out', finished_at = coalesce(finished_at, now())
       WHERE contact_id = ANY (ids)
         AND status IN ('active', 'paused', 'cooldown');

      r := jsonb_build_object('status', 'ok', 'alreadyOptedOut', coalesce(ya_baja, false),
                              'workspaceId', espacio, 'touchId', toque);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.public_optout', antes_token, true);
    PERFORM set_config('app.public_optout_contacts', antes_contacts, true);
    PERFORM set_config('app.public_optout_email', antes_email, true);
    RAISE;
  END;

  PERFORM set_config('app.public_optout', antes_token, true);
  PERFORM set_config('app.public_optout_contacts', antes_contacts, true);
  PERFORM set_config('app.public_optout_email', antes_email, true);
  RETURN r;
END;
$$;

COMMENT ON FUNCTION public_optout(text) IS
  'Baja desde el enlace de un correo (VEN-9, VEN-15): anota en contact_suppression la dirección a la que salió ese '
  'correo (recipient_address), marca contact.opted_out en la ficha que lo recibió y en las fichas con esa dirección, y '
  'cancela lo pendiente de todas en cualquier workspace. SECURITY DEFINER de mc_public_share (0037 §9).';

-- ---------------------------------------------------------------------
-- 9.4 · Privilegios y dueño
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION public_optout(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_optout(text) TO mc_app;
ALTER FUNCTION public_optout(text) OWNER TO mc_public_share;

REVOKE CREATE ON SCHEMA public FROM mc_public_share;
