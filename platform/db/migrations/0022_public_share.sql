-- =====================================================================
-- 0022 · Enlaces públicos de Cotizar: media kit y cotización (COT-2, COT-3, COT-4)
-- (Nació como 0014 en el plan de la fase 2; se numeró al final de la
-- serie porque 0014–0021 ya existen en el repositorio.)
-- ---------------------------------------------------------------------
-- El problema: /kit/<slug> y /cotizacion/<slug> se abren SIN sesión y
-- sin workspace, y media_kit, quote y deal llevan RLS con FORCE. Sin
-- workspace fijado, current_workspace_id() es NULL y la página pública
-- no ve nada; con un workspace fijado desde la URL, cualquiera leería
-- el del vecino. Ninguna de las dos sirve.
--
-- La salida son tres funciones SECURITY DEFINER —la puerta— y unas
-- políticas permisivas acotadas al slug que se está abriendo —la
-- cerradura—. Las dos mitades importan:
--
--   · Cada función fija `app.public_share` al entrar y lo RESTAURA al
--     salir, también si algo lanza (bloque EXCEPTION), así que el
--     permiso no sobrevive a la llamada ni contamina el resto de la
--     transacción. Sería más corto declararlo con la cláusula
--     `SET "app.public_share" = ''` de CREATE FUNCTION, que Postgres
--     restaura solo; no se puede: guardar un parámetro en proconfig
--     pide privilegio sobre ese parámetro, y mc_migrator no es
--     superusuario ('permission denied to set parameter'). En tiempo de
--     ejecución, set_config sobre un parámetro personalizado sí está
--     permitido, y de ahí la forma de abajo.
--   · Las políticas nuevas abren exactamente la fila cuyo slug está en
--     ese parámetro, y solo si está publicada. FORCE hace que la RLS
--     aplique también al dueño de las tablas (mc_migrator), que es
--     quien ejecuta la función: sin políticas, una función SECURITY
--     DEFINER aquí tampoco vería nada. Son la razón por la que la
--     puerta no se puede quedar abierta de par en par por descuido.
--
-- El slug ES la credencial, como en el compartir de Notion o en una
-- factura alojada de Stripe: caracteres aleatorios que no se enumeran.
-- La contraseña opcional se compara por su derivado (scrypt con sal por
-- fila); la contraseña en claro no llega nunca a la base, y el formato
-- del campo es 's1:<sal hex>:<scrypt hex>'.
--
-- Lo que devuelven las funciones es lo justo para pintar la página:
-- jsonb ya congelado, nunca la fila entera.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Columnas nuevas de quote
-- ---------------------------------------------------------------------
-- public_snapshot: lo que la marca vio cuando se le envió la
-- cotización, congelado igual que el media kit. Sin esto la página
-- pública tendría que leer quote_item, company y creator_profile en
-- vivo —tres políticas más— y una edición posterior cambiaría un
-- documento ya enviado.
ALTER TABLE quote ADD COLUMN IF NOT EXISTS public_snapshot jsonb;

-- La ventana de la campaña se acuerda ANTES de publicar, como el resto
-- de lo acordado: es lo que COT-4 le pasa a createCampaignFromQuote()
-- (CAM-2) al aceptar, sin volver a preguntar.
ALTER TABLE quote ADD COLUMN IF NOT EXISTS campaign_starts_on date;
ALTER TABLE quote ADD COLUMN IF NOT EXISTS campaign_ends_on   date;

-- Cuántas veces se abrió el enlace. Mismo contador que el media kit.
ALTER TABLE quote ADD COLUMN IF NOT EXISTS view_count int NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------
-- La cerradura: políticas permisivas acotadas al slug compartido
-- ---------------------------------------------------------------------
-- Se suman (OR) a las de aislamiento por workspace de 0010: el creador
-- sigue viendo lo suyo por la suya, y estas solo abren la fila cuyo
-- slug está en app.public_share.
CREATE POLICY media_kit_public_share ON media_kit
  FOR SELECT
  USING (is_public AND slug = nullif(current_setting('app.public_share', true), ''));

-- El contador de vistas. WITH CHECK con la misma condición: la fila no
-- puede dejar de ser la compartida por culpa del UPDATE.
CREATE POLICY media_kit_public_share_views ON media_kit
  FOR UPDATE
  USING (is_public AND slug = nullif(current_setting('app.public_share', true), ''))
  WITH CHECK (is_public AND slug = nullif(current_setting('app.public_share', true), ''));

-- Un borrador no tiene enlace: el slug existe desde que se crea la
-- cotización, pero hasta enviarla no abre nada.
CREATE POLICY quote_public_share ON quote
  FOR SELECT
  USING (status <> 'draft' AND slug = nullif(current_setting('app.public_share', true), ''));

-- Marcar vista, vencida o aceptada.
CREATE POLICY quote_public_share_state ON quote
  FOR UPDATE
  USING (status <> 'draft' AND slug = nullif(current_setting('app.public_share', true), ''))
  WITH CHECK (status <> 'draft' AND slug = nullif(current_setting('app.public_share', true), ''));

-- El deal de esa cotización, para pasarlo a «Ganado» al aceptar. La
-- subconsulta corre bajo la RLS de quien pregunta, así que la política
-- de arriba es la que decide qué cotización cuenta.
CREATE POLICY deal_public_share ON deal
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM quote q
                 WHERE q.deal_id = deal.id
                   AND q.slug = nullif(current_setting('app.public_share', true), '')));

CREATE POLICY deal_public_share_won ON deal
  FOR UPDATE
  USING (EXISTS (SELECT 1 FROM quote q
                 WHERE q.deal_id = deal.id
                   AND q.slug = nullif(current_setting('app.public_share', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM quote q
                      WHERE q.deal_id = deal.id
                        AND q.slug = nullif(current_setting('app.public_share', true), '')));

-- deal_stage_history hereda de deal por la política de 0018 (EXISTS
-- sobre el padre), así que la fila del cambio de etapa entra sin
-- política propia.

-- ---------------------------------------------------------------------
-- La puerta: tres funciones, una por acción pública
-- ---------------------------------------------------------------------

-- Media kit. Sin contraseña devuelve el snapshot y suma una vista; con
-- contraseña, primero pide el derivado (devolviendo la sal) y solo
-- entrega el snapshot cuando coincide.
--
--   {"status":"not_found"}
--   {"status":"expired","expiresAt":"…"}
--   {"status":"password_required","algo":"s1","salt":"…"}
--   {"status":"password_invalid","algo":"s1","salt":"…"}
--   {"status":"ok","slug":"…","snapshot":{…},"viewCount":12,"createdAt":"…"}
-- El cuerpo va en una función aparte para que el envoltorio de abajo
-- pueda restaurar app.public_share en un solo sitio, salga por donde
-- salga. Nadie más que el envoltorio la puede ejecutar.
CREATE FUNCTION public_media_kit_impl(p_slug text, p_password_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  k record;
BEGIN
  SELECT id, slug, snapshot, password_hash, expires_at, view_count, created_at
    INTO k
    FROM media_kit
   WHERE slug = p_slug;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF k.expires_at IS NOT NULL AND k.expires_at <= now() THEN
    RETURN jsonb_build_object('status', 'expired', 'expiresAt', to_jsonb(k.expires_at));
  END IF;

  IF k.password_hash IS NOT NULL THEN
    IF p_password_hash IS NULL THEN
      RETURN jsonb_build_object('status', 'password_required',
                                'algo', split_part(k.password_hash, ':', 1),
                                'salt', split_part(k.password_hash, ':', 2));
    END IF;
    -- La comparación es sobre el derivado; la contraseña no llega aquí.
    IF p_password_hash <> k.password_hash THEN
      RETURN jsonb_build_object('status', 'password_invalid',
                                'algo', split_part(k.password_hash, ':', 1),
                                'salt', split_part(k.password_hash, ':', 2));
    END IF;
  END IF;

  UPDATE media_kit SET view_count = view_count + 1 WHERE id = k.id;

  RETURN jsonb_build_object(
    'status', 'ok',
    'slug', k.slug,
    'snapshot', k.snapshot,
    'viewCount', k.view_count + 1,
    'createdAt', to_jsonb(k.created_at));
END;
$$;

CREATE FUNCTION public_media_kit(p_slug text, p_password_hash text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  anterior text := coalesce(current_setting('app.public_share', true), '');
  r jsonb;
BEGIN
  IF p_slug IS NULL OR length(p_slug) = 0 OR length(p_slug) > 120 THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  PERFORM set_config('app.public_share', p_slug, true);
  BEGIN
    r := public_media_kit_impl(p_slug, p_password_hash);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.public_share', anterior, true);
    RAISE;
  END;
  PERFORM set_config('app.public_share', anterior, true);
  RETURN r;
END;
$$;

-- Cotización. Marca 'viewed' la primera vez que la marca abre el
-- enlace, y 'expired' cuando se pasó la fecha de validez.
--
--   {"status":"not_found"}
--   {"status":"ok","quote":{…}}   con quote.status 'sent'|'viewed'|'accepted'|'rejected'|'expired'
CREATE FUNCTION public_quote_impl(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  q record;
  nuevo_estado text;
BEGIN
  SELECT id, slug, number, status, public_snapshot, valid_until, sent_at, viewed_at, accepted_at
    INTO q
    FROM quote
   WHERE slug = p_slug;

  IF NOT FOUND OR q.public_snapshot IS NULL THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  nuevo_estado := q.status;
  IF q.status IN ('sent', 'viewed') AND q.valid_until IS NOT NULL AND q.valid_until < CURRENT_DATE THEN
    nuevo_estado := 'expired';
    UPDATE quote SET status = 'expired', view_count = view_count + 1 WHERE id = q.id;
  ELSIF q.status = 'sent' THEN
    nuevo_estado := 'viewed';
    UPDATE quote
       SET status = 'viewed', viewed_at = coalesce(viewed_at, now()), view_count = view_count + 1
     WHERE id = q.id;
  ELSE
    UPDATE quote SET view_count = view_count + 1 WHERE id = q.id;
  END IF;

  RETURN jsonb_build_object(
    'status', 'ok',
    'quote', q.public_snapshot
             || jsonb_build_object(
                  'slug', q.slug,
                  'number', q.number,
                  'status', nuevo_estado,
                  'validUntil', to_jsonb(q.valid_until),
                  'sentAt', to_jsonb(q.sent_at),
                  'viewedAt', to_jsonb(coalesce(q.viewed_at, now())),
                  'acceptedAt', to_jsonb(q.accepted_at)));
END;
$$;

CREATE FUNCTION public_quote(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  anterior text := coalesce(current_setting('app.public_share', true), '');
  r jsonb;
BEGIN
  IF p_slug IS NULL OR length(p_slug) = 0 OR length(p_slug) > 120 THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  PERFORM set_config('app.public_share', p_slug, true);
  BEGIN
    r := public_quote_impl(p_slug);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.public_share', anterior, true);
    RAISE;
  END;
  PERFORM set_config('app.public_share', anterior, true);
  RETURN r;
END;
$$;

-- Aceptar. Deja la cotización en 'accepted' y su deal en «Ganado», con
-- su fila de historial, todo en la transacción de quien llama.
--
-- NO crea la campaña: eso es createCampaignFromQuote() (CAM-2), que es
-- TypeScript y corre con el workspace del creador. La respuesta trae
-- 'campaignPending' para que la interfaz lo diga con esas palabras.
--
--   {"status":"not_found"}
--   {"status":"not_acceptable","quoteStatus":"accepted"}
--   {"status":"ok","quoteId":"…","dealId":"…","acceptedAt":"…","campaignPending":true}
CREATE FUNCTION public_quote_accept_impl(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  q record;
  d record;
  ultimo timestamptz;
  ahora timestamptz := now();
BEGIN
  SELECT id, status, deal_id, valid_until, public_snapshot
    INTO q
    FROM quote
   WHERE slug = p_slug
     FOR UPDATE;

  IF NOT FOUND OR q.public_snapshot IS NULL THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF q.status NOT IN ('sent', 'viewed') THEN
    RETURN jsonb_build_object('status', 'not_acceptable', 'quoteStatus', q.status);
  END IF;
  IF q.valid_until IS NOT NULL AND q.valid_until < CURRENT_DATE THEN
    UPDATE quote SET status = 'expired' WHERE id = q.id;
    RETURN jsonb_build_object('status', 'not_acceptable', 'quoteStatus', 'expired');
  END IF;

  UPDATE quote SET status = 'accepted', accepted_at = ahora WHERE id = q.id;

  IF q.deal_id IS NOT NULL THEN
    SELECT id, stage_id, won_at INTO d FROM deal WHERE id = q.deal_id FOR UPDATE;
    IF FOUND AND d.stage_id <> 'ganado' THEN
      SELECT max(changed_at) INTO ultimo FROM deal_stage_history WHERE deal_id = d.id;
      INSERT INTO deal_stage_history (deal_id, from_stage_id, to_stage_id, changed_at, days_in_stage)
      VALUES (d.id, d.stage_id, 'ganado', ahora,
              CASE WHEN ultimo IS NULL THEN NULL
                   ELSE round((extract(epoch FROM (ahora - ultimo)) / 86400)::numeric, 2) END);
      UPDATE deal
         SET stage_id = 'ganado', probability = NULL, won_at = coalesce(won_at, ahora), lost_at = NULL
       WHERE id = d.id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status', 'ok',
    'quoteId', to_jsonb(q.id),
    'dealId', to_jsonb(q.deal_id),
    'acceptedAt', to_jsonb(ahora),
    'campaignPending', true);
END;
$$;

CREATE FUNCTION public_quote_accept(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  anterior text := coalesce(current_setting('app.public_share', true), '');
  r jsonb;
BEGIN
  IF p_slug IS NULL OR length(p_slug) = 0 OR length(p_slug) > 120 THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  PERFORM set_config('app.public_share', p_slug, true);
  BEGIN
    r := public_quote_accept_impl(p_slug);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.public_share', anterior, true);
    RAISE;
  END;
  PERFORM set_config('app.public_share', anterior, true);
  RETURN r;
END;
$$;

-- La web las llama como mc_app, desde una transacción SIN workspace.
-- Los cuerpos (_impl) no: solo el envoltorio, que es quien restaura el
-- parámetro, y que al ser SECURITY DEFINER los puede llamar.
REVOKE ALL ON FUNCTION public_media_kit_impl(text, text)   FROM PUBLIC;
REVOKE ALL ON FUNCTION public_quote_impl(text)             FROM PUBLIC;
REVOKE ALL ON FUNCTION public_quote_accept_impl(text)      FROM PUBLIC;
REVOKE ALL ON FUNCTION public_media_kit(text, text)  FROM PUBLIC;
REVOKE ALL ON FUNCTION public_quote(text)            FROM PUBLIC;
REVOKE ALL ON FUNCTION public_quote_accept(text)     FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_media_kit(text, text) TO mc_app;
GRANT EXECUTE ON FUNCTION public_quote(text)           TO mc_app;
GRANT EXECUTE ON FUNCTION public_quote_accept(text)    TO mc_app;

-- El enlace se busca por slug en cada visita.
CREATE INDEX IF NOT EXISTS quote_slug_idx ON quote (slug);
