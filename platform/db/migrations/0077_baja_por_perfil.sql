-- =====================================================================
-- 0077 · La baja por LinkedIn o Instagram vive en la dirección
--        (VEN-15, pulido r5)
-- ---------------------------------------------------------------------
-- Número: 0077, la siguiente libre de la serie de integración, detrás de
-- 0076. No está aplicada en ningún sitio.
--
-- El hallazgo. La lista del espacio (outbound_workspace_optout, 0055
-- §8) solo guarda CORREOS: outbound_workspace_optout_record y
-- contact_optout_keep no escribían nada si la ficha no tenía correo, y
-- enforce_outbound_optout y el enrolamiento solo miraban
-- contact.opted_out de ESA ficha. contact no tiene índice único por
-- linkedin_url ni por instagram_handle. Si alguien que solo tiene
-- LinkedIn respondía «no me escriban más», bastaba crear otra ficha con
-- la misma URL (o ponérsela a otra ficha) para enrolarla, y el paso de
-- LinkedIn salía: su recipient_address es la URL, que ninguna lista
-- conocía. Incumplía «la baja respetada en todos los canales».
--
-- Lo que deja esta migración:
--
--   1 · outreach_handle_key(canal, dirección): la forma comparable de un
--       perfil. LinkedIn: con los %XX decodificados, sin esquema, sin
--       ningún subdominio («www.», «co.», «m.»), sin parámetros, y solo
--       «/in/<slug>» o «/company/<slug>» (lo que sigue, como «/es» o
--       «/details/…», se corta), en minúsculas
--       («linkedin.com/in/sofia-cardenas»). Instagram: el usuario sin @
--       ni «instagram.com/», en minúsculas. NULL si no queda nada.
--       (Pulido r6: la forma que copia el navegador, con la tilde
--       codificada, y la que muestra, con la tilde, dan la misma clave.)
--   2 · outbound_workspace_optout_handle: la hermana de
--       outbound_workspace_optout para los perfiles, por (workspace,
--       canal, clave). La escriben solo las funciones de abajo y el
--       worker; mc_app la lee con su RLS.
--   3 · outreach_handles_opted_out(workspace, ficha, canal, dirección):
--       si la ficha (por su LinkedIn o su Instagram) o la dirección del
--       envío están en esa lista. SECURITY INVOKER: mc_app ve solo su
--       workspace, el worker todo.
--   4 · Dónde se anota: outbound_workspace_optout_record (la baja por
--       respuesta o a mano desde la web) anota también los perfiles de
--       la ficha, y contact_optout_handles (disparador, definer) los de
--       toda ficha PROPIA que queda de baja por la vía que sea, también
--       el enlace de un correo (public_optout, mc_public_share). La
--       fila sobrevive a la ficha: borrarla no la deshace.
--   5 · Dónde se hace cumplir: enforce_outbound_optout (el toque no
--       entra en scheduled, processing ni sent) y
--       outbound_workspace_optout_check (el enrolamiento no nace ni se
--       reanuda), con el mismo error de 0055 §8.3. El reclamo, la
--       relectura antes de enviar y enrollContacts (skipped 'opted_out')
--       lo miran con la misma función (@mc/db).
--
-- Lo que ya estaba de baja antes de aplicar esto no se copia: con FORCE
-- ROW LEVEL SECURITY, quien migra no ve las fichas de ningún workspace
-- (como 0055 §8.4). Esas fichas siguen con contact.opted_out; la primera
-- vez que se toquen sus perfiles (UPDATE de linkedin_url o
-- instagram_handle) el disparador los anota.
--
-- Re-ejecutable: IF NOT EXISTS, CREATE OR REPLACE y DROP … IF EXISTS.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1 · La forma comparable de un perfil
-- ---------------------------------------------------------------------
-- 1.1 · Los %XX de una URL, decodificados como UTF-8. El navegador
-- muestra «/in/sofía-cárdenas» y copia «/in/sof%C3%ADa-c%C3%A1rdenas»:
-- las dos son la misma persona. Un % que no forma un byte se queda
-- como está; si los bytes no son UTF-8 válido, vuelve el texto tal cual.
CREATE OR REPLACE FUNCTION outreach_percent_decode(p_text text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  bytes bytea := ''::bytea;
  i int := 1;
  n int;
  ch text;
BEGIN
  IF p_text IS NULL OR strpos(p_text, '%') = 0 THEN
    RETURN p_text;
  END IF;
  n := length(p_text);
  WHILE i <= n LOOP
    ch := substr(p_text, i, 1);
    IF ch = '%' AND substr(p_text, i + 1, 2) ~ '^[0-9A-Fa-f]{2}$' THEN
      bytes := bytes || decode(substr(p_text, i + 1, 2), 'hex');
      i := i + 3;
    ELSE
      bytes := bytes || convert_to(ch, 'UTF8');
      i := i + 1;
    END IF;
  END LOOP;
  RETURN convert_from(bytes, 'UTF8');
EXCEPTION WHEN OTHERS THEN
  RETURN p_text;
END;
$$;

COMMENT ON FUNCTION outreach_percent_decode(text) IS
  'Los %XX de una URL decodificados como UTF-8 (0077, pulido r6). Un % suelto se queda; bytes que no son UTF-8 '
  'válido devuelven el texto tal cual.';

-- 1.2 · La clave. LinkedIn, en este orden: decodificar, minúsculas,
-- sin esquema, sin subdominio alguno (www., co., m., es.), sin
-- parámetros ni ancla, y de un perfil o una página solo
-- «/in/<slug>» o «/company/<slug>»: «/in/sofia-cardenas/es» y
-- «/in/sofia-cardenas/details/experience» son la misma persona.
CREATE OR REPLACE FUNCTION outreach_handle_key(p_channel text, p_address text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT nullif(
    CASE p_channel
      WHEN 'linkedin' THEN
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(lower(btrim(outreach_percent_decode(btrim(p_address)))), '^https?://', ''),
                '^([a-z0-9-]+\.)*(linkedin\.com)(/|$)', '\2\3'),
              '[?#].*$', ''),
            '^(linkedin\.com/(in|company|school|showcase)/[^/]+)/.*$', '\1'),
          '/+$', '')
      WHEN 'instagram_dm' THEN
        regexp_replace(
          regexp_replace(
            regexp_replace(lower(btrim(p_address)), '^(https?://)?(www\.)?instagram\.com/', ''),
            '[?#].*$', ''),
          '^@+|/+$', '', 'g')
    END,
    '');
$$;

COMMENT ON FUNCTION outreach_handle_key(text, text) IS
  'La forma comparable de un perfil (0077): LinkedIn con los %XX decodificados, sin esquema, subdominio, parámetros '
  'ni barra final, y solo /in/<slug> o /company/<slug>; '
  'Instagram, el usuario sin @ ni instagram.com/. En minúsculas. NULL para otro canal o si no queda nada.';


-- ---------------------------------------------------------------------
-- 2 · outbound_workspace_optout_handle
-- ---------------------------------------------------------------------
--   channel      linkedin o instagram_dm (el correo va en
--                outbound_workspace_optout)
--   address_key  outreach_handle_key(channel, …)
--   source       reply (respondió pidiéndolo), manual (una persona la
--                marcó en la ficha) o contact (la ficha quedó de baja
--                por otra vía: el enlace de un correo, un script)
CREATE TABLE IF NOT EXISTS outbound_workspace_optout_handle (
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  channel       text NOT NULL CHECK (channel IN ('linkedin', 'instagram_dm')),
  address_key   text NOT NULL CHECK (length(address_key) BETWEEN 1 AND 320),
  source        text NOT NULL CHECK (source IN ('reply', 'manual', 'contact')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, channel, address_key)
);

ALTER TABLE outbound_workspace_optout_handle ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_workspace_optout_handle FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outbound_workspace_optout_handle_ws_read ON outbound_workspace_optout_handle;
CREATE POLICY outbound_workspace_optout_handle_ws_read ON outbound_workspace_optout_handle FOR SELECT
  USING (workspace_id = current_workspace_id());
-- Las dos funciones definer de abajo corren como su dueño: su alta, TO
-- CURRENT_USER (mc_migrator, o el rol que migra en PGlite), como la de
-- outbound_workspace_optout (0055 §8.4). A mc_app no le alcanza.
DROP POLICY IF EXISTS outbound_workspace_optout_handle_owner_record ON outbound_workspace_optout_handle;
CREATE POLICY outbound_workspace_optout_handle_owner_record ON outbound_workspace_optout_handle
  FOR INSERT TO CURRENT_USER
  WITH CHECK (source IN ('reply', 'manual', 'contact'));
REVOKE INSERT, UPDATE, DELETE ON outbound_workspace_optout_handle FROM mc_app;

COMMENT ON TABLE outbound_workspace_optout_handle IS
  'A qué perfil de LinkedIn o de Instagram no le vuelve a escribir el workspace (0077, VEN-15): la hermana de '
  'outbound_workspace_optout para quien no tiene correo. La escriben outbound_workspace_optout_record, el disparador '
  'contact_optout_handles y el worker; mc_app solo la lee. Sobrevive a la ficha.';


-- ---------------------------------------------------------------------
-- 3 · Si la ficha o la dirección del envío están en la lista
-- ---------------------------------------------------------------------
-- p_channel y p_recipient son los del toque (NULL al enrolar): una URL
-- de LinkedIn o un usuario de Instagram que ninguna ficha tiene ya
-- también cuenta. La ficha cuenta por sus DOS perfiles, sea cual sea el
-- canal del toque: la persona pidió no recibir nada de este espacio.
CREATE OR REPLACE FUNCTION outreach_handles_opted_out(p_workspace uuid, p_contact uuid, p_channel text, p_recipient text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM outbound_workspace_optout_handle h
     WHERE h.workspace_id = p_workspace
       AND ((h.channel = p_channel AND h.address_key = outreach_handle_key(p_channel, p_recipient))
            OR EXISTS (SELECT 1 FROM contact c
                        WHERE c.id = p_contact
                          AND ((h.channel = 'linkedin' AND h.address_key = outreach_handle_key('linkedin', c.linkedin_url))
                               OR (h.channel = 'instagram_dm'
                                   AND h.address_key = outreach_handle_key('instagram_dm', c.instagram_handle))))));
$$;

COMMENT ON FUNCTION outreach_handles_opted_out(uuid, uuid, text, text) IS
  'Si el LinkedIn o el Instagram de la ficha, o la dirección del envío en su canal, están en '
  'outbound_workspace_optout_handle del workspace (0077). SECURITY INVOKER: mc_app solo ve su workspace.';


-- ---------------------------------------------------------------------
-- 4 · Dónde se anota
-- ---------------------------------------------------------------------
-- 4.1 · La baja por respuesta o a mano desde la web: la de 0055 §8.4,
-- con la misma firma, los mismos permisos y la misma cerradura, que
-- anota también los perfiles de la ficha. true si anotó algo.
CREATE OR REPLACE FUNCTION outbound_workspace_optout_record(p_contact uuid, p_source text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  ws uuid := current_workspace_id();
  correo citext;
  li text;
  ig text;
BEGIN
  IF ws IS NULL THEN
    RAISE EXCEPTION 'outbound_workspace_optout_record necesita un workspace fijado en la transacción.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('reply', 'manual') THEN
    RAISE EXCEPTION 'Origen desconocido: %. Es reply o manual (el enlace lo anota public_optout).', p_source
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT c.email, outreach_handle_key('linkedin', c.linkedin_url), outreach_handle_key('instagram_dm', c.instagram_handle)
    INTO correo, li, ig
    FROM contact c
   WHERE c.id = p_contact AND contact_visible_to(c.id, ws);
  IF correo IS NOT NULL THEN
    INSERT INTO outbound_workspace_optout (workspace_id, email, source)
    VALUES (ws, correo, p_source)
    ON CONFLICT (workspace_id, email) DO NOTHING;
  END IF;
  IF li IS NOT NULL THEN
    INSERT INTO outbound_workspace_optout_handle (workspace_id, channel, address_key, source)
    VALUES (ws, 'linkedin', li, p_source)
    ON CONFLICT (workspace_id, channel, address_key) DO NOTHING;
  END IF;
  IF ig IS NOT NULL THEN
    INSERT INTO outbound_workspace_optout_handle (workspace_id, channel, address_key, source)
    VALUES (ws, 'instagram_dm', ig, p_source)
    ON CONFLICT (workspace_id, channel, address_key) DO NOTHING;
  END IF;
  RETURN correo IS NOT NULL OR li IS NOT NULL OR ig IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION outbound_workspace_optout_record(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbound_workspace_optout_record(uuid, text) TO mc_app;
COMMENT ON FUNCTION outbound_workspace_optout_record(uuid, text) IS
  'Anota la baja de una ficha que pidió la baja respondiendo (reply) o que una persona dio de baja (manual) en el '
  'workspace de la transacción: su correo en outbound_workspace_optout (entregabilidad §8.4) y su LinkedIn y su '
  'Instagram en outbound_workspace_optout_handle (0077). Solo una ficha que ese workspace ve; nunca borra ni cambia '
  'una fila. true si la ficha tiene alguna dirección (la fila ya podía estar).';

-- 4.2 · Toda ficha PROPIA que queda de baja, por la vía que sea (el
-- enlace de un correo con mc_public_share, la ficha, una respuesta, un
-- script): sus perfiles entran en la lista de SU workspace. También si
-- a una ficha ya de baja se le pone otro perfil. Definer por la misma
-- razón que contact_optout_keep: quien escribe la ficha no tiene INSERT
-- en la lista. Ni el workspace ni la lista se preguntan antes: la clave
-- primaria dice si ya estaba.
CREATE OR REPLACE FUNCTION contact_optout_handles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  origen text := CASE WHEN NEW.opted_out_code LIKE 'reply_optout:%' THEN 'reply' ELSE 'contact' END;
  fila record;
BEGIN
  FOR fila IN
    SELECT v.canal, v.clave
      FROM (VALUES ('linkedin', outreach_handle_key('linkedin', NEW.linkedin_url)),
                   ('instagram_dm', outreach_handle_key('instagram_dm', NEW.instagram_handle))) AS v(canal, clave)
     WHERE v.clave IS NOT NULL
  LOOP
    BEGIN
      INSERT INTO outbound_workspace_optout_handle (workspace_id, channel, address_key, source)
      VALUES (NEW.owner_workspace_id, fila.canal, fila.clave, origen);
    EXCEPTION WHEN unique_violation OR foreign_key_violation THEN
      NULL;
    END;
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION contact_optout_handles() FROM PUBLIC;
COMMENT ON FUNCTION contact_optout_handles() IS
  'Al quedar de baja una ficha propia (o cambiar el perfil de una ya de baja), su LinkedIn y su Instagram entran en '
  'outbound_workspace_optout_handle de su workspace (0077). Solo inserta a partir de NEW; nunca borra.';

DROP TRIGGER IF EXISTS contact_optout_handles ON contact;
CREATE TRIGGER contact_optout_handles
  AFTER INSERT OR UPDATE OF opted_out, linkedin_url, instagram_handle ON contact
  FOR EACH ROW
  WHEN (NEW.opted_out AND NEW.owner_workspace_id IS NOT NULL
        AND (NEW.linkedin_url IS NOT NULL OR NEW.instagram_handle IS NOT NULL))
  EXECUTE FUNCTION contact_optout_handles();


-- ---------------------------------------------------------------------
-- 5 · Dónde se hace cumplir
-- ---------------------------------------------------------------------
-- 5.1 · El toque: la regla de 0055 §8.3, entera y con las mismas
-- transiciones, con una fuente más de «la baja de este espacio»: la
-- ficha o la dirección del envío en outbound_workspace_optout_handle.
CREATE OR REPLACE FUNCTION enforce_outbound_optout()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
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
         AND (o.email = correo OR o.email = NEW.recipient_address))
      OR outreach_handles_opted_out(NEW.workspace_id, NEW.contact_id, NEW.channel, NEW.recipient_address);
  END IF;
  IF NOT is_out AND NOT del_espacio THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'sent' AND TG_OP = 'UPDATE' AND OLD.status = 'processing'
     AND NEW.contact_id IS NOT DISTINCT FROM OLD.contact_id THEN
    NEW.blocked_reason := 'opted_out_in_flight';
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'processing' AND NEW.status = 'scheduled' THEN
    NEW.status := 'canceled';
    NEW.blocked_reason := 'opted_out';
    RETURN NEW;
  END IF;

  IF del_espacio THEN
    RAISE EXCEPTION 'La persona de la ficha % pidió no recibir más mensajes de este espacio.',
                    coalesce(NEW.contact_id::text, NEW.recipient_address::text)
      USING ERRCODE = 'check_violation',
            HINT = 'Pidió la baja de este espacio: su correo está en outbound_workspace_optout, o su LinkedIn o su '
                   'Instagram en outbound_workspace_optout_handle.';
  END IF;
  RAISE EXCEPTION 'El contacto % pidió no ser contactado (opt-out).', coalesce(NEW.contact_id::text, NEW.recipient_address::text)
    USING ERRCODE = 'check_violation',
          HINT = 'La ficha está dada de baja, o su correo o la dirección del envío están en la baja global.';
END;
$$;

-- 5.2 · El enrolamiento: a quien pidió la baja de este espacio, por su
-- correo o por uno de sus perfiles, no se le enrola ni se le reanuda.
CREATE OR REPLACE FUNCTION outbound_workspace_optout_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
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
  IF (correo IS NOT NULL AND EXISTS (SELECT 1 FROM outbound_workspace_optout o
                                      WHERE o.workspace_id = NEW.workspace_id AND o.email = correo))
     OR (NEW.contact_id IS NOT NULL AND outreach_handles_opted_out(NEW.workspace_id, NEW.contact_id, NULL, NULL)) THEN
    RAISE EXCEPTION 'La persona de la ficha % pidió no recibir más mensajes de este espacio.', NEW.contact_id
      USING ERRCODE = 'check_violation',
            HINT = 'Pidió la baja de este espacio: su correo está en outbound_workspace_optout, o su LinkedIn o su '
                   'Instagram en outbound_workspace_optout_handle.';
  END IF;
  RETURN NEW;
END;
$$;
