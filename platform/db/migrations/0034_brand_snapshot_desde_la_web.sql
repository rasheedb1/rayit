-- =====================================================================
-- 0034 · Seguidores de la marca por campaña y «Actualizar ahora» desde la web (CAM-3)
-- ---------------------------------------------------------------------
-- Qué hace:
--   1 · la unicidad de brand_account_snapshot pasa a ser POR CAMPAÑA:
--       (campaign_id, platform_id, day) para las filas con campaña y
--       (company_id, platform_id, day) solo para las filas sin campaña
--       (el seed de demostración). Antes era (company_id, platform_id,
--       day) para todas.
--   2 · mc_app recibe INSERT (y solo INSERT) sobre la tabla, con una
--       política que exige que la fila cuelgue de una campaña visible y
--       de su misma empresa, el USAGE de la secuencia del id y el
--       disparador de referencias de 0025 §3 en sus dos claves ajenas.
--
-- Por qué:
--   · La ficha de campaña ofrece «Actualizar ahora»: leer la fuente
--     pública de la marca en el momento y dejar el snapshot del día con
--     el MISMO INSERT que el job brand.snapshot (ON CONFLICT DO NOTHING:
--     la primera lectura del día queda). Hasta aquí mc_app solo tenía
--     SELECT (0024 §7.2) y la política de INSERT de 0029 era TO
--     CURRENT_USER (el seed). Es el reparto de account_metric_snapshot
--     desde CON-10 (0025 §5): la web añade, nunca corrige ni borra; el
--     worker (mc_worker, BYPASSRLS) es quien mide y quien reemplaza.
--   · Un único global sobre (company_id, platform_id, day) no aísla en
--     cuanto mc_app escribe: company tiene filas de catálogo (sin dueño,
--     0025) que ven todos los workspaces, así que dos campañas de dos
--     workspaces sobre la misma marca del catálogo chocarían en la misma
--     fila (el 23505 no pasa por RLS: 0026 §2), y la lectura de uno
--     quedaría bajo la campaña del otro, invisible para el primero. Con
--     la unicidad por campaña cada fila cuelga de UNA campaña, RLS la
--     aísla por ella, y una marca en varias campañas del mismo workspace
--     se lee por empresa a través de sus campañas visibles (DISTINCT ON
--     day): la segunda campaña reutiliza la historia de la primera.
--     El job hace UNA llamada por (workspace, empresa, red, handle) y
--     deja una fila por campaña en ventana.
--
-- Re-ejecutable: DROP … IF EXISTS, CREATE … IF NOT EXISTS, GRANT es
-- idempotente. El seed 0003 inserta con ON CONFLICT DO NOTHING sin
-- objetivo, así que sirve con la unicidad vieja y con la nueva.
--
-- Numeración: 0033 es la más alta en todas las ramas al 23-sep-2026
-- (0023 sigue reservada para ACC). En Supabase van aplicadas hasta 0022:
-- esta entra en la cola del integrador detrás de 0024–0033.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · La unicidad es por campaña
-- ---------------------------------------------------------------------
ALTER TABLE brand_account_snapshot DROP CONSTRAINT IF EXISTS brand_account_snapshot_company_id_platform_id_day_key;

CREATE UNIQUE INDEX IF NOT EXISTS brand_account_snapshot_campaign_day_idx
  ON brand_account_snapshot (campaign_id, platform_id, day)
  WHERE campaign_id IS NOT NULL;

-- Las filas sin campaña son las del seed de demostración (0029: TO
-- CURRENT_USER); mc_app no las escribe (la política de abajo exige
-- campaign_id). Siguen deduplicándose entre sí por empresa y día.
CREATE UNIQUE INDEX IF NOT EXISTS brand_account_snapshot_catalog_day_idx
  ON brand_account_snapshot (company_id, platform_id, day)
  WHERE campaign_id IS NULL;

-- ---------------------------------------------------------------------
-- 2 · El privilegio: INSERT, y nada más
-- ---------------------------------------------------------------------
GRANT INSERT ON brand_account_snapshot TO mc_app;
REVOKE UPDATE, DELETE ON brand_account_snapshot FROM mc_app;

-- La columna id es bigserial: insertar necesita USAGE sobre su secuencia
-- (0026 §4 se lo quitó a mc_app donde no insertaba). SELECT no: last_value
-- es el volumen de toda la plataforma. El id no se devuelve a la web
-- (CIM-2 §3): la consulta pide RETURNING 1.
GRANT USAGE ON SEQUENCE brand_account_snapshot_id_seq TO mc_app;

-- ---------------------------------------------------------------------
-- 3 · La política: una fila cuelga de una campaña que se ve, y es de su empresa
-- ---------------------------------------------------------------------
-- Sin la rama «campaign_id IS NULL»: desde la web toda lectura la pide
-- una campaña (la rama global es del seed, 0029, y sigue TO CURRENT_USER).
-- El EXISTS corre con los privilegios de quien inserta, así que la RLS
-- de campaign decide el workspace; y company_id tiene que ser el de esa
-- campaña para que nadie deje una lectura de una marca bajo la campaña
-- de otra.
DROP POLICY IF EXISTS brand_account_snapshot_write ON brand_account_snapshot;
CREATE POLICY brand_account_snapshot_write ON brand_account_snapshot FOR INSERT TO mc_app
  WITH CHECK (
    campaign_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM campaign p
       WHERE p.id = brand_account_snapshot.campaign_id
         AND p.company_id = brand_account_snapshot.company_id
    )
  );

-- ---------------------------------------------------------------------
-- 4 · El disparador de referencias (0025 §3) en las dos claves ajenas
-- ---------------------------------------------------------------------
-- El bucle de 0025 §7 solo lo enganchó donde mc_app escribía entonces, y
-- brand_account_snapshot estaba cerrada. Con el INSERT, una fila no puede
-- nombrar una campaña ni una empresa que la transacción no ve (la guardia
-- de esquema.ts lo exige: «referencia sin comprobar»).
DROP TRIGGER IF EXISTS ref_visible_campaign_id ON brand_account_snapshot;
CREATE TRIGGER ref_visible_campaign_id
  BEFORE INSERT OR UPDATE OF campaign_id ON brand_account_snapshot
  FOR EACH ROW WHEN (NEW.campaign_id IS NOT NULL)
  EXECUTE FUNCTION assert_reference_visible('campaign_id', 'campaign', 'id');

DROP TRIGGER IF EXISTS ref_visible_company_id ON brand_account_snapshot;
CREATE TRIGGER ref_visible_company_id
  BEFORE INSERT OR UPDATE OF company_id ON brand_account_snapshot
  FOR EACH ROW WHEN (NEW.company_id IS NOT NULL)
  EXECUTE FUNCTION assert_reference_visible('company_id', 'company', 'id');

COMMENT ON TABLE brand_account_snapshot IS
  'Seguidores públicos de la marca por día (CAM-3). Una fila por (campaña, red, día); la escribe el worker brand.snapshot y la web con «Actualizar ahora» (solo INSERT, ON CONFLICT DO NOTHING). followers NULL con source not_found / not_discoverable / no_public_source: ese día no hubo cifra, y la razón. Sin campaña: solo el seed.';
