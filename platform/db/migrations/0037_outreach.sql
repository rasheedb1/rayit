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
