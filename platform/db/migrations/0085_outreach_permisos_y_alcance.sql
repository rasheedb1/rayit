-- =====================================================================
-- 0085 · Los permisos del outreach y el search_path de scope_allows (R2-ACC)
-- ---------------------------------------------------------------------
-- Número: 0085, el siguiente libre detrás de 0084_search_path_extensions
-- (aplicada en Supabase el 9-oct-2026). Re-ejecutable: ON CONFLICT DO
-- NOTHING y ALTER FUNCTION … SET, que no cambian nada la segunda vez.
--
-- Compatible con el código que hoy está en producción: solo AÑADE dos
-- filas al catálogo de permisos (y sus filas en role_permission para los
-- roles de fábrica) y fija el search_path de dos funciones que ya
-- existen. La web vieja descarta una llave que su catálogo no conoce
-- (aConjunto() en lib/permisos/sesion.ts: «descartarla nunca da más
-- acceso»), así que se aplica ANTES del despliegue sin ventana.
--
-- 1 · Los permisos del outreach (CIERRE-ACC §5.1, ventas-outreach §5.2
--     paso 8). Hasta hoy las Server Actions de Ventas, Cotizar y Resumen
--     se protegían por ROL (puedeOperarVentas: owner, admin, manager,
--     editor) y no por el catálogo de ACC-1; desde R2-ACC cada una abre
--     con requirePermission(). Las del CRM y de Cotizar tienen su permiso
--     desde 0034 (docs/propuestas/ACC-1.md §4); las del outreach no
--     tenían ninguno:
--
--     · ventas.outreach.enviar — aprobar, deshacer, regenerar y saltar
--       mensajes (aprobaciones), responder y clasificar en la bandeja,
--       reintentar y cancelar en Actividad. Lo tienen el Dueño, el
--       Administrador y el Mánager/Ejecutivo: es quien habla con las
--       marcas, igual que ventas.negocio.editar.
--     · ventas.outreach.configurar — encender y apagar el envío, la
--       política (dirección postal, topes), los canales (límites,
--       desconectar) y el brief. Compromete la reputación del remitente,
--       así que es 'sensible' y lo tienen solo el Dueño y el Administrador
--       (lo que hoy decían PUEDEN_CAMBIAR_LA_POLITICA,
--       PUEDEN_GESTIONAR_CANALES y PUEDEN_EDITAR_BRIEF: owner y admin).
--
--     Los roles propios de un workspace (workspace_id no nulo) no se
--     tocan: su dueño decide (ACC-9). La semilla de 0034 es inmutable; la
--     prueba packages/db/test/accesos.test.ts sabe que estas dos llaves
--     las siembra esta migración (PERMISOS_DESPUES_DE_0034).
--
-- 2 · scope_allows(text, uuid) y scope_allows(text, uuid[]) (0040) no
--     fijaban search_path y leen membership_scope sin calificar
--     (pendientes-fase-9.json, hallazgo de ACC-7 r5). Son la base de la
--     política RESTRICTIVE por creador (0082): con un search_path ajeno,
--     una tabla membership_scope de otro esquema las engañaría. Mismo
--     search_path que exigen 0084 y search-path-extensions.test.ts.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · Los dos permisos del outreach y sus roles de fábrica
-- ---------------------------------------------------------------------
-- Una sentencia por permiso, con la forma que accesos.test.ts busca
-- (la de 0037): «INSERT INTO permission (…)\nVALUES ('<clave>'».
INSERT INTO permission (key, module, label_es, sensitivity)
VALUES ('ventas.outreach.enviar', 'ventas', 'Aprobar, responder y reintentar mensajes de outreach', 'normal')
ON CONFLICT (key) DO NOTHING;

INSERT INTO permission (key, module, label_es, sensitivity)
VALUES ('ventas.outreach.configurar', 'ventas', 'Configurar el envío: política, canales y brief', 'sensible')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permission (role_id, permission_key)
SELECT r.id, 'ventas.outreach.enviar'
  FROM role r
 WHERE r.workspace_id IS NULL
   AND (r.key, r.workspace_kind) IN (('owner', 'creator'), ('manager', 'creator'),
                                     ('owner', 'agency'), ('admin', 'agency'), ('manager', 'agency'))
ON CONFLICT DO NOTHING;

INSERT INTO role_permission (role_id, permission_key)
SELECT r.id, 'ventas.outreach.configurar'
  FROM role r
 WHERE r.workspace_id IS NULL
   AND (r.key, r.workspace_kind) IN (('owner', 'creator'), ('owner', 'agency'), ('admin', 'agency'))
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 2 · scope_allows con el search_path fijado
-- ---------------------------------------------------------------------
ALTER FUNCTION scope_allows(text, uuid) SET search_path = public, extensions, pg_temp;
ALTER FUNCTION scope_allows(text, uuid[]) SET search_path = public, extensions, pg_temp;
