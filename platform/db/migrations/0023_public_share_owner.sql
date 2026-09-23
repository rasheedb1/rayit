-- =====================================================================
-- 0023 · El enlace público corre con su propio rol (COT-2, COT-3, COT-4)
-- ---------------------------------------------------------------------
-- Qué estaba mal en 0022. Las seis políticas del enlace público no
-- llevaban cláusula TO, así que valían para CUALQUIER rol, también
-- mc_app. Cualquier transacción de la aplicación que hiciera
--
--     SELECT set_config('app.public_share', '<slug>', true);
--
-- sin pasar por las funciones podía leer el deal entero y reescribir
-- cualquier columna de la cotización (total, status, public_snapshot) y
-- del deal (name, amount, stage_id), y también el snapshot «congelado»
-- del media kit. La revisión lo reprodujo en PGlite como mc_app. La
-- puerta (las funciones SECURITY DEFINER) estaba bien; la cerradura
-- (las políticas) estaba abierta para todos.
--
-- Qué cambia:
--
--   1 · Un rol nuevo, mc_public_share: NOLOGIN, sin BYPASSRLS, y con
--       privilegios de COLUMNA, los justos para las tres acciones
--       públicas (sumar una visita, marcar vista, vencida o aceptada,
--       pasar el deal a «Ganado» con su historial). Aunque una de estas
--       funciones tuviera un error, no podría tocar el total de una
--       cotización ni el nombre de un deal: Postgres se lo niega.
--   2 · Las funciones son de mc_public_share (ALTER … OWNER), así que
--       dentro de ellas current_user es mc_public_share y no el dueño
--       de las tablas.
--   3 · Las seis políticas se recrean con `TO mc_public_share`. Para
--       mc_app el parámetro app.public_share vuelve a no significar
--       nada: la prueba «la sonda» de packages/db/test/cotizar.test.ts
--       lo fija.
--
-- Y, ya que las funciones se recrean, lo que la revisión pidió de ellas:
--
--   · public_media_kit y public_quote reciben p_count: la vista previa
--     del panel y los robots que desenrollan enlaces (WhatsApp, Slack)
--     no cuentan como visita ni marcan la cotización como vista.
--   · public_media_kit bloquea 15 minutos tras 10 contraseñas fallidas
--     (failed_attempts, locked_until) y compara los derivados por su
--     sha256, no con `<>` sobre el texto: la comparación ya no filtra
--     cuántos caracteres del derivado guardado coinciden.
--   · public_quote_accept pide nombre y correo de quien acepta, los
--     guarda (accepted_by_name, accepted_by_email) y devuelve el
--     workspace de la cotización —un dato de la base, no del
--     navegador— para que el servidor cree la campaña (COT-4).
--   · rejected_at y expired_at: el ciclo draft → sent → viewed →
--     accepted / rejected / expired queda con una fecha por estado.
--   · El vencimiento se cuenta en la zona del workspace (la que viaja en
--     public_snapshot), no en UTC.
--
-- 0022 no se toca: todavía no está aplicada en Supabase y el integrador
-- puede aplicarlas juntas. Esta migración deja el resultado final igual
-- que si 0022 hubiera nacido así.
--
-- REQUISITO EN SUPABASE (mc_migrator no tiene CREATEROLE, a propósito):
--
--   ./scripts/supabase-admin.sh sql "CREATE ROLE mc_public_share NOLOGIN NOINHERIT; GRANT mc_public_share TO mc_migrator; GRANT USAGE, CREATE ON SCHEMA public TO mc_public_share"
--
-- La membresía hace falta para `ALTER FUNCTION … OWNER TO` (quien
-- cambia el dueño tiene que poder ser el dueño nuevo), y CREATE en
-- public también (el dueño de una función tiene que poder crearla en
-- su esquema). En PGlite de pruebas, en `make db.check` y en el
-- Postgres del CI la migración corre como superusuario o el embebido
-- crea el rol antes (packages/db/src/embedded.ts), así que se verifica
-- sin ese paso.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · El rol
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mc_public_share') THEN
    BEGIN
      CREATE ROLE mc_public_share NOLOGIN NOINHERIT;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION USING
        MESSAGE = 'Falta el rol mc_public_share y este usuario no puede crearlo.',
        HINT = './scripts/supabase-admin.sh sql "CREATE ROLE mc_public_share NOLOGIN NOINHERIT; '
               'GRANT mc_public_share TO mc_migrator; GRANT USAGE, CREATE ON SCHEMA public TO mc_public_share"';
    END;
  END IF;
  -- Guardia: si alguien lo creó a mano con más poder del debido, parar.
  IF EXISTS (SELECT 1 FROM pg_roles
              WHERE rolname = 'mc_public_share'
                AND (rolbypassrls OR rolsuper OR rolcanlogin OR rolcreaterole)) THEN
    RAISE EXCEPTION 'mc_public_share tiene que ser NOLOGIN, sin BYPASSRLS, sin SUPERUSER y sin CREATEROLE.';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO mc_public_share;
-- Solo mientras dura esta migración: el dueño de una función necesita
-- CREATE en su esquema para recibirla. Se revoca al final.
GRANT CREATE ON SCHEMA public TO mc_public_share;

-- ---------------------------------------------------------------------
-- 2 · Columnas nuevas
-- ---------------------------------------------------------------------
-- La tasa con la que se calculó el impuesto, para que el detalle diga
-- «Impuesto (19 %)» sin dividir tax entre la base en la pantalla.
ALTER TABLE quote ADD COLUMN IF NOT EXISTS tax_rate numeric(7,6)
  CHECK (tax_rate IS NULL OR (tax_rate >= 0 AND tax_rate <= 1));

-- Una fecha por estado: sent_at, viewed_at y accepted_at ya existían.
ALTER TABLE quote ADD COLUMN IF NOT EXISTS rejected_at timestamptz;
ALTER TABLE quote ADD COLUMN IF NOT EXISTS expired_at  timestamptz;

-- Quién dijo que sí. Es la prueba que Bonsai y HoneyBook piden antes de
-- aceptar: un documento que da pie a una factura necesita un nombre.
ALTER TABLE quote ADD COLUMN IF NOT EXISTS accepted_by_name  text
  CHECK (accepted_by_name IS NULL OR length(accepted_by_name) BETWEEN 1 AND 120);
ALTER TABLE quote ADD COLUMN IF NOT EXISTS accepted_by_email text
  CHECK (accepted_by_email IS NULL OR (length(accepted_by_email) <= 254 AND accepted_by_email LIKE '%_@_%'));

-- El límite de intentos de contraseña del media kit.
ALTER TABLE media_kit ADD COLUMN IF NOT EXISTS failed_attempts int NOT NULL DEFAULT 0;
ALTER TABLE media_kit ADD COLUMN IF NOT EXISTS locked_until    timestamptz;

-- El aviso al creador cuando la marca acepta desde el enlace. Se añade
-- un valor al CHECK de 0009; los demás quedan igual.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check CHECK (kind IN
  ('outlier','breakout','signal','deal_due','deal_overdue',
   'payment_received','invoice_overdue','connection_error',
   'analysis_ready','report_sent','trend','quote_accepted'));

-- ---------------------------------------------------------------------
-- 3 · Lo único que mc_public_share puede tocar
-- ---------------------------------------------------------------------
GRANT SELECT ON media_kit, quote, deal, deal_stage_history TO mc_public_share;
GRANT UPDATE (view_count, failed_attempts, locked_until) ON media_kit TO mc_public_share;
GRANT UPDATE (status, viewed_at, accepted_at, expired_at, view_count,
              accepted_by_name, accepted_by_email) ON quote TO mc_public_share;
GRANT UPDATE (stage_id, probability, won_at, lost_at) ON deal TO mc_public_share;
GRANT INSERT ON deal_stage_history TO mc_public_share;
GRANT USAGE ON SEQUENCE deal_stage_history_id_seq TO mc_public_share;

-- ---------------------------------------------------------------------
-- 4 · La cerradura, ahora con dueño
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS media_kit_public_share       ON media_kit;
DROP POLICY IF EXISTS media_kit_public_share_views ON media_kit;
DROP POLICY IF EXISTS quote_public_share           ON quote;
DROP POLICY IF EXISTS quote_public_share_state     ON quote;
DROP POLICY IF EXISTS deal_public_share            ON deal;
DROP POLICY IF EXISTS deal_public_share_won        ON deal;

CREATE POLICY media_kit_public_share ON media_kit
  FOR SELECT TO mc_public_share
  USING (is_public AND slug = nullif(current_setting('app.public_share', true), ''));

CREATE POLICY media_kit_public_share_views ON media_kit
  FOR UPDATE TO mc_public_share
  USING (is_public AND slug = nullif(current_setting('app.public_share', true), ''))
  WITH CHECK (is_public AND slug = nullif(current_setting('app.public_share', true), ''));

CREATE POLICY quote_public_share ON quote
  FOR SELECT TO mc_public_share
  USING (status <> 'draft' AND slug = nullif(current_setting('app.public_share', true), ''));

CREATE POLICY quote_public_share_state ON quote
  FOR UPDATE TO mc_public_share
  USING (status <> 'draft' AND slug = nullif(current_setting('app.public_share', true), ''))
  WITH CHECK (status <> 'draft' AND slug = nullif(current_setting('app.public_share', true), ''));

CREATE POLICY deal_public_share ON deal
  FOR SELECT TO mc_public_share
  USING (EXISTS (SELECT 1 FROM quote q
                 WHERE q.deal_id = deal.id
                   AND q.slug = nullif(current_setting('app.public_share', true), '')));

CREATE POLICY deal_public_share_won ON deal
  FOR UPDATE TO mc_public_share
  USING (EXISTS (SELECT 1 FROM quote q
                 WHERE q.deal_id = deal.id
                   AND q.slug = nullif(current_setting('app.public_share', true), '')))
  WITH CHECK (EXISTS (SELECT 1 FROM quote q
                      WHERE q.deal_id = deal.id
                        AND q.slug = nullif(current_setting('app.public_share', true), '')));

-- deal_stage_history sigue heredando de deal por la política de 0018,
-- que no tiene TO: su EXISTS sobre deal corre como mc_public_share y
-- es deal_public_share la que decide.

-- ---------------------------------------------------------------------
-- 5 · La puerta, recreada
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public_media_kit(text, text);
DROP FUNCTION IF EXISTS public_media_kit_impl(text, text);
DROP FUNCTION IF EXISTS public_quote(text);
DROP FUNCTION IF EXISTS public_quote_impl(text);
DROP FUNCTION IF EXISTS public_quote_accept(text);
DROP FUNCTION IF EXISTS public_quote_accept_impl(text);

-- El día de hoy en una zona, sin que un nombre de zona raro tire la
-- función: si no se reconoce, UTC.
CREATE FUNCTION public_share_today(p_timezone text)
RETURNS date
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN (now() AT TIME ZONE coalesce(nullif(p_timezone, ''), 'UTC'))::date;
EXCEPTION WHEN invalid_parameter_value THEN
  RETURN (now() AT TIME ZONE 'UTC')::date;
END;
$$;

-- Media kit.
--
--   {"status":"not_found"}
--   {"status":"expired","expiresAt":"…"}
--   {"status":"locked","lockedUntil":"…"}
--   {"status":"password_required","algo":"s1","salt":"…"}
--   {"status":"password_invalid","algo":"s1","salt":"…","attemptsLeft":7}
--   {"status":"ok","slug":"…","snapshot":{…},"viewCount":12,"createdAt":"…"}
CREATE FUNCTION public_media_kit_impl(p_slug text, p_password_hash text, p_count boolean)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  max_intentos constant int := 10;
  bloqueo constant interval := interval '15 minutes';
  k record;
  intentos int;
  vistas int;
BEGIN
  SELECT id, slug, snapshot, password_hash, expires_at, view_count, created_at, failed_attempts, locked_until
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
    IF k.locked_until IS NOT NULL AND k.locked_until > now() THEN
      RETURN jsonb_build_object('status', 'locked', 'lockedUntil', to_jsonb(k.locked_until));
    END IF;
    IF p_password_hash IS NULL THEN
      RETURN jsonb_build_object('status', 'password_required',
                                'algo', split_part(k.password_hash, ':', 1),
                                'salt', split_part(k.password_hash, ':', 2));
    END IF;
    -- Se comparan los sha256 de los dos derivados: el tiempo de la
    -- comparación depende de un resumen que quien ataca no controla,
    -- no de cuántos caracteres del derivado guardado acertó.
    IF sha256(convert_to(p_password_hash, 'UTF8')) <> sha256(convert_to(k.password_hash, 'UTF8')) THEN
      -- Un bloqueo que ya venció empieza la cuenta de cero.
      intentos := CASE WHEN k.locked_until IS NOT NULL THEN 1 ELSE k.failed_attempts + 1 END;
      IF intentos >= max_intentos THEN
        UPDATE media_kit SET failed_attempts = 0, locked_until = now() + bloqueo WHERE id = k.id;
        RETURN jsonb_build_object('status', 'locked', 'lockedUntil', to_jsonb(now() + bloqueo));
      END IF;
      UPDATE media_kit SET failed_attempts = intentos, locked_until = NULL WHERE id = k.id;
      RETURN jsonb_build_object('status', 'password_invalid',
                                'algo', split_part(k.password_hash, ':', 1),
                                'salt', split_part(k.password_hash, ':', 2),
                                'attemptsLeft', max_intentos - intentos);
    END IF;
    IF k.failed_attempts > 0 OR k.locked_until IS NOT NULL THEN
      UPDATE media_kit SET failed_attempts = 0, locked_until = NULL WHERE id = k.id;
    END IF;
  END IF;

  vistas := k.view_count;
  IF p_count THEN
    UPDATE media_kit SET view_count = view_count + 1 WHERE id = k.id RETURNING view_count INTO vistas;
  END IF;

  RETURN jsonb_build_object(
    'status', 'ok',
    'slug', k.slug,
    'snapshot', k.snapshot,
    'viewCount', vistas,
    'createdAt', to_jsonb(k.created_at));
END;
$$;

CREATE FUNCTION public_media_kit(p_slug text, p_password_hash text DEFAULT NULL, p_count boolean DEFAULT true)
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
    r := public_media_kit_impl(p_slug, p_password_hash, coalesce(p_count, true));
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.public_share', anterior, true);
    RAISE;
  END;
  PERFORM set_config('app.public_share', anterior, true);
  RETURN r;
END;
$$;

-- Cotización. Con p_count la primera visita la marca como vista; sin
-- él (vista previa, robots) solo se lee. El vencimiento se aplica
-- siempre: es un hecho del calendario, no de quién mira.
--
--   {"status":"not_found"}
--   {"status":"ok","quote":{…}}
CREATE FUNCTION public_quote_impl(p_slug text, p_count boolean)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  q record;
  nuevo_estado text;
  visto timestamptz;
  vencida timestamptz;
BEGIN
  SELECT id, slug, number, status, public_snapshot, valid_until, sent_at, viewed_at, accepted_at,
         rejected_at, expired_at, accepted_by_name
    INTO q
    FROM quote
   WHERE slug = p_slug;

  IF NOT FOUND OR q.public_snapshot IS NULL THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  nuevo_estado := q.status;
  visto := q.viewed_at;
  vencida := q.expired_at;

  IF q.status IN ('sent', 'viewed') AND q.valid_until IS NOT NULL
     AND q.valid_until < public_share_today(q.public_snapshot->>'timezone') THEN
    nuevo_estado := 'expired';
    vencida := coalesce(q.expired_at, now());
    UPDATE quote
       SET status = 'expired', expired_at = vencida,
           view_count = view_count + CASE WHEN p_count THEN 1 ELSE 0 END
     WHERE id = q.id;
  ELSIF p_count AND q.status = 'sent' THEN
    nuevo_estado := 'viewed';
    visto := coalesce(q.viewed_at, now());
    UPDATE quote SET status = 'viewed', viewed_at = visto, view_count = view_count + 1 WHERE id = q.id;
  ELSIF p_count THEN
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
                  'viewedAt', to_jsonb(visto),
                  'acceptedAt', to_jsonb(q.accepted_at),
                  'acceptedByName', to_jsonb(q.accepted_by_name),
                  'rejectedAt', to_jsonb(q.rejected_at),
                  'expiredAt', to_jsonb(vencida)));
END;
$$;

CREATE FUNCTION public_quote(p_slug text, p_count boolean DEFAULT true)
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
    r := public_quote_impl(p_slug, coalesce(p_count, true));
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.public_share', anterior, true);
    RAISE;
  END;
  PERFORM set_config('app.public_share', anterior, true);
  RETURN r;
END;
$$;

-- Aceptar, con nombre y correo de quien acepta. Deja la cotización en
-- 'accepted' y su deal en «Ganado», con su fila de historial, en la
-- transacción de quien llama.
--
-- La campaña NO se crea aquí: createCampaignFromQuote() (CAM-2) es
-- TypeScript y corre con el workspace del creador. Por eso la respuesta
-- trae workspaceId, que el servidor usa para abrir esa transacción; la
-- página pública nunca lo recibe.
--
--   {"status":"not_found"}
--   {"status":"invalid_signer"}
--   {"status":"not_acceptable","quoteStatus":"accepted"}
--   {"status":"ok","quoteId":"…","quoteNumber":"…","dealId":"…","workspaceId":"…","acceptedAt":"…"}
CREATE FUNCTION public_quote_accept_impl(p_slug text, p_name text, p_email text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  q record;
  d record;
  ultimo timestamptz;
  ahora timestamptz := now();
  nombre text := btrim(coalesce(p_name, ''));
  correo text := lower(btrim(coalesce(p_email, '')));
BEGIN
  IF length(nombre) NOT BETWEEN 1 AND 120
     OR length(correo) > 254
     OR correo !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RETURN jsonb_build_object('status', 'invalid_signer');
  END IF;

  SELECT id, workspace_id, number, status, deal_id, valid_until, public_snapshot
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
  IF q.valid_until IS NOT NULL AND q.valid_until < public_share_today(q.public_snapshot->>'timezone') THEN
    UPDATE quote SET status = 'expired', expired_at = coalesce(expired_at, ahora) WHERE id = q.id;
    RETURN jsonb_build_object('status', 'not_acceptable', 'quoteStatus', 'expired');
  END IF;

  UPDATE quote
     SET status = 'accepted', accepted_at = ahora, viewed_at = coalesce(viewed_at, ahora),
         accepted_by_name = nombre, accepted_by_email = correo
   WHERE id = q.id;

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
    'quoteNumber', q.number,
    'dealId', to_jsonb(q.deal_id),
    'workspaceId', to_jsonb(q.workspace_id),
    'acceptedAt', to_jsonb(ahora));
END;
$$;

CREATE FUNCTION public_quote_accept(p_slug text, p_name text, p_email text)
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
    r := public_quote_accept_impl(p_slug, p_name, p_email);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.public_share', anterior, true);
    RAISE;
  END;
  PERFORM set_config('app.public_share', anterior, true);
  RETURN r;
END;
$$;

-- ---------------------------------------------------------------------
-- 6 · Privilegios y dueño
-- ---------------------------------------------------------------------
-- Primero los GRANT (los hace el dueño actual, mc_migrator) y después
-- el cambio de dueño, que conserva la lista de privilegios.
REVOKE ALL ON FUNCTION public_share_today(text)                    FROM PUBLIC;
REVOKE ALL ON FUNCTION public_media_kit_impl(text, text, boolean)   FROM PUBLIC;
REVOKE ALL ON FUNCTION public_quote_impl(text, boolean)             FROM PUBLIC;
REVOKE ALL ON FUNCTION public_quote_accept_impl(text, text, text)   FROM PUBLIC;
REVOKE ALL ON FUNCTION public_media_kit(text, text, boolean)        FROM PUBLIC;
REVOKE ALL ON FUNCTION public_quote(text, boolean)                  FROM PUBLIC;
REVOKE ALL ON FUNCTION public_quote_accept(text, text, text)        FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_media_kit(text, text, boolean)     TO mc_app;
GRANT EXECUTE ON FUNCTION public_quote(text, boolean)               TO mc_app;
GRANT EXECUTE ON FUNCTION public_quote_accept(text, text, text)     TO mc_app;

ALTER FUNCTION public_share_today(text)                    OWNER TO mc_public_share;
ALTER FUNCTION public_media_kit_impl(text, text, boolean)   OWNER TO mc_public_share;
ALTER FUNCTION public_quote_impl(text, boolean)             OWNER TO mc_public_share;
ALTER FUNCTION public_quote_accept_impl(text, text, text)   OWNER TO mc_public_share;
ALTER FUNCTION public_media_kit(text, text, boolean)        OWNER TO mc_public_share;
ALTER FUNCTION public_quote(text, boolean)                  OWNER TO mc_public_share;
ALTER FUNCTION public_quote_accept(text, text, text)        OWNER TO mc_public_share;

REVOKE CREATE ON SCHEMA public FROM mc_public_share;
