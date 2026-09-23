-- =====================================================================
-- 0041 · La web escribe el resultado de SU campaña: «Recalcular» (CAM-5)
-- ---------------------------------------------------------------------
-- Qué hace:
--   1 · mc_app recibe INSERT y UPDATE (sin DELETE) sobre campaign_result.
--   2 · Dos políticas RESTRICTIVAS, para INSERT y para UPDATE, que atan
--       cada fila que escribe mc_app a una campaña que la transacción ve
--       y que es de su MISMO workspace.
--   3 · El disparador de referencias de 0025 §3 en sus dos claves ajenas
--       (campaign_id → campaign, workspace_id → workspace).
--
-- Por qué:
--   · 0025 §5 le quitó a mc_app la escritura de campaign_result porque
--     «lo consolida el worker». Pero el worker no corre en producción
--     (WRK) y la web no llega a la cola de pg-boss, así que el resultado
--     de producción conservaba las cifras del mock (CPM 11 800) y el
--     botón «Recalcular» de la ficha no podía existir. La acción
--     (recalcularResultado) ya estaba escrita: calcula con la MISMA
--     función que el job (computeCampaignResult) dentro de withWorkspace,
--     y la ficha solo enseña el botón si has_table_privilege lo permite.
--     Esta migración es lo único que le faltaba: no hay bandera nueva.
--   · Es un materializado, no una métrica: el UPSERT reemplaza la fila
--     (ON CONFLICT (campaign_id) DO UPDATE … WHERE workspace_id igual),
--     como hace el worker. Por eso UPDATE sí y DELETE no: nadie borra un
--     resultado desde la web; una campaña borrada se lo lleva en cascada.
--   · La política de 0010 (campaign_result_ws_isolation, FOR ALL con
--     USING, que sirve de WITH CHECK) ya obliga a que workspace_id sea el
--     de la transacción. Lo que no obliga es que campaign_id sea una
--     campaña de ESE workspace: hoy lo cubre la RLS de campaign (que es
--     también de aislamiento puro) a través del disparador de
--     referencias, pero si una historia futura abre la visibilidad de
--     campaign (alcance por membresía de ACC-6, cuentas de agencia), una
--     campaña visible de otro workspace podría recibir una fila con
--     workspace_id propio. Las restrictivas lo dicen en la propia tabla:
--     la campaña existe, se ve y su workspace_id es el de la fila. Solo
--     para mc_app: el worker (mc_worker, BYPASSRLS) no pasa por RLS.
--
-- Compatible con el código de producción (7737b62): ese código ya
-- consulta has_table_privilege('campaign_result', 'INSERT') y
-- ('…', 'UPDATE') en canRecomputeResult. Aplicada la migración ANTES del
-- deploy, la ficha vieja empieza a enseñar «Recalcular» y la acción vieja
-- (requirePermission('campanas.resultado.calcular') + el mismo UPSERT)
-- escribe una fila válida. Nada de lo que ya corre lee o escribe distinto.
--
-- Re-ejecutable: GRANT y REVOKE son idempotentes; DROP POLICY IF EXISTS y
-- DROP TRIGGER IF EXISTS antes de crear.
--
-- Número: 0041 reservada para CAM en docs/cierre-modulos-nicolas-prompts.md
-- (0040 es de ACC-6). No depende de 0040.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · El privilegio: INSERT y UPDATE, nunca DELETE
-- ---------------------------------------------------------------------
-- La tabla no tiene columnas serial (la clave es campaign_id): no hace
-- falta USAGE sobre ninguna secuencia.
GRANT INSERT, UPDATE ON campaign_result TO mc_app;
REVOKE DELETE ON campaign_result FROM mc_app;

-- ---------------------------------------------------------------------
-- 2 · La fila es de una campaña visible de su mismo workspace
-- ---------------------------------------------------------------------
-- RESTRICTIVE: se combinan con AND con campaign_result_ws_isolation
-- (0010), que sigue siendo la permisiva que decide el workspace. El
-- EXISTS corre con los privilegios de quien escribe, así que la RLS de
-- campaign también decide.
DROP POLICY IF EXISTS campaign_result_web_insert ON campaign_result;
CREATE POLICY campaign_result_web_insert ON campaign_result AS RESTRICTIVE FOR INSERT TO mc_app
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM campaign c
       WHERE c.id = campaign_result.campaign_id
         AND c.workspace_id = campaign_result.workspace_id
    )
  );

DROP POLICY IF EXISTS campaign_result_web_update ON campaign_result;
CREATE POLICY campaign_result_web_update ON campaign_result AS RESTRICTIVE FOR UPDATE TO mc_app
  USING (
    EXISTS (
      SELECT 1 FROM campaign c
       WHERE c.id = campaign_result.campaign_id
         AND c.workspace_id = campaign_result.workspace_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM campaign c
       WHERE c.id = campaign_result.campaign_id
         AND c.workspace_id = campaign_result.workspace_id
    )
  );

-- ---------------------------------------------------------------------
-- 3 · El disparador de referencias (0025 §3) en las dos claves ajenas
-- ---------------------------------------------------------------------
-- El bucle de 0025 §7 solo lo enganchó donde mc_app escribía entonces
-- (medido DESPUÉS de quitarle campaign_result). Con el GRANT, la guardia
-- de esquema.ts lo exige («referencia sin comprobar»).
DROP TRIGGER IF EXISTS ref_visible_campaign_id ON campaign_result;
CREATE TRIGGER ref_visible_campaign_id
  BEFORE INSERT OR UPDATE OF campaign_id ON campaign_result
  FOR EACH ROW WHEN (NEW.campaign_id IS NOT NULL)
  EXECUTE FUNCTION assert_reference_visible('campaign_id', 'campaign', 'id');

DROP TRIGGER IF EXISTS ref_visible_workspace_id ON campaign_result;
CREATE TRIGGER ref_visible_workspace_id
  BEFORE INSERT OR UPDATE OF workspace_id ON campaign_result
  FOR EACH ROW WHEN (NEW.workspace_id IS NOT NULL)
  EXECUTE FUNCTION assert_reference_visible('workspace_id', 'workspace', 'id');

COMMENT ON TABLE campaign_result IS
  'Resultado consolidado de una campaña (CAM-5), una fila por campaña, materializado: lo reemplaza el job campaign.compute (mc_worker) cada mañana y «Recalcular» en la ficha (mc_app, 0041: INSERT y UPDATE, sin DELETE, solo sobre una campaña visible de su mismo workspace). missing_inputs dice qué falta para que el reporte sea completo.';
