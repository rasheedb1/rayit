-- =====================================================================
-- 0038 · Entregabilidad y cumplimiento del correo saliente (VEN-15)
-- ---------------------------------------------------------------------
-- Número: el siguiente libre en rasheed/integracion, que llega a 0037
-- (outreach). main ya aplicó en Supabase sus propias 0034–0039, así que
-- el integrador renumera todas las de integración después de esas; esta
-- no depende de ninguna de main y solo necesita ir después de 0037.
--
-- Qué trae:
--   1. contact.email_invalid: el correo de la ficha rebotó con un error
--      permanente (5.1.x). Con su motivo y su hora. Se borra solo cuando
--      alguien le cambia el correo a la ficha.
--   2. La regla: un correo no se programa a una ficha con el correo
--      inválido (outbound_touch_email_invalid). LinkedIn e Instagram sí:
--      un rebote dice que la dirección no existe, no que la persona pidió
--      no ser contactada. Por eso el rebote NO va a contact_suppression,
--      que corta todos los canales (0037 §4.1).
--   3. outbound_bounce: la bitácora de rebotes que lee el job
--      outbound.bounces del buzón del creador. Única por aviso del
--      buzón: leer dos veces el mismo buzón no cuenta dos rebotes.
--   4. Los dos jobs en job_definition y los seis avisos nuevos de
--      notification (las alertas diarias del outreach; el sexto, r5, es
--      el buzón de rebotes que nadie lee).
--   5. public_optout_preview(token, espacios de quien lo abre): lo que la
--      página de baja enseña ANTES del clic (la dirección enmascarada y
--      quién la escribe) y si quien la abre es del workspace que envió.
--      El token es opaco (32 bytes al azar): todo se resuelve desde su
--      sha256, igual que public_optout. Sin secreto que configurar.
--   6. outreach_channel_account.bounces_read_at: hasta dónde se leyó el
--      buzón de rebotes de cada cuenta (r3).
--   7. La política de envío la escriben solo 'owner' y 'admin' (r3).
--   8. La baja por enlace en dos tiempos (r3): vale ya para el workspace
--      que envió (outbound_workspace_optout) y pasa a toda la plataforma
--      cuando otro workspace la confirma. Cierra el sabotaje del
--      remitente que pulsa su propio enlace sin sesión. Desde r4 el
--      segundo workspace tiene que ser de OTRAS personas: uno que comparte
--      un miembro con el primero (una agencia con dos espacios) no
--      confirma nada.
--
-- Después de la última revisión, en su sitio: la vuelta desde 'processing' de
-- alguien dado de baja (de este workspace o de toda la plataforma) se
-- cancela en vez de rechazarse (§8.3), como la del correo inválido: el
-- rescate por lotes del despachador de VEN-10 ya no aborta entero por un
-- solo zombi dado de baja.
--
-- Después de la ronda 5, en su sitio: la vuelta desde 'processing' a una
-- dirección que rebotó se cancela en vez de rechazarse (§2): el toque
-- no vuelve a la cola ni se queda atascado en 'processing'.
--
-- Ronda 5, también en su sitio: una sola regla de la baja para los toques
-- (§8.3: enforce_outbound_optout mira también outbound_workspace_optout,
-- con las transiciones de 0037, así que un toque reclamado al pulsar la
-- baja no vuelve a la cola), la regla del correo inválido mira también
-- el reclamo y la vuelta desde 'processing' (§2), y la vista previa de
-- la baja dice el idioma del workspace que envió (§5).
--
-- Ronda 4, también en su sitio: outreach_can_manage falla cerrada (sin
-- identidad solo responde que sí con la bandera explícita
-- app.auth_disabled, §7), y la baja guarda un código
-- ('unsubscribe_link') en contact.opted_out_reason en vez de una frase:
-- la pantalla lo traduce en el idioma del espacio.
--
-- Esta migración no está aplicada en ningún sitio (en Supabase, la 0038
-- es la de main), así que la ronda 3 la corrige en su sitio en vez de
-- apilar una 0039 encima.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · contact.email_invalid
-- ---------------------------------------------------------------------
ALTER TABLE contact
  ADD COLUMN email_invalid        boolean NOT NULL DEFAULT false,
  ADD COLUMN email_invalid_at     timestamptz,
  ADD COLUMN email_invalid_reason text CHECK (email_invalid_reason IS NULL OR length(email_invalid_reason) <= 300),
  ADD CONSTRAINT contact_email_invalid_check
    CHECK (NOT email_invalid OR (email_invalid_at IS NOT NULL AND email_invalid_reason IS NOT NULL));

COMMENT ON COLUMN contact.email_invalid IS
  'El correo de la ficha rebotó con un error permanente (VEN-15, job outbound.bounces). No se le programan correos; '
  'los otros canales siguen. Cambiar el correo de la ficha lo borra.';

-- Las fichas con el correo inválido son pocas: el barrido de
-- outbound.bounces (sweepInvalidEmail) parte de ellas en vez de recorrer
-- todos los toques.
CREATE INDEX contact_email_invalid_idx ON contact (id) WHERE email_invalid;

-- Otro correo, otra historia: el rebote era de la dirección anterior.
-- También se limpia contact.bounced (0007), que el job marca junto con
-- email_invalid y que la ficha de Ventas enseña como «Correo rebotado»:
-- sin esto, la píldora seguía ahí con el correo ya corregido.
CREATE FUNCTION contact_email_invalid_reset()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email AND NOT (NEW.email_invalid AND NOT OLD.email_invalid) THEN
    NEW.email_invalid := false;
    NEW.email_invalid_at := NULL;
    NEW.email_invalid_reason := NULL;
    NEW.bounced := false;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER contact_email_invalid_reset
  BEFORE UPDATE OF email ON contact
  FOR EACH ROW EXECUTE FUNCTION contact_email_invalid_reset();

-- ---------------------------------------------------------------------
-- 2 · Un correo no se programa a un correo inválido
-- ---------------------------------------------------------------------
-- Mira la ENTRADA en 'scheduled', en 'processing' y en 'sent' (r5), como
-- la regla de la baja (0037 §4.1): el alta, aprobar (draft/held →
-- scheduled), el reclamo del despachador (scheduled → processing), el
-- reintento o el rescate de un zombi (processing → scheduled) y un envío
-- registrado a mano. La excepción es processing → sent: el correo ya
-- salió y se registra.
-- La vuelta desde 'processing' (el reintento, o el rescate de un zombi
-- de más de cinco minutos) NO se rechaza: se CANCELA en el sitio
-- (status 'canceled', blocked_reason 'email_invalid'). Un correo que
-- rebotó mientras estaba reclamado no vuelve a la cola, y tampoco se
-- queda para siempre en 'processing' con el despachador chocando en
-- cada rescate. Solo el despachador saca un toque de 'processing'
-- (0037 §4.1, outbound_touch_worker_columns), así que esto no le cambia
-- a nadie más lo que ve.
-- Lo demás se rechaza con check_violation: quien programa (la web, el
-- planificador de VEN-10) se entera y salta ese paso; el reclamo de
-- VEN-10 filtra esas filas y las pasa a 'canceled'
-- (docs/ventas-outreach.md §5.2). Y lo que queda en draft o held a una
-- dirección que ya rebotó lo cancela el barrido de cada pasada de
-- outbound.bounces, que también pausa los enrolamientos de secuencias
-- solo de correo.
-- La dirección que cuenta es la del envío si ya la tiene, y si no la de
-- la ficha: si el toque va a otra dirección, esa no rebotó.
--
-- Dos fuentes, porque la ficha puede no ser de este workspace (r3):
--   · contact.email_invalid, la marca de una ficha PROPIA del workspace
--     que la leyó rebotar (el job solo marca fichas con
--     owner_workspace_id = el workspace del buzón);
--   · outbound_bounce: un rebote DURO y VERIFICADO (verified: el aviso
--     trae el Message-ID de un correo que este mismo workspace envió) a
--     esa dirección, en ESTE workspace. Es lo que frena el correo a un
--     contacto global (fuentes públicas, owner_workspace_id NULL): ese
--     rebote no toca la ficha compartida, así que un aviso en el buzón de
--     un creador no le cierra el correo a los demás.
-- La tabla de rebotes la lee mc_app con su RLS (la del workspace de la
-- transacción, que es el del toque) y el worker sin ella.
CREATE FUNCTION outbound_touch_email_invalid()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  c record;
  direccion citext;
BEGIN
  IF NEW.channel <> 'email' OR NEW.status NOT IN ('scheduled', 'processing', 'sent') OR NEW.contact_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- Seguir en el mismo estado no es entrar; y lo que ya salió se registra.
  IF TG_OP = 'UPDATE' AND (OLD.status = NEW.status OR (OLD.status = 'processing' AND NEW.status = 'sent')) THEN
    RETURN NEW;
  END IF;
  SELECT x.email, x.email_invalid INTO c FROM contact x WHERE x.id = NEW.contact_id;
  IF FOUND AND c.email_invalid
     AND (NEW.recipient_address IS NULL OR NEW.recipient_address = c.email) THEN
    -- La vuelta a la cola de lo reclamado: se cancela en el sitio (arriba).
    IF TG_OP = 'UPDATE' AND OLD.status = 'processing' AND NEW.status = 'scheduled' THEN
      NEW.status := 'canceled';
      NEW.blocked_reason := 'email_invalid';
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'El correo de la ficha % rebotó: no se le programan correos.', NEW.contact_id
      USING ERRCODE = 'check_violation',
            HINT = 'Corrige el correo de la ficha (eso borra la marca) o escríbele por otro canal.';
  END IF;
  direccion := coalesce(NEW.recipient_address, c.email);
  IF direccion IS NOT NULL AND EXISTS (
       SELECT 1 FROM outbound_bounce b
        WHERE b.workspace_id = NEW.workspace_id AND b.kind = 'hard'
          AND b.verified AND b.recipient_address = direccion) THEN
    IF TG_OP = 'UPDATE' AND OLD.status = 'processing' AND NEW.status = 'scheduled' THEN
      NEW.status := 'canceled';
      NEW.blocked_reason := 'email_invalid';
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'La dirección de la ficha % rebotó en un correo de este espacio: no se le programan correos.', NEW.contact_id
      USING ERRCODE = 'check_violation',
            HINT = 'Escríbele por otro canal, o usa otra dirección.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbound_touch_email_invalid
  BEFORE INSERT OR UPDATE OF status ON outbound_touch
  FOR EACH ROW EXECUTE FUNCTION outbound_touch_email_invalid();

-- Los correos que todavía pueden salir (draft, scheduled, held): lo único
-- que el barrido de cada media hora de outbound.bounces mira. Sin este
-- índice parcial el barrido global recorría outbound_touch entero, de
-- todos los workspaces, en cada pasada, hubiera rebotes nuevos o no.
CREATE INDEX outbound_touch_email_pending_idx ON outbound_touch (workspace_id, contact_id)
  WHERE channel = 'email' AND status IN ('draft', 'scheduled', 'held');

-- ---------------------------------------------------------------------
-- 3 · outbound_bounce: la bitácora de rebotes
-- ---------------------------------------------------------------------
--   provider_message_id  el id del AVISO de rebote en el buzón (Gmail):
--                        la llave de idempotencia por workspace.
--   touch_id             el correo que rebotó: el toque 'sent' de ESTE
--                        workspace cuyo Message-ID
--                        (outbound_touch.message_id_rfc) trae el aviso.
--                        Sin eso, NULL: no se adivina por la dirección.
--   verified             el aviso se casó con un correo que este
--                        workspace envió (touch_id, enviado antes del
--                        aviso). Solo un rebote verificado tiene efectos:
--                        marcar la ficha, cancelar y frenar nuevos
--                        correos (§2). Lo que no se verifica (un aviso
--                        falso, uno sin Message-ID) queda anotado y nada
--                        más.
--   kind                 hard (la dirección no existe), soft (pasajero,
--                        buzón lleno), blocked (política o reputación
--                        del servidor que recibe: habla de quien envía).
-- Es una métrica: se inserta y no se corrige. La escribe el worker.
CREATE TABLE outbound_bounce (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel_account_id   uuid REFERENCES outreach_channel_account(id) ON DELETE SET NULL,
  provider_message_id  text NOT NULL CHECK (length(provider_message_id) BETWEEN 1 AND 200),
  touch_id             uuid REFERENCES outbound_touch(id) ON DELETE SET NULL,
  contact_id           uuid REFERENCES contact(id) ON DELETE SET NULL,
  recipient_address    citext,
  verified             boolean NOT NULL DEFAULT false,
  kind                 text NOT NULL CHECK (kind IN ('hard', 'soft', 'blocked')),
  status_code          text CHECK (status_code ~ '^[245]\.[0-9]{1,3}\.[0-9]{1,3}$'),
  smtp_code            int CHECK (smtp_code BETWEEN 400 AND 599),
  reason               text NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  received_at          timestamptz,
  detected_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbound_bounce_verified_check CHECK (NOT verified OR recipient_address IS NOT NULL)
);
CREATE UNIQUE INDEX outbound_bounce_message_idx ON outbound_bounce (workspace_id, provider_message_id);
CREATE INDEX ON outbound_bounce (workspace_id, detected_at);
CREATE INDEX ON outbound_bounce (contact_id);
CREATE INDEX ON outbound_bounce (touch_id);
-- Lo que mira la regla de §2 al programar un correo.
CREATE INDEX outbound_bounce_hard_idx ON outbound_bounce (workspace_id, recipient_address) WHERE kind = 'hard' AND verified;

-- El patrón de 0037 §7.1b: RLS con política SOLO de lectura. Ni un GRANT
-- de más abriría la escritura a la aplicación.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'outbound_bounce' AND column_name = 'workspace_id'
  ) THEN
    RAISE EXCEPTION 'outbound_bounce está en la lista de RLS pero no tiene workspace_id';
  END IF;
END $$;
ALTER TABLE outbound_bounce ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_bounce FORCE ROW LEVEL SECURITY;
CREATE POLICY outbound_bounce_ws_read ON outbound_bounce FOR SELECT
  USING (workspace_id = current_workspace_id());
REVOKE INSERT, UPDATE, DELETE ON outbound_bounce FROM mc_app;
-- La demo (seed 0006) la siembra quien migra con el workspace de la demo
-- fijado, como outbound_optout_link_seed (0037 §9.2): TO CURRENT_USER y
-- solo en el workspace fijado. A mc_app no le alcanza (y además no
-- tiene INSERT).
CREATE POLICY outbound_bounce_seed ON outbound_bounce FOR INSERT TO CURRENT_USER
  WITH CHECK (current_workspace_id() IS NOT NULL AND workspace_id = current_workspace_id());

COMMENT ON TABLE outbound_bounce IS
  'Rebotes leídos del buzón del creador (VEN-15, job outbound.bounces). Append-only; la escribe el worker. '
  'Única por (workspace_id, provider_message_id): leer dos veces el mismo aviso no cuenta dos rebotes.';

-- ---------------------------------------------------------------------
-- 4 · Los jobs y los avisos
-- ---------------------------------------------------------------------
-- outbound.alerts corre cada hora y cada workspace se procesa desde su
-- mañana (como sales.follow_ups, 0034): «a diario» en la zona de cada uno.
INSERT INTO job_definition (id, label_es, queue, default_cron, timeout_s, max_attempts, max_concurrency) VALUES
  ('outbound.bounces', 'Leer rebotes del correo saliente', 'sales', '*/30 * * * *', 300, 3, 1),
  ('outbound.alerts',  'Alertas diarias del outreach',     'sales', '25 * * * *',   300, 3, 1)
ON CONFLICT (id) DO NOTHING;

-- 'connection_added' es de main (0038_notification_connection_added,
-- ACC-8, ya aplicada en Supabase). Esta migración corre DESPUÉS de esa
-- al renumerarse, y el CHECK se reescribe entero: sin ese valor aquí,
-- esta lo borraría de la lista.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check CHECK (kind IN
  ('outlier','breakout','signal','deal_due','deal_overdue',
   'payment_received','invoice_overdue','connection_error',
   'analysis_ready','report_sent','trend','quote_accepted','media_kit_locked',
   'connection_added',
   'outreach_bounce_rate','outreach_no_sends','outreach_queue_stuck',
   'outreach_account_down','outreach_llm_budget','outreach_bounces_unread'));

-- ---------------------------------------------------------------------
-- 5 · public_optout_preview: lo que la página de baja dice antes del clic
-- ---------------------------------------------------------------------
-- La página /baja/<token> se abre sin sesión y tiene que decir, antes de
-- pedir el clic:
--   · PARA QUÉ correo es: «Dejarás de recibir mensajes en v•••@marca.com»
--     (referencia: la baja de Substack). La dirección va enmascarada: el
--     enlace puede llegar reenviado, y quien lo reciba así no se lleva la
--     dirección entera;
--   · QUIÉN escribe: el nombre del workspace que envió ese correo;
--   · EN QUÉ IDIOMA (r5): el locale de ese workspace. El pie del correo
--     sale en su idioma (footerTextsFor), y la página a la que lleva
--     tiene que hablar el mismo;
--   · si quien lo abre con sesión es MIEMBRO de ese workspace. El correo
--     sale del Gmail del creador y el enlace queda en su carpeta de
--     enviados: su clic suprimiría a la marca en toda la plataforma
--     (docs/ventas-outreach.md §5.2, «Obligatorio para VEN-15»). La web
--     no puede leer outbound_optout_link; esta función sí, por el sha256
--     del token, y responde un sí o un no: el id del workspace no sale.
--
-- Solo LEE. Misma forma que public_optout (0037 §9): SECURITY DEFINER de
-- mc_public_share, políticas `TO mc_public_share` que abren solo lo que
-- la función fija en parámetros de la transacción, y se restauran al
-- salir. Lo nuevo que el rol puede leer:
--   workspace   id, name y locale, solo la fila que fija
--               app.public_optout_workspace (el workspace del enlace);
--   membership  workspace_id y user_id, que no le abren ninguna fila: los
--               pide workspace_read_member (0028), la política sin TO de
--               workspace, que también le alcanza al leerlo, y las
--               políticas de membership solo abren la sesión o el
--               workspace fijados, que este rol no tiene.
--
-- Respuesta:
--   {"status":"not_found"}
--   {"status":"ok","maskedAddress":"v•••@marca.com","senderName":"…"|null,
--    "locale":"es-CO"|null,"isSender":bool,"alreadyOptedOut":bool}

GRANT CREATE ON SCHEMA public TO mc_public_share;   -- solo mientras dura la migración (ver 0030 §1)

GRANT SELECT (id, name, locale) ON workspace TO mc_public_share;
GRANT SELECT (workspace_id, user_id) ON membership TO mc_public_share;

CREATE POLICY workspace_public_optout ON workspace
  FOR SELECT TO mc_public_share
  USING (id = nullif(current_setting('app.public_optout_workspace', true), '')::uuid);

CREATE FUNCTION public_optout_preview(p_token text, p_viewer_workspaces uuid[] DEFAULT '{}')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  antes_token     text := coalesce(current_setting('app.public_optout', true), '');
  antes_contacts  text := coalesce(current_setting('app.public_optout_contacts', true), '');
  antes_email     text := coalesce(current_setting('app.public_optout_email', true), '');
  antes_workspace text := coalesce(current_setting('app.public_optout_workspace', true), '');
  resumen   text;
  enlace    outbound_optout_link%ROWTYPE;
  direccion text;
  nombre    text;
  idioma    text;
  ya_baja   boolean;
  r         jsonb;
BEGIN
  IF p_token IS NULL OR length(p_token) < 16 OR length(p_token) > 200 THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  resumen := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');

  BEGIN
    PERFORM set_config('app.public_optout', resumen, true);
    SELECT * INTO enlace FROM outbound_optout_link l WHERE l.token_hash = resumen;

    IF NOT FOUND THEN
      r := jsonb_build_object('status', 'not_found');
    ELSE
      direccion := enlace.recipient_address::text;
      PERFORM set_config('app.public_optout_contacts', format('{%s}', enlace.contact_id), true);
      PERFORM set_config('app.public_optout_email', direccion, true);
      PERFORM set_config('app.public_optout_workspace', coalesce(enlace.workspace_id::text, ''), true);

      -- «Ya estabas fuera» es de ESTE remitente (r3, §8): la ficha que
      -- recibió el correo ya de baja, o la dirección ya en la lista de
      -- ese workspace. Que otro creador tenga su propia ficha de baja no
      -- dice nada de este.
      SELECT c.opted_out INTO ya_baja FROM contact c WHERE c.id = enlace.contact_id;
      ya_baja := coalesce(ya_baja, false)
                 OR EXISTS (SELECT 1 FROM outbound_workspace_optout o
                             WHERE o.workspace_id = enlace.workspace_id AND o.email = enlace.recipient_address);
      SELECT w.name, w.locale INTO nombre, idioma FROM workspace w WHERE w.id = enlace.workspace_id;

      r := jsonb_build_object(
        'status', 'ok',
        -- La regla de maskEmailAddress (@mc/core/outreach/deliverability).
        'maskedAddress', lower(left(direccion, 1) || '•••' || substr(direccion, strpos(direccion, '@'))),
        'senderName', nombre,
        'locale', idioma,
        'isSender', coalesce(enlace.workspace_id = ANY (coalesce(p_viewer_workspaces, '{}'::uuid[])), false),
        'alreadyOptedOut', coalesce(ya_baja, false));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.public_optout', antes_token, true);
    PERFORM set_config('app.public_optout_contacts', antes_contacts, true);
    PERFORM set_config('app.public_optout_email', antes_email, true);
    PERFORM set_config('app.public_optout_workspace', antes_workspace, true);
    RAISE;
  END;

  PERFORM set_config('app.public_optout', antes_token, true);
  PERFORM set_config('app.public_optout_contacts', antes_contacts, true);
  PERFORM set_config('app.public_optout_email', antes_email, true);
  PERFORM set_config('app.public_optout_workspace', antes_workspace, true);
  RETURN r;
END;
$$;

COMMENT ON FUNCTION public_optout_preview(text, uuid[]) IS
  'Lo que la página de baja enseña antes del clic (VEN-15): la dirección enmascarada a la que salió el correo del '
  'enlace, el nombre y el idioma del workspace que lo envió, si ya estaba de baja, y si quien lo abre (sus workspaces) es de '
  'ese workspace. Solo lee, por el sha256 del token. SECURITY DEFINER de mc_public_share (0037 §9, 0038 §5).';

REVOKE ALL ON FUNCTION public_optout_preview(text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_optout_preview(text, uuid[]) TO mc_app;
ALTER FUNCTION public_optout_preview(text, uuid[]) OWNER TO mc_public_share;

REVOKE CREATE ON SCHEMA public FROM mc_public_share;

-- ---------------------------------------------------------------------
-- 6 · Hasta dónde se leyó el buzón de rebotes de cada cuenta (r3)
-- ---------------------------------------------------------------------
-- El job outbound.bounces lee los avisos del Gmail de cada cuenta
-- conectada DESDE AQUÍ, del más viejo al más nuevo, y lo avanza solo
-- hasta el último aviso que leyó de verdad. Antes el cursor salía de
-- max(received_at) de outbound_bounce: no avanzaba con los avisos que
-- no eran rebotes, y con más de cien avisos en media hora los más viejos
-- quedaban detrás de él y no se leían nunca. NULL = nunca se leyó (la
-- primera lectura va BOUNCES_FIRST_LOOKBACK_H hacia atrás).
--
-- Lo escribe solo el worker: el mismo candado por disparador que las
-- columnas del proveedor (0037 §2.1). Desde la web, mover el cursor
-- hacia adelante escondería rebotes.
ALTER TABLE outreach_channel_account ADD COLUMN bounces_read_at timestamptz;

COMMENT ON COLUMN outreach_channel_account.bounces_read_at IS
  'Hasta cuándo se leyeron los avisos de rebote del buzón de esta cuenta (VEN-15, job outbound.bounces). '
  'La escribe solo el worker; NULL = nunca se leyó.';

CREATE FUNCTION outreach_channel_account_bounces_cursor()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF ((TG_OP = 'INSERT' AND NEW.bounces_read_at IS NOT NULL)
      OR (TG_OP = 'UPDATE' AND NEW.bounces_read_at IS DISTINCT FROM OLD.bounces_read_at))
     AND NOT outreach_is_dispatcher() THEN
    RAISE EXCEPTION 'El cursor de rebotes de una cuenta lo mueve el worker, no la aplicación (rol %).', current_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outreach_channel_account_bounces_cursor
  BEFORE INSERT OR UPDATE OF bounces_read_at ON outreach_channel_account
  FOR EACH ROW EXECUTE FUNCTION outreach_channel_account_bounces_cursor();

-- ---------------------------------------------------------------------
-- 7 · La política de envío la cambia quien administra el espacio (r3)
-- ---------------------------------------------------------------------
-- Encender el envío automático a marcas, subir el tope a 2.000 correos
-- al día o quitar la revisión humana es la decisión de cumplimiento más
-- delicada del módulo, y 0017 dejaba escribir outbound_policy a
-- cualquier miembro del workspace, también a 'viewer' y 'client' (0001).
-- Ahora, para mc_app, escribir la política (guardarla, y encender o
-- apagar con enable_outreach / disable_outreach, que la escriben con los
-- privilegios de quien llama) pide ser 'owner' o 'admin' del workspace.
--
-- Son políticas RESTRICTIVE: se suman con AND a outbound_policy_ws_isolation
-- (0017), que sigue decidiendo QUÉ fila es del workspace. La de UPDATE
-- deja ver la fila (USING true) y exige el rol en la fila nueva: así el
-- rechazo es un error explícito (42501, «new row violates row-level
-- security policy») y no un UPDATE que no encuentra nada, que
-- enable_outreach leería como «sin dirección postal».
--
-- Falla CERRADA (r4). Sin identidad en la transacción (app.user_id NULL)
-- no hay roles que mirar, y la respuesta es NO, salvo que la transacción
-- traiga la bandera explícita app.auth_disabled = 'on'. La fija el
-- cliente de @mc/db (DbOptions.authDisabled) solo donde de verdad no
-- existe ningún usuario: la web sin Supabase Auth (lib/db/cliente.ts,
-- cuando authConfig() es null) y las pruebas (openTestDb). Así, una ruta
-- futura que abra withWorkspace sin identidad con Supabase Auth
-- configurado (un cron de Vercel, un webhook, un route handler) recibe
-- 42501 en vez de saltarse la regla sin que nadie lo note. La bandera no
-- es una frontera contra código hostil —quien tiene mc_app puede fijar
-- cualquier parámetro, también app.user_id—, sino contra el olvido.
-- El worker (BYPASSRLS) y quien migra (las políticas son TO mc_app) no
-- cambian: el disyuntor del worker sigue apagando el envío.
CREATE FUNCTION outreach_can_manage(p_workspace uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT (current_user_id() IS NULL AND coalesce(current_setting('app.auth_disabled', true), '') = 'on')
      OR EXISTS (SELECT 1 FROM membership m
                  WHERE m.workspace_id = p_workspace
                    AND m.user_id = current_user_id()
                    AND m.role IN ('owner', 'admin'));
$$;

COMMENT ON FUNCTION outreach_can_manage(uuid) IS
  'Si quien está en la transacción puede cambiar la política de envío del workspace: owner o admin (VEN-15 r3). '
  'Sin identidad responde que no, salvo con app.auth_disabled = ''on'' (desarrollo sin Supabase Auth, pruebas: '
  'lo fija el cliente de @mc/db). Corre con los privilegios de quien llama: mc_app solo ve las membresías del '
  'workspace fijado.';

CREATE POLICY outbound_policy_manage_insert ON outbound_policy AS RESTRICTIVE
  FOR INSERT TO mc_app
  WITH CHECK (outreach_can_manage(workspace_id));
CREATE POLICY outbound_policy_manage_update ON outbound_policy AS RESTRICTIVE
  FOR UPDATE TO mc_app
  USING (true)
  WITH CHECK (outreach_can_manage(workspace_id));
CREATE POLICY outbound_policy_manage_delete ON outbound_policy AS RESTRICTIVE
  FOR DELETE TO mc_app
  USING (outreach_can_manage(workspace_id));

-- =====================================================================
-- 8 · La baja por enlace, en dos tiempos (r3)
-- ---------------------------------------------------------------------
-- El correo sale del Gmail del creador y el enlace de baja queda en SU
-- carpeta de enviados. La página rechaza el clic que llega con una
-- sesión del workspace que envió (§5), pero en una ventana privada, o
-- con `curl -X POST …/un-clic`, el propio remitente suprimía a la marca
-- para TODOS los creadores de la plataforma: public_optout (0037 §9) la
-- metía en contact_suppression al primer clic. Era una vía de sabotaje
-- entre inquilinos (docs/ventas-outreach.md §5.2).
--
-- Ahora la baja por enlace va en dos tiempos:
--
--   1. El clic vale YA para el workspace que envió ese correo: la
--      dirección entra en outbound_workspace_optout (este workspace no
--      le vuelve a escribir, por ningún canal), se cancela lo pendiente
--      y se cierran los enrolamientos de ESE workspace, y se marca
--      opted_out la ficha si es propia de ese workspace. Es lo que la
--      ley pide (CAN-SPAM, RGPD: la baja es con quien envía) y lo que
--      la persona pidió al pulsar el enlace de ese correo. Una ficha
--      compartida (contacto global, owner_workspace_id NULL) no se
--      marca: el freno es la fila de este workspace (§8.3).
--
--   2. La baja pasa a TODA la plataforma (contact_suppression con
--      'unsubscribe_link', las fichas marcadas y lo pendiente cancelado
--      en cualquier workspace, como hacía 0037) cuando la confirma un
--      SEGUNDO workspace DE OTRAS PERSONAS: la misma dirección pulsa el
--      enlace de un correo de otro creador. Eso el remitente no lo puede
--      fabricar: necesita que otro workspace le haya escrito de verdad a
--      esa dirección (el enlace solo existe si el despachador lo
--      reclamó), y desde r4 que ese workspace no comparta NINGÚN miembro
--      con el suyo. Sin esto, una agencia (o cualquier persona miembro de
--      dos espacios) que escribe a la misma marca desde los dos pulsaba
--      sus dos enlaces sin sesión y la suprimía para todos los creadores.
--      Lo que sigue abierto es el sabotaje con dos cuentas de personas
--      distintas en connivencia; eso ya no es un clic, y queda en
--      outbound_optout_event para la alerta y para deshacerlo.
--
-- Por qué no «pasa a global si en una ventana no hay señal de que fue el
-- remitente»: la única señal sería la IP o el navegador de una sesión
-- reciente de sus miembros, y la plataforma no guarda ninguna de las
-- dos (audit_log.ip no se escribe en cada petición). Con una ventana, el
-- remitente en una ventana privada o por VPN volvía a suprimir a la
-- marca para todos, solo que una hora más tarde.
--
-- Cada clic sigue en outbound_optout_event, ahora con su alcance
-- (scope): 'workspace' o 'global'.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 8.1 · outbound_workspace_optout: a quién no le vuelve a escribir un workspace
-- ---------------------------------------------------------------------
--   email       la dirección a la que salió el correo del enlace
--               (outbound_optout_link.recipient_address)
--   token_hash  el enlace que la puso aquí (el primero)
-- La escribe public_optout y nadie más (mc_app no tiene INSERT). La web
-- la lee con su RLS para la regla de §8.3 y para la ficha.
CREATE TABLE outbound_workspace_optout (
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  email         citext NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  token_hash    text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, email)
);
CREATE INDEX ON outbound_workspace_optout (email);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'outbound_workspace_optout' AND column_name = 'workspace_id'
  ) THEN
    RAISE EXCEPTION 'outbound_workspace_optout está en la lista de RLS pero no tiene workspace_id';
  END IF;
END $$;
ALTER TABLE outbound_workspace_optout ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_workspace_optout FORCE ROW LEVEL SECURITY;
CREATE POLICY outbound_workspace_optout_ws_read ON outbound_workspace_optout FOR SELECT
  USING (workspace_id = current_workspace_id());
REVOKE INSERT, UPDATE, DELETE ON outbound_workspace_optout FROM mc_app;

COMMENT ON TABLE outbound_workspace_optout IS
  'La baja por enlace con efecto en el workspace que envió el correo (VEN-15 r3). La escribe public_optout; con dos '
  'workspaces sin miembros en común para la misma dirección, la baja pasa a contact_suppression (toda la plataforma).';

-- Lo que la baja lee y escribe aquí, con la misma cerradura que 0037 §9:
-- las filas de la dirección que fija la función, y el alta solo para el
-- workspace y el token del enlace que se está pulsando.
GRANT SELECT (workspace_id, email), INSERT ON outbound_workspace_optout TO mc_public_share;

-- Quién confirma (r4): para saber si dos workspaces comparten miembro,
-- public_optout lee las membresías del workspace del enlace y de los
-- workspaces que ya anotaron la baja de ESA dirección, y nada más. Los
-- fija en app.public_optout_members (una lista de uuid, como
-- app.public_optout_contacts) y los restaura al salir. Las columnas
-- (workspace_id, user_id) ya son suyas desde §5.
CREATE POLICY membership_public_optout ON membership
  FOR SELECT TO mc_public_share
  USING (workspace_id = ANY (nullif(current_setting('app.public_optout_members', true), '')::uuid[]));

CREATE POLICY outbound_workspace_optout_public_optout_read ON outbound_workspace_optout
  FOR SELECT TO mc_public_share
  USING (email = nullif(current_setting('app.public_optout_email', true), '')::citext);

CREATE POLICY outbound_workspace_optout_public_optout ON outbound_workspace_optout
  FOR INSERT TO mc_public_share
  WITH CHECK (token_hash = nullif(current_setting('app.public_optout', true), '')
              AND workspace_id = nullif(current_setting('app.public_optout_workspace', true), '')::uuid
              AND email = nullif(current_setting('app.public_optout_email', true), '')::citext);

-- El alcance de cada clic. Los de antes de r3 fueron globales.
ALTER TABLE outbound_optout_event
  ADD COLUMN scope text NOT NULL DEFAULT 'global' CHECK (scope IN ('workspace', 'global'));
COMMENT ON COLUMN outbound_optout_event.scope IS
  'workspace: la baja valió solo para el workspace que envió el correo; global: pasó a contact_suppression (VEN-15 r3).';

-- ---------------------------------------------------------------------
-- 8.2 · public_optout, en dos tiempos
-- ---------------------------------------------------------------------
-- La misma puerta que 0037 §9 (el mismo rol, las mismas políticas, los
-- parámetros restaurados al salir) y la misma respuesta, con «scope»:
--   {"status":"ok","alreadyOptedOut":bool,"scope":"workspace"|"global",
--    "workspaceId":"…"|null,"touchId":"…"|null}
-- alreadyOptedOut dice si ESTE remitente ya no le escribía (un segundo
-- clic del mismo enlace, o de otro correo del mismo workspace).
GRANT CREATE ON SCHEMA public TO mc_public_share;   -- solo mientras dura la migración (ver 0030 §1)
CREATE OR REPLACE FUNCTION public_optout(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  antes_token     text := coalesce(current_setting('app.public_optout', true), '');
  antes_contacts  text := coalesce(current_setting('app.public_optout_contacts', true), '');
  antes_email     text := coalesce(current_setting('app.public_optout_email', true), '');
  antes_workspace text := coalesce(current_setting('app.public_optout_workspace', true), '');
  antes_members   text := coalesce(current_setting('app.public_optout_members', true), '');
  resumen   text;
  enlace    outbound_optout_link%ROWTYPE;
  espacios  uuid[];
  ya_ficha  boolean;
  ya_aqui   boolean;
  ya        boolean;
  remitentes int;
  es_global boolean;
  nuevas    int;
  ids       uuid[];
  r         jsonb;
BEGIN
  -- El token lo genera el despachador al azar (al menos 128 bits en
  -- base64url o hex); lo que no tenga esa forma no se busca.
  IF p_token IS NULL OR length(p_token) < 16 OR length(p_token) > 200 THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  resumen := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');

  BEGIN
    PERFORM set_config('app.public_optout', resumen, true);
    -- El enlace, y solo el enlace: ni el estado del toque ni que exista.
    SELECT * INTO enlace FROM outbound_optout_link l WHERE l.token_hash = resumen;

    IF NOT FOUND THEN
      r := jsonb_build_object('status', 'not_found');
    ELSE
      PERFORM set_config('app.public_optout_contacts', format('{%s}', enlace.contact_id), true);
      PERFORM set_config('app.public_optout_email', enlace.recipient_address::text, true);
      PERFORM set_config('app.public_optout_workspace', coalesce(enlace.workspace_id::text, ''), true);

      -- ¿Este remitente ya no le escribía? La ficha que recibió el correo
      -- ya de baja (propia de ese workspace, o una global ya suprimida),
      -- o la dirección ya en la lista de ese workspace.
      SELECT c.opted_out INTO ya_ficha FROM contact c WHERE c.id = enlace.contact_id;
      SELECT EXISTS (SELECT 1 FROM outbound_workspace_optout o
                      WHERE o.workspace_id = enlace.workspace_id AND o.email = enlace.recipient_address)
        INTO ya_aqui;

      -- 1 · Para el workspace que envió, ya. (Si ese workspace se borró,
      -- no queda nadie que le escriba desde él.)
      IF enlace.workspace_id IS NOT NULL THEN
        INSERT INTO outbound_workspace_optout (workspace_id, email, token_hash)
        VALUES (enlace.workspace_id, enlace.recipient_address, resumen)
        ON CONFLICT DO NOTHING;
      END IF;

      -- 2 · Para toda la plataforma, cuando lo confirma otro workspace DE
      -- OTRAS PERSONAS (r4): cuenta el del enlace y los que ya anotaron la
      -- baja sin compartir ningún miembro con él. Una persona con dos
      -- espacios que pulsa sus dos enlaces sigue en 'workspace'. Un
      -- workspace que ya no existe cuenta como el remitente que fue (su
      -- fila se fue con él): su enlace confirma la baja que otro anotó.
      -- Las membresías que hacen falta, y ninguna más, las abre
      -- membership_public_optout con esta lista.
      SELECT array_agg(DISTINCT o.workspace_id) INTO espacios
        FROM outbound_workspace_optout o
       WHERE o.email = enlace.recipient_address;
      PERFORM set_config('app.public_optout_members',
                         format('{%s}', array_to_string(array_append(coalesce(espacios, '{}'::uuid[]), enlace.workspace_id), ',')),
                         true);
      SELECT count(DISTINCT o.workspace_id) INTO remitentes
        FROM outbound_workspace_optout o
       WHERE o.email = enlace.recipient_address
         AND (o.workspace_id = enlace.workspace_id
              OR NOT EXISTS (SELECT 1
                               FROM membership m1
                               JOIN membership m2 ON m1.user_id = m2.user_id
                              WHERE m1.workspace_id = o.workspace_id
                                AND m2.workspace_id = enlace.workspace_id));
      es_global := remitentes + CASE WHEN enlace.workspace_id IS NULL THEN 1 ELSE 0 END >= 2;

      IF es_global THEN
        -- Lo de 0037: la ficha del correo y las fichas con esa dirección
        -- en cualquier workspace.
        SELECT array_agg(DISTINCT c.id) INTO ids
          FROM contact c
         WHERE c.id = enlace.contact_id OR c.email = enlace.recipient_address;
        -- Sin columna en ON CONFLICT a propósito: nombrarla pediría SELECT
        -- sobre la lista, y este rol solo inserta en ella.
        INSERT INTO contact_suppression (email, reason) VALUES (enlace.recipient_address, 'unsubscribe_link')
        ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS nuevas = ROW_COUNT;
      ELSE
        -- Solo lo de ese workspace: la ficha del correo y sus fichas
        -- propias con esa dirección. La RLS de 9.2 (0037) abre todas las
        -- que se nombran, y la condición de cada UPDATE de abajo acota.
        SELECT array_agg(DISTINCT c.id) INTO ids
          FROM contact c
         WHERE c.id = enlace.contact_id
            OR (c.email = enlace.recipient_address AND c.owner_workspace_id = enlace.workspace_id);
        nuevas := 0;
      END IF;
      ids := coalesce(ids, '{}'::uuid[]);
      -- Ya estaba: este remitente ya no le escribía, o la dirección ya
      -- estaba en la lista global (el INSERT no entró).
      ya := coalesce(ya_aqui, false) OR coalesce(ya_ficha, false) OR (es_global AND nuevas = 0);
      PERFORM set_config('app.public_optout_contacts', format('{%s}', array_to_string(ids, ',')), true);

      -- Quién la provocó, y con qué alcance (4.6 de 0037, 8.1).
      INSERT INTO outbound_optout_event (token_hash, workspace_id, touch_id, recipient_address, claimed_at,
                                         sent_at, already_opted_out, scope)
      VALUES (resumen, enlace.workspace_id, enlace.touch_id, enlace.recipient_address, enlace.claimed_at,
              enlace.sent_at, ya,
              CASE WHEN es_global THEN 'global' ELSE 'workspace' END);

      -- Las fichas: todas si es global; si no, solo las PROPIAS del
      -- workspace que envió. Una ficha compartida no se marca por el clic
      -- de un solo remitente: la frena su fila de 8.1 (regla de 8.3).
      UPDATE contact
         SET opted_out = true,
             opted_out_at = coalesce(opted_out_at, now()),
             -- Un código, no una frase (r4): la ficha lo traduce en el idioma
             -- del espacio (ventas/_lib/messages.ts, contacto.optedOutReasons).
             opted_out_reason = coalesce(opted_out_reason, 'unsubscribe_link')
       WHERE id = ANY (ids) AND NOT opted_out
         AND (es_global OR owner_workspace_id = enlace.workspace_id);

      -- CANCELABLE_TOUCH_STATUSES: todo lo que puede salir menos lo que
      -- el despachador ya reclamó (processing, 0037 §4.1).
      UPDATE outbound_touch
         SET status = 'canceled', blocked_reason = 'opted_out'
       WHERE contact_id = ANY (ids)
         AND status IN ('draft', 'scheduled', 'held')
         AND (es_global OR workspace_id = enlace.workspace_id);

      UPDATE outbound_enrollment
         SET status = 'opted_out', finished_at = coalesce(finished_at, now())
       WHERE contact_id = ANY (ids)
         AND status IN ('active', 'paused', 'cooldown')
         AND (es_global OR workspace_id = enlace.workspace_id);

      r := jsonb_build_object('status', 'ok',
                              'alreadyOptedOut', ya,
                              'scope', CASE WHEN es_global THEN 'global' ELSE 'workspace' END,
                              'workspaceId', enlace.workspace_id, 'touchId', enlace.touch_id);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.public_optout', antes_token, true);
    PERFORM set_config('app.public_optout_contacts', antes_contacts, true);
    PERFORM set_config('app.public_optout_email', antes_email, true);
    PERFORM set_config('app.public_optout_workspace', antes_workspace, true);
    PERFORM set_config('app.public_optout_members', antes_members, true);
    RAISE;
  END;

  PERFORM set_config('app.public_optout', antes_token, true);
  PERFORM set_config('app.public_optout_contacts', antes_contacts, true);
  PERFORM set_config('app.public_optout_email', antes_email, true);
  PERFORM set_config('app.public_optout_workspace', antes_workspace, true);
  PERFORM set_config('app.public_optout_members', antes_members, true);
  RETURN r;
END;
$$;

COMMENT ON FUNCTION public_optout(text) IS
  'Baja desde el enlace de un correo (VEN-9, VEN-15 r3), en dos tiempos: vale ya para el workspace que envió ese '
  'correo (outbound_workspace_optout, su ficha propia, sus toques y enrolamientos) y pasa a contact_suppression, con '
  'las fichas y lo pendiente de cualquier workspace, cuando otro workspace la confirma. Busca el sha256 del token en '
  'outbound_optout_link y deja el clic en outbound_optout_event. SECURITY DEFINER de mc_public_share (0037 §9, 0038 §8).';

REVOKE ALL ON FUNCTION public_optout(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_optout(text) TO mc_app;
ALTER FUNCTION public_optout(text) OWNER TO mc_public_share;

REVOKE CREATE ON SCHEMA public FROM mc_public_share;

-- ---------------------------------------------------------------------
-- 8.3 · Lo que un workspace ya no puede programar
-- ---------------------------------------------------------------------
-- Una sola regla de la baja para los toques (r5). Hasta r4 la baja del
-- workspace tenía su propio disparador, que solo miraba la ENTRADA en
-- 'scheduled' y se saltaba la vuelta desde 'processing'. Con un contacto
-- global (owner_workspace_id NULL, que la baja del workspace no marca)
-- la regla de 0037 tampoco lo frenaba: un toque de LinkedIn reclamado al
-- pulsar la baja volvía a la cola con el reintento o el rescate del
-- zombi, se reclamaba otra vez y salía como 'sent' con blocked_reason
-- NULL. La persona había pedido no recibir nada, por ningún canal.
--
-- Ahora outbound_workspace_optout es una fuente más de
-- enforce_outbound_optout (0037 §4.1), con las mismas transiciones que
-- la ficha dada de baja y la lista global: un toque de CUALQUIER canal
-- no entra en 'scheduled', 'processing' ni 'sent' si su workspace tiene
-- la dirección de su ficha, o la del envío, en outbound_workspace_optout.
-- La excepción es la de siempre: processing → sent se registra con
-- blocked_reason = 'opted_out_in_flight'. Y la vuelta processing →
-- scheduled no se rechaza: se cancela en el sitio con blocked_reason =
-- 'opted_out' (como §2 con el correo inválido), para
-- que un zombi dado de baja no aborte el rescate por lotes. El despachador de VEN-10
-- descubre la baja porque la base le rechaza el reclamo; su consulta de
-- reclamo filtra también outbound_workspace_optout y pasa esas filas a
-- 'canceled' (docs/ventas-outreach.md §5.2).
--
-- mc_app lee outbound_workspace_optout con su RLS (el workspace del
-- toque es el de la transacción); el worker, sin ella. El mensaje del
-- error distingue la baja de este workspace de la global.
CREATE OR REPLACE FUNCTION enforce_outbound_optout()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  is_out     boolean := false;
  del_espacio boolean := false;
  correo     citext;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.contact_id IS NOT DISTINCT FROM OLD.contact_id
     AND NEW.recipient_address IS NOT DISTINCT FROM OLD.recipient_address THEN
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('scheduled', 'processing', 'sent') THEN
    RETURN NEW;
  END IF;
  -- Lo que no es enviar a nadie nuevo pasa (0037 §4.1): un toque que ya
  -- estaba en 'sent' y sigue ahí, y soltar la ficha sin cambiar ni el
  -- estado ni la dirección.
  IF TG_OP = 'UPDATE' AND OLD.status = 'sent' AND NEW.status = 'sent' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.contact_id IS NULL
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.recipient_address IS NOT DISTINCT FROM OLD.recipient_address THEN
    RETURN NEW;
  END IF;

  IF NEW.contact_id IS NOT NULL THEN
    SELECT c.opted_out, c.email INTO is_out, correo FROM contact c WHERE c.id = NEW.contact_id;
  END IF;
  is_out := coalesce(is_out, false)
            OR address_is_suppressed(correo)
            OR address_is_suppressed(NEW.recipient_address);
  IF NOT is_out THEN
    del_espacio := EXISTS (
      SELECT 1 FROM outbound_workspace_optout o
       WHERE o.workspace_id = NEW.workspace_id
         AND (o.email = correo OR o.email = NEW.recipient_address));
  END IF;
  IF NOT is_out AND NOT del_espacio THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'sent' AND TG_OP = 'UPDATE' AND OLD.status = 'processing'
     AND NEW.contact_id IS NOT DISTINCT FROM OLD.contact_id THEN
    NEW.blocked_reason := 'opted_out_in_flight';
    RETURN NEW;
  END IF;

  -- La vuelta a la cola de lo reclamado (el reintento, o el rescate de
  -- un zombi) se CANCELA en el sitio, igual que §2 con el correo
  -- inválido. El rescate de VEN-10 devuelve a la cola con un solo UPDATE
  -- por lote: si esto lanzara check_violation, un solo zombi de alguien
  -- que pulsó la baja abortaría el rescate entero, de todos los
  -- workspaces, en cada pasada, y esos toques se quedarían en
  -- 'processing' para siempre.
  IF TG_OP = 'UPDATE' AND OLD.status = 'processing' AND NEW.status = 'scheduled' THEN
    NEW.status := 'canceled';
    NEW.blocked_reason := 'opted_out';
    RETURN NEW;
  END IF;

  IF del_espacio THEN
    RAISE EXCEPTION 'La persona de la ficha % pidió no recibir más mensajes de este espacio.',
                    coalesce(NEW.contact_id::text, NEW.recipient_address::text)
      USING ERRCODE = 'check_violation',
            HINT = 'Pulsó el enlace de baja de un correo de este espacio (outbound_workspace_optout).';
  END IF;
  RAISE EXCEPTION 'El contacto % pidió no ser contactado (opt-out).', coalesce(NEW.contact_id::text, NEW.recipient_address::text)
    USING ERRCODE = 'check_violation',
          HINT = 'La ficha está dada de baja, o su correo o la dirección del envío están en la baja global.';
END;
$$;

-- Y la entrada de un enrolamiento en active, paused o cooldown: a quien
-- pidió la baja de este workspace no se le enrola ni se le reanuda.
CREATE FUNCTION outbound_workspace_optout_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  correo citext;
BEGIN
  IF NEW.status NOT IN ('active', 'paused', 'cooldown')
     OR (TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status
         AND NEW.contact_id IS NOT DISTINCT FROM OLD.contact_id) THEN
    RETURN NEW;
  END IF;
  IF NEW.contact_id IS NOT NULL THEN
    SELECT c.email INTO correo FROM contact c WHERE c.id = NEW.contact_id;
  END IF;
  IF correo IS NOT NULL AND EXISTS (SELECT 1 FROM outbound_workspace_optout o
              WHERE o.workspace_id = NEW.workspace_id AND o.email = correo) THEN
    RAISE EXCEPTION 'La persona de la ficha % pidió no recibir más mensajes de este espacio.', NEW.contact_id
      USING ERRCODE = 'check_violation',
            HINT = 'Pulsó el enlace de baja de un correo de este espacio (outbound_workspace_optout).';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbound_enrollment_workspace_optout
  BEFORE INSERT OR UPDATE OF contact_id, status ON outbound_enrollment
  FOR EACH ROW EXECUTE FUNCTION outbound_workspace_optout_check();
