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
--   2 · Cuentas de canal (outreach_channel_account); 2.1 lo que solo
--       escribe el callback del proveedor
--   3 · Secuencia, pasos y enrolamiento; 3.4 coherencia con la secuencia
--   4 · La cola: outbound_touch extendida; 4.1 la regla de la baja (con
--       la lista global); 4.2 las columnas del despachador; 4.4
--       coherencia del toque; 4.5 outbound_optout_link, la prueba del
--       enlace de baja; 4.6 outbound_optout_event, quién provocó cada baja
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
-- la cuenta, no al workspace); NULL = el de outbound_policy. Cada canal
-- tiene un techo que nadie pasa (outreach_channel_account_channel_caps_check,
-- con los números de §5.1: 100 al día y 200 a la semana en LinkedIn). Se cuentan
-- en outbound_counter con channel_account_id (6.2), así que tres
-- LinkedIn de una agencia en el mismo workspace no comparten plaza.
-- warmup_started_at arranca el calentamiento progresivo (VEN-15).
--
-- Un buzón, una cuenta viva EN TODA LA PLATAFORMA: (provider,
-- provider_account_id) es único entre las cuentas AUTENTICADAS
-- (connected, needs_reconnect, error), cruzando workspaces. Los topes se
-- cuentan por channel_account_id, así que el mismo Gmail conectado en el
-- workspace del creador y en el de su agencia tendría dos filas, dos
-- contadores y podría enviar el doble de lo que el proveedor aguanta.
-- Contar por (provider, provider_account_id) en vez de por fila
-- obligaría a un contador que cruza workspaces, que la RLS de
-- outbound_counter no deja ni leer ni escribir desde el workspace. Se
-- elige la regla simple: el buzón envía desde UN workspace; para
-- moverlo, se desconecta en el otro. Dentro del workspace la unicidad es
-- completa (también con la fila desconectada): reconectar reutiliza la
-- fila, no crea otra.
--
-- 'pending' NO ocupa el buzón: es una fila que la web puede crear antes
-- de mandar a la persona al OAuth, con la dirección que ella escribió, y
-- que nadie ha autenticado. Si contara, un workspace reservaba
-- laura@gmail.com con una fila 'pending' y Laura ya no podía conectar su
-- Gmail en ningún sitio (23505), además de aprender si ese buzón está
-- conectado en otra parte.
--
-- Y el paso a un estado autenticado no es de la web: lo da el callback
-- del proveedor (el OAuth de Google o el alta en Unipile), que corre en
-- el servidor con asWorker (mc_worker). El disparador
-- outreach_channel_account_worker_columns (2.1) rechaza con 42501 que
-- mc_app escriba provider_account_id en una fila que ya existe,
-- secret_ref, scopes o un status autenticado, al crear o al cambiar. Es
-- el mismo criterio que las pruebas de envío de outbound_touch (4.2):
-- lo que prueba que la plataforma habló con el proveedor lo escribe
-- quien habló con él, no la pantalla. Así el índice global es un
-- oráculo que solo responde a quien ya autenticó esa cuenta
-- (UNICOS_GLOBALES_DECLARADOS en src/esquema.ts).
--
-- Contrato del callback (VEN-9, pantalla de canales): escribe
-- provider_account_id con lo que DEVUELVE el proveedor en la misma
-- sentencia que pasa la fila a 'connected', nunca con lo que la persona
-- escribió en la fila 'pending'.
-- =====================================================================

-- Quién es el despachador: mc_worker (tras SET ROLE), un superusuario o
-- un rol con BYPASSRLS, o el DUEÑO de outbound_touch, que es quien migra
-- y siembra (mc_migrator en Supabase, que no tiene BYPASSRLS; el seed
-- 0005 escribe así la demo de outreach). Es el dueño de esa tabla y no
-- el del esquema porque esta misma migración la altera: quien la aplica
-- es su dueño por fuerza. Y no le da nada nuevo: ya puede ALTER TABLE …
-- DISABLE TRIGGER. mc_app, no: no es miembro de
-- ningún rol (ROLES_DE_LA_APP_DECLARADOS, vacía). Lo usan todos los
-- candados de columna de esta migración; current_user es el rol
-- efectivo aunque la conexión herede otros (el mc_app_ci del CI es
-- miembro de mc_worker).
CREATE FUNCTION outreach_is_dispatcher()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce((SELECT current_user = 'mc_worker' OR r.rolsuper OR r.rolbypassrls
                          OR pg_has_role(current_user, c.relowner, 'MEMBER')
                     FROM pg_catalog.pg_roles r, pg_catalog.pg_class c
                    WHERE r.rolname = current_user AND c.oid = 'public.outbound_touch'::regclass), false);
$$;

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
    CHECK (provider <> 'gmail_oauth' OR provider_account_id = lower(btrim(provider_account_id))),
  -- El techo de cada canal (§5.1): lo que el proveedor aguanta antes de
  -- castigar la cuenta. Es un CHECK y no un candado de rol porque vale
  -- para todos: ni la web, ni el worker, ni un operador sube una cuenta
  -- de LinkedIn por encima de lo que LinkedIn tolera. Por debajo, el
  -- tope es de la persona (VEN-15 lo baja durante el calentamiento).
  -- Los mismos números en CHANNEL_CAP_LIMITS (src/schema/outreach.ts),
  -- que la pantalla de canales usa como máximo del campo.
  --   email          500 / día,  3500 / semana en un Gmail personal
  --                  (@gmail.com, @googlemail.com: el cupo oficial de
  --                  Google para una cuenta gratuita)
  --                 2000 / día, 10000 / semana en Google Workspace
  --   linkedin       100 / día,   200 / semana (invitaciones en cuenta activa)
  --   instagram_dm   100 / día,   700 / semana (100 acciones al día)
  --   whatsapp       100 / día,   700 / semana (fase 2; el mismo techo
  --                  que Instagram hasta medir el de Unipile)
  -- La regla del buzón personal es la misma de la vista
  -- outreach_channel_account_limits (0040, 0052): el dominio de la
  -- dirección, en minúsculas por el CHECK de arriba.
  CONSTRAINT outreach_channel_account_channel_caps_check CHECK (
    CASE channel
      WHEN 'email'        THEN CASE WHEN split_part(provider_account_id, '@', 2) IN ('gmail.com', 'googlemail.com')
                                    THEN coalesce(daily_cap, 0) <= 500 AND coalesce(weekly_cap, 0) <= 3500
                                    ELSE coalesce(daily_cap, 0) <= 2000 AND coalesce(weekly_cap, 0) <= 10000
                               END
      WHEN 'linkedin'     THEN coalesce(daily_cap, 0) <= 100  AND coalesce(weekly_cap, 0) <= 200
      WHEN 'instagram_dm' THEN coalesce(daily_cap, 0) <= 100  AND coalesce(weekly_cap, 0) <= 700
      WHEN 'whatsapp'     THEN coalesce(daily_cap, 0) <= 100  AND coalesce(weekly_cap, 0) <= 700
      ELSE false
    END)
);
CREATE UNIQUE INDEX outreach_channel_account_provider_idx
  ON outreach_channel_account (workspace_id, provider, provider_account_id);
CREATE UNIQUE INDEX outreach_channel_account_live_idx
  ON outreach_channel_account (provider, provider_account_id)
  WHERE status IN ('connected', 'needs_reconnect', 'error');
CREATE INDEX ON outreach_channel_account (workspace_id, channel, status);
CREATE INDEX ON outreach_channel_account (creator_id);
CREATE TRIGGER outreach_channel_account_updated BEFORE UPDATE ON outreach_channel_account
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- 2.1 · Lo que solo escribe el callback del proveedor
-- ---------------------------------------------------------------------
-- Para mc_app:
--   · al crear: status solo 'pending' o 'disconnected', sin secret_ref
--     y sin scopes (provider_account_id sí: es la dirección que la
--     persona escribió, y en 'pending' no ocupa nada);
--   · al crear, tampoco warmup_started_at ni last_ok_at;
--   · al cambiar: provider_account_id, secret_ref, scopes, channel,
--     provider, warmup_started_at y last_ok_at no se tocan, y status solo
--     va a 'disconnected' (desconectar es de la persona; conectar, del
--     proveedor). last_error y last_error_at sí: son el código del
--     intento de conexión que la web anota (0044), y la salud de la
--     cuenta la dice status.
--   · y no borra una cuenta que ya se autenticó
--     (outreach_channel_account_keep_live, abajo).
CREATE FUNCTION outreach_channel_account_worker_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  escribe text[] := '{}';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('pending', 'disconnected') THEN escribe := escribe || 'status'::text; END IF;
    IF NEW.secret_ref IS NOT NULL THEN escribe := escribe || 'secret_ref'::text; END IF;
    IF cardinality(NEW.scopes) > 0 THEN escribe := escribe || 'scopes'::text; END IF;
    IF NEW.warmup_started_at IS NOT NULL THEN escribe := escribe || 'warmup_started_at'::text; END IF;
    IF NEW.last_ok_at IS NOT NULL THEN escribe := escribe || 'last_ok_at'::text; END IF;
  ELSE
    -- Desde la web el estado solo va a 'disconnected': volver a
    -- 'pending' una cuenta que ya se autenticó la dejaría borrable
    -- (outreach_channel_account_keep_live) y con ella sus contadores.
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'disconnected' THEN
      escribe := escribe || 'status'::text;
    END IF;
    -- channel y provider son la identidad de la cuenta: cambiarlos saca
    -- el buzón del índice global (provider, provider_account_id) con la
    -- credencial de otro proveedor dentro.
    IF NEW.channel IS DISTINCT FROM OLD.channel THEN escribe := escribe || 'channel'::text; END IF;
    IF NEW.provider IS DISTINCT FROM OLD.provider THEN escribe := escribe || 'provider'::text; END IF;
    IF NEW.provider_account_id IS DISTINCT FROM OLD.provider_account_id THEN
      escribe := escribe || 'provider_account_id'::text;
    END IF;
    IF NEW.secret_ref IS DISTINCT FROM OLD.secret_ref THEN escribe := escribe || 'secret_ref'::text; END IF;
    IF NEW.scopes IS DISTINCT FROM OLD.scopes THEN escribe := escribe || 'scopes'::text; END IF;
    -- El calentamiento y la última vez que el proveedor respondió bien los
    -- escribe quien habló con él: moverlos saltaba el calentamiento de
    -- VEN-15 o pintaba sana una cuenta que no lo está.
    IF NEW.warmup_started_at IS DISTINCT FROM OLD.warmup_started_at THEN escribe := escribe || 'warmup_started_at'::text; END IF;
    IF NEW.last_ok_at IS DISTINCT FROM OLD.last_ok_at THEN escribe := escribe || 'last_ok_at'::text; END IF;
  END IF;
  IF cardinality(escribe) = 0 OR outreach_is_dispatcher() THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Una cuenta de canal la autentica el callback del proveedor, no la aplicación: % (rol %).',
                  array_to_string(escribe, ', '), current_user
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'El OAuth de Google o el alta en Unipile escriben status, provider_account_id, secret_ref y scopes '
                 'con asWorker. Desde la web solo se crea la fila pendiente o se desconecta.';
END;
$$;

CREATE TRIGGER outreach_channel_account_worker_columns
  BEFORE INSERT OR UPDATE OF status, provider_account_id, secret_ref, scopes, channel, provider, warmup_started_at, last_ok_at
  ON outreach_channel_account
  FOR EACH ROW EXECUTE FUNCTION outreach_channel_account_worker_columns();

-- Borrar una cuenta desde la web: solo la fila 'pending' de un intento
-- de conexión, que nadie autenticó y que no tiene contadores. Una cuenta
-- que ya envió se desconecta y se queda: outbound_counter cuelga de ella
-- en cascada (6.2), y borrarla y volver a conectar el mismo buzón le
-- devolvía la plaza del día y de la semana, justo lo que 7.4 le quita a
-- la aplicación. El callback reutiliza la fila al reconectar (§2), así
-- que no hace falta borrarla. Las cascadas del workspace o del creador
-- (pg_trigger_depth() > 1) y el despachador (sales.channels_release,
-- outreach_channel_connect) sí pasan.
CREATE FUNCTION outreach_channel_account_keep_live()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.status = 'pending' OR pg_trigger_depth() > 1 OR outreach_is_dispatcher() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Una cuenta de canal que se autenticó no se borra desde la aplicación: se desconecta (rol %).', current_user
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Sus contadores del día y de la semana cuelgan de la fila: borrarla y reconectar reiniciaría los topes.';
END;
$$;

CREATE TRIGGER outreach_channel_account_keep_live
  BEFORE DELETE ON outreach_channel_account
  FOR EACH ROW EXECUTE FUNCTION outreach_channel_account_keep_live();


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
  ADD COLUMN updated_at      timestamptz NOT NULL DEFAULT now(),
  -- active pasa a ser la sombra de status (abajo): su DEFAULT dice lo
  -- mismo que el de status ('draft' ⇒ false), y así lo dice también el
  -- esquema de Drizzle.
  ALTER COLUMN active SET DEFAULT false;

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

-- A quien pidió la baja (la ficha, o su correo en la lista global, como
-- en 4.1) no se le enrola, ni se le reanuda. Sin esto el
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
  correo citext;
BEGIN
  IF NEW.status NOT IN ('active', 'paused', 'cooldown') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.contact_id IS NOT DISTINCT FROM OLD.contact_id THEN
    RETURN NEW;
  END IF;
  -- La misma definición de «dado de baja» que la regla del toque (4.1):
  -- la ficha, o su correo en la lista global (un rebote o una queja que
  -- el worker anotó y que todavía no se reflejó en la ficha).
  -- address_is_suppressed se crea en 4.1; plpgsql la resuelve al correr.
  SELECT c.opted_out, c.email INTO is_out, correo FROM contact c WHERE c.id = NEW.contact_id;
  IF coalesce(is_out, false) OR address_is_suppressed(correo) THEN
    RAISE EXCEPTION 'El contacto % pidió no ser contactado (opt-out).', NEW.contact_id
      USING ERRCODE = 'check_violation',
            HINT = 'La ficha está dada de baja o su correo está en la baja global. Un enrolamiento de quien '
                   'pidió la baja solo puede estar en opted_out, completed o replied.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbound_enrollment_optout
  BEFORE INSERT OR UPDATE OF contact_id, status ON outbound_enrollment
  FOR EACH ROW EXECUTE FUNCTION enforce_enrollment_optout();

-- ---------------------------------------------------------------------
-- 3.4 · Coherencia entre filas: paso, enrolamiento y su secuencia
-- ---------------------------------------------------------------------
-- La RLS y assert_reference_visible (0025) solo protegen a mc_app, y
-- solo de ver lo ajeno: nada impedía un paso con el workspace_id de A
-- colgado de una secuencia de B escrito por el worker (BYPASSRLS), ni un
-- enrolamiento cuyo paso actual es de otra secuencia. Aquí se exige, a
-- cualquiera que escriba:
--   · outbound_step y outbound_enrollment tienen el workspace de su
--     secuencia;
--   · el paso actual de un enrolamiento es de SU secuencia.
-- Si la fila a la que apuntan no se ve (o ya no existe, en medio de un
-- borrado en cascada), no se dice nada: la existencia la comprueba la
-- clave ajena y la visibilidad, assert_reference_visible.
CREATE FUNCTION outbound_sequence_member_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  espacio uuid;
  secuencia uuid;
BEGIN
  SELECT s.workspace_id INTO espacio FROM outbound_sequence s WHERE s.id = NEW.sequence_id;
  IF FOUND AND espacio IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION '% % es del workspace %, pero su secuencia % es del workspace %.',
                    TG_TABLE_NAME, NEW.id, NEW.workspace_id, NEW.sequence_id, espacio
      USING ERRCODE = 'check_violation';
  END IF;
  -- Dos IF y no un AND: plpgsql prepara la expresión entera, y en un
  -- paso NEW no tiene current_step_id.
  IF TG_TABLE_NAME = 'outbound_enrollment' THEN
    IF NEW.current_step_id IS NOT NULL THEN
      SELECT st.sequence_id INTO secuencia FROM outbound_step st WHERE st.id = NEW.current_step_id;
      IF FOUND AND secuencia IS DISTINCT FROM NEW.sequence_id THEN
        RAISE EXCEPTION 'El paso actual % del enrolamiento % es de otra secuencia (%, no %).',
                        NEW.current_step_id, NEW.id, secuencia, NEW.sequence_id
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbound_step_sequence_check
  BEFORE INSERT OR UPDATE OF workspace_id, sequence_id ON outbound_step
  FOR EACH ROW EXECUTE FUNCTION outbound_sequence_member_check();
CREATE TRIGGER outbound_enrollment_sequence_check
  BEFORE INSERT OR UPDATE OF workspace_id, sequence_id, current_step_id ON outbound_enrollment
  FOR EACH ROW EXECUTE FUNCTION outbound_sequence_member_check();


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
-- el correo. Su sha256 NO vive en la cola sino en outbound_optout_link
-- (4.5), una tabla que solo escribe el despachador y que no depende del
-- toque: ni de su estado, ni de que exista, ni de que exista su empresa,
-- su ficha o su workspace. public_optout (sección 9) busca ahí. Mientras
-- la prueba vivía en outbound_touch, el enlace dejaba de funcionar si el
-- workspace pasaba el toque de 'sent' a 'draft', lo borraba, o borraba
-- la empresa (que arrastra sus toques en cascada), y CAN-SPAM pide que
-- funcione al menos 30 días.
--
-- Lo que sí queda en el toque son las pruebas de que la PLATAFORMA lo
-- envió: provider_message_id, message_id_rfc y recipient_address. Solo
-- las escribe el despachador (mc_worker) o quien migra (4.2), y un toque
-- enviado no vuelve atrás ni se borra desde la aplicación (4.2): pasar
-- un 'sent' a 'scheduled' era volver a meter en la cola un correo que ya
-- salió (un segundo envío).
--
-- recipient_address es la dirección EXACTA a la que sale el mensaje. La
-- escribe el despachador AL RECLAMAR el toque (scheduled → processing):
-- un correo en processing o con provider_message_id sin ella no entra
-- (CHECK), y así la regla de la baja (4.1) la compara con la lista
-- global ANTES del envío. La baja se anota sobre ella y no sobre
-- contact.email ni sobre el contact_id de hoy: la ficha se puede editar,
-- borrar o cambiar después del envío, y quien pulsa el enlace es quien
-- recibió ESE correo. Por la misma razón, un toque con pruebas de envío
-- no cambia de destinatario (ni de contacto ni de empresa) desde la
-- aplicación (4.2).
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
  ADD COLUMN recipient_address   citext CHECK (length(recipient_address) BETWEEN 3 AND 320),
  ADD COLUMN status_changed_at   timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at          timestamptz NOT NULL DEFAULT now(),
  -- En un correo, la dirección es una dirección (sin espacios, con una
  -- sola arroba): es lo que public_optout anota en la lista global.
  ADD CONSTRAINT outbound_touch_recipient_email_check
    CHECK (recipient_address IS NULL OR channel <> 'email' OR recipient_address ~ '^[^@\s]+@[^@\s]+$'),
  -- Un correo que el despachador reclamó, o que ya tiene id del
  -- proveedor, sabe a qué dirección sale: sin ella la regla de la baja
  -- no la puede comparar con la lista global (4.1).
  ADD CONSTRAINT outbound_touch_email_recipient_check
    CHECK (channel <> 'email' OR recipient_address IS NOT NULL
           OR (status <> 'processing' AND provider_message_id IS NULL));

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
-- cambia ni el estado, ni el contacto, ni la dirección pasa siempre. Si
-- no, después de una baja ya no se podría anotar replied_at («bórrame»
-- es una respuesta), opened_at, thread_ref ni provider_message_id en un
-- toque que ya salió. Tampoco mira lo que sigue en 'sent' (un registro
-- no es un envío) ni el contact_id que pasa a NULL al borrar la ficha:
-- si no, borrar la ficha, la empresa o el workspace de alguien que pidió
-- la baja fallaría.
--
-- «Dado de baja» es cualquiera de estas tres cosas:
--   · contact.opted_out de la ficha del toque (0007: la baja de ESE
--     workspace, o la global que public_optout reflejó en ella);
--   · el correo de esa ficha está en contact_suppression (la lista
--     global, 0029 §1: un rebote duro o una queja que el worker anotó y
--     que todavía no se reflejó en esta ficha);
--   · recipient_address, la dirección a la que sale DE VERDAD, está en
--     contact_suppression, aunque no coincida con contact.email.
--
--   · entrar en scheduled o processing dado de baja: no.
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
--   1. al reclamar (scheduled → processing) escribe recipient_address
--      y sube attempt_count en la misma sentencia, y en la misma
--      transacción el enlace de baja de ese intento (4.5; la base no
--      confirma un correo reclamado sin él); si la dirección o la ficha
--      están dadas de baja la base rechaza el reclamo, así que la
--      consulta de reclamo las filtra y las pasa a 'canceled';
--   2. antes de llamar al proveedor, relee el contacto, la lista y la
--      política en la transacción del envío; con la baja o el apagado,
--      pasa el toque a 'canceled' (processing → canceled siempre se
--      puede) y no envía;
--   3. después de llamar, processing → sent, aunque la baja haya llegado
--      en medio;
--   4. al rescatar un zombi (processing de más de cinco minutos), el
--      que esté dado de baja va a 'canceled' y no a 'scheduled', que la
--      regla rechaza.
--
-- mc_app no puede leer contact_suppression (0026 §3), así que la
-- consulta pasa por address_is_suppressed, SECURITY DEFINER, que solo
-- responde sí o no para UNA dirección. No enseña nada nuevo: un
-- workspace ya lo aprende creando una ficha con ese correo, que nace
-- dada de baja (contact_suppression_apply, 0029 §1).
CREATE FUNCTION address_is_suppressed(p_email citext)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_email IS NOT NULL AND EXISTS (SELECT 1 FROM contact_suppression s WHERE s.email = p_email);
$$;
REVOKE ALL ON FUNCTION address_is_suppressed(citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION address_is_suppressed(citext) TO mc_app, mc_worker;
COMMENT ON FUNCTION address_is_suppressed(citext) IS
  'Si una dirección está en la baja global (contact_suppression), para la regla de la baja de outbound_touch '
  '(0037 §4.1). SECURITY DEFINER porque mc_app no lee la lista; responde solo sí o no.';

CREATE OR REPLACE FUNCTION enforce_outbound_optout()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  is_out boolean := false;
  correo citext;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.contact_id IS NOT DISTINCT FROM OLD.contact_id
     AND NEW.recipient_address IS NOT DISTINCT FROM OLD.recipient_address THEN
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('scheduled', 'processing', 'sent') THEN
    RETURN NEW;
  END IF;
  -- Lo que no es enviar a nadie nuevo pasa: un toque que ya estaba en
  -- 'sent' y sigue ahí (un registro, no un envío), y soltar la ficha sin
  -- cambiar ni el estado ni la dirección (la clave ajena pone contact_id
  -- a NULL al borrar la ficha, y eso no puede fallar porque la persona
  -- haya pedido la baja).
  IF TG_OP = 'UPDATE' AND OLD.status = 'sent' AND NEW.status = 'sent' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.contact_id IS NULL
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.recipient_address IS NOT DISTINCT FROM OLD.recipient_address THEN
    RETURN NEW;
  END IF;

  IF NEW.contact_id IS NOT NULL THEN
    SELECT c.opted_out, c.email INTO is_out, correo FROM contact c WHERE c.id = NEW.contact_id;
  END IF;
  is_out := coalesce(is_out, false)
            OR address_is_suppressed(correo)
            OR address_is_suppressed(NEW.recipient_address);
  IF NOT is_out THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'sent' AND TG_OP = 'UPDATE' AND OLD.status = 'processing'
     AND NEW.contact_id IS NOT DISTINCT FROM OLD.contact_id THEN
    NEW.blocked_reason := 'opted_out_in_flight';
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'El contacto % pidió no ser contactado (opt-out).', coalesce(NEW.contact_id::text, NEW.recipient_address::text)
    USING ERRCODE = 'check_violation',
          HINT = 'La ficha está dada de baja, o su correo o la dirección del envío están en la baja global.';
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
-- Pueden escribirlas el despachador y quien migra
-- (outreach_is_dispatcher, sección 2). mc_app, no: ni al crear el toque
-- ni después. Poner NULL donde ya había algo también es escribir.
--
-- Y para mc_app, además:
--   · el destinatario de un toque con pruebas de envío (cualquiera de
--     las tres columnas) queda fijo: ni contact_id ni company_id
--     cambian. La única excepción es contact_id → NULL, que es lo que
--     hace la clave ajena (ON DELETE SET NULL, 0007) al borrar la ficha,
--     y no redirige nada: public_optout ya no mira el toque sino
--     outbound_optout_link. De NULL a otra ficha, en cambio, sí es
--     cambiar de destinatario, y no se deja;
--   · 'sent' es terminal: un toque enviado no vuelve a draft, scheduled
--     ni a ningún otro estado (volver a la cola era un segundo envío del
--     mismo correo);
--   · 'processing' es del despachador (4.1): la aplicación no crea un
--     toque en ese estado, no lleva uno a él y no saca uno de él. Si
--     pudiera, un toque de LinkedIn puesto en processing desde la web
--     (sin correo, el CHECK de recipient_address no aplica) quedaba
--     fuera de public_optout y de disable_outreach, que no tocan lo
--     reclamado, y podía pasar a sent sin que nadie lo hubiera enviado;
--   · un toque con pruebas de envío, o reclamado, no se borra
--     (outbound_touch_keep_sent, abajo): es el registro de lo que la
--     plataforma envió, o de lo que está enviando. Borrar la
--     empresa o el workspace sí lo arrastra en cascada, y no rompe nada:
--     el enlace de baja vive en outbound_optout_link.
CREATE FUNCTION outbound_touch_worker_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  pruebas boolean;
  destinatario boolean := false;
  vuelve boolean := false;
  reclamo boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    pruebas := NEW.provider_message_id IS NOT NULL OR NEW.message_id_rfc IS NOT NULL
               OR NEW.recipient_address IS NOT NULL;
    reclamo := NEW.status = 'processing';
  ELSE
    -- Entrar en processing o salir de él: las dos puntas del reclamo.
    reclamo := NEW.status IS DISTINCT FROM OLD.status
               AND (NEW.status = 'processing' OR OLD.status = 'processing');
    pruebas := NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id
               OR NEW.message_id_rfc IS DISTINCT FROM OLD.message_id_rfc
               OR NEW.recipient_address IS DISTINCT FROM OLD.recipient_address;
    destinatario := (OLD.provider_message_id IS NOT NULL OR OLD.message_id_rfc IS NOT NULL
                     OR OLD.recipient_address IS NOT NULL)
                    AND ((NEW.contact_id IS DISTINCT FROM OLD.contact_id AND NEW.contact_id IS NOT NULL)
                         OR NEW.company_id IS DISTINCT FROM OLD.company_id);
    vuelve := OLD.status = 'sent' AND NEW.status IS DISTINCT FROM 'sent';
  END IF;
  IF NOT (pruebas OR destinatario OR vuelve OR reclamo) OR outreach_is_dispatcher() THEN
    RETURN NEW;
  END IF;
  IF reclamo THEN
    RAISE EXCEPTION 'El estado processing es del despachador: la aplicación no pone un toque en él ni lo saca '
                    '(de ''%'' a ''%'', rol %).', CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status, current_user
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Lo reclamado no lo cancelan ni la baja ni el apagado (4.1); si la web pudiera ponerlo, el toque '
                   'quedaría fuera de los dos. Para programar, scheduled; el worker lo reclama.';
  END IF;
  IF pruebas THEN
    RAISE EXCEPTION 'provider_message_id, message_id_rfc y recipient_address los escribe solo el despachador (rol %).',
                    current_user
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Son la prueba de que la plataforma envió el mensaje: la escribe el worker con asWorker.';
  END IF;
  IF vuelve THEN
    RAISE EXCEPTION 'Un toque enviado no vuelve atrás: de ''sent'' no pasa a ''%'' desde la aplicación (rol %).',
                    NEW.status, current_user
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Volver a la cola sería enviar otra vez el mismo mensaje. Para otro envío, otro toque.';
  END IF;
  RAISE EXCEPTION 'Un toque enviado no cambia de destinatario: contact_id y company_id son los del envío (rol %).',
                  current_user
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'La baja del enlace se anota sobre la dirección del envío; para otro destinatario, otro toque.';
END;
$$;

CREATE TRIGGER outbound_touch_worker_columns
  BEFORE INSERT OR UPDATE OF provider_message_id, message_id_rfc, recipient_address,
                             contact_id, company_id, status ON outbound_touch
  FOR EACH ROW EXECUTE FUNCTION outbound_touch_worker_columns();

-- Borrar un toque con pruebas de envío, o en processing: solo el despachador, o una
-- cascada (borrar la empresa o el workspace). La cascada la ejecuta un
-- disparador de clave ajena, así que llega aquí con pg_trigger_depth()
-- mayor que 1; un DELETE de la aplicación llega con 1.
CREATE FUNCTION outbound_touch_keep_sent()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (OLD.provider_message_id IS NULL AND OLD.message_id_rfc IS NULL AND OLD.recipient_address IS NULL
      AND OLD.status <> 'processing')
     OR pg_trigger_depth() > 1
     OR outreach_is_dispatcher() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Un toque enviado o reclamado por la plataforma no se borra desde la aplicación (toque %, rol %).',
                  OLD.id, current_user
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Es el registro de lo que salió: la salud, los rebotes y la baja lo necesitan.';
END;
$$;

CREATE TRIGGER outbound_touch_keep_sent
  BEFORE DELETE ON outbound_touch
  FOR EACH ROW EXECUTE FUNCTION outbound_touch_keep_sent();

-- status_changed_at solo se mueve cuando cambia el estado; lo que venga
-- escrito en un UPDATE que no lo cambia se ignora. Al crear el toque, la
-- aplicación no elige la hora: es now(). Si pudiera, un 'failed' con
-- status_changed_at en 2036 entraba en la ventana de fallos de
-- outbound_health (8.6) durante diez años. El despachador (y el seed,
-- que corre como dueño) sí la escribe, para sembrar una historia. Y lo
-- que vuelve a 'scheduled' sin hora sale ya. Se crea después de
-- rellenar las filas que ya existen (abajo).
CREATE FUNCTION outbound_touch_status_changed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT outreach_is_dispatcher() THEN
      NEW.status_changed_at := now();
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := now();
    -- Volver a la cola sin hora (aprobar un borrador o un retenido que
    -- nunca la tuvo) es volver para ya: sin ella nadie lo reclamaría
    -- (outbound_touch_scheduled_for_check, 4.3).
    IF NEW.status = 'scheduled' AND NEW.scheduled_for IS NULL THEN
      NEW.scheduled_for := now();
    END IF;
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
  -- Un 'scheduled' sin hora no lo ve nadie (outbound_touch_scheduled_for_check,
  -- abajo): los que hubiera salen en la hora de su alta.
  UPDATE outbound_touch SET scheduled_for = created_at WHERE status = 'scheduled' AND scheduled_for IS NULL;
  ALTER TABLE outbound_touch ENABLE TRIGGER outbound_touch_optout;

  IF forzada THEN
    ALTER TABLE outbound_touch FORCE ROW LEVEL SECURITY;
  END IF;
END $$;

CREATE TRIGGER outbound_touch_status_changed BEFORE INSERT OR UPDATE OF status, status_changed_at ON outbound_touch
  FOR EACH ROW EXECUTE FUNCTION outbound_touch_status_changed();

ALTER TABLE outbound_touch
  ADD CONSTRAINT outbound_touch_held_reason_check CHECK (status <> 'held' OR held_reason IS NOT NULL),
  -- Un toque en cola tiene hora: sin ella, coalesce(next_retry_at,
  -- scheduled_for) es NULL, outbound_touch_due_idx no lo ve, la salud no
  -- lo cuenta como vencido y se queda en la cola para siempre.
  ADD CONSTRAINT outbound_touch_scheduled_for_check CHECK (status <> 'scheduled' OR scheduled_for IS NOT NULL),
  ADD CONSTRAINT outbound_touch_processing_claimed_check CHECK (status <> 'processing' OR claimed_at IS NOT NULL),
  -- Reclamar es un intento: el despachador sube attempt_count en la
  -- misma sentencia, y el enlace de baja de ese intento lleva el número
  -- (4.5, outbound_touch_optout_link_required).
  ADD CONSTRAINT outbound_touch_processing_attempt_check CHECK (status <> 'processing' OR attempt_count >= 1);

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
--   · Las búsquedas por id del proveedor (webhooks y respuestas).
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
-- La salud (8.6) lee la ventana por la hora de cada cosa, no la historia
-- entera: fallos y cancelaciones por la hora del cambio de estado; lo
-- enviado, lo abierto y lo respondido por su propia hora.
CREATE INDEX outbound_touch_status_changed_idx ON outbound_touch (workspace_id, status, status_changed_at);
CREATE INDEX outbound_touch_sent_idx ON outbound_touch (workspace_id, sent_at) WHERE status = 'sent';
CREATE INDEX outbound_touch_opened_idx ON outbound_touch (workspace_id, opened_at) WHERE opened_at IS NOT NULL;
CREATE INDEX outbound_touch_replied_idx ON outbound_touch (workspace_id, replied_at) WHERE replied_at IS NOT NULL;

-- ---------------------------------------------------------------------
-- 4.4 · Un toque es coherente con su enrolamiento y con su paso
-- ---------------------------------------------------------------------
-- La regla de la baja (4.1) mira touch.contact_id. Si un toque pudiera
-- apuntar al enrolamiento del contacto X con contact_id Y (o sin
-- contacto), un despachador que tomara el destinatario del enrolamiento
-- se saltaría la regla sin error; y el índice de un solo toque vivo por
-- (enrollment_id, step_id) no protegería nada con un paso de otra
-- secuencia. Aquí se exige, a cualquiera que escriba (también al worker,
-- que no pasa por la RLS ni por assert_reference_visible):
--   · el enrolamiento es del mismo workspace y del mismo contacto;
--   · el paso es del mismo workspace y de la secuencia del enrolamiento.
-- contact_id NULL con enrolamiento solo lo deja una cascada (borrar la
-- ficha pone a NULL el contacto del toque antes de borrar su
-- enrolamiento): llega con pg_trigger_depth() mayor que 1. Si la fila a
-- la que apunta no se ve o ya no existe, no se dice nada: eso es de la
-- clave ajena y de assert_reference_visible.
CREATE FUNCTION outbound_touch_enrollment_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  e_espacio uuid;
  e_contacto uuid;
  e_secuencia uuid;
  p_espacio uuid;
  p_secuencia uuid;
BEGIN
  IF NEW.enrollment_id IS NOT NULL THEN
    SELECT e.workspace_id, e.contact_id, e.sequence_id INTO e_espacio, e_contacto, e_secuencia
      FROM outbound_enrollment e WHERE e.id = NEW.enrollment_id;
    IF FOUND THEN
      IF e_espacio IS DISTINCT FROM NEW.workspace_id THEN
        RAISE EXCEPTION 'El toque % es del workspace %, pero su enrolamiento % es del workspace %.',
                        NEW.id, NEW.workspace_id, NEW.enrollment_id, e_espacio
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.contact_id IS NULL AND pg_trigger_depth() = 1 THEN
        RAISE EXCEPTION 'El toque % tiene enrolamiento (%) y no tiene contacto: el contacto es el del enrolamiento.',
                        NEW.id, NEW.enrollment_id
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.contact_id IS NOT NULL AND NEW.contact_id IS DISTINCT FROM e_contacto THEN
        RAISE EXCEPTION 'El toque % es para el contacto %, pero su enrolamiento % es del contacto %.',
                        NEW.id, NEW.contact_id, NEW.enrollment_id, e_contacto
          USING ERRCODE = 'check_violation',
                HINT = 'La regla de la baja mira el contacto del toque: tiene que ser el del enrolamiento.';
      END IF;
    END IF;
  END IF;
  IF NEW.step_id IS NOT NULL THEN
    SELECT st.workspace_id, st.sequence_id INTO p_espacio, p_secuencia
      FROM outbound_step st WHERE st.id = NEW.step_id;
    IF FOUND THEN
      IF p_espacio IS DISTINCT FROM NEW.workspace_id THEN
        RAISE EXCEPTION 'El toque % es del workspace %, pero su paso % es del workspace %.',
                        NEW.id, NEW.workspace_id, NEW.step_id, p_espacio
          USING ERRCODE = 'check_violation';
      END IF;
      IF e_secuencia IS NOT NULL AND p_secuencia IS DISTINCT FROM e_secuencia THEN
        RAISE EXCEPTION 'El paso % del toque % es de la secuencia %, y su enrolamiento % es de la secuencia %.',
                        NEW.step_id, NEW.id, p_secuencia, NEW.enrollment_id, e_secuencia
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbound_touch_enrollment_check
  BEFORE INSERT OR UPDATE OF workspace_id, enrollment_id, step_id, contact_id ON outbound_touch
  FOR EACH ROW EXECUTE FUNCTION outbound_touch_enrollment_check();

-- ---------------------------------------------------------------------
-- 4.5 · outbound_optout_link: la prueba del enlace de baja, fuera de la cola
-- ---------------------------------------------------------------------
-- Una fila por INTENTO de envío de un correo con enlace de baja. La
-- escribe el despachador AL RECLAMAR el toque (scheduled → processing),
-- en la misma transacción que recipient_address y ANTES de llamar al
-- proveedor; nadie más la escribe: mc_app no tiene ningún privilegio
-- sobre ella (7.4) y su RLS solo tiene políticas de lectura, así que ni
-- un GRANT de más dejaría escribir desde la web.
--
-- Por qué al reclamar y no al confirmar: si el despachador cae entre la
-- llamada a Gmail y el COMMIT, o la respuesta del proveedor se pierde
-- por un timeout, el correo ya salió. Con el enlace guardado después,
-- ese correo llevaba un token que la base nunca supo, y «darme de baja»
-- respondía not_found (CAN-SPAM, a nombre del creador). Guardado antes,
-- el peor caso es un enlace de un correo que al final no salió: nadie
-- tiene ese token, así que no da de baja a nadie.
--
-- Y la base lo exige: un correo no queda en 'processing' sin el enlace
-- de ESE intento (outbound_touch_optout_link_required, abajo), salvo que
-- el workspace haya apagado require_optout_link en su política.
--
--   token_hash         sha256 (hex) del token al azar que solo va en el
--                      correo: quien lee la tabla no puede fabricar el
--                      enlace. Clave primaria: un token repetido por un
--                      error del despachador falla al escribirlo, en vez
--                      de dar de baja en silencio a otra dirección.
--   attempt            el intento del toque (outbound_touch.attempt_count
--                      después de reclamarlo). Cada reintento lleva un
--                      token nuevo en su propia fila, y los de los
--                      intentos anteriores siguen funcionando: el correo
--                      del primero quizá salió aunque nadie lo confirmara.
--   recipient_address  la dirección a la que sale: lo que se suprime.
--   claimed_at         cuándo se reclamó el intento (el enlace existe
--                      desde entonces).
--   sent_at            cuándo confirmó el proveedor; NULL si no confirmó
--                      (falló, o se perdió la respuesta). El enlace
--                      funciona igual: no se sabe si el correo salió.
--   workspace_id, touch_id, contact_id
--                      quién lo envió, desde qué toque y a qué ficha. Son
--                      ON DELETE SET NULL: borrar el toque, la empresa, la
--                      ficha o el workspace entero no rompe el enlace
--                      (CAN-SPAM pide al menos 30 días; aquí no caduca).
--
-- public_optout (sección 9) busca aquí y solo aquí, sin mirar sent_at.
CREATE TABLE outbound_optout_link (
  token_hash          text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  workspace_id        uuid REFERENCES workspace(id) ON DELETE SET NULL,
  touch_id            uuid REFERENCES outbound_touch(id) ON DELETE SET NULL,
  contact_id          uuid REFERENCES contact(id) ON DELETE SET NULL,
  attempt             int NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 20),
  channel             text NOT NULL DEFAULT 'email' CHECK (channel = 'email'),
  recipient_address   citext NOT NULL
                           CHECK (length(recipient_address) BETWEEN 3 AND 320
                                  AND recipient_address ~ '^[^@\s]+@[^@\s]+$'),
  claimed_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
-- Un intento, un enlace.
CREATE UNIQUE INDEX outbound_optout_link_touch_idx ON outbound_optout_link (touch_id, attempt)
  WHERE touch_id IS NOT NULL;
CREATE INDEX ON outbound_optout_link (contact_id);
CREATE INDEX ON outbound_optout_link (workspace_id, claimed_at);

-- Al escribirlo, el enlace dice lo mismo que su toque: el mismo
-- workspace, la misma ficha, un correo, y la dirección a la que el toque
-- sale. Después, lo único que cambia es sent_at (de NULL a la hora que
-- confirmó el proveedor) y las claves que los ON DELETE SET NULL ponen a
-- NULL al borrar el toque, la ficha o el workspace. Ni el despachador
-- reescribe la dirección o el token de un enlace que ya pudo salir.
CREATE FUNCTION outbound_optout_link_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  t record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.token_hash IS DISTINCT FROM OLD.token_hash
       OR NEW.attempt IS DISTINCT FROM OLD.attempt
       OR NEW.channel IS DISTINCT FROM OLD.channel
       OR NEW.recipient_address IS DISTINCT FROM OLD.recipient_address
       OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR (OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at)
       OR (NEW.workspace_id IS DISTINCT FROM OLD.workspace_id AND NEW.workspace_id IS NOT NULL)
       OR (NEW.touch_id IS DISTINCT FROM OLD.touch_id AND NEW.touch_id IS NOT NULL)
       OR (NEW.contact_id IS DISTINCT FROM OLD.contact_id AND NEW.contact_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Un enlace de baja no se reescribe: solo se anota sent_at una vez (enlace del toque %).', OLD.touch_id
        USING ERRCODE = 'check_violation',
              HINT = 'El correo pudo salir con ese token y esa dirección. Para otro intento, otro enlace.';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.touch_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT x.workspace_id, x.contact_id, x.channel, x.recipient_address INTO t
    FROM outbound_touch x WHERE x.id = NEW.touch_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF t.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR t.contact_id IS DISTINCT FROM NEW.contact_id
     OR t.channel <> 'email'
     OR (t.recipient_address IS NOT NULL AND t.recipient_address IS DISTINCT FROM NEW.recipient_address) THEN
    RAISE EXCEPTION 'El enlace de baja no concuerda con su toque %: workspace, contacto, canal o dirección.', NEW.touch_id
      USING ERRCODE = 'check_violation',
            HINT = 'El enlace se escribe al reclamar, con los datos del correo que va a salir, en la misma transacción.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbound_optout_link_check
  BEFORE INSERT OR UPDATE ON outbound_optout_link
  FOR EACH ROW EXECUTE FUNCTION outbound_optout_link_check();

-- Un correo reclamado lleva el enlace de su intento. Se comprueba al
-- COMMIT (DEFERRABLE INITIALLY DEFERRED): el despachador reclama y
-- escribe el enlace en la misma transacción, en el orden que quiera, y
-- lo que se confirma nunca es un correo en 'processing' cuyo enlace la
-- base no sabe. Al comprobar se relee la fila: si en la misma
-- transacción el toque ya salió de 'processing' (lo canceló antes de
-- llamar al proveedor, 4.1), no se exige nada.
--
-- Un intento es un reclamo: el despachador sube attempt_count al
-- reclamar (lo exige outbound_touch_processing_attempt_check, 4.3), y
-- el enlace lleva ese número. Sin política, o con require_optout_link
-- (0007, true por defecto), el enlace es obligatorio.
CREATE FUNCTION outbound_touch_optout_link_required()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  x record;
  exige boolean;
BEGIN
  SELECT o.status, o.channel, o.attempt_count, o.workspace_id INTO x FROM outbound_touch o WHERE o.id = NEW.id;
  IF NOT FOUND OR x.status <> 'processing' OR x.channel <> 'email' THEN
    RETURN NULL;
  END IF;
  SELECT p.require_optout_link INTO exige FROM outbound_policy p WHERE p.workspace_id = x.workspace_id;
  IF NOT coalesce(exige, true) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM outbound_optout_link l WHERE l.touch_id = NEW.id AND l.attempt = x.attempt_count) THEN
    RAISE EXCEPTION 'El correo % se reclamó (intento %) sin su enlace de baja en outbound_optout_link.', NEW.id, x.attempt_count
      USING ERRCODE = 'check_violation',
            HINT = 'El despachador escribe el enlace del intento al reclamar, antes de llamar al proveedor (0037 §4.5).';
  END IF;
  RETURN NULL;
END;
$$;

-- Dos disparadores y no uno: en un UPDATE la condición es el CAMBIO a
-- processing (un UPDATE que nombra status sin cambiarlo no exige nada),
-- y en un INSERT no hay OLD.
CREATE CONSTRAINT TRIGGER outbound_touch_optout_link_required
  AFTER UPDATE OF status ON outbound_touch
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.status = 'processing' AND NEW.channel = 'email' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION outbound_touch_optout_link_required();
CREATE CONSTRAINT TRIGGER outbound_touch_optout_link_required_insert
  AFTER INSERT ON outbound_touch
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.status = 'processing' AND NEW.channel = 'email')
  EXECUTE FUNCTION outbound_touch_optout_link_required();

-- ---------------------------------------------------------------------
-- 4.6 · outbound_optout_event: quién provocó cada baja global
-- ---------------------------------------------------------------------
-- Una fila por clic en un enlace de baja; la escribe public_optout. El
-- enlace también queda en la carpeta de enviados del Gmail del creador,
-- así que quien envía podría pulsar su propio enlace y suprimir a una
-- marca en toda la plataforma (el hueco que 0029 §1 quiso cerrar con
-- «quien envía no lo ve»). La página de VEN-15 rechaza el clic que llega
-- con la sesión del workspace que envió; esta tabla es lo que queda
-- detrás, para lo que la página no pueda ver:
--   · atribuible: qué workspace y qué toque produjeron cada entrada de
--     contact_suppression (por recipient_address y created_at);
--   · reversible: un operador (worker) borra la entrada de la lista y
--     deshace el opted_out de las fichas de los demás workspaces;
--   · vigilable: claimed_at (o sent_at, si el proveedor confirmó) y
--     created_at dan la alerta «workspace cuyos destinatarios se dan de
--     baja a los pocos minutos del envío» (VEN-15, en una vista; ninguna
--     pantalla hace esa resta).
-- Bitácora: se inserta y no se corrige. mc_app no tiene ningún
-- privilegio sobre ella (7.4).
CREATE TABLE outbound_optout_event (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash          text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  workspace_id        uuid REFERENCES workspace(id) ON DELETE SET NULL,
  touch_id            uuid REFERENCES outbound_touch(id) ON DELETE SET NULL,
  recipient_address   citext NOT NULL,
  -- Copiados del enlace (4.5): sent_at es NULL si el proveedor no llegó
  -- a confirmar ese intento.
  claimed_at          timestamptz NOT NULL,
  sent_at             timestamptz,
  -- La persona ya estaba de baja (un segundo clic): no suprimió nada nuevo.
  already_opted_out   boolean NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON outbound_optout_event (workspace_id, created_at);
CREATE INDEX ON outbound_optout_event (recipient_address);
CREATE INDEX ON outbound_optout_event (touch_id);


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
  -- Siempre USD: la factura de Anthropic es en dólares y el tope
  -- llm_daily_cap_usd (6.1) suma esta columna. Una fila en otra moneda
  -- no la vería la salud (8.6) y el tope se saltaría en silencio.
  cost_currency       char(3) NOT NULL DEFAULT 'USD' CHECK (cost_currency = 'USD'),
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
  -- Siempre USD: la factura de Anthropic es en dólares y el tope
  -- llm_daily_cap_usd (6.1) suma esta columna. Una fila en otra moneda
  -- no la vería la salud (8.6) y el tope se saltaría en silencio.
  cost_currency       char(3) NOT NULL DEFAULT 'USD' CHECK (cost_currency = 'USD'),
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
--                        La llave de Anthropic es de On Cue, así que el
--                        tope protege la factura de la PLATAFORMA: lo
--                        cambia solo el worker o un operador, no el
--                        workspace (outbound_policy_llm_cap, abajo). Su
--                        valor por defecto vive en una sola función,
--                        outreach_default_llm_daily_cap(), que usan el
--                        DEFAULT, el candado y outbound_health.
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
CREATE FUNCTION outreach_default_llm_daily_cap()
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT 5.00::numeric(14,2);
$$;

ALTER TABLE outbound_policy
  ADD COLUMN enabled             boolean NOT NULL DEFAULT false,
  ADD COLUMN disabled_reason     text,
  ADD COLUMN disabled_at         timestamptz,
  ADD COLUMN llm_daily_cap_usd   numeric(14,2) NOT NULL DEFAULT outreach_default_llm_daily_cap()
                                      CHECK (llm_daily_cap_usd >= 0),
  ADD COLUMN warmup_days         int NOT NULL DEFAULT 14 CHECK (warmup_days BETWEEN 0 AND 90),
  ADD COLUMN postal_address      text,
  ADD COLUMN max_pending_touches int NOT NULL DEFAULT 200 CHECK (max_pending_touches BETWEEN 1 AND 10000),
  ADD CONSTRAINT outbound_policy_enabled_needs_address
    CHECK (NOT enabled OR (postal_address IS NOT NULL AND btrim(postal_address) <> ''));

CREATE TRIGGER outbound_policy_updated BEFORE UPDATE ON outbound_policy
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- El tope de gasto en el modelo lo fija la plataforma. mc_app puede
-- crear su política con el valor por defecto y cambiar todo lo demás,
-- pero no llm_daily_cap_usd: con un UPDATE, un workspace se quitaba su
-- propio techo y lo pagaba On Cue. Borrar la fila y volver a crearla
-- tampoco sirve: el alta solo acepta el valor por defecto. Es un
-- disparador y no un GRANT por columnas por lo mismo que en 4.2 (Drizzle
-- nombra todas las columnas en cada INSERT).
CREATE FUNCTION outbound_policy_llm_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.llm_daily_cap_usd = outreach_default_llm_daily_cap() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.llm_daily_cap_usd IS NOT DISTINCT FROM OLD.llm_daily_cap_usd THEN
    RETURN NEW;
  END IF;
  IF outreach_is_dispatcher() THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'llm_daily_cap_usd lo fija la plataforma, no el workspace (rol %).', current_user
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'El gasto en el modelo lo paga On Cue: para subir el tope de un workspace, un operador con asWorker.';
END;
$$;

CREATE TRIGGER outbound_policy_llm_cap
  BEFORE INSERT OR UPDATE OF llm_daily_cap_usd ON outbound_policy
  FOR EACH ROW EXECUTE FUNCTION outbound_policy_llm_cap();

-- El enlace de baja en cada correo tampoco lo apaga el workspace:
-- require_optout_link es lo único que hace obligatorio el enlace de 4.5
-- (outbound_touch_optout_link_required lo mira al reclamar), y con un
-- UPDATE el mismo workspace que envía se quitaba public_optout y el pie
-- que pide CAN-SPAM. La web puede crear su política y dejarlo en true;
-- ponerlo en false, al crear o al cambiar, es del despachador (un
-- operador con asWorker, para un caso que lo justifique).
CREATE FUNCTION outbound_policy_optout_link()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.require_optout_link OR outreach_is_dispatcher() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NOT OLD.require_optout_link THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'El enlace de baja es obligatorio: el workspace no lo apaga (rol %).', current_user
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'require_optout_link lo fija la plataforma: cada correo lleva su enlace de baja (0037 §4.5).';
END;
$$;

CREATE TRIGGER outbound_policy_optout_link
  BEFORE INSERT OR UPDATE OF require_optout_link ON outbound_policy
  FOR EACH ROW EXECUTE FUNCTION outbound_policy_optout_link();

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
-- 7.1b · Los enlaces y los clics de baja: solo lectura por workspace
-- ---------------------------------------------------------------------
-- outbound_optout_link y outbound_optout_event llevan la misma guardia y
-- la misma RLS, pero su política de workspace es SOLO de lectura: no hay
-- ninguna que deje escribir a la aplicación, así que ni un GRANT de más
-- (el mc_app_ci del CI hereda los de mc_worker) abriría la escritura. Los
-- escribe el worker (BYPASSRLS) y public_optout, con las políticas
-- `TO mc_public_share` de la sección 9. Hoy mc_app tampoco las lee
-- (7.4); si una pantalla lo necesita, basta un GRANT SELECT: la fila ya
-- está aislada.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['outbound_optout_link', 'outbound_optout_event'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'workspace_id'
    ) THEN
      RAISE EXCEPTION 'La tabla % está en la lista de RLS pero no tiene workspace_id', t;
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_ws_read ON %I FOR SELECT USING (workspace_id = current_workspace_id())', t, t);
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
--     hoy se devolvería el presupuesto);
--   · enlaces y clics de baja: nada. Son la prueba de que la plataforma
--     envió el correo y de quién pidió la baja (4.5, 4.6).
REVOKE ALL ON outbound_optout_link FROM mc_app;
REVOKE ALL ON outbound_optout_event FROM mc_app;
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
  -- Sin un canal conectado, «encendido» no enviaría nada (§6.1 y la
  -- decisión 2 de §8: se enciende con un canal conectado y la política
  -- aceptada). Se comprueba después de la política para que el error de
  -- la dirección, que es el primer paso de la persona, salga antes.
  IF NOT EXISTS (SELECT 1 FROM outreach_channel_account a
                  WHERE a.workspace_id = p_workspace AND a.status = 'connected') THEN
    RAISE EXCEPTION 'Sin un canal conectado no se puede encender el envío (workspace %).', p_workspace
      USING ERRCODE = 'check_violation',
            HINT = 'Conecta tu Gmail o tu LinkedIn antes de encender el envío.';
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
-- outbound_touch es la cola y también el registro de todo lo enviado,
-- así que nada aquí recorre la historia: la cola se lee por su estado
-- vivo y cada cifra de la ventana por el índice de su propia hora (4.3).
-- «lastSentAt» es el último toque en 'sent', por su índice.
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
-- del juez. «dailyCap» sin política es el valor por defecto de la
-- columna (outreach_default_llm_daily_cap), el mismo que tendrá la
-- política cuando se cree: nunca 0, que el generador leería como «sin
-- presupuesto».
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

  -- La cola: solo lo vivo, por (workspace_id, status, scheduled_for) de
  -- 0007. outbound_touch es también el registro de todo lo enviado; la
  -- salud no lo recorre entero en cada llamada.
  SELECT jsonb_build_object(
           'draft',      count(*) FILTER (WHERE status = 'draft'),
           'scheduled',  count(*) FILTER (WHERE status = 'scheduled'),
           'due',        count(*) FILTER (WHERE status = 'scheduled'
                                            AND coalesce(next_retry_at, scheduled_for) <= now()),
           'processing', count(*) FILTER (WHERE status = 'processing'),
           'stuck',      count(*) FILTER (WHERE status = 'processing'
                                            AND claimed_at < now() - interval '5 minutes'),
           'held',       count(*) FILTER (WHERE status = 'held'))
    INTO cola
    FROM outbound_touch
   WHERE workspace_id = p_workspace
     AND status IN ('draft', 'scheduled', 'processing', 'held');

  -- La ventana: cada cifra por el índice de su hora, sin tocar lo que
  -- pasó antes de «desde».
  SELECT jsonb_build_object(
           'sent',     (SELECT count(*) FROM outbound_touch
                         WHERE workspace_id = p_workspace AND status = 'sent' AND sent_at >= desde),
           'failed',   (SELECT count(*) FROM outbound_touch
                         WHERE workspace_id = p_workspace AND status = 'failed' AND status_changed_at >= desde),
           'canceled', (SELECT count(*) FROM outbound_touch
                         WHERE workspace_id = p_workspace AND status = 'canceled' AND status_changed_at >= desde),
           'opened',   (SELECT count(*) FROM outbound_touch
                         WHERE workspace_id = p_workspace AND opened_at >= desde),
           'replied',  (SELECT count(*) FROM outbound_touch
                         WHERE workspace_id = p_workspace AND replied_at >= desde),
           -- Desde los envíos del workspace (outbound_touch_sent_idx) y no
           -- desde contact: como worker (BYPASSRLS), filtrar contact por
           -- opted_out recorría todas las bajas de la plataforma desde
           -- siempre en cada llamada.
           'optedOut', (SELECT count(DISTINCT c.id)
                          FROM outbound_touch s
                          JOIN contact c ON c.id = s.contact_id
                         WHERE s.workspace_id = p_workspace AND s.status = 'sent'
                           AND c.opted_out AND c.opted_out_at >= desde),
           'sentAfterOptOut', (SELECT count(*) FROM outbound_touch
                                WHERE workspace_id = p_workspace AND status = 'sent' AND sent_at >= desde
                                  AND blocked_reason = 'opted_out_in_flight'))
    INTO ventana;

  SELECT t.sent_at INTO ultimo
    FROM outbound_touch t
   WHERE t.workspace_id = p_workspace AND t.status = 'sent' AND t.sent_at IS NOT NULL
   ORDER BY t.sent_at DESC
   LIMIT 1;

  SELECT coalesce(jsonb_object_agg(channel, jsonb_build_object('sent', enviados, 'failed', fallidos)), '{}'::jsonb)
    INTO por_canal
    FROM (SELECT channel, sum(enviado) AS enviados, sum(fallido) AS fallidos
            FROM (SELECT channel, 1 AS enviado, 0 AS fallido
                    FROM outbound_touch
                   WHERE workspace_id = p_workspace AND status = 'sent' AND sent_at >= desde
                  UNION ALL
                  SELECT channel, 0, 1
                    FROM outbound_touch
                   WHERE workspace_id = p_workspace AND status = 'failed' AND status_changed_at >= desde) AS x
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
                                         'dailyCap', coalesce(pol.llm_daily_cap_usd,
                                                              outreach_default_llm_daily_cap()),
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
-- «De verdad» quiere decir que el sha256 del token está en
-- outbound_optout_link (4.5), que solo escribe el despachador al reclamar el envío:
-- un workspace no puede fabricarse un enlace para dar de baja el correo
-- de otra persona. Y el enlace no depende de la cola: ni el estado del
-- toque, ni que el toque, su empresa, su ficha o su workspace sigan
-- existiendo cambian la respuesta (CAN-SPAM pide al menos 30 días).
--
-- A QUIÉN se da de baja lo dice outbound_optout_link.recipient_address,
-- la dirección a la que salió ese correo, y no la ficha tal como esté
-- hoy: editar contact.email después del envío no mueve la baja a otra
-- dirección; y borrar la ficha no rompe el enlace: la dirección igual
-- entra en la lista global y se marcan las fichas con esa dirección en
-- todos los workspaces. La ficha que recibió el correo
-- (outbound_optout_link.contact_id, si sigue existiendo) también se
-- marca, tenga hoy el correo que tenga.
--
-- Cada clic queda en outbound_optout_event (4.6) con el workspace y el
-- toque que lo originaron: la baja global es atribuible y reversible.
--
-- Misma forma que los enlaces de Cotizar (0030): una función SECURITY
-- DEFINER cuyo dueño es mc_public_share (NOLOGIN, sin BYPASSRLS), y
-- políticas `TO mc_public_share` que abren solo las filas que la propia
-- función fija en parámetros de la transacción y restaura al salir:
--
--   app.public_optout           el sha256 del token: abre su enlace y
--                               deja anotar su clic
--   app.public_optout_contacts  los ids de los contactos que se dan de
--                               baja ('{…}'): abre sus fichas, sus
--                               toques y sus enrolamientos
--   app.public_optout_email     la dirección a la que salió el correo:
--                               abre las fichas con esa dirección en
--                               cualquier workspace
--
-- Para mc_app esos parámetros no significan nada: las políticas son solo
-- de mc_public_share, y fijarlos a mano en una transacción de la
-- aplicación no abre ninguna fila. Lo que el rol puede escribir va por
-- COLUMNA: el estado y el motivo de los toques, el estado y la hora de
-- fin de los enrolamientos y la baja del contacto; nunca su correo, su
-- nombre ni el cuerpo de un mensaje. La guardia (src/esquema.ts) exige ese
-- inventario exacto en cada arranque, igual que el de 0030.
--
-- Lo que cancela: los toques en draft, scheduled y held
-- (CANCELABLE_TOUCH_STATUSES en src/schema/ventas.ts). No 'processing',
-- que es del despachador que lo reclamó (4.1).
--
-- La respuesta no dice a cuántos workspaces afectó (quien pulsa el
-- enlace no tiene por qué saber cuántos creadores le escriben):
--   {"status":"not_found"}
--   {"status":"ok","alreadyOptedOut":false,"workspaceId":"…"|null,"touchId":"…"|null}
-- workspaceId es para el servidor (avisar al creador), no para la página;
-- es null si el workspace que envió ya no existe, y touchId si el toque
-- se borró.
--
-- Lo que la base no puede ver y es de VEN-15: el enlace también queda
-- en la carpeta de enviados del Gmail del creador. La página rechaza el
-- clic que llega con una sesión del workspace que envió (el servidor lo
-- sabe antes de llamar aquí); lo que se escape queda atribuido en
-- outbound_optout_event. Ver docs/ventas-outreach.md §5.2.
-- =====================================================================

GRANT CREATE ON SCHEMA public TO mc_public_share;   -- solo mientras dura la migración (ver 0030 §1)

-- ---------------------------------------------------------------------
-- 9.1 · Lo único que mc_public_share puede tocar para la baja
-- ---------------------------------------------------------------------
GRANT SELECT ON outbound_optout_link, outbound_touch, outbound_enrollment, contact TO mc_public_share;
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
GRANT INSERT ON outbound_optout_event TO mc_public_share;

-- ---------------------------------------------------------------------
-- 9.2 · La cerradura: políticas acotadas a lo que fija la función
-- ---------------------------------------------------------------------
-- La demo (seed 0005) la siembra quien migra, con el workspace de la
-- demo fijado: sin BYPASSRLS y con FORCE, sin esta política no podría
-- dejar el enlace de un correo «enviado». TO CURRENT_USER (mc_migrator,
-- o mc_migrator_embedded en PGlite) y solo en el workspace fijado, como
-- las altas de 7.2; a mc_app no le alcanza.
CREATE POLICY outbound_optout_link_seed ON outbound_optout_link FOR INSERT TO CURRENT_USER
  WITH CHECK (current_workspace_id() IS NOT NULL AND workspace_id = current_workspace_id());

CREATE POLICY outbound_optout_link_public_optout ON outbound_optout_link
  FOR SELECT TO mc_public_share
  USING (token_hash = nullif(current_setting('app.public_optout', true), ''));

CREATE POLICY outbound_optout_event_public_optout ON outbound_optout_event
  FOR INSERT TO mc_public_share
  WITH CHECK (token_hash = nullif(current_setting('app.public_optout', true), ''));

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
  enlace    outbound_optout_link%ROWTYPE;
  ya_baja   boolean;
  todas_de_baja boolean;
  nuevas    int;
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
    -- El enlace, y solo el enlace: ni el estado del toque ni que exista.
    SELECT * INTO enlace FROM outbound_optout_link l WHERE l.token_hash = resumen;

    IF NOT FOUND THEN
      r := jsonb_build_object('status', 'not_found');
    ELSE
      -- La ficha que recibió el correo (si no se borró) y las fichas con
      -- esa dirección en cualquier workspace. La primera se abre antes
      -- para leer si ya estaba de baja.
      PERFORM set_config('app.public_optout_contacts', format('{%s}', enlace.contact_id), true);
      PERFORM set_config('app.public_optout_email', enlace.recipient_address::text, true);
      SELECT c.opted_out INTO ya_baja FROM contact c WHERE c.id = enlace.contact_id;
      SELECT array_agg(DISTINCT c.id), bool_and(c.opted_out) INTO ids, todas_de_baja
        FROM contact c
       WHERE c.id = enlace.contact_id OR c.email = enlace.recipient_address;
      ids := coalesce(ids, '{}'::uuid[]);
      ya_baja := coalesce(ya_baja, todas_de_baja, false);
      PERFORM set_config('app.public_optout_contacts', format('{%s}', array_to_string(ids, ',')), true);

      -- Sin columna en ON CONFLICT a propósito: nombrarla pediría SELECT
      -- sobre la lista, y este rol solo inserta en ella. Si la dirección
      -- ya estaba (otro clic, de este correo o de otro), no entra ninguna
      -- fila: ya estaba de baja, aunque ninguna ficha lo diga.
      INSERT INTO contact_suppression (email, reason) VALUES (enlace.recipient_address, 'unsubscribe_link')
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS nuevas = ROW_COUNT;
      ya_baja := ya_baja OR nuevas = 0;

      -- Quién la provocó: el workspace y el toque del correo (4.6).
      INSERT INTO outbound_optout_event (token_hash, workspace_id, touch_id, recipient_address, claimed_at,
                                         sent_at, already_opted_out)
      VALUES (resumen, enlace.workspace_id, enlace.touch_id, enlace.recipient_address, enlace.claimed_at,
              enlace.sent_at, ya_baja);

      UPDATE contact
         SET opted_out = true,
             opted_out_at = coalesce(opted_out_at, now()),
             opted_out_reason = coalesce(opted_out_reason, 'Pidió la baja desde el enlace de un correo.')
       WHERE id = ANY (ids) AND NOT opted_out;

      -- CANCELABLE_TOUCH_STATUSES: todo lo que puede salir menos lo que
      -- el despachador ya reclamó (processing, 4.1).
      UPDATE outbound_touch
         SET status = 'canceled', blocked_reason = 'opted_out'
       WHERE contact_id = ANY (ids)
         AND status IN ('draft', 'scheduled', 'held');

      UPDATE outbound_enrollment
         SET status = 'opted_out', finished_at = coalesce(finished_at, now())
       WHERE contact_id = ANY (ids)
         AND status IN ('active', 'paused', 'cooldown');

      r := jsonb_build_object('status', 'ok', 'alreadyOptedOut', ya_baja,
                              'workspaceId', enlace.workspace_id, 'touchId', enlace.touch_id);
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
  'Baja desde el enlace de un correo (VEN-9, VEN-15): busca el sha256 del token en outbound_optout_link, anota en '
  'contact_suppression la dirección a la que salió ese correo, deja el clic en outbound_optout_event, marca '
  'contact.opted_out en la ficha que lo recibió y en las fichas con esa dirección, y cancela lo pendiente de todas en '
  'cualquier workspace. SECURITY DEFINER de mc_public_share (0037 §9).';

-- ---------------------------------------------------------------------
-- 9.4 · Privilegios y dueño
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION public_optout(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_optout(text) TO mc_app;
ALTER FUNCTION public_optout(text) OWNER TO mc_public_share;

REVOKE CREATE ON SCHEMA public FROM mc_public_share;
