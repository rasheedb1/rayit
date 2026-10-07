-- =====================================================================
-- Seed 13 · Una agencia de demo con alcance por creador (ACC-7)
-- ---------------------------------------------------------------------
-- La demo de Laura (0002–0012) es un espacio de UNA creadora y nadie
-- lleva alcance: ahí no se ve nada de ACC-7. Ni el selector de creador
-- en «Nuevo negocio», ni «Sin creador · Solo lo ve quien ve a todos», ni
-- el creador en las tarjetas del pipeline, ni el aviso de negocios que
-- la persona no ve. Este seed deja un espacio aparte donde sí:
--
--   · «Agencia Norte · demo», tipo agencia, COP y Bogotá (los valores por
--     defecto del producto, no una regla).
--   · Dos creadores: Camilo Rey (cocina) y Mariana Gil (viajes).
--   · Valentina Ortiz, Dueña: ve a los dos.
--   · Diego Salas, Ejecutivo de cuenta, acotado a Camilo
--     (membership_scope): en una consulta cruda, en el pipeline y en
--     Campañas solo ve lo de Camilo; en la ficha de Fresko Market, el
--     aviso de que la marca tiene negocios que él no ve.
--   · Cinco negocios con marcas del catálogo (0002): dos de Camilo, dos de
--     Mariana (uno con la misma marca que uno de Camilo) y uno sin
--     creador, que solo ve quien ve a todos.
--   · Dos campañas planificadas, una de cada creador.
--
-- Cómo verlo (docs/propuestas/ACC-7.md, «Cómo verlo»):
--   · Sin llaves (modo demo): DEMO_WORKSPACE_ID=00000013-0000-4000-8000-000000000001
--     enseña la agencia como la ve quien ve a todos (el modo demo no
--     tiene persona en las pantallas): el selector, «Sin creador» y el
--     creador en cada tarjeta.
--   · Con Supabase Auth y este seed aplicado (make db.seed): entrar como
--     diego@agencia-demo.test con generate_link (apps/web/README.md,
--     «Cómo probarlo sin esperar un correo»): lo que ve el ejecutivo
--     acotado. valentina@agencia-demo.test, la dueña.
--
-- Reglas del archivo (las de 0002 y 0011):
--   * Idempotente: ids fijos y ON CONFLICT DO NOTHING. Ninguna fecha: los
--     negocios no tienen vencimiento ni cierre esperado y las campañas no
--     tienen fechas, así que nada envejece y ningún job del worker (los
--     vencimientos, las campañas que empiezan) los toca.
--   * RLS en modo FORCE. app_user y membership solo admiten la fila
--     PROPIA (0025 §4 y 0028): la sesión pasa por cada persona para darla
--     de alta, como 0003 con Andrés, y termina siendo Valentina.
--   * membership_scope no tiene política de escritura: mc_app solo la lee
--     (0034 §10) y nadie la escribe todavía desde la web (CIERRE-ACC
--     §5.6). Aquí se le quita FORCE solo dentro de un bloque DO, para la
--     única fila, y se le devuelve en la misma sentencia (como 0082 §2 y
--     §5): si el INSERT falla, el bloque entero se deshace y la tabla
--     sigue con FORCE. El disparador de 0082 §2 corre igual: Diego es
--     Ejecutivo, no Dueño ni Administrador.
--
-- Requiere 0082 (y las anteriores) y el seed 0002 (las marcas del
-- catálogo).
--
-- Mapa de identificadores (00000013-…):
--   …-000000000001    workspace (Agencia Norte · demo)
--   …-000000000002    app_user Valentina Ortiz (Dueña)
--   …-000000000004    app_user Diego Salas (Ejecutivo de cuenta, acotado a Camilo)
--   …-0000000000a3    creator_profile Camilo Rey
--   …-0000000000b3    creator_profile Mariana Gil
--   …-0000000dea01…05 deal
--   …-000000ca0001…02 campaign
-- =====================================================================

SELECT set_config('app.workspace_id', '00000013-0000-4000-8000-000000000001', false);
SELECT set_config('app.user_id', '00000013-0000-4000-8000-000000000002', false);
SELECT set_config('TimeZone', 'UTC', false);


-- =====================================================================
-- 1 · El espacio y sus dos personas
-- =====================================================================
INSERT INTO workspace (id, slug, name, kind, country, currency, timezone, locale, plan, niche_slugs)
VALUES ('00000013-0000-4000-8000-000000000001', 'agencia-norte-demo', 'Agencia Norte · demo',
        'agency', 'CO', 'COP', 'America/Bogota', 'es-CO', 'agency', '{cocina,viajes}')
ON CONFLICT DO NOTHING;

INSERT INTO app_user (id, email, name, locale)
VALUES ('00000013-0000-4000-8000-000000000002', 'valentina@agencia-demo.test', 'Valentina Ortiz', 'es-CO')
ON CONFLICT DO NOTHING;
INSERT INTO membership (workspace_id, user_id, role_id)
VALUES ('00000013-0000-4000-8000-000000000001', '00000013-0000-4000-8000-000000000002', system_role_id('agency', 'owner'))
ON CONFLICT DO NOTHING;

SELECT set_config('app.user_id', '00000013-0000-4000-8000-000000000004', false);
INSERT INTO app_user (id, email, name, locale)
VALUES ('00000013-0000-4000-8000-000000000004', 'diego@agencia-demo.test', 'Diego Salas', 'es-CO')
ON CONFLICT DO NOTHING;
INSERT INTO membership (workspace_id, user_id, role_id)
VALUES ('00000013-0000-4000-8000-000000000001', '00000013-0000-4000-8000-000000000004', system_role_id('agency', 'manager'))
ON CONFLICT DO NOTHING;

SELECT set_config('app.user_id', '00000013-0000-4000-8000-000000000002', false);


-- =====================================================================
-- 2 · Los dos creadores, y el alcance de Diego
-- =====================================================================
INSERT INTO creator_profile (id, workspace_id, display_name, handle, country, languages, niche_slugs)
VALUES
  ('00000013-0000-4000-8000-0000000000a3', '00000013-0000-4000-8000-000000000001', 'Camilo Rey', 'camilo.cocina', 'CO', '{es}', '{cocina}'),
  ('00000013-0000-4000-8000-0000000000b3', '00000013-0000-4000-8000-000000000001', 'Mariana Gil', 'mariana.viaja', 'CO', '{es}', '{viajes}')
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  forzada boolean;
BEGIN
  SELECT c.relforcerowsecurity INTO forzada
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'membership_scope';
  IF forzada THEN
    ALTER TABLE membership_scope NO FORCE ROW LEVEL SECURITY;
  END IF;
  INSERT INTO membership_scope (workspace_id, user_id, scope_type, scope_id)
  VALUES ('00000013-0000-4000-8000-000000000001', '00000013-0000-4000-8000-000000000004', 'creator',
          '00000013-0000-4000-8000-0000000000a3')
  ON CONFLICT DO NOTHING;
  IF forzada THEN
    ALTER TABLE membership_scope FORCE ROW LEVEL SECURITY;
  END IF;
END $$;


-- =====================================================================
-- 3 · Las marcas en el CRM de la agencia (del catálogo de 0002)
-- =====================================================================
INSERT INTO company_link (workspace_id, company_id, owner_user_id, relationship, notes)
VALUES
  ('00000013-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e1', '00000013-0000-4000-8000-000000000002', 'client',
   'Trabaja con Camilo.'),
  ('00000013-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e2', '00000013-0000-4000-8000-000000000002', 'prospect',
   'Habla con los dos: un negocio de Camilo y otro de Mariana.'),
  ('00000013-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e3', '00000013-0000-4000-8000-000000000002', 'prospect',
   'Viajes con Mariana.'),
  ('00000013-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e4', '00000013-0000-4000-8000-000000000002', 'prospect',
   'Llegó sin decir para quién: el negocio está «Sin creador».')
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 4 · Los negocios: de Camilo, de Mariana y uno sin creador
-- ---------------------------------------------------------------------
-- Sin vencimiento ni cierre esperado (ver la cabecera). Los de Camilo
-- los lleva Diego; los demás, Valentina.
-- =====================================================================
INSERT INTO deal (id, workspace_id, company_id, creator_id, owner_user_id, name, stage_id, amount, currency, next_action)
VALUES
  ('00000013-0000-4000-8000-0000000dea01', '00000013-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e1',
   '00000013-0000-4000-8000-0000000000a3', '00000013-0000-4000-8000-000000000004',
   'Recetas con café · Camilo', 'propuesta', 4500000.00, 'COP', 'Esperar respuesta a la propuesta'),
  ('00000013-0000-4000-8000-0000000dea02', '00000013-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e2',
   '00000013-0000-4000-8000-0000000000a3', '00000013-0000-4000-8000-000000000004',
   'Mercado de la semana · Camilo', 'contactado', 3000000.00, 'COP', 'Mandar el media kit'),
  ('00000013-0000-4000-8000-0000000dea03', '00000013-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e2',
   '00000013-0000-4000-8000-0000000000b3', '00000013-0000-4000-8000-000000000002',
   'Snacks de viaje · Mariana', 'nuevo', 2500000.00, 'COP', 'Enviar pitch'),
  ('00000013-0000-4000-8000-0000000dea04', '00000013-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e3',
   '00000013-0000-4000-8000-0000000000b3', '00000013-0000-4000-8000-000000000002',
   'Casa de playa · Mariana', 'conversacion', 6000000.00, 'COP', 'Responder con fechas'),
  ('00000013-0000-4000-8000-0000000dea05', '00000013-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e4',
   NULL, '00000013-0000-4000-8000-000000000002',
   'Por definir · Nutrivé', 'nuevo', NULL, 'COP', 'Decidir de qué creador es')
ON CONFLICT DO NOTHING;

INSERT INTO deal_stage_history (deal_id, from_stage_id, to_stage_id, changed_by)
SELECT d.id, NULL, d.stage_id, '00000013-0000-4000-8000-000000000002'
  FROM deal d
 WHERE d.workspace_id = '00000013-0000-4000-8000-000000000001'
   AND NOT EXISTS (SELECT 1 FROM deal_stage_history h WHERE h.deal_id = d.id);


-- =====================================================================
-- 5 · Una campaña planificada de cada creador
-- =====================================================================
INSERT INTO campaign (id, workspace_id, company_id, creator_id, name, brief, amount, currency, status)
VALUES
  ('00000013-0000-4000-8000-000000ca0001', '00000013-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e1',
   '00000013-0000-4000-8000-0000000000a3', 'Café de la mañana · Camilo', '1 reel + 3 historias.', 4000000.00, 'COP', 'planned'),
  ('00000013-0000-4000-8000-000000ca0002', '00000013-0000-4000-8000-000000000001', '00000002-0000-4000-8000-0000000000e3',
   '00000013-0000-4000-8000-0000000000b3', 'Escapada a la costa · Mariana', '2 TikTok + 1 reel.', 5500000.00, 'COP', 'planned')
ON CONFLICT DO NOTHING;
