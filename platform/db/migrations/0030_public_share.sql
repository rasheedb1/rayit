-- =====================================================================
-- 0030 · Enlaces públicos de Cotizar: media kit y cotización
--        (COT-2, COT-3, COT-4)
-- ---------------------------------------------------------------------
-- Número: 0022 es de CON-10 (0022_public_profile_access, en main y
-- aplicada), 0023 está reservada para ACC-3, 0024–0026 y 0029 son del
-- pase de endurecimiento de RLS y 0027/0028 de CIM-3. Esta migración
-- nació en dos archivos (0022 + 0023 de las rondas 1 y 2 de Cotizar,
-- ninguno aplicado), llegó a rasheed/integracion como 0026 y pasó a
-- 0030 al integrar el endurecimiento, que ya tenía su propia 0026. No
-- se había aplicado en ninguna base persistente. Aquí van fundidos en
-- el estado final, sin el paso intermedio de políticas abiertas que el
-- segundo corregía. Va la última: cuenta con 0024 (aislamiento por
-- defecto: sus políticas llevan TO), 0025 (disparadores de referencias)
-- y 0029.
--
-- El problema: /kit/<slug> y /cotizacion/<slug> se abren SIN sesión y
-- sin workspace, y media_kit, quote y deal llevan RLS con FORCE. Sin
-- workspace fijado, current_workspace_id() es NULL y la página pública
-- no ve nada; con un workspace fijado desde la URL, cualquiera leería
-- el del vecino. Ninguna de las dos sirve.
--
-- La salida tiene tres piezas:
--
--   · La PUERTA: tres funciones SECURITY DEFINER, una por acción
--     pública (abrir el media kit, abrir la cotización, aceptarla). La
--     web las llama como mc_app desde una transacción sin workspace
--     (lib/db · withPublicShare). Reciben el slug y devuelven jsonb ya
--     recortado, nunca la fila entera.
--   · El ROL: las funciones son de mc_public_share —NOLOGIN, sin
--     BYPASSRLS, con privilegios de COLUMNA, los justos para sumar una
--     visita, marcar vista, vencida o aceptada y pasar el deal a
--     «Ganado» con su historial—. Aunque una función tuviera un error,
--     no podría tocar el total de una cotización ni el nombre de un
--     deal: Postgres se lo niega.
--   · La CERRADURA: políticas `TO mc_public_share` que abren
--     exactamente la fila cuyo slug está en `app.public_share`. Para
--     mc_app ese parámetro no significa nada: fijarlo a mano en una
--     transacción de la aplicación no abre ninguna fila (lo fija «la
--     sonda» de packages/db/test/cotizar.test.ts).
--
-- Cada función fija `app.public_share` al entrar y lo RESTAURA al salir,
-- también si algo lanza (bloque EXCEPTION), así que el permiso no
-- sobrevive a la llamada. Sería más corto con la cláusula
-- `SET "app.public_share" = ''` de CREATE FUNCTION, que Postgres
-- restaura solo; no se puede: guardar un parámetro en proconfig pide
-- privilegio sobre ese parámetro, y mc_migrator no es superusuario.
--
-- El slug ES la credencial, como en el compartir de Notion o en una
-- factura alojada de Stripe: 26 signos aleatorios (≈128 bits) que no se
-- enumeran. La contraseña opcional se compara por su derivado (scrypt
-- con sal por fila, 's1:<sal hex>:<scrypt hex>'); la contraseña en claro
-- no llega nunca a la base.
--
-- Bloqueo por contraseñas fallidas, en DOS niveles, contados en la base
-- (cuentan igual caiga donde caiga la petición):
--
--   · POR ORIGEN: 10 fallos desde un mismo origen (la IP de la petición)
--     bloquean ESE origen 15 minutos. La marca que escribe bien desde
--     otro sitio no se entera. Vive en media_kit_lockout, una fila por
--     media kit y origen, y el origen se guarda como sha256(id del kit |
--     IP), nunca la IP: la función la recibe como argumento y no la
--     escribe. mc_app no puede leer ese resumen (privilegio de COLUMNA:
--     solo media_kit_id y locked_until, lo justo para contar y borrar).
--     Las filas viejas se podan en cada fallo.
--   · POR ENLACE, como techo: 50 fallos en una hora, sumando todos los
--     orígenes, bloquean el enlace entero 15 minutos
--     (media_kit.failed_attempts, failed_since y locked_until). Es lo
--     que para a quien rota IPs, o a quien falsea X-Forwarded-For
--     detrás de un proxy que no lo reescribe, para adivinar la
--     contraseña: sin él, cada origen nuevo traería 10 intentos más.
--
-- El compromiso que queda, dicho: quien tenga el enlace y reparta sus
-- intentos entre cinco o más IPs puede disparar el techo y dejar fuera
-- a la marca 15 minutos cada vez. Ya no basta una máquina, y el creador
-- se ENTERA sin esperar a que la marca se queje: al saltar el techo la
-- función devuelve el kit y su workspace, y el servidor le deja un aviso
-- (notification 'media_kit_locked') con «Desbloquear» en Cotizar
-- (pulido r6). Y lo VE: /cotizar/media-kit enseña «Bloqueado hasta …» (y cuántas
-- visitas tienen su origen bloqueado) con un botón «Desbloquear» que
-- pone a cero los dos niveles (queries/cotizar · unlockMediaKit). Si el
-- abuso sigue, la salida es generar otro media kit: el enlace nuevo no
-- lo tiene quien ataca. Un acierto borra la cuenta de SU origen pero no
-- la del enlace, que se vacía sola al pasar la hora: si no, quien
-- supiera la contraseña podría abrirle 50 intentos más a quien no.
--
-- Delante hay además un límite por enlace e IP en el servidor (5
-- intentos por minuto, apps/web/app/(app)/cotizar/_lib/limite.ts), que
-- ahorra el scrypt a quien insiste desde una máquina. Es POR INSTANCIA y
-- de mejor esfuerzo (en Vercel cada instancia serverless tiene el suyo):
-- no es la barrera, la barrera es la de la base.
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
-- crea el rol antes (packages/db/src/embedded.ts).
--
-- Convivencia con el pase de endurecimiento (0024/0025): 0025 pone un
-- disparador assert_reference_visible en cada clave ajena hacia una
-- tabla con RLS, que corre con los permisos de quien escribe. Al
-- aceptar, mc_public_share cambia deal.stage_id e inserta en
-- deal_stage_history, así que tiene que poder LEER la etapa (sección 3
-- y la política pipeline_stage_public_share). Sin eso, la aceptación
-- desde el enlace fallaría en cuanto 0025 esté aplicada.
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
ALTER TABLE quote ADD CONSTRAINT quote_campaign_window_check
  CHECK (campaign_starts_on IS NULL OR campaign_ends_on IS NULL OR campaign_ends_on >= campaign_starts_on);

-- Cuántas veces se abrió el enlace. Mismo contador que el media kit.
ALTER TABLE quote ADD COLUMN IF NOT EXISTS view_count int NOT NULL DEFAULT 0;

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

-- El límite de intentos de contraseña del media kit: el techo POR
-- ENLACE (ver la cabecera). failed_attempts cuenta los fallos de todos
-- los orígenes desde failed_since; pasada una hora, la cuenta vuelve a
-- empezar.
ALTER TABLE media_kit ADD COLUMN IF NOT EXISTS failed_attempts int NOT NULL DEFAULT 0;
ALTER TABLE media_kit ADD COLUMN IF NOT EXISTS failed_since    timestamptz;
ALTER TABLE media_kit ADD COLUMN IF NOT EXISTS locked_until    timestamptz;

-- Y el bloqueo POR ORIGEN. Hija de media_kit: se aísla por su padre
-- (misma forma que las hijas de 0018), así que el creador ve las de sus
-- kits y mc_public_share solo las del kit cuyo slug fija la función.
-- origin_hash es sha256(id del kit | IP) en hex: ni la IP en claro ni
-- un resumen que sirva para cruzar visitas entre dos media kits.
CREATE TABLE IF NOT EXISTS media_kit_lockout (
  media_kit_id    uuid        NOT NULL REFERENCES media_kit(id) ON DELETE CASCADE,
  origin_hash     text        NOT NULL CHECK (origin_hash ~ '^[0-9a-f]{64}$'),
  failed_attempts int         NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (media_kit_id, origin_hash)
);
ALTER TABLE media_kit_lockout ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_kit_lockout FORCE ROW LEVEL SECURITY;
CREATE POLICY media_kit_lockout_ws_isolation ON media_kit_lockout
  USING (EXISTS (SELECT 1 FROM media_kit p WHERE p.id = media_kit_lockout.media_kit_id));

-- Lo que la aplicación hace con ella: contar los orígenes bloqueados de
-- un kit y borrarlos con «Desbloquear». No lee el resumen del origen
-- ni escribe filas: eso es solo de public_media_kit(). Revocar de tabla
-- entera y conceder por columna: ALTER DEFAULT PRIVILEGES le dio los
-- cuatro al nacer.
REVOKE ALL ON media_kit_lockout FROM mc_app;
GRANT SELECT (media_kit_id, locked_until) ON media_kit_lockout TO mc_app;
GRANT DELETE ON media_kit_lockout TO mc_app;

-- El disparador de referencias de 0025 §3: el bucle de 0025 §7 solo
-- enganchó las claves que existían entonces. Con él, ni el creador ni
-- mc_public_share nombran un media kit que no ven.
DROP TRIGGER IF EXISTS ref_visible_media_kit_id ON media_kit_lockout;
CREATE TRIGGER ref_visible_media_kit_id
  BEFORE INSERT OR UPDATE OF media_kit_id ON media_kit_lockout
  FOR EACH ROW WHEN (NEW.media_kit_id IS NOT NULL)
  EXECUTE FUNCTION assert_reference_visible('media_kit_id', 'media_kit', 'id');

-- Los avisos al creador que nacen de un enlace público: la marca aceptó
-- una cotización (quote_accepted), y el techo POR ENLACE de contraseñas
-- fallidas dejó un media kit bloqueado para todos (media_kit_locked,
-- pulido r6: sin él, el creador se enteraba cuando la marca se quejaba).
-- Se añaden dos valores al CHECK de 0009; los demás quedan igual.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check CHECK (kind IN
  ('outlier','breakout','signal','deal_due','deal_overdue',
   'payment_received','invoice_overdue','connection_error',
   'analysis_ready','report_sent','trend','quote_accepted','media_kit_locked'));

-- Un rango del tarifario no puede estar al revés ni ser negativo: ese
-- rango llega al media kit que ve la marca y al aviso «fuera de rango»
-- de la cotización. La aplicación ya lo valida en las tres capas
-- (pantalla, acción y saveRateCard); esto es la garantía de la base.
-- NOT VALID: vale para toda fila nueva o editada sin reescribir la
-- bitácora de tarifarios que ya existe (un tarifario viejo se consulta,
-- no se toca).
ALTER TABLE rate_card_item ADD CONSTRAINT rate_card_item_price_range_check
  CHECK (
    (price_low IS NULL OR price_low >= 0)
    AND (price_high IS NULL OR price_high >= 0)
    AND (price_low IS NULL OR price_high IS NULL OR price_low <= price_high)
  ) NOT VALID;

-- El enlace se busca por slug en cada visita.
CREATE INDEX IF NOT EXISTS quote_slug_idx ON quote (slug);

-- ---------------------------------------------------------------------
-- 3 · Lo único que mc_public_share puede tocar
-- ---------------------------------------------------------------------
GRANT SELECT ON media_kit, quote, deal, deal_stage_history, pipeline_stage TO mc_public_share;
GRANT UPDATE (view_count, failed_attempts, failed_since, locked_until) ON media_kit TO mc_public_share;
-- El bloqueo por origen: contar el fallo (INSERT … ON CONFLICT), borrar
-- la fila al acertar y podar las viejas. Solo las filas del kit
-- compartido: la política de la tabla hereda de media_kit_public_share.
GRANT SELECT, INSERT, DELETE ON media_kit_lockout TO mc_public_share;
GRANT UPDATE (failed_attempts, locked_until, updated_at) ON media_kit_lockout TO mc_public_share;
GRANT UPDATE (status, viewed_at, accepted_at, expired_at, view_count,
              accepted_by_name, accepted_by_email) ON quote TO mc_public_share;
GRANT UPDATE (stage_id, probability, won_at, lost_at) ON deal TO mc_public_share;
GRANT INSERT ON deal_stage_history TO mc_public_share;
GRANT USAGE ON SEQUENCE deal_stage_history_id_seq TO mc_public_share;

-- ---------------------------------------------------------------------
-- 4 · La cerradura: políticas acotadas al slug compartido
-- ---------------------------------------------------------------------
-- Se suman (OR) a las de aislamiento por workspace de 0010, pero solo
-- para mc_public_share: el creador sigue viendo lo suyo por la suya.

CREATE POLICY media_kit_public_share ON media_kit
  FOR SELECT TO mc_public_share
  USING (is_public AND slug = nullif(current_setting('app.public_share', true), ''));

-- El contador de vistas y el de contraseñas fallidas. WITH CHECK con la
-- misma condición: la fila no puede dejar de ser la compartida.
CREATE POLICY media_kit_public_share_views ON media_kit
  FOR UPDATE TO mc_public_share
  USING (is_public AND slug = nullif(current_setting('app.public_share', true), ''))
  WITH CHECK (is_public AND slug = nullif(current_setting('app.public_share', true), ''));

-- Un borrador no tiene enlace: el slug existe desde que se crea la
-- cotización, pero hasta enviarla no abre nada.
CREATE POLICY quote_public_share ON quote
  FOR SELECT TO mc_public_share
  USING (status <> 'draft' AND slug = nullif(current_setting('app.public_share', true), ''));

-- Marcar vista, vencida o aceptada.
CREATE POLICY quote_public_share_state ON quote
  FOR UPDATE TO mc_public_share
  USING (status <> 'draft' AND slug = nullif(current_setting('app.public_share', true), ''))
  WITH CHECK (status <> 'draft' AND slug = nullif(current_setting('app.public_share', true), ''));

-- El deal de esa cotización, para pasarlo a «Ganado» al aceptar. La
-- subconsulta corre bajo la RLS de mc_public_share, así que la política
-- de arriba es la que decide qué cotización cuenta.
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

-- La etapa en la que está ese deal, si es propia del workspace (las
-- globales ya las deja ver pipeline_stage_read de 0020). Hace falta
-- para el disparador de referencias de 0025 (ver la cabecera).
CREATE POLICY pipeline_stage_public_share ON pipeline_stage
  FOR SELECT TO mc_public_share
  USING (EXISTS (SELECT 1 FROM deal d
                 WHERE d.stage_id = pipeline_stage.id
                   AND d.workspace_id = pipeline_stage.workspace_id));

-- deal_stage_history hereda de deal por la política de 0018, que no
-- tiene TO: su EXISTS sobre deal corre como mc_public_share y es
-- deal_public_share la que decide.

-- ---------------------------------------------------------------------
-- 5 · La puerta
-- ---------------------------------------------------------------------

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

-- Media kit. p_origin es la IP de la petición (o lo que el servidor use
-- para distinguir orígenes): se resume con el id del kit y no se guarda.
-- Sin origen, todos los que llaman comparten uno.
--
--   {"status":"not_found"}
--   {"status":"expired","expiresAt":"…"}
--   {"status":"locked","lockedUntil":"…"}
--   {"status":"locked","lockedUntil":"…","linkLocked":true,"mediaKitId":"…","workspaceId":"…"}
--       (solo al saltar el techo del enlace; ver más abajo)
--   {"status":"password_required","algo":"s1","salt":"…"}
--   {"status":"password_invalid","algo":"s1","salt":"…","attemptsLeft":7}
--   {"status":"ok","slug":"…","snapshot":{…},"viewCount":12,"createdAt":"…"}
CREATE FUNCTION public_media_kit_impl(p_slug text, p_password_hash text, p_count boolean, p_origin text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  max_por_origen constant int := 10;
  max_por_enlace constant int := 50;
  ventana constant interval := interval '1 hour';
  bloqueo constant interval := interval '15 minutes';
  k record;
  origen text;
  origen_hasta timestamptz;
  intentos int;
  del_enlace int;
  vistas int;
BEGIN
  SELECT id, workspace_id, slug, snapshot, password_hash, expires_at, view_count, created_at, locked_until
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
    -- El techo del enlace primero: vale para todos los orígenes.
    IF k.locked_until IS NOT NULL AND k.locked_until > now() THEN
      RETURN jsonb_build_object('status', 'locked', 'lockedUntil', to_jsonb(k.locked_until));
    END IF;

    origen := encode(sha256(convert_to(k.id::text || '|' || coalesce(p_origin, ''), 'UTF8')), 'hex');
    SELECT locked_until INTO origen_hasta
      FROM media_kit_lockout
     WHERE media_kit_id = k.id AND origin_hash = origen;
    IF origen_hasta IS NOT NULL AND origen_hasta > now() THEN
      RETURN jsonb_build_object('status', 'locked', 'lockedUntil', to_jsonb(origen_hasta));
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
      -- Las filas de orígenes que ya no cuentan, fuera: la tabla no crece
      -- con cada IP que alguna vez falló.
      DELETE FROM media_kit_lockout
       WHERE media_kit_id = k.id AND origin_hash <> origen
         AND updated_at < now() - ventana
         AND (locked_until IS NULL OR locked_until <= now());

      -- 1 · El origen. Un bloqueo vencido, o una racha de hace más de
      -- una hora, empieza la cuenta de cero. ON CONFLICT: dos fallos a
      -- la vez desde el mismo origen suman los dos, sin chocar.
      INSERT INTO media_kit_lockout AS l (media_kit_id, origin_hash, failed_attempts, locked_until, updated_at)
      VALUES (k.id, origen, 1, NULL, now())
      ON CONFLICT (media_kit_id, origin_hash) DO UPDATE
         SET failed_attempts = CASE WHEN l.locked_until IS NOT NULL OR l.updated_at <= now() - ventana
                                    THEN 1 ELSE l.failed_attempts + 1 END,
             locked_until = NULL,
             updated_at = now()
      RETURNING failed_attempts INTO intentos;

      -- 2 · El enlace: todos los orígenes de la última hora.
      UPDATE media_kit
         SET failed_attempts = CASE WHEN failed_since IS NULL OR failed_since <= now() - ventana OR locked_until IS NOT NULL
                                    THEN 1 ELSE failed_attempts + 1 END,
             failed_since = CASE WHEN failed_since IS NULL OR failed_since <= now() - ventana OR locked_until IS NOT NULL
                                 THEN now() ELSE failed_since END,
             locked_until = NULL
       WHERE id = k.id
      RETURNING failed_attempts INTO del_enlace;

      IF del_enlace >= max_por_enlace THEN
        UPDATE media_kit SET failed_attempts = 0, failed_since = NULL, locked_until = now() + bloqueo WHERE id = k.id;
        -- linkLocked, mediaKitId y workspaceId solo en ESTA respuesta, la
        -- que salta el techo: con ellos el servidor deja el aviso al
        -- creador (media_kit_locked, con «Desbloquear») dentro del
        -- workspace del kit, como hace la aceptación con el suyo. Este
        -- rol no escribe en notification, y la frase la pone la web. La
        -- página pública no los recibe (app/(public)/actions.ts).
        RETURN jsonb_build_object('status', 'locked', 'lockedUntil', to_jsonb(now() + bloqueo),
                                  'linkLocked', true, 'mediaKitId', to_jsonb(k.id),
                                  'workspaceId', to_jsonb(k.workspace_id));
      END IF;
      IF intentos >= max_por_origen THEN
        UPDATE media_kit_lockout SET failed_attempts = 0, locked_until = now() + bloqueo, updated_at = now()
         WHERE media_kit_id = k.id AND origin_hash = origen;
        RETURN jsonb_build_object('status', 'locked', 'lockedUntil', to_jsonb(now() + bloqueo));
      END IF;
      RETURN jsonb_build_object('status', 'password_invalid',
                                'algo', split_part(k.password_hash, ':', 1),
                                'salt', split_part(k.password_hash, ':', 2),
                                'attemptsLeft', max_por_origen - intentos);
    END IF;
    -- Acierto: la cuenta de ESTE origen vuelve a cero. La del enlace no
    -- (ver la cabecera): se vacía sola al pasar la hora.
    DELETE FROM media_kit_lockout WHERE media_kit_id = k.id AND origin_hash = origen;
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

CREATE FUNCTION public_media_kit(p_slug text, p_password_hash text DEFAULT NULL, p_count boolean DEFAULT true,
                                 p_origin text DEFAULT NULL)
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
    r := public_media_kit_impl(p_slug, p_password_hash, coalesce(p_count, true), left(p_origin, 200));
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
REVOKE ALL ON FUNCTION public_media_kit_impl(text, text, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_quote_impl(text, boolean)             FROM PUBLIC;
REVOKE ALL ON FUNCTION public_quote_accept_impl(text, text, text)   FROM PUBLIC;
REVOKE ALL ON FUNCTION public_media_kit(text, text, boolean, text)  FROM PUBLIC;
REVOKE ALL ON FUNCTION public_quote(text, boolean)                  FROM PUBLIC;
REVOKE ALL ON FUNCTION public_quote_accept(text, text, text)        FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_media_kit(text, text, boolean, text) TO mc_app;
GRANT EXECUTE ON FUNCTION public_quote(text, boolean)               TO mc_app;
GRANT EXECUTE ON FUNCTION public_quote_accept(text, text, text)     TO mc_app;

ALTER FUNCTION public_share_today(text)                    OWNER TO mc_public_share;
ALTER FUNCTION public_media_kit_impl(text, text, boolean, text) OWNER TO mc_public_share;
ALTER FUNCTION public_quote_impl(text, boolean)             OWNER TO mc_public_share;
ALTER FUNCTION public_quote_accept_impl(text, text, text)   OWNER TO mc_public_share;
ALTER FUNCTION public_media_kit(text, text, boolean, text)  OWNER TO mc_public_share;
ALTER FUNCTION public_quote(text, boolean)                  OWNER TO mc_public_share;
ALTER FUNCTION public_quote_accept(text, text, text)        OWNER TO mc_public_share;

REVOKE CREATE ON SCHEMA public FROM mc_public_share;
