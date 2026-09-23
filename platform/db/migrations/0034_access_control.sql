-- =====================================================================
-- 0034 · Esquema de accesos: permisos, roles, alcance, invitaciones y
--        concesiones (ACC-3)
-- ---------------------------------------------------------------------
-- Número: la propuesta ACC reservó 0023 (22-sep), pero el runner aplica
-- en orden y 0024–0033 (endurecimiento, CIM-3, Cotizar) ya están en
-- main y en la cola del integrador: una 0023 nueva quedaría DETRÁS de
-- ellas en Supabase y DELANTE en un embebido limpio, con dos historias
-- distintas de la misma base. Por eso esta es 0034 —el número más alto
-- en todas las ramas, más uno— y 0023 sigue como hueco declarado en
-- packages/db/test/aplicar.test.ts. Va detrás de todas y cuenta con
-- ellas: la guardia invertida (0024), assert_reference_visible (0025),
-- las políticas membership_read / membership_alta (0028) y las
-- funciones de sesión current_user_id() (0019).
--
-- Hoy `membership.role` es un text con CHECK de cinco valores que solo
-- distingue quién puede renombrar el espacio (lib/auth/reglas.ts):
-- entrar a un workspace es tener todo el workspace. El piloto tiene
-- mánagers (backlog §7, decisión 10) y sin roles el mánager entra con
-- la cuenta del creador, que es justo lo que el producto dice evitar.
--
-- Lo que deja esta migración (docs/propuestas/ACC-accesos-y-roles.md,
-- fase 4, corregida con lo que la base tiene hoy):
--
--   permission        el catálogo (43 claves <módulo>.<recurso>.<acción>)
--   role              los roles: workspace_id NULL = de sistema (patrón
--                     feature_flag), con workspace_id = a medida (ACC-9)
--   role_permission   la matriz
--   membership        role (text) → role_id (FK a role), con relleno
--   membership_scope  el alcance de una persona (ACC-6, fase 2). Sin
--                     filas = todo el workspace
--   invitation        invitar por correo; el token solo como SHA-256
--   workspace_grant   la concesión de un creador a una agencia (AGE).
--                     Va ya para que el modelo quede cerrado de una vez
--   audit_log         actor_kind 'delegate' y on_behalf_of_workspace_id
--   + la semilla de los diez roles de fábrica (5 de creador, 5 de
--     agencia) con sus 220 permisos, generada desde el catálogo de
--     ACC-1 (packages/core/src/permisos.ts). ON CONFLICT DO NOTHING.
--
-- Decisiones de esta migración que no están en la fase 4 (todas en
-- docs/propuestas/ACC-3.md §0.3):
--   · el relleno NUNCA sube a nadie: admin de creador → Mánager;
--     client → Solo lectura (decisión D: la marca no tiene cuenta);
--   · mc_app: SELECT en permission, role, role_permission y
--     workspace_grant; sin DELETE en invitation (revocar es una fecha);
--   · workspace_grant SÍ lleva RLS (por los dos extremos): la guardia
--     exige aislar toda tabla que apunte a una con RLS;
--   · token_hash solo admite un SHA-256 hexadecimal (CHECK): el token
--     en claro no cabe en la columna;
--   · el disparador role_fits_workspace impide colgar un rol de
--     agencia en un workspace de creador o el rol a medida de OTRO
--     workspace.
--
-- Re-ejecutable: cada sentencia lleva IF NOT EXISTS / DROP … IF EXISTS
-- / CREATE OR REPLACE; el relleno solo corre si la columna `role`
-- todavía existe; la semilla es ON CONFLICT DO NOTHING. Y se para si se
-- aplica al revés (sección 0). Comprobado en PGlite dos veces seguidas
-- (packages/db/test/accesos.test.ts).
--
-- ÍNDICE
--   0 · guardia: 0028 aplicada y assert_reference_visible presente
--   1 · permission: el catálogo
--   2 · role y system_role_id()
--   3 · role_permission: la matriz
--   4 · la semilla (generada; no se edita a mano). Va ANTES del relleno
--       de la sección 5, que la necesita
--   5 · membership: role → role_id, relleno y disparadores
--   6 · membership_scope
--   7 · invitation
--   8 · workspace_grant
--   9 · audit_log: 'delegate' y on_behalf_of_workspace_id
--  10 · privilegios mínimos de mc_app
-- =====================================================================


-- =====================================================================
-- 0 · Guardia: esta migración cuenta con 0024, 0025 y 0028
-- ---------------------------------------------------------------------
-- Sobre una base sin 0025 no existe assert_reference_visible() y los
-- disparadores de abajo fallarían al crearse; sin 0028, membership no
-- tendría las políticas con las que aquí se cuenta (0024 y 0025 las
-- exige 0028 a su vez). El runner aplica en orden y no debería pasar;
-- si alguien aplicó este archivo a mano, mejor parar con un mensaje
-- claro. schema_migrations es la tabla del runner (db/lib/aplicar.mjs);
-- si no existe, quien aplica no es el runner (db/seed/verify/run.mjs) y
-- solo se comprueba la función. Misma forma que 0024 §2 y 0028.
-- =====================================================================
DO $$
DECLARE
  aplicada boolean;
BEGIN
  IF to_regprocedure('assert_reference_visible()') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = '0034_access_control necesita 0025_referencias_visibles aplicada antes (falta assert_reference_visible()).',
      HINT = 'Aplica las migraciones en orden con make db.migrate.';
  END IF;
  IF to_regclass('schema_migrations') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = $1)'
    INTO aplicada
    USING '0028_membership_alta_propia.sql';
  IF NOT aplicada THEN
    RAISE EXCEPTION USING
      MESSAGE = '0034_access_control necesita 0028_membership_alta_propia aplicada antes.',
      HINT = 'Aplica las migraciones en orden con make db.migrate (0024 … 0033, 0034).';
  END IF;
END $$;


-- =====================================================================
-- 1 · permission: el catálogo
-- ---------------------------------------------------------------------
-- Como niche o job_definition: compartido, sin workspace_id, lo llena
-- esta migración (sección 4) y la aplicación solo lo lee. Sin RLS —no
-- hay nada que aislar— y sin escritura para mc_app (sección 10). La
-- fuente de verdad es packages/core/src/permisos.ts (ACC-1): agregar un
-- permiso es editar ese archivo y traer una migración con la fila.
-- =====================================================================
CREATE TABLE IF NOT EXISTS permission (
  key            text PRIMARY KEY,            -- 'finanzas.factura.crear'
  module         text NOT NULL,               -- 'finanzas'
  label_es       text NOT NULL,               -- 'Crear facturas'
  description_es text,
  sensitivity    text NOT NULL DEFAULT 'normal'
                 CHECK (sensitivity IN ('normal', 'sensible')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE permission IS
  'Catálogo cerrado de permisos <módulo>.<recurso>.<acción> (ACC-1/ACC-3). Lo llena la migración desde packages/core/src/permisos.ts; la web solo lo lee.';


-- =====================================================================
-- 2 · role y system_role_id()
-- ---------------------------------------------------------------------
-- workspace_id NULL = rol de sistema (los diez de fábrica), igual que
-- feature_flag y pipeline_stage: se ve desde cualquier workspace. Con
-- workspace_id = un rol a medida de ESE workspace (ACC-9, fase 2), que
-- solo ve su dueño. La unicidad es distinta en cada caso, de ahí los
-- dos índices parciales.
--
-- Tres políticas, con la forma de 0020 §3 y 0025 §4:
--   read   lo de sistema y lo mío
--   seed   INSERT del rol que migra (TO CURRENT_USER: mc_migrator en
--          Supabase, mc_migrator_embedded en pglite), solo filas de
--          sistema y sin workspace fijado: es lo que hace la sección 4
--   (ninguna de escritura para mc_app: los roles a medida llegan con
--   ACC-9, que traerá su política y su GRANT)
-- =====================================================================
CREATE TABLE IF NOT EXISTS role (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid REFERENCES workspace(id) ON DELETE CASCADE,
  key            text NOT NULL,               -- 'owner', 'manager', 'editor', 'finance', 'viewer', 'admin'
  workspace_kind text NOT NULL CHECK (workspace_kind IN ('creator', 'agency')),
  label_es       text NOT NULL,
  description_es text,
  is_system      boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- Un rol de sistema es de sistema y uno a medida tiene dueño: las dos
-- cosas a la vez no significan nada.
ALTER TABLE role DROP CONSTRAINT IF EXISTS role_system_has_no_workspace;
ALTER TABLE role ADD CONSTRAINT role_system_has_no_workspace
  CHECK (is_system = (workspace_id IS NULL));
-- Y un rol a medida no puede llamarse como uno de fábrica: la pantalla
-- de cuenta y cualquier regla que mire la clave lo tomarían por el de
-- sistema (un «owner» a medida sin permisos contaría como Dueño).
ALTER TABLE role DROP CONSTRAINT IF EXISTS role_custom_key_not_system;
ALTER TABLE role ADD CONSTRAINT role_custom_key_not_system
  CHECK (is_system OR key NOT IN ('owner', 'admin', 'manager', 'editor', 'finance', 'viewer'));
CREATE UNIQUE INDEX IF NOT EXISTS role_system_uk ON role (key, workspace_kind)
  WHERE workspace_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS role_ws_uk ON role (workspace_id, key)
  WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS role_workspace_idx ON role (workspace_id) WHERE workspace_id IS NOT NULL;
COMMENT ON TABLE role IS
  'Roles: workspace_id NULL = de sistema (los diez de fábrica, sembrados por 0034); con workspace_id = a medida de ese workspace (ACC-9).';

ALTER TABLE role ENABLE ROW LEVEL SECURITY;
ALTER TABLE role FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_read ON role;
CREATE POLICY role_read ON role FOR SELECT
  USING (workspace_id IS NULL OR workspace_id = current_workspace_id());

DROP POLICY IF EXISTS role_seed ON role;
CREATE POLICY role_seed ON role FOR INSERT TO CURRENT_USER
  WITH CHECK (workspace_id IS NULL AND current_workspace_id() IS NULL);

-- El id de un rol de sistema por su clave y el tipo de workspace, para
-- que seeds, pruebas, createCreatorWorkspace y la pantalla de Equipo no
-- repitan el SELECT. STABLE y SECURITY INVOKER: solo ve lo que role_read
-- deja ver, y los roles de sistema los ve cualquiera. NULL si no existe
-- (un INSERT con ese NULL choca con el NOT NULL de membership.role_id).
CREATE OR REPLACE FUNCTION system_role_id(p_workspace_kind text, p_key text) RETURNS uuid AS $$
  SELECT id FROM role
   WHERE workspace_id IS NULL AND workspace_kind = p_workspace_kind AND key = p_key;
$$ LANGUAGE sql STABLE;
COMMENT ON FUNCTION system_role_id(text, text) IS
  'El id del rol de sistema (workspace_id NULL) con esa clave para ese tipo de workspace, o NULL (0034).';
REVOKE ALL ON FUNCTION system_role_id(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION system_role_id(text, text) TO mc_app, mc_worker;


-- =====================================================================
-- 3 · role_permission: la matriz
-- ---------------------------------------------------------------------
-- Hija de role sin workspace_id: hereda la RLS del padre con el EXISTS
-- de 0018 (la subconsulta corre con los privilegios de quien consulta,
-- así que role_read decide). Sin WITH CHECK explícito la escritura usa
-- la misma condición: el rol que migra ve las filas de sistema y por
-- eso la sección 4 pasa; mc_app no tiene INSERT (sección 10).
-- =====================================================================
CREATE TABLE IF NOT EXISTS role_permission (
  role_id        uuid NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permission(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);
CREATE INDEX IF NOT EXISTS role_permission_permission_idx ON role_permission (permission_key);

ALTER TABLE role_permission ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permission FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_permission_ws_isolation ON role_permission;
CREATE POLICY role_permission_ws_isolation ON role_permission
  USING (EXISTS (SELECT 1 FROM role p WHERE p.id = role_permission.role_id));


-- =====================================================================
-- 4 · La semilla: el catálogo y los diez roles de fábrica con su matriz
-- ---------------------------------------------------------------------
-- GENERADA con `pnpm --filter @mc/core permisos:sql`
-- (packages/core/scripts/permisos-sql.ts, ACC-1) desde el catálogo de
-- packages/core/src/permisos.ts, y pegada tal cual. No se
-- edita a mano. Una matriz distinta será
-- otra migración (esta, aplicada, es inmutable), que borrará lo que
-- sobre; por eso aquí no hay DELETE. ON CONFLICT DO NOTHING: la segunda
-- pasada no cambia nada. Va ANTES del relleno de membership (sección
-- 5): el relleno busca el rol de fábrica de cada membresía, y sobre una
-- base con membresías —Supabase tiene una— sin esta semilla se pararía
-- con «N membresías quedaron sin role_id». En un embebido limpio no se
-- nota (los seeds cargan después de las migraciones); lo prueba
-- test/accesos.test.ts sobre una base «como estaba» hasta 0033. Corre
-- como el rol que migra: permission no
-- tiene RLS, role admite el INSERT por role_seed y role_permission ve
-- las filas de sistema por role_read.
--
-- Conteo esperado (packages/db/test/accesos.test.ts lo comprueba contra
-- ROLES_SISTEMA de @mc/core): 43 permisos; creador owner 43, manager 28,
-- editor 4, finance 9, viewer 9; agencia owner 43, admin 42, manager 24,
-- finance 9, viewer 9; 220 filas de role_permission.
-- =====================================================================
-- 43 permisos.
INSERT INTO permission (key, module, label_es, sensitivity) VALUES
  ('resumen.panel.ver', 'resumen', 'Ver el resumen', 'normal'),
  ('resumen.metricas.importar', 'resumen', 'Importar métricas por CSV', 'normal'),
  ('ventas.senal.ver', 'ventas', 'Ver el radar de señales', 'normal'),
  ('ventas.senal.registrar', 'ventas', 'Anotar, aceptar y descartar señales', 'normal'),
  ('ventas.senal.importar', 'ventas', 'Cargar una lista de marcas por CSV', 'normal'),
  ('ventas.empresa.ver', 'ventas', 'Ver empresas y contactos', 'normal'),
  ('ventas.empresa.crear', 'ventas', 'Crear empresas', 'normal'),
  ('ventas.empresa.editar', 'ventas', 'Editar empresas y sus contactos', 'normal'),
  ('ventas.negocio.ver', 'ventas', 'Ver el pipeline de negocios', 'normal'),
  ('ventas.negocio.crear', 'ventas', 'Crear negocios', 'normal'),
  ('ventas.negocio.editar', 'ventas', 'Mover negocios de etapa', 'normal'),
  ('cotizar.tarifario.ver', 'cotizar', 'Ver el tarifario', 'normal'),
  ('cotizar.tarifario.editar', 'cotizar', 'Guardar el tarifario', 'normal'),
  ('cotizar.mediakit.ver', 'cotizar', 'Ver los media kits', 'normal'),
  ('cotizar.mediakit.generar', 'cotizar', 'Generar un media kit', 'normal'),
  ('cotizar.mediakit.editar', 'cotizar', 'Publicar, despublicar y desbloquear media kits', 'normal'),
  ('cotizar.cotizacion.ver', 'cotizar', 'Ver las cotizaciones', 'normal'),
  ('cotizar.cotizacion.crear', 'cotizar', 'Crear cotizaciones', 'normal'),
  ('cotizar.cotizacion.editar', 'cotizar', 'Editar y borrar borradores de cotización', 'normal'),
  ('cotizar.cotizacion.enviar', 'cotizar', 'Enviar cotizaciones y registrar la respuesta de la marca', 'normal'),
  ('campanas.campana.ver', 'campanas', 'Ver las campañas', 'normal'),
  ('campanas.campana.crear', 'campanas', 'Crear campañas', 'normal'),
  ('campanas.campana.editar', 'campanas', 'Editar campañas y cambiar su estado', 'normal'),
  ('campanas.post.asociar', 'campanas', 'Asociar posts y marcar entregables', 'normal'),
  ('campanas.aporte.registrar', 'campanas', 'Registrar lo que aporta la marca', 'normal'),
  ('campanas.reporte.enviar', 'campanas', 'Enviar el reporte a la marca', 'normal'),
  ('finanzas.factura.ver', 'finanzas', 'Ver las facturas', 'sensible'),
  ('finanzas.factura.crear', 'finanzas', 'Crear facturas', 'sensible'),
  ('finanzas.factura.editar', 'finanzas', 'Marcar facturas como enviadas o anularlas', 'sensible'),
  ('finanzas.pago.registrar', 'finanzas', 'Registrar pagos', 'sensible'),
  ('finanzas.cobro.ver', 'finanzas', 'Ver el estado de cobro de las campañas', 'sensible'),
  ('finanzas.gasto.ver', 'finanzas', 'Ver los gastos', 'sensible'),
  ('finanzas.gasto.registrar', 'finanzas', 'Registrar gastos', 'sensible'),
  ('finanzas.flujo.ver', 'finanzas', 'Ver el flujo de caja y la reserva de impuestos', 'sensible'),
  ('finanzas.ajustes.configurar', 'finanzas', 'Configurar los parámetros financieros', 'sensible'),
  ('conexiones.cuenta.ver', 'conexiones', 'Ver el estado de las cuentas conectadas', 'normal'),
  ('conexiones.cuenta.conectar', 'conexiones', 'Conectar cuentas y pedir una lectura nueva', 'sensible'),
  ('conexiones.cuenta.desconectar', 'conexiones', 'Quitar cuentas conectadas', 'sensible'),
  ('equipo.miembro.ver', 'equipo', 'Ver quién está en el espacio', 'sensible'),
  ('equipo.miembro.invitar', 'equipo', 'Invitar personas al espacio', 'sensible'),
  ('equipo.miembro.revocar', 'equipo', 'Quitar personas del espacio', 'sensible'),
  ('equipo.rol.editar', 'equipo', 'Cambiar el rol de una persona', 'sensible'),
  ('equipo.workspace.configurar', 'equipo', 'Configurar el espacio y cerrar la cuenta', 'sensible')
ON CONFLICT (key) DO NOTHING;

-- 10 roles de sistema (workspace_id IS NULL).
INSERT INTO role (workspace_id, key, workspace_kind, label_es, description_es, is_system) VALUES
  (NULL, 'owner', 'creator', 'Dueño', 'El creador. Todo, incluido el equipo y la cuenta.', true),
  (NULL, 'manager', 'creator', 'Mánager', 'Su agente, quien habla con las marcas. Ventas, Cotizar y Campañas completas, el estado de cobro de las campañas, y ve el resto. No conecta cuentas ni ve el flujo de caja.', true),
  (NULL, 'editor', 'creator', 'Editor', 'Community manager o editor de video. Ve las campañas y marca sus entregables.', true),
  (NULL, 'finance', 'creator', 'Contador', 'Contador externo. Todo Finanzas; las campañas las ve por sus facturas.', true),
  (NULL, 'viewer', 'creator', 'Solo lectura', 'Quien mira y no toca. Sin Finanzas ni Equipo.', true),
  (NULL, 'owner', 'agency', 'Dueño', 'Toda la agencia, incluidas la facturación de la cuenta y su cierre.', true),
  (NULL, 'admin', 'agency', 'Administrador', 'Personas, roles y marcas de toda la agencia. No configura ni cierra la cuenta.', true),
  (NULL, 'manager', 'agency', 'Ejecutivo de cuenta', 'Ventas, Cotizar y Campañas de las marcas o creadores que tiene asignados.', true),
  (NULL, 'finance', 'agency', 'Contador', 'Finanzas de la agencia.', true),
  (NULL, 'viewer', 'agency', 'Solo lectura', 'Ver lo que se le asigne. Sin Finanzas ni Equipo.', true)
ON CONFLICT (key, workspace_kind) WHERE workspace_id IS NULL DO NOTHING;

-- 220 filas de la matriz. El role_id se resuelve por (key, workspace_kind) porque es gen_random_uuid().
INSERT INTO role_permission (role_id, permission_key)
SELECT r.id, m.permission_key
FROM (VALUES
  ('owner', 'creator', 'resumen.panel.ver'),
  ('owner', 'creator', 'resumen.metricas.importar'),
  ('owner', 'creator', 'ventas.senal.ver'),
  ('owner', 'creator', 'ventas.senal.registrar'),
  ('owner', 'creator', 'ventas.senal.importar'),
  ('owner', 'creator', 'ventas.empresa.ver'),
  ('owner', 'creator', 'ventas.empresa.crear'),
  ('owner', 'creator', 'ventas.empresa.editar'),
  ('owner', 'creator', 'ventas.negocio.ver'),
  ('owner', 'creator', 'ventas.negocio.crear'),
  ('owner', 'creator', 'ventas.negocio.editar'),
  ('owner', 'creator', 'cotizar.tarifario.ver'),
  ('owner', 'creator', 'cotizar.tarifario.editar'),
  ('owner', 'creator', 'cotizar.mediakit.ver'),
  ('owner', 'creator', 'cotizar.mediakit.generar'),
  ('owner', 'creator', 'cotizar.mediakit.editar'),
  ('owner', 'creator', 'cotizar.cotizacion.ver'),
  ('owner', 'creator', 'cotizar.cotizacion.crear'),
  ('owner', 'creator', 'cotizar.cotizacion.editar'),
  ('owner', 'creator', 'cotizar.cotizacion.enviar'),
  ('owner', 'creator', 'campanas.campana.ver'),
  ('owner', 'creator', 'campanas.campana.crear'),
  ('owner', 'creator', 'campanas.campana.editar'),
  ('owner', 'creator', 'campanas.post.asociar'),
  ('owner', 'creator', 'campanas.aporte.registrar'),
  ('owner', 'creator', 'campanas.reporte.enviar'),
  ('owner', 'creator', 'finanzas.factura.ver'),
  ('owner', 'creator', 'finanzas.factura.crear'),
  ('owner', 'creator', 'finanzas.factura.editar'),
  ('owner', 'creator', 'finanzas.pago.registrar'),
  ('owner', 'creator', 'finanzas.cobro.ver'),
  ('owner', 'creator', 'finanzas.gasto.ver'),
  ('owner', 'creator', 'finanzas.gasto.registrar'),
  ('owner', 'creator', 'finanzas.flujo.ver'),
  ('owner', 'creator', 'finanzas.ajustes.configurar'),
  ('owner', 'creator', 'conexiones.cuenta.ver'),
  ('owner', 'creator', 'conexiones.cuenta.conectar'),
  ('owner', 'creator', 'conexiones.cuenta.desconectar'),
  ('owner', 'creator', 'equipo.miembro.ver'),
  ('owner', 'creator', 'equipo.miembro.invitar'),
  ('owner', 'creator', 'equipo.miembro.revocar'),
  ('owner', 'creator', 'equipo.rol.editar'),
  ('owner', 'creator', 'equipo.workspace.configurar'),
  ('manager', 'creator', 'resumen.panel.ver'),
  ('manager', 'creator', 'ventas.senal.ver'),
  ('manager', 'creator', 'ventas.senal.registrar'),
  ('manager', 'creator', 'ventas.senal.importar'),
  ('manager', 'creator', 'ventas.empresa.ver'),
  ('manager', 'creator', 'ventas.empresa.crear'),
  ('manager', 'creator', 'ventas.empresa.editar'),
  ('manager', 'creator', 'ventas.negocio.ver'),
  ('manager', 'creator', 'ventas.negocio.crear'),
  ('manager', 'creator', 'ventas.negocio.editar'),
  ('manager', 'creator', 'cotizar.tarifario.ver'),
  ('manager', 'creator', 'cotizar.tarifario.editar'),
  ('manager', 'creator', 'cotizar.mediakit.ver'),
  ('manager', 'creator', 'cotizar.mediakit.generar'),
  ('manager', 'creator', 'cotizar.mediakit.editar'),
  ('manager', 'creator', 'cotizar.cotizacion.ver'),
  ('manager', 'creator', 'cotizar.cotizacion.crear'),
  ('manager', 'creator', 'cotizar.cotizacion.editar'),
  ('manager', 'creator', 'cotizar.cotizacion.enviar'),
  ('manager', 'creator', 'campanas.campana.ver'),
  ('manager', 'creator', 'campanas.campana.crear'),
  ('manager', 'creator', 'campanas.campana.editar'),
  ('manager', 'creator', 'campanas.post.asociar'),
  ('manager', 'creator', 'campanas.aporte.registrar'),
  ('manager', 'creator', 'campanas.reporte.enviar'),
  ('manager', 'creator', 'finanzas.cobro.ver'),
  ('manager', 'creator', 'conexiones.cuenta.ver'),
  ('manager', 'creator', 'equipo.miembro.ver'),
  ('editor', 'creator', 'resumen.panel.ver'),
  ('editor', 'creator', 'campanas.campana.ver'),
  ('editor', 'creator', 'campanas.post.asociar'),
  ('editor', 'creator', 'conexiones.cuenta.ver'),
  ('finance', 'creator', 'finanzas.factura.ver'),
  ('finance', 'creator', 'finanzas.factura.crear'),
  ('finance', 'creator', 'finanzas.factura.editar'),
  ('finance', 'creator', 'finanzas.pago.registrar'),
  ('finance', 'creator', 'finanzas.cobro.ver'),
  ('finance', 'creator', 'finanzas.gasto.ver'),
  ('finance', 'creator', 'finanzas.gasto.registrar'),
  ('finance', 'creator', 'finanzas.flujo.ver'),
  ('finance', 'creator', 'finanzas.ajustes.configurar'),
  ('viewer', 'creator', 'resumen.panel.ver'),
  ('viewer', 'creator', 'ventas.senal.ver'),
  ('viewer', 'creator', 'ventas.empresa.ver'),
  ('viewer', 'creator', 'ventas.negocio.ver'),
  ('viewer', 'creator', 'cotizar.tarifario.ver'),
  ('viewer', 'creator', 'cotizar.mediakit.ver'),
  ('viewer', 'creator', 'cotizar.cotizacion.ver'),
  ('viewer', 'creator', 'campanas.campana.ver'),
  ('viewer', 'creator', 'conexiones.cuenta.ver'),
  ('owner', 'agency', 'resumen.panel.ver'),
  ('owner', 'agency', 'resumen.metricas.importar'),
  ('owner', 'agency', 'ventas.senal.ver'),
  ('owner', 'agency', 'ventas.senal.registrar'),
  ('owner', 'agency', 'ventas.senal.importar'),
  ('owner', 'agency', 'ventas.empresa.ver'),
  ('owner', 'agency', 'ventas.empresa.crear'),
  ('owner', 'agency', 'ventas.empresa.editar'),
  ('owner', 'agency', 'ventas.negocio.ver'),
  ('owner', 'agency', 'ventas.negocio.crear'),
  ('owner', 'agency', 'ventas.negocio.editar'),
  ('owner', 'agency', 'cotizar.tarifario.ver'),
  ('owner', 'agency', 'cotizar.tarifario.editar'),
  ('owner', 'agency', 'cotizar.mediakit.ver'),
  ('owner', 'agency', 'cotizar.mediakit.generar'),
  ('owner', 'agency', 'cotizar.mediakit.editar'),
  ('owner', 'agency', 'cotizar.cotizacion.ver'),
  ('owner', 'agency', 'cotizar.cotizacion.crear'),
  ('owner', 'agency', 'cotizar.cotizacion.editar'),
  ('owner', 'agency', 'cotizar.cotizacion.enviar'),
  ('owner', 'agency', 'campanas.campana.ver'),
  ('owner', 'agency', 'campanas.campana.crear'),
  ('owner', 'agency', 'campanas.campana.editar'),
  ('owner', 'agency', 'campanas.post.asociar'),
  ('owner', 'agency', 'campanas.aporte.registrar'),
  ('owner', 'agency', 'campanas.reporte.enviar'),
  ('owner', 'agency', 'finanzas.factura.ver'),
  ('owner', 'agency', 'finanzas.factura.crear'),
  ('owner', 'agency', 'finanzas.factura.editar'),
  ('owner', 'agency', 'finanzas.pago.registrar'),
  ('owner', 'agency', 'finanzas.cobro.ver'),
  ('owner', 'agency', 'finanzas.gasto.ver'),
  ('owner', 'agency', 'finanzas.gasto.registrar'),
  ('owner', 'agency', 'finanzas.flujo.ver'),
  ('owner', 'agency', 'finanzas.ajustes.configurar'),
  ('owner', 'agency', 'conexiones.cuenta.ver'),
  ('owner', 'agency', 'conexiones.cuenta.conectar'),
  ('owner', 'agency', 'conexiones.cuenta.desconectar'),
  ('owner', 'agency', 'equipo.miembro.ver'),
  ('owner', 'agency', 'equipo.miembro.invitar'),
  ('owner', 'agency', 'equipo.miembro.revocar'),
  ('owner', 'agency', 'equipo.rol.editar'),
  ('owner', 'agency', 'equipo.workspace.configurar'),
  ('admin', 'agency', 'resumen.panel.ver'),
  ('admin', 'agency', 'resumen.metricas.importar'),
  ('admin', 'agency', 'ventas.senal.ver'),
  ('admin', 'agency', 'ventas.senal.registrar'),
  ('admin', 'agency', 'ventas.senal.importar'),
  ('admin', 'agency', 'ventas.empresa.ver'),
  ('admin', 'agency', 'ventas.empresa.crear'),
  ('admin', 'agency', 'ventas.empresa.editar'),
  ('admin', 'agency', 'ventas.negocio.ver'),
  ('admin', 'agency', 'ventas.negocio.crear'),
  ('admin', 'agency', 'ventas.negocio.editar'),
  ('admin', 'agency', 'cotizar.tarifario.ver'),
  ('admin', 'agency', 'cotizar.tarifario.editar'),
  ('admin', 'agency', 'cotizar.mediakit.ver'),
  ('admin', 'agency', 'cotizar.mediakit.generar'),
  ('admin', 'agency', 'cotizar.mediakit.editar'),
  ('admin', 'agency', 'cotizar.cotizacion.ver'),
  ('admin', 'agency', 'cotizar.cotizacion.crear'),
  ('admin', 'agency', 'cotizar.cotizacion.editar'),
  ('admin', 'agency', 'cotizar.cotizacion.enviar'),
  ('admin', 'agency', 'campanas.campana.ver'),
  ('admin', 'agency', 'campanas.campana.crear'),
  ('admin', 'agency', 'campanas.campana.editar'),
  ('admin', 'agency', 'campanas.post.asociar'),
  ('admin', 'agency', 'campanas.aporte.registrar'),
  ('admin', 'agency', 'campanas.reporte.enviar'),
  ('admin', 'agency', 'finanzas.factura.ver'),
  ('admin', 'agency', 'finanzas.factura.crear'),
  ('admin', 'agency', 'finanzas.factura.editar'),
  ('admin', 'agency', 'finanzas.pago.registrar'),
  ('admin', 'agency', 'finanzas.cobro.ver'),
  ('admin', 'agency', 'finanzas.gasto.ver'),
  ('admin', 'agency', 'finanzas.gasto.registrar'),
  ('admin', 'agency', 'finanzas.flujo.ver'),
  ('admin', 'agency', 'finanzas.ajustes.configurar'),
  ('admin', 'agency', 'conexiones.cuenta.ver'),
  ('admin', 'agency', 'conexiones.cuenta.conectar'),
  ('admin', 'agency', 'conexiones.cuenta.desconectar'),
  ('admin', 'agency', 'equipo.miembro.ver'),
  ('admin', 'agency', 'equipo.miembro.invitar'),
  ('admin', 'agency', 'equipo.miembro.revocar'),
  ('admin', 'agency', 'equipo.rol.editar'),
  ('manager', 'agency', 'ventas.senal.ver'),
  ('manager', 'agency', 'ventas.senal.registrar'),
  ('manager', 'agency', 'ventas.senal.importar'),
  ('manager', 'agency', 'ventas.empresa.ver'),
  ('manager', 'agency', 'ventas.empresa.crear'),
  ('manager', 'agency', 'ventas.empresa.editar'),
  ('manager', 'agency', 'ventas.negocio.ver'),
  ('manager', 'agency', 'ventas.negocio.crear'),
  ('manager', 'agency', 'ventas.negocio.editar'),
  ('manager', 'agency', 'cotizar.tarifario.ver'),
  ('manager', 'agency', 'cotizar.tarifario.editar'),
  ('manager', 'agency', 'cotizar.mediakit.ver'),
  ('manager', 'agency', 'cotizar.mediakit.generar'),
  ('manager', 'agency', 'cotizar.mediakit.editar'),
  ('manager', 'agency', 'cotizar.cotizacion.ver'),
  ('manager', 'agency', 'cotizar.cotizacion.crear'),
  ('manager', 'agency', 'cotizar.cotizacion.editar'),
  ('manager', 'agency', 'cotizar.cotizacion.enviar'),
  ('manager', 'agency', 'campanas.campana.ver'),
  ('manager', 'agency', 'campanas.campana.crear'),
  ('manager', 'agency', 'campanas.campana.editar'),
  ('manager', 'agency', 'campanas.post.asociar'),
  ('manager', 'agency', 'campanas.aporte.registrar'),
  ('manager', 'agency', 'campanas.reporte.enviar'),
  ('finance', 'agency', 'finanzas.factura.ver'),
  ('finance', 'agency', 'finanzas.factura.crear'),
  ('finance', 'agency', 'finanzas.factura.editar'),
  ('finance', 'agency', 'finanzas.pago.registrar'),
  ('finance', 'agency', 'finanzas.cobro.ver'),
  ('finance', 'agency', 'finanzas.gasto.ver'),
  ('finance', 'agency', 'finanzas.gasto.registrar'),
  ('finance', 'agency', 'finanzas.flujo.ver'),
  ('finance', 'agency', 'finanzas.ajustes.configurar'),
  ('viewer', 'agency', 'resumen.panel.ver'),
  ('viewer', 'agency', 'ventas.senal.ver'),
  ('viewer', 'agency', 'ventas.empresa.ver'),
  ('viewer', 'agency', 'ventas.negocio.ver'),
  ('viewer', 'agency', 'cotizar.tarifario.ver'),
  ('viewer', 'agency', 'cotizar.mediakit.ver'),
  ('viewer', 'agency', 'cotizar.cotizacion.ver'),
  ('viewer', 'agency', 'campanas.campana.ver'),
  ('viewer', 'agency', 'conexiones.cuenta.ver')
) AS m (role_key, workspace_kind, permission_key)
JOIN role r ON r.key = m.role_key AND r.workspace_kind = m.workspace_kind AND r.workspace_id IS NULL
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 5 · membership: role (text) → role_id (FK), con relleno
-- ---------------------------------------------------------------------
-- El relleno va por workspace.kind, porque los roles de fábrica son
-- distintos en un workspace de creador y en uno de agencia, y NUNCA
-- SUBE A NADIE (docs/propuestas/ACC-3.md §0.3, decisión 1):
--
--   owner  → owner                     en los dos
--   admin  → admin en agencia          no existe «admin» de creador:
--            manager en creador        Mánager es el rol de creador
--                                      más alto sin ser Dueño
--   member → manager en agencia, editor en creador
--   viewer → viewer
--   client → viewer                    decisión D: la marca no tiene
--                                      cuenta, tiene un enlace. La
--                                      fila, si existiera, queda como
--                                      «solo lectura» hasta que
--                                      alguien la quite desde Equipo
--
-- Un valor fuera de esos cinco no puede existir (CHECK de 0001); si
-- existiera, la migración se para en vez de inventar un rol.
--
-- membership y workspace tienen FORCE ROW LEVEL SECURITY, y membership
-- no tiene política de UPDATE: como el rol que migra y sin workspace
-- fijado, el UPDATE tocaría cero filas en silencio. Como en 0026, 0032
-- y 0033, se les quita FORCE solo durante el relleno y se les devuelve
-- en la misma transacción. El bloque entero solo corre si la columna
-- `role` todavía existe: la segunda pasada no hace nada.
--
-- Las políticas membership_read y membership_alta (0028) no nombran la
-- columna role (comprobado con pg_get_expr): no hay que reescribirlas.
-- =====================================================================
ALTER TABLE membership ADD COLUMN IF NOT EXISTS role_id uuid REFERENCES role(id);

DO $$
DECLARE
  forzadas text[] := ARRAY[]::text[];
  t text;
  sin_rol integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'membership' AND column_name = 'role'
  ) THEN
    RETURN;
  END IF;

  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname IN ('membership', 'workspace') AND c.relforcerowsecurity
  LOOP
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    forzadas := forzadas || t;
  END LOOP;

  EXECUTE $relleno$
    UPDATE membership m
       SET role_id = r.id
      FROM workspace w, role r
     WHERE w.id = m.workspace_id
       AND m.role_id IS NULL
       AND r.workspace_id IS NULL
       AND r.workspace_kind = w.kind
       AND r.key = CASE m.role
                     WHEN 'owner'  THEN 'owner'
                     WHEN 'admin'  THEN CASE w.kind WHEN 'agency' THEN 'admin'   ELSE 'manager' END
                     WHEN 'member' THEN CASE w.kind WHEN 'agency' THEN 'manager' ELSE 'editor'  END
                     WHEN 'viewer' THEN 'viewer'
                     WHEN 'client' THEN 'viewer'
                   END
  $relleno$;

  EXECUTE 'SELECT count(*)::int FROM membership WHERE role_id IS NULL' INTO sin_rol;
  IF sin_rol > 0 THEN
    RAISE EXCEPTION USING
      MESSAGE = format('%s membresías quedaron sin role_id: hay un valor de membership.role fuera de owner/admin/member/viewer/client, o falta la semilla de roles.', sin_rol),
      HINT = 'Revisa SELECT role, count(*) FROM membership GROUP BY 1 antes de volver a aplicar 0034.';
  END IF;

  FOREACH t IN ARRAY forzadas LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

ALTER TABLE membership ALTER COLUMN role_id SET NOT NULL;
ALTER TABLE membership DROP COLUMN IF EXISTS role;
CREATE INDEX IF NOT EXISTS membership_role_idx ON membership (role_id);
COMMENT ON COLUMN membership.role_id IS
  'El rol de la persona en el workspace (0034). Sin DEFAULT: quien inserta lo dice, normalmente con system_role_id(kind, key).';

-- La clave nueva hacia una tabla con RLS lleva el disparador de 0025 §3
-- (mc_app tiene INSERT en membership desde 0028): una membresía solo
-- puede nombrar un rol que quien escribe ve, es decir uno de sistema o
-- uno a medida de su propio workspace.
DROP TRIGGER IF EXISTS ref_visible_role_id ON membership;
CREATE TRIGGER ref_visible_role_id
  BEFORE INSERT OR UPDATE OF role_id ON membership
  FOR EACH ROW WHEN (NEW.role_id IS NOT NULL)
  EXECUTE FUNCTION assert_reference_visible('role_id', 'role', 'id');

-- Y que el rol sea del tipo del workspace: un rol de agencia no se
-- cuelga de un workspace de creador ni al revés, y un rol a medida solo
-- vale en el workspace que lo creó. La misma regla vale para el rol que
-- lleva una invitación (sección 7) y una concesión (sección 8), así que
-- la función es genérica: argumentos = columna del rol, columna del
-- workspace donde el rol se va a usar.
--
-- SECURITY INVOKER: lee role y workspace con la RLS de quien escribe.
-- El disparador se llama role_fits_workspace a propósito: Postgres
-- dispara los BEFORE en orden alfabético, así que corre DESPUÉS de los
-- ref_visible_*, que ya rechazaron (23503) un workspace o un rol que
-- quien escribe no ve. Si aun así no ve alguno, no decide nada. Va
-- DESPUÉS del relleno: el relleno corre sin workspace fijado.
CREATE OR REPLACE FUNCTION assert_role_fits_workspace() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  col_rol  text := TG_ARGV[0];
  col_ws   text := TG_ARGV[1];
  id_rol   uuid;
  id_ws    uuid;
  kind_ws  text;
  kind_rol text;
  ws_rol   uuid;
BEGIN
  EXECUTE format('SELECT ($1).%I, ($1).%I', col_rol, col_ws) INTO id_rol, id_ws USING NEW;
  SELECT w.kind INTO kind_ws FROM workspace w WHERE w.id = id_ws;
  SELECT r.workspace_kind, r.workspace_id INTO kind_rol, ws_rol FROM role r WHERE r.id = id_rol;
  IF kind_ws IS NULL OR kind_rol IS NULL THEN
    RETURN NEW;
  END IF;
  IF kind_rol <> kind_ws THEN
    RAISE EXCEPTION 'el rol de % es de un workspace de tipo % y este workspace es de tipo %', TG_TABLE_NAME, kind_rol, kind_ws
      USING ERRCODE = 'check_violation',
            HINT = 'Un rol de agencia no vale en un workspace de creador ni al revés (migración 0034 §5).';
  END IF;
  IF ws_rol IS NOT NULL AND ws_rol <> id_ws THEN
    RAISE EXCEPTION 'el rol a medida de % es de otro workspace', TG_TABLE_NAME
      USING ERRCODE = 'check_violation',
            HINT = 'Un rol a medida solo vale en el workspace que lo creó (migración 0034 §5).';
  END IF;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION assert_role_fits_workspace() IS
  'Disparador BEFORE INSERT OR UPDATE: el rol (columna TG_ARGV[0]) es del tipo del workspace (columna TG_ARGV[1]) y, si es a medida, de ese mismo workspace. En membership, invitation y workspace_grant (0034 §5).';

DROP TRIGGER IF EXISTS role_fits_workspace ON membership;
CREATE TRIGGER role_fits_workspace
  BEFORE INSERT OR UPDATE OF role_id, workspace_id ON membership
  FOR EACH ROW EXECUTE FUNCTION assert_role_fits_workspace('role_id', 'workspace_id');


-- =====================================================================
-- 6 · membership_scope: el alcance de una persona (fase 2, ACC-6)
-- ---------------------------------------------------------------------
-- Sin filas = todo el workspace. Con filas, la persona solo ve lo que
-- cuelga de esos creadores, empresas o campañas; el filtro lo aplican
-- las consultas de @mc/db (scopeFilter, ACC-6), no RLS (decisión C).
-- La tabla va ya para que el modelo quede cerrado; hoy nadie la lee.
--
-- Para mc_app es de SOLO LECTURA (sección 10): el alcance de una persona
-- lo decide quien administra el equipo (ACC-4) por una función acotada o
-- el worker, nunca un INSERT o un DELETE sueltos desde la web; si no,
-- cualquier miembro podría borrar su propio alcance y ver todo el
-- workspace. Misma política y mismo privilegio que la rama de ACC-6
-- (0034_membership_scope.sql, que al integrar pasa a 0035 y crea esta
-- misma tabla con IF NOT EXISTS). Como mc_app no la escribe, la clave
-- compuesta hacia membership no necesita assert_reference_visible.
-- =====================================================================
CREATE TABLE IF NOT EXISTS membership_scope (
  workspace_id  uuid NOT NULL,
  user_id       uuid NOT NULL,
  scope_type    text NOT NULL CHECK (scope_type IN ('creator', 'company', 'campaign')),
  scope_id      uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, scope_type, scope_id),
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES membership(workspace_id, user_id) ON DELETE CASCADE
);
COMMENT ON TABLE membership_scope IS
  'A qué creadores, empresas o campañas se limita una persona dentro del workspace (ACC-6, fase 2). Sin filas, ve todo el workspace.';

ALTER TABLE membership_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_scope FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS membership_scope_read ON membership_scope;
CREATE POLICY membership_scope_read ON membership_scope FOR SELECT
  USING (workspace_id = current_workspace_id());


-- =====================================================================
-- 7 · invitation
-- ---------------------------------------------------------------------
-- El token que viaja en el enlace no se guarda nunca: solo su SHA-256
-- en hexadecimal, y el CHECK hace que la columna no admita otra cosa
-- (misma regla que los secretos de CON-3, exigida por la base). Una sola
-- invitación pendiente por correo y workspace (índice parcial); revocar
-- es una fecha, no un DELETE (sección 10). El hash es único en toda la
-- base porque la aceptación busca por él sin saber el workspace:
-- declarado en UNICOS_GLOBALES_DECLARADOS (chocar exige conocer el
-- token, y conocerlo ya es tenerlo).
--
-- Cómo acepta quien todavía no es miembro —y por tanto no puede fijar
-- este workspace— es de ACC-4: docs/propuestas/ACC-3.md §4.
-- =====================================================================
CREATE TABLE IF NOT EXISTS invitation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  email         citext NOT NULL,
  role_id       uuid NOT NULL REFERENCES role(id),
  scope         jsonb NOT NULL DEFAULT '[]'::jsonb,
  token_hash    text NOT NULL,
  invited_by    uuid REFERENCES app_user(id) ON DELETE SET NULL,
  expires_at    timestamptz NOT NULL,
  accepted_at   timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE invitation DROP CONSTRAINT IF EXISTS invitation_token_hash_is_sha256;
ALTER TABLE invitation ADD CONSTRAINT invitation_token_hash_is_sha256
  CHECK (token_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE invitation DROP CONSTRAINT IF EXISTS invitation_not_accepted_and_revoked;
ALTER TABLE invitation ADD CONSTRAINT invitation_not_accepted_and_revoked
  CHECK (accepted_at IS NULL OR revoked_at IS NULL);
CREATE UNIQUE INDEX IF NOT EXISTS invitation_pending_uk ON invitation (workspace_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS invitation_token_hash_uk ON invitation (token_hash);
CREATE INDEX IF NOT EXISTS invitation_workspace_idx ON invitation (workspace_id, created_at DESC);
COMMENT ON COLUMN invitation.token_hash IS
  'SHA-256 en hexadecimal del token del enlace. El token en claro no se guarda nunca (0034 §7).';

ALTER TABLE invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitation FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invitation_read ON invitation;
CREATE POLICY invitation_read ON invitation FOR SELECT
  USING (workspace_id = current_workspace_id());

DROP POLICY IF EXISTS invitation_write ON invitation;
CREATE POLICY invitation_write ON invitation FOR INSERT
  WITH CHECK (workspace_id = current_workspace_id());

DROP POLICY IF EXISTS invitation_update ON invitation;
CREATE POLICY invitation_update ON invitation FOR UPDATE
  USING (workspace_id = current_workspace_id())
  WITH CHECK (workspace_id = current_workspace_id());

-- Las tres claves ajenas hacia tablas con RLS, con el disparador de
-- 0025 §3: el bucle de 0025 §7 solo enganchó las que existían entonces.
DROP TRIGGER IF EXISTS ref_visible_workspace_id ON invitation;
CREATE TRIGGER ref_visible_workspace_id
  BEFORE INSERT OR UPDATE OF workspace_id ON invitation
  FOR EACH ROW WHEN (NEW.workspace_id IS NOT NULL)
  EXECUTE FUNCTION assert_reference_visible('workspace_id', 'workspace', 'id');
DROP TRIGGER IF EXISTS ref_visible_role_id ON invitation;
CREATE TRIGGER ref_visible_role_id
  BEFORE INSERT OR UPDATE OF role_id ON invitation
  FOR EACH ROW WHEN (NEW.role_id IS NOT NULL)
  EXECUTE FUNCTION assert_reference_visible('role_id', 'role', 'id');
DROP TRIGGER IF EXISTS ref_visible_invited_by ON invitation;
CREATE TRIGGER ref_visible_invited_by
  BEFORE INSERT OR UPDATE OF invited_by ON invitation
  FOR EACH ROW WHEN (NEW.invited_by IS NOT NULL)
  EXECUTE FUNCTION assert_reference_visible('invited_by', 'app_user', 'id');

-- El rol invitado, del tipo del workspace (sección 5): mejor fallar al
-- invitar que dejar un enlace que no se podrá aceptar.
DROP TRIGGER IF EXISTS role_fits_workspace ON invitation;
CREATE TRIGGER role_fits_workspace
  BEFORE INSERT OR UPDATE OF role_id, workspace_id ON invitation
  FOR EACH ROW EXECUTE FUNCTION assert_role_fits_workspace('role_id', 'workspace_id');


-- =====================================================================
-- 8 · workspace_grant: la concesión de un creador a una agencia (AGE)
-- ---------------------------------------------------------------------
-- Decisión A (backlog §7, decisión 6): la agencia no absorbe al creador;
-- recibe una concesión revocable sobre su workspace, con un rol y un
-- alcance. La sesión sigue fijada a UN workspace y RLS no cambia; la
-- persona de la agencia ENTRA al workspace del creador con lo que dice
-- la concesión. La pantalla es fase 2 (AGE-1); la tabla va ya porque es
-- barata y cierra el modelo.
--
-- La propuesta decía «sin RLS por workspace_id»; pero la guardia exige
-- aislar toda tabla que apunte a una con RLS, y lo que la propuesta
-- describe («se consulta por los dos extremos») ES una política: la ve
-- quien concede y quien recibe. Sin política de escritura y sin
-- privilegio de escritura para mc_app: la concesión la escribirá el
-- worker o una función acotada, cuando exista AGE-1.
-- =====================================================================
CREATE TABLE IF NOT EXISTS workspace_grant (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grantor_workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE, -- el creador
  grantee_workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE, -- la agencia
  role_id              uuid NOT NULL REFERENCES role(id),
  scope                jsonb NOT NULL DEFAULT '[]'::jsonb,
  status               text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'active', 'revoked', 'expired')),
  requested_by         uuid REFERENCES app_user(id) ON DELETE SET NULL,
  approved_by          uuid REFERENCES app_user(id) ON DELETE SET NULL,
  expires_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  revoked_at           timestamptz,
  CHECK (grantor_workspace_id <> grantee_workspace_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_grant_live_uk
  ON workspace_grant (grantor_workspace_id, grantee_workspace_id)
  WHERE status IN ('pending', 'active');
CREATE INDEX IF NOT EXISTS workspace_grant_grantee_idx ON workspace_grant (grantee_workspace_id);
COMMENT ON TABLE workspace_grant IS
  'Concesión revocable de un workspace (grantor, el creador) a otro (grantee, la agencia), con rol y alcance (decisión A, AGE-1). La escribe el worker; la web solo la lee.';

ALTER TABLE workspace_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_grant FORCE ROW LEVEL SECURITY;

-- El rol de la concesión se usa DENTRO del workspace que concede (el del
-- creador): tiene que ser de su tipo (sección 5).
DROP TRIGGER IF EXISTS role_fits_workspace ON workspace_grant;
CREATE TRIGGER role_fits_workspace
  BEFORE INSERT OR UPDATE OF role_id, grantor_workspace_id ON workspace_grant
  FOR EACH ROW EXECUTE FUNCTION assert_role_fits_workspace('role_id', 'grantor_workspace_id');

DROP POLICY IF EXISTS workspace_grant_read ON workspace_grant;
CREATE POLICY workspace_grant_read ON workspace_grant FOR SELECT
  USING (grantor_workspace_id = current_workspace_id() OR grantee_workspace_id = current_workspace_id());


-- =====================================================================
-- 9 · audit_log: la actuación delegada
-- ---------------------------------------------------------------------
-- «Ana, de la agencia, actuando dentro del workspace de Camilo»:
-- workspace_id sigue siendo el inquilino de los datos (Camilo),
-- actor_user_id es Ana, actor_kind = 'delegate' y
-- on_behalf_of_workspace_id es el workspace por cuya concesión entró
-- (la agencia). Es lo que hace el modelo confiable para el creador:
-- siempre puede ver qué hizo su mánager o su agencia, y cuándo. Hoy
-- nadie escribe 'delegate': lo harán ACC-2/AGE-2 cuando exista la
-- concesión; la columna va ya porque audit_log no se rellena hacia
-- atrás.
-- =====================================================================
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_kind_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_kind_check
  CHECK (actor_kind IN ('user', 'system', 'job', 'webhook', 'delegate'));

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS on_behalf_of_workspace_id uuid
  REFERENCES workspace(id) ON DELETE SET NULL;
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_on_behalf_only_delegate;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_on_behalf_only_delegate
  CHECK (on_behalf_of_workspace_id IS NULL OR actor_kind = 'delegate');
COMMENT ON COLUMN audit_log.on_behalf_of_workspace_id IS
  'Solo con actor_kind = ''delegate'': el workspace (la agencia) por cuya concesión actuó actor_user_id dentro de workspace_id (0034 §9).';

-- mc_app tiene INSERT en audit_log (0025 §5): la clave nueva lleva el
-- disparador de referencia. La agencia se ve desde el workspace del
-- creador porque quien escribe es miembro de ella (workspace_read_member, 0028).
DROP TRIGGER IF EXISTS ref_visible_on_behalf_of_workspace_id ON audit_log;
CREATE TRIGGER ref_visible_on_behalf_of_workspace_id
  BEFORE INSERT OR UPDATE OF on_behalf_of_workspace_id ON audit_log
  FOR EACH ROW WHEN (NEW.on_behalf_of_workspace_id IS NOT NULL)
  EXECUTE FUNCTION assert_reference_visible('on_behalf_of_workspace_id', 'workspace', 'id');


-- =====================================================================
-- 10 · Privilegios mínimos de mc_app (0024 §7: lo que RLS no cubre)
-- ---------------------------------------------------------------------
-- ALTER DEFAULT PRIVILEGES le dio a mc_app los cuatro privilegios sobre
-- cada tabla nueva al nacer. Aquí se rebajan, con el motivo, y la
-- guardia (PRIVILEGIOS_DE_LA_APP en src/esquema.ts) exige que sigan así.
-- mc_worker no se toca: hereda los cuatro (0014) y se salta RLS.
--
--   permission        catálogo: lo llena una migración
--   role              los de sistema los llena una migración; los a
--                     medida son ACC-9 (traerá su política y su GRANT)
--   role_permission   ídem
--   workspace_grant   fase 2: la escribe el worker o una función acotada
--   membership_scope  el alcance lo fija quien administra el equipo, por
--                     función o worker (sección 6)
--   invitation        revocar es revoked_at; nadie borra el rastro de a
--                     quién se invitó
-- =====================================================================
REVOKE INSERT, UPDATE, DELETE ON permission, role, role_permission, workspace_grant, membership_scope FROM mc_app;
REVOKE DELETE ON invitation FROM mc_app;
