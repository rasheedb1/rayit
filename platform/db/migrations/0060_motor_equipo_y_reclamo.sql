-- =====================================================================
-- 0060 · Quién es del equipo, con y sin los roles de main; y un solo
--        reclamo a la vez (VEN-10)
-- ---------------------------------------------------------------------
-- Número: 0060. La serie de integración va de 0043 a 0075, detrás de
-- la 0042 de main (0034–0042, ya aplicadas en Supabase); ninguna de la
-- serie está aplicada aún. Hasta el pulido r2 de ventas esta fue la
-- 0055. Va detrás de 0059_respuesta_detiene_la_marca. En Supabase se
-- aplica DESPUÉS de 0034_access_control (main), y funciona con ella y
-- sin ella (§1).
--
-- 1 · membership_is_team / membership_is_owner
--
-- El motor avisa a una persona del equipo cuando una marca responde, un
-- toque queda retenido o falla, y a los dueños en las alertas. Hasta
-- aquí lo decidía con `membership.role <> 'client'` y `role = 'owner'`.
-- main aplicó 0034_access_control, que borra membership.role (pasa a
-- role_id → role, con 'client' convertido en 'viewer'). Con esa serie,
-- el INSERT del aviso tumbaba la transacción de recordInbound: la
-- respuesta no se guardaba, lo pendiente no se cancelaba y la cadencia
-- seguía escribiendo a quien ya respondió (el error número uno de
-- Chief, §9). Y `make db.check` seguía en verde, porque el SQL de las
-- consultas no se compila hasta que corre.
--
-- Una sola regla, en la base, que funciona en las dos series: la forma
-- se elige al aplicar esta migración, según exista role_id o no.
--   · con 0034_access_control: equipo = el rol no es 'viewer' (solo
--     lectura, donde 0034_access_control dejó a los 'client'); dueño = 'owner';
--   · sin ella (la serie de esta rama): equipo = role <> 'client';
--     dueño = role = 'owner'.
-- STABLE y SECURITY INVOKER: ve la membresía y el rol con la RLS de
-- quien pregunta, igual que la consulta que reemplaza (los roles de
-- sistema los ve cualquiera, 0034_access_control §2). Si alguien la aplicara DESPUÉS
-- de esta (no pasa con el runner: aplica en orden), basta volver a
-- correr este archivo a mano para que tome la forma nueva.
--
-- 2 · outbound.dispatch con max_concurrency = 1
--
-- En este runner max_concurrency no son corridas en paralelo (boss.ts:
-- la cola es 'stately', una activa), pero lo que declara la fila tiene
-- que ser verdad: el reclamo se serializa (claimDueTouches toma
-- pg_advisory_xact_lock(hashtext('outbound.dispatch/claim'))), porque
-- la separación con la marca y el ritmo por hora de cada cuenta se leen
-- de lo ya confirmado. Un job:dispatch a mano que coincide con el cron
-- espera en ese candado en vez de leer el mismo estado.
--
-- Re-ejecutable: CREATE OR REPLACE y un UPDATE idempotente.
-- =====================================================================

DO $$
DECLARE
  con_roles boolean := EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'membership' AND column_name = 'role_id'
  );
BEGIN
  IF con_roles THEN
    EXECUTE $f$
      CREATE OR REPLACE FUNCTION membership_is_team(p_workspace uuid, p_user uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $b$
        SELECT EXISTS (SELECT 1 FROM membership m JOIN role r ON r.id = m.role_id
                        WHERE m.workspace_id = p_workspace AND m.user_id = p_user AND r.key <> 'viewer');
      $b$
    $f$;
    EXECUTE $f$
      CREATE OR REPLACE FUNCTION membership_is_owner(p_workspace uuid, p_user uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $b$
        SELECT EXISTS (SELECT 1 FROM membership m JOIN role r ON r.id = m.role_id
                        WHERE m.workspace_id = p_workspace AND m.user_id = p_user AND r.key = 'owner');
      $b$
    $f$;
  ELSE
    EXECUTE $f$
      CREATE OR REPLACE FUNCTION membership_is_team(p_workspace uuid, p_user uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $b$
        SELECT EXISTS (SELECT 1 FROM membership m
                        WHERE m.workspace_id = p_workspace AND m.user_id = p_user AND m.role <> 'client');
      $b$
    $f$;
    EXECUTE $f$
      CREATE OR REPLACE FUNCTION membership_is_owner(p_workspace uuid, p_user uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $b$
        SELECT EXISTS (SELECT 1 FROM membership m
                        WHERE m.workspace_id = p_workspace AND m.user_id = p_user AND m.role = 'owner');
      $b$
    $f$;
  END IF;
END $$;

COMMENT ON FUNCTION membership_is_team(uuid, uuid) IS
  'La persona es del equipo del workspace (no solo lectura ni cliente): recibe los avisos del motor. Con y sin 0034_access_control (0060).';
COMMENT ON FUNCTION membership_is_owner(uuid, uuid) IS
  'La persona es dueña del workspace: recibe las alertas del motor. Con y sin 0034_access_control (0060).';

REVOKE ALL ON FUNCTION membership_is_team(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION membership_is_owner(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION membership_is_team(uuid, uuid) TO mc_app, mc_worker;
GRANT EXECUTE ON FUNCTION membership_is_owner(uuid, uuid) TO mc_app, mc_worker;

UPDATE job_definition SET max_concurrency = 1 WHERE id = 'outbound.dispatch';
