-- =====================================================================
-- 0031 · Una sola forma de mover un negocio de etapa, y el monto que
--        acuerda la cotización (VEN-2, VEN-3, COT-3, COT-4)
-- ---------------------------------------------------------------------
-- Número: 0030 es la última de rasheed/integracion (enlaces públicos de
-- Cotizar). Ninguna de 0024–0030 está aplicada en Supabase; esta va
-- detrás de todas porque reescribe public_quote_accept_impl de 0030.
-- Si otra área eligió también 0031, el integrador renumera: no depende
-- de nada que venga después.
--
-- El problema, en tres partes:
--
--   1. Mover un negocio de etapa estaba escrito TRES veces —moveDeal en
--      queries/ventas.ts, ganarDeal/moverDealAPropuesta en
--      queries/cotizar/cotizacion.ts y public_quote_accept_impl aquí en
--      SQL— y ya divergían: una calculaba los días en la etapa desde que
--      entró en ella (o desde que nació el negocio) y las otras desde el
--      último cambio cualquiera, o NULL; una escribía changed_by y
--      limpiaba lost_reason y las otras no. La métrica de días por etapa
--      dependía de desde qué módulo se había movido el negocio.
--   2. Ni enviar ni aceptar una cotización tocaba deal.amount. Aceptar
--      una cotización de COP 6,5 M sobre un negocio anotado en 8,0 M
--      dejaba «Ganado este trimestre» en 8,0 M mientras la campaña y la
--      factura iban por lo cotizado: Ventas y Cotizar decían cifras
--      distintas del mismo acuerdo.
--   3. Un negocio ganado con la cotización firmada y la campaña planeada
--      se podía devolver a «Contactado» desde el tablero, sin aviso.
--   4. Perder un negocio dejaba viva la cotización enviada o vista: si
--      la marca la aceptaba después desde el enlace, el negocio volvía
--      de «Perdido» a «Ganado», nacía la campaña y el motivo de pérdida
--      que había escrito el creador se borraba sin avisar a nadie.
--
-- La salida es UNA función, deal_move_stage, que usan las tres rutas
-- (moveDeal y Cotizar como mc_app, la aceptación pública como
-- mc_public_share). Es SECURITY INVOKER a propósito: corre con los
-- permisos y la RLS de quien la llama, así que no abre nada que ese rol
-- no tuviera ya. Las actividades NO las escribe ella: su frase la
-- compone cada módulo (la web tiene los textos, @mc/db no tiene idioma)
-- y mc_public_share no puede escribir en activity; la función devuelve
-- lo que cambió para que quien la llama lo cuente.
--
-- El monto del negocio es el NETO de la cotización: total − impuesto,
-- es decir, el subtotal menos el descuento. Sin impuesto, como el resto
-- del pipeline (lo que una marca presupuesta y lo que el creador cobra
-- como ingreso; el IVA no es de ninguno de los dos). La campaña (CAM-2)
-- y la factura llevan el total con impuesto: es lo que se cobra.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · brand_key: el nombre de una marca, comparable
-- ---------------------------------------------------------------------
-- «Nutrivé», «NUTRIVE» y «nutrivé » son la misma marca. Sin la
-- extensión unaccent (no está en Supabase por defecto ni en PGlite) se
-- quitan a mano las tildes del español y del portugués, y después todo
-- lo que no sea letra o número. Es inmutable: sirve en un índice si un
-- día hace falta.
CREATE FUNCTION brand_key(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT nullif(
           regexp_replace(
             translate(lower(btrim(coalesce(p_name, ''))),
                       'áàäâãåéèëêíìïîóòöôõúùüûñçý',
                       'aaaaaaeeeeiiiiooooouuuuncy'),
             '[^a-z0-9]+', '', 'g'),
           '')
$$;

-- ---------------------------------------------------------------------
-- 2 · deal_move_stage: la única transición de etapa
-- ---------------------------------------------------------------------
-- Parámetros:
--   p_deal_id       el negocio (lo filtra la RLS de quien llama)
--   p_to_stage      la etapa de llegada: global ('propuesta') o privada
--                   del workspace (su id es un uuid al azar, 0026 §2)
--   p_forward_only  no retroceder: si el negocio ya está en esa etapa o
--                   más adelante, o cerrado, no se mueve (enviar una
--                   cotización no devuelve a «Propuesta» uno que está en
--                   negociación)
--   p_amount        el monto que acuerda una cotización, o NULL para no
--                   tocarlo. Con p_forward_only, un negocio cerrado no
--                   cambia de monto (una cotización nueva sobre un
--                   ganado no reescribe lo ganado)
--   p_currency      la moneda de ese monto
--
-- Reglas de la transición (las mismas que tenía moveDeal):
--   · historial con los días que pasó en la etapa que deja, desde que
--     entró en ella o, si nunca se registró, desde que nació el negocio;
--     changed_by es quien mueve (NULL desde el enlace público)
--   · won_at y lost_at los decide la etapa de llegada: se fijan al
--     entrar en una terminal y se limpian al salir, para que el KPI del
--     trimestre no cuente un negocio reabierto
--   · lost_reason solo sobrevive dentro de «Perdido»
--   · probability vuelve a NULL: la personalizada era de la etapa que
--     deja, y la vista deal_pipeline usa entonces la de la etapa nueva
--   · mover a la etapa en la que ya está no escribe historial
--   · un negocio GANADO no sale de «Ganado» si tiene una campaña viva
--     (no cancelada) o una cotización aceptada cuya campaña todavía no
--     existe: la cotización diría «Firmó …» y la campaña «Planeada» con
--     un negocio abierto. Se cancela la campaña primero.
--   · entrar en una etapa PERDIDA cierra, en la misma transacción, las
--     cotizaciones que la marca todavía podía aceptar ('sent' o
--     'viewed' → 'rejected', con rejected_at): perder es decir que no a
--     lo que está sobre la mesa. El enlace público las ve «rechazadas»
--     y ya no gana el negocio por detrás del creador. Los borradores no
--     se tocan (la marca no los ve). Si el creador quiere retomar la
--     conversación, reabre el negocio y envía una cotización nueva.
--     Esas filas se bloquean ANTES que el negocio, en el mismo orden
--     que la aceptación pública (cotización → negocio): perder y
--     aceptar a la vez no se bloquean entre sí; gana el primero y el
--     otro ve el resultado (la aceptación, «rechazada»; perder un
--     negocio recién ganado, «locked»).
--
-- Devuelve jsonb (los montos y los días como texto, para que ningún
-- decimal pase por un number de JavaScript):
--   {"status":"not_found"} · {"status":"invalid_stage"}
--   {"status":"locked","reason":"campaign"|"quote"}
--   {"status":"moved"|"unchanged","fromStageId":…,"toStageId":…,
--    "daysInStage":"3.25"|null,"isWon":…,"isLost":…,
--    "amountChanged":true|false,"amountFrom":"9000000.00"|null,
--    "currencyFrom":"COP","amountTo":…,"currencyTo":…,
--    "closedQuotes":[{"id":…,"number":"COT-2026-007"}]}
CREATE FUNCTION deal_move_stage(
  p_deal_id uuid,
  p_to_stage text,
  p_forward_only boolean DEFAULT false,
  p_amount numeric DEFAULT NULL,
  p_currency text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  d record;
  desde record;
  hacia record;
  ultimo timestamptz;
  dias numeric;
  ahora timestamptz := now();
  mueve boolean;
  toca_monto boolean;
  cambia_monto boolean;
  cerrado boolean;
  cerradas jsonb := '[]'::jsonb;
  moneda text := upper(nullif(btrim(coalesce(p_currency, '')), ''));
BEGIN
  IF p_deal_id IS NULL OR p_to_stage IS NULL OR length(p_to_stage) = 0 OR length(p_to_stage) > 64 THEN
    RETURN jsonb_build_object('status', CASE WHEN p_deal_id IS NULL THEN 'not_found' ELSE 'invalid_stage' END);
  END IF;
  IF p_amount IS NOT NULL AND p_amount < 0 THEN
    RAISE EXCEPTION 'deal_move_stage: monto negativo' USING ERRCODE = 'check_violation';
  END IF;

  -- Las cotizaciones abiertas primero, y después el negocio: el mismo
  -- orden de bloqueo que public_quote_accept_impl (ver las reglas).
  IF EXISTS (SELECT 1 FROM pipeline_stage WHERE id = p_to_stage AND is_lost) THEN
    PERFORM 1
       FROM quote
      WHERE deal_id = p_deal_id AND status IN ('sent', 'viewed')
      ORDER BY id
        FOR UPDATE;
  END IF;

  SELECT id, stage_id, amount, currency::text AS currency, created_at
    INTO d
    FROM deal
   WHERE id = p_deal_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  SELECT id, is_won, is_lost, position INTO hacia FROM pipeline_stage WHERE id = p_to_stage;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'invalid_stage');
  END IF;

  SELECT id, is_won, is_lost, position INTO desde FROM pipeline_stage WHERE id = d.stage_id;
  cerrado := coalesce(desde.is_won, false) OR coalesce(desde.is_lost, false);

  mueve := d.stage_id <> hacia.id
           AND NOT (p_forward_only AND (cerrado OR coalesce(desde.position, 0) >= hacia.position));

  -- Reabrir un ganado que ya tiene campaña o cotización firmada.
  IF mueve AND coalesce(desde.is_won, false) AND NOT hacia.is_won THEN
    IF EXISTS (SELECT 1 FROM campaign c WHERE c.deal_id = d.id AND c.status <> 'cancelled') THEN
      RETURN jsonb_build_object('status', 'locked', 'reason', 'campaign');
    END IF;
    IF EXISTS (SELECT 1 FROM quote q WHERE q.deal_id = d.id AND q.status = 'accepted')
       AND NOT EXISTS (SELECT 1 FROM campaign c WHERE c.deal_id = d.id) THEN
      RETURN jsonb_build_object('status', 'locked', 'reason', 'quote');
    END IF;
  END IF;

  toca_monto := p_amount IS NOT NULL AND NOT (p_forward_only AND cerrado);
  cambia_monto := toca_monto
                  AND (d.amount IS DISTINCT FROM p_amount OR (moneda IS NOT NULL AND moneda <> d.currency));

  IF mueve THEN
    SELECT max(changed_at) INTO ultimo
      FROM deal_stage_history
     WHERE deal_id = d.id AND to_stage_id = d.stage_id;
    dias := round((extract(epoch FROM (ahora - coalesce(ultimo, d.created_at))) / 86400)::numeric, 2);
  END IF;

  IF mueve OR cambia_monto THEN
    UPDATE deal
       SET stage_id    = CASE WHEN mueve THEN hacia.id ELSE stage_id END,
           probability = CASE WHEN mueve THEN NULL ELSE probability END,
           won_at      = CASE WHEN NOT mueve THEN won_at
                              WHEN hacia.is_won THEN coalesce(won_at, ahora) ELSE NULL END,
           lost_at     = CASE WHEN NOT mueve THEN lost_at
                              WHEN hacia.is_lost THEN coalesce(lost_at, ahora) ELSE NULL END,
           lost_reason = CASE WHEN NOT mueve OR hacia.is_lost THEN lost_reason ELSE NULL END,
           amount      = CASE WHEN cambia_monto THEN p_amount ELSE amount END,
           currency    = CASE WHEN cambia_monto AND moneda IS NOT NULL THEN moneda ELSE currency END
     WHERE id = d.id;
  END IF;

  IF mueve THEN
    INSERT INTO deal_stage_history (deal_id, from_stage_id, to_stage_id, changed_by, changed_at, days_in_stage)
    VALUES (d.id, d.stage_id, hacia.id, current_user_id(), ahora, dias);
  END IF;

  IF mueve AND hacia.is_lost THEN
    WITH c AS (
      UPDATE quote
         SET status = 'rejected', rejected_at = coalesce(rejected_at, ahora)
       WHERE deal_id = d.id AND status IN ('sent', 'viewed')
      RETURNING id, number
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'number', c.number) ORDER BY c.number), '[]'::jsonb)
      INTO cerradas
      FROM c;
  END IF;

  RETURN jsonb_build_object(
    'status', CASE WHEN mueve THEN 'moved' ELSE 'unchanged' END,
    'fromStageId', d.stage_id,
    'toStageId', CASE WHEN mueve THEN hacia.id ELSE d.stage_id END,
    'daysInStage', to_jsonb(dias::text),
    'isWon', CASE WHEN mueve THEN hacia.is_won ELSE coalesce(desde.is_won, false) END,
    'isLost', CASE WHEN mueve THEN hacia.is_lost ELSE coalesce(desde.is_lost, false) END,
    'amountChanged', cambia_monto,
    'amountFrom', to_jsonb(d.amount::text),
    'currencyFrom', d.currency,
    'amountTo', to_jsonb((CASE WHEN cambia_monto THEN p_amount ELSE d.amount END)::numeric(14,2)::text),
    'currencyTo', CASE WHEN cambia_monto AND moneda IS NOT NULL THEN moneda ELSE d.currency END,
    'closedQuotes', cerradas);
END;
$$;

REVOKE ALL ON FUNCTION deal_move_stage(uuid, text, boolean, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION deal_move_stage(uuid, text, boolean, numeric, text) TO mc_app, mc_public_share;
GRANT EXECUTE ON FUNCTION brand_key(text) TO mc_app;

-- El enlace público pasa ahora por deal_move_stage, que escribe también
-- el monto, la moneda y lost_reason. Sigue sin poder tocar el nombre del
-- negocio, su empresa, su dueño ni su siguiente acción; y el monto que
-- escribe es el de la cotización que la propia función acaba de leer
-- bajo la política de su slug, no uno que llegue de la página.
GRANT UPDATE (lost_reason, amount, currency) ON deal TO mc_public_share;

-- ---------------------------------------------------------------------
-- 3 · La aceptación pública, sobre deal_move_stage
-- ---------------------------------------------------------------------
-- Igual que en 0030 salvo el bloque del negocio: la transición es la de
-- deal_move_stage y el monto pasa a ser el neto de la cotización. La
-- respuesta trae además dealAmountChanged / dealAmountFrom /
-- dealCurrencyFrom, para que el servidor deje en la historia del
-- negocio la actividad que cuenta el cambio (la escribe la web dentro
-- del workspace de la cotización, junto a la de «aceptada»).
--
-- CREATE OR REPLACE conserva el dueño (mc_public_share) y los permisos;
-- mc_migrator puede reemplazarla porque es miembro de mc_public_share
-- (0030, requisito en Supabase).
CREATE OR REPLACE FUNCTION public_quote_accept_impl(p_slug text, p_name text, p_email text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  q record;
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
         total, tax, currency::text AS currency
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
