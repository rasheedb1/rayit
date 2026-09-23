-- =====================================================================
-- 0033 · Un negocio, una cotización aceptada (COT-3, COT-4, pulido r6)
-- ---------------------------------------------------------------------
-- Número: 0032 es la última de rasheed/integracion. Ninguna de
-- 0024–0032 está aplicada en Supabase; esta va detrás de todas porque
-- reescribe public_quote_accept_impl de 0031 y public_quote_impl de
-- 0030. Si otra área eligió también 0033, el integrador renumera: no
-- depende de nada que venga después.
--
-- El problema, reproducido: COT-2026-012 aceptada (negocio «Ganado»,
-- campaña creada) y después COT-2026-009, del MISMO negocio y todavía
-- «enviada», aceptada desde su enlace en otra sesión. Quedaron dos
-- campañas «Vitalé · Paquete snacks · Q4» en /campanas, dos avisos
-- «aceptó» y el monto del negocio pisado por la segunda. Enviar una
-- versión nueva dejaba vivas las anteriores, y ninguna de las dos
-- rutas de aceptación miraba si el negocio ya tenía una aceptada. Eso
-- duplica el ingreso en Campañas y, después, en Finanzas.
--
-- La salida tiene tres piezas; esta migración trae las de la base y la
-- regla completa vive en queries/cotizar/cotizacion.ts:
--
--   1. ENVIAR deja sin efecto las demás versiones vivas del negocio
--      (sendQuote): pasan a 'expired' con superseded_by = la que se
--      envía, y el detalle de las dos lo dice («COT-2026-009 queda sin
--      efecto»). Así, en todo momento, un negocio tiene como mucho UNA
--      cotización que la marca puede aceptar.
--   2. ACEPTAR, desde el panel (acceptQuote) o desde el enlace (aquí),
--      bloquea el negocio y se niega si el negocio está ganado con OTRA
--      cotización aceptada. Es la red para lo que 1 no cubre: datos de
--      antes de esta migración y dos transacciones a la vez.
--   3. El enlace de una versión sin efecto lo dice («quedó sin efecto:
--      te enviaron una más reciente»), no «venció».
--
-- Por qué «ganado CON otra aceptada» y no solo «hay otra aceptada»: un
-- negocio ganado cuya campaña se cancela se puede reabrir (0031,
-- deal_move_stage), y la cotización nueva que se negocie entonces se
-- tiene que poder aceptar. La aceptada vieja sigue siendo historia.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · superseded_by: qué versión dejó sin efecto a esta
-- ---------------------------------------------------------------------
ALTER TABLE quote ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES quote(id) ON DELETE SET NULL;
ALTER TABLE quote ADD CONSTRAINT quote_superseded_by_not_self CHECK (superseded_by IS NULL OR superseded_by <> id);
CREATE INDEX IF NOT EXISTS quote_superseded_by_idx ON quote (superseded_by) WHERE superseded_by IS NOT NULL;

-- La clave nueva hacia una tabla con RLS lleva el disparador de 0025 §3:
-- el bucle de 0025 §7 solo enganchó las que existían entonces.
DROP TRIGGER IF EXISTS ref_visible_superseded_by ON quote;
CREATE TRIGGER ref_visible_superseded_by
  BEFORE INSERT OR UPDATE OF superseded_by ON quote
  FOR EACH ROW WHEN (NEW.superseded_by IS NOT NULL)
  EXECUTE FUNCTION assert_reference_visible('superseded_by', 'quote', 'id');

-- Lo que ya existe: en cada negocio con más de una versión viva, la
-- enviada más reciente sigue y las demás quedan sin efecto; y un negocio
-- ganado con una aceptada no conserva versiones vivas. quote tiene FORCE
-- ROW LEVEL SECURITY y la migración corre sin workspace fijado: como en
-- 0026 y 0032, el rol que migra (dueño de la tabla) le quita FORCE solo
-- durante el relleno y se lo devuelve en la misma transacción.
DO $$
DECLARE
  forzadas text[] := ARRAY[]::text[];
  t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname IN ('quote', 'deal') AND c.relforcerowsecurity
  LOOP
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    forzadas := forzadas || t;
  END LOOP;

  -- Ganado con una aceptada: las vivas de ese negocio, sin efecto.
  UPDATE quote v
     SET status = 'expired', expired_at = coalesce(v.expired_at, now()), superseded_by = a.id
    FROM quote a JOIN deal d ON d.id = a.deal_id
   WHERE a.status = 'accepted' AND d.won_at IS NOT NULL
     AND v.deal_id = a.deal_id AND v.id <> a.id AND v.status IN ('sent', 'viewed');

  -- Varias vivas: gana la enviada más reciente.
  UPDATE quote v
     SET status = 'expired', expired_at = coalesce(v.expired_at, now()), superseded_by = u.id
    FROM (SELECT DISTINCT ON (deal_id) id, deal_id
            FROM quote
           WHERE deal_id IS NOT NULL AND status IN ('sent', 'viewed')
           ORDER BY deal_id, sent_at DESC NULLS LAST, created_at DESC) u
   WHERE v.deal_id = u.deal_id AND v.id <> u.id AND v.status IN ('sent', 'viewed');

  FOREACH t IN ARRAY forzadas LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 2 · La aceptada del mismo negocio, visible para el enlace
-- ---------------------------------------------------------------------
-- La política de 0030 abre a mc_public_share SOLO la cotización cuyo
-- slug fija la función, así que desde el enlace no se podía saber si el
-- negocio ya tenía otra aceptada. Esta abre, además, las ACEPTADAS del
-- negocio cuyo id fija public_quote_accept_impl en `app.public_share_deal`
-- mientras lo comprueba (y vacía justo después). Ese id no llega de la
-- página: la función lo lee de la cotización que acaba de abrir por su
-- slug. Para mc_app el parámetro no significa nada (la política es
-- `TO mc_public_share`), y una aceptada ya es un documento que la marca
-- firmó por su propio enlace. No abre borradores ni montos de otra
-- versión viva: solo las aceptadas.
--
-- No se escribe como un EXISTS sobre quote: una política de quote que
-- lee quote (o deal, cuya política de 0030 lee quote) es recursión, y
-- Postgres la rechaza.
CREATE POLICY quote_public_share_accepted_sibling ON quote
  FOR SELECT TO mc_public_share
  USING (status = 'accepted'
         AND deal_id IS NOT NULL
         AND deal_id::text = nullif(current_setting('app.public_share_deal', true), ''));

-- ---------------------------------------------------------------------
-- 3 · Aceptar desde el enlace
-- ---------------------------------------------------------------------
-- Igual que en 0031, más:
--   · una versión sin efecto responde quoteStatus 'superseded' (y no
--     'expired', que la página traduce por «venció»);
--   · después de bloquear la cotización, bloquea el negocio (el orden de
--     siempre: primero la cotización, después el negocio) y, si está
--     ganado con OTRA aceptada, deja esta sin efecto y responde
--     'superseded'. La segunda de dos aceptaciones a la vez espera aquí
--     al bloqueo del negocio y, cuando lo tiene, ya ve la primera.
--
-- CREATE OR REPLACE conserva el dueño (mc_public_share) y los permisos;
-- mc_migrator puede reemplazarla porque es miembro de mc_public_share.
CREATE OR REPLACE FUNCTION public_quote_accept_impl(p_slug text, p_name text, p_email text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  q record;
  d record;
  otra uuid;
  mov jsonb;
  ahora timestamptz := now();
  nombre text := btrim(coalesce(p_name, ''));
  correo text := lower(btrim(coalesce(p_email, '')));
BEGIN
  IF length(nombre) NOT BETWEEN 1 AND 120
     OR length(correo) > 254
     OR correo !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RETURN jsonb_build_object('status', 'invalid_signer');
  END IF;

  SELECT id, workspace_id, number, status, deal_id, valid_until, public_snapshot,
         total, tax, currency::text AS currency, superseded_by
    INTO q
    FROM quote
   WHERE slug = p_slug
     FOR UPDATE;

  IF NOT FOUND OR q.public_snapshot IS NULL THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF q.status NOT IN ('sent', 'viewed') THEN
    RETURN jsonb_build_object('status', 'not_acceptable', 'quoteStatus',
      CASE WHEN q.status = 'expired' AND q.superseded_by IS NOT NULL THEN 'superseded' ELSE q.status END);
  END IF;
  IF q.valid_until IS NOT NULL AND q.valid_until < public_share_today(q.public_snapshot->>'timezone') THEN
    UPDATE quote SET status = 'expired', expired_at = coalesce(expired_at, ahora) WHERE id = q.id;
    RETURN jsonb_build_object('status', 'not_acceptable', 'quoteStatus', 'expired');
  END IF;

  IF q.deal_id IS NOT NULL THEN
    SELECT id, won_at INTO d FROM deal WHERE id = q.deal_id FOR UPDATE;
    IF FOUND AND d.won_at IS NOT NULL THEN
      PERFORM set_config('app.public_share_deal', q.deal_id::text, true);
      BEGIN
        SELECT id INTO otra FROM quote
         WHERE deal_id = q.deal_id AND id <> q.id AND status = 'accepted'
         ORDER BY accepted_at DESC NULLS LAST
         LIMIT 1;
      EXCEPTION WHEN OTHERS THEN
        PERFORM set_config('app.public_share_deal', '', true);
        RAISE;
      END;
      PERFORM set_config('app.public_share_deal', '', true);
      IF otra IS NOT NULL THEN
        -- superseded_by no se escribe desde aquí: mc_public_share no
        -- tiene esa columna. Basta con que deje de estar viva; el panel
        -- la ve vencida y el negocio no se toca.
        UPDATE quote SET status = 'expired', expired_at = coalesce(expired_at, ahora) WHERE id = q.id;
        RETURN jsonb_build_object('status', 'not_acceptable', 'quoteStatus', 'superseded');
      END IF;
    END IF;
  END IF;

  UPDATE quote
     SET status = 'accepted', accepted_at = ahora, viewed_at = coalesce(viewed_at, ahora),
         accepted_by_name = nombre, accepted_by_email = correo
   WHERE id = q.id;

  IF q.deal_id IS NOT NULL THEN
    mov := deal_move_stage(q.deal_id, 'ganado', false, q.total - q.tax, q.currency);
  END IF;

  RETURN jsonb_build_object(
    'status', 'ok',
    'quoteId', to_jsonb(q.id),
    'quoteNumber', q.number,
    'dealId', to_jsonb(q.deal_id),
    'workspaceId', to_jsonb(q.workspace_id),
    'acceptedAt', to_jsonb(ahora),
    'dealAmountChanged', coalesce((mov->>'amountChanged')::boolean, false),
    'dealAmountFrom', coalesce(mov->'amountFrom', 'null'::jsonb),
    'dealCurrencyFrom', coalesce(mov->'currencyFrom', 'null'::jsonb));
END;
$$;

-- ---------------------------------------------------------------------
-- 4 · Abrir el enlace de una versión sin efecto
-- ---------------------------------------------------------------------
-- Igual que en 0030, más `superseded` en lo que devuelve: la página
-- dice «quedó sin efecto, te enviaron una más reciente» en vez de
-- «venció», que sería falso (su «válida hasta» puede no haber pasado).
CREATE OR REPLACE FUNCTION public_quote_impl(p_slug text, p_count boolean)
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
         rejected_at, expired_at, accepted_by_name, superseded_by
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
                  'superseded', nuevo_estado = 'expired' AND q.superseded_by IS NOT NULL,
                  'validUntil', to_jsonb(q.valid_until),
                  'sentAt', to_jsonb(q.sent_at),
                  'viewedAt', to_jsonb(visto),
                  'acceptedAt', to_jsonb(q.accepted_at),
                  'acceptedByName', to_jsonb(q.accepted_by_name),
                  'rejectedAt', to_jsonb(q.rejected_at),
                  'expiredAt', to_jsonb(vencida)));
END;
$$;
