-- =====================================================================
-- 0018 · RLS en las tablas hijas de una tabla de tenant (CIM-2, ronda 2)
-- ---------------------------------------------------------------------
-- 0010, 0011 y 0017 aíslan por workspace las tablas que tienen
-- workspace_id. Las hijas que no lo tienen —quote_item, rate_card_item,
-- deal_stage_history, campaign_post y las del laboratorio de video—
-- quedaron legibles y escribibles desde cualquier workspace y sin
-- workspace fijado: desde el workspace B se leían los precios unitarios
-- de las cotizaciones y del tarifario de A, y el historial de etapas de
-- sus deals. packages/db/test/rls.test.ts lo reproduce; esta migración
-- lo cierra.
--
-- La política no repite workspace_id: comprueba que el padre exista.
-- La subconsulta corre con los privilegios de quien consulta, así que
-- la RLS del padre decide: si no ves la cotización, no ves sus ítems ni
-- puedes insertar uno que apunte a ella (sin WITH CHECK explícito, la
-- escritura usa la misma condición que USING). mc_worker sigue
-- saltándola por BYPASSRLS. FORCE hace que aplique también al dueño de
-- la tabla (mc_migrator), igual que en 0010.
--
-- Entran las hijas cuya FK al padre es NOT NULL. Las que la tienen
-- opcional (brand_account_snapshot, trait_lift, external_post,
-- api_call_log, api_quota_usage) tienen filas sin padre por diseño y
-- su política la decide el dueño del módulo; la prueba
-- packages/db/test/schema.test.ts las deja a la vista en cada corrida.
-- =====================================================================

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('quote_item',            'quote_id',     'quote'),
      ('rate_card_item',        'rate_card_id', 'rate_card'),
      ('deal_stage_history',    'deal_id',      'deal'),
      ('campaign_post',         'campaign_id',  'campaign'),
      ('idea_evidence',         'idea_id',      'idea'),
      ('posting_window',        'creator_id',   'creator_profile'),
      ('script_block',          'script_id',    'script'),
      ('script_variant',        'script_id',    'script'),
      ('preflight_result',      'analysis_id',  'video_analysis'),
      ('preflight_verdict',     'analysis_id',  'video_analysis'),
      ('video_audio_profile',   'analysis_id',  'video_analysis'),
      ('video_feature',         'analysis_id',  'video_analysis'),
      ('video_onscreen_text',   'analysis_id',  'video_analysis'),
      ('video_prediction',      'analysis_id',  'video_analysis'),
      ('video_recommendation',  'analysis_id',  'video_analysis'),
      ('video_second',          'analysis_id',  'video_analysis'),
      ('video_shot',            'analysis_id',  'video_analysis'),
      ('video_transcript',      'analysis_id',  'video_analysis'),
      ('video_transcript_word', 'analysis_id',  'video_analysis')
    ) AS t(child, fk, parent)
  LOOP
    -- Guardias: la columna existe y es NOT NULL, y el padre ya tiene RLS.
    -- Mejor fallar aquí que dejar una política que no aísla.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = r.child
        AND column_name = r.fk AND is_nullable = 'NO'
    ) THEN
      RAISE EXCEPTION 'La columna %.% no existe o admite NULL: no puede heredar la RLS de %', r.child, r.fk, r.parent;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = r.parent AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'La tabla padre % no tiene RLS: % no puede heredarla', r.parent, r.child;
    END IF;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.child);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.child);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (EXISTS (SELECT 1 FROM %I p WHERE p.id = %I.%I))',
      r.child || '_ws_isolation', r.child, r.parent, r.child, r.fk);
  END LOOP;
END $$;

-- quote_item era la única hija sin índice por su FK: la política la
-- consulta por fila y las pantallas de Cotizar leen los ítems por
-- cotización.
CREATE INDEX IF NOT EXISTS quote_item_quote_id_idx ON quote_item (quote_id, position);
