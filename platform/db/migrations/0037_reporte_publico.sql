-- =====================================================================
-- 0037 · El reporte a la marca por enlace público (CAM-6)
-- ---------------------------------------------------------------------
-- Número: git fetch el 23-sep y el más alto en TODAS las ramas es 0036
-- (0034 la usan ACC-3 —access_control, aplicada— y dos ramas sin
-- fusionar; 0035 CAM-3 y ACC-6; 0036 FIN-7). 0023 sigue reservada y no
-- se recicla. Cuenta con 0024 (aislamiento por defecto), 0025
-- (disparadores de referencias), 0030 (el rol mc_public_share y su
-- forma) y 0034 (permission / role / role_permission). No depende de
-- 0035 ni de 0036: si el integrador aplica en otro orden, esta va bien
-- en cualquier punto después de 0034. Si otra rama eligió también 0037,
-- se renumera sin tocar el contenido.
--
-- Qué hace y por qué. /reporte/<slug> se abre SIN sesión y sin
-- workspace, igual que /cotizacion/<slug>, y `report` lleva RLS con
-- FORCE desde 0010. La salida es la misma que 0030 dio a la cotización:
--
--   · La PUERTA: public_report(slug, count), SECURITY DEFINER, de
--     mc_public_share. La web la llama como mc_app desde withPublicShare;
--     recibe el slug, devuelve el payload congelado más el estado del
--     enlace (jsonb recortado, nunca la fila) y, con p_count, marca la
--     primera vista (status 'viewed', viewed_at) y suma la visita.
--   · La CERRADURA: dos políticas `TO mc_public_share` que abren solo la
--     fila cuyo slug fija la propia función mientras dura la llamada
--     (app.public_share, restaurado al salir, también si algo lanza).
--     Un borrador no abre nada: el slug existe desde que se genera, pero
--     hasta marcar «enviado» no hay enlace.
--   · Los PRIVILEGIOS: SELECT sobre report y UPDATE de tres columnas
--     (status, viewed_at, view_count). Aunque la función tuviera un
--     error, no podría tocar el payload ni el workspace de un reporte:
--     Postgres se lo niega.
--
-- Y una columna: report.superseded_by. Un reporte enviado NO cambia
-- (es lo que hace que la marca pueda discutir cifras un mes después) y
-- su enlace no se rompe; si el creador genera y envía otro, el viejo
-- apunta al nuevo y su página dice «hay una versión más reciente». Se
-- fija al ENVIAR el nuevo, no al generarlo: un borrador no lo ve nadie.
--
-- El slug ES la credencial (26 signos de 31, ≈128 bits, nuevoSlug de
-- queries/cotizar/enlace.ts): no se enumera, y not_found no dice si
-- existe. No hay contraseña ni, por tanto, bloqueo por origen (eso
-- protege la contraseña de un media kit, no el slug).
--
-- Re-ejecutable: ADD COLUMN IF NOT EXISTS, DO con pg_constraint, DROP
-- POLICY IF EXISTS, CREATE OR REPLACE FUNCTION, GRANT/REVOKE idempotentes.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · superseded_by: qué versión dejó atrás a esta (0033 hizo lo mismo en quote)
-- ---------------------------------------------------------------------
ALTER TABLE report ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES report(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_superseded_by_not_self') THEN
    ALTER TABLE report ADD CONSTRAINT report_superseded_by_not_self CHECK (superseded_by IS NULL OR superseded_by <> id);
  END IF;
END $$;

-- El disparador de referencias de 0025 §3: el bucle de 0025 §7 solo
-- enganchó las claves que existían entonces. Con él, un reporte solo
-- nombra como versión nueva otro reporte que quien escribe puede leer
-- (el suyo, por RLS).
DROP TRIGGER IF EXISTS ref_visible_superseded_by ON report;
CREATE TRIGGER ref_visible_superseded_by
  BEFORE INSERT OR UPDATE OF superseded_by ON report
  FOR EACH ROW WHEN (NEW.superseded_by IS NOT NULL)
  EXECUTE FUNCTION assert_reference_visible('superseded_by', 'report', 'id');

-- Las versiones de una campaña, las más recientes primero (la sección
-- «Reporte» de la ficha). El slug ya tiene su índice único de 0008.
CREATE INDEX IF NOT EXISTS report_campaign_created_idx ON report (campaign_id, created_at DESC);

-- ---------------------------------------------------------------------
-- 2 · Lo único que mc_public_share puede tocar de report
-- ---------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO mc_public_share;
-- Solo mientras dura esta migración: el dueño de una función necesita
-- CREATE en su esquema para recibirla (0030 §1). Se revoca al final.
GRANT CREATE ON SCHEMA public TO mc_public_share;

GRANT SELECT ON report TO mc_public_share;
GRANT UPDATE (status, viewed_at, view_count) ON report TO mc_public_share;

-- ---------------------------------------------------------------------
-- 3 · La cerradura: políticas acotadas al slug compartido
-- ---------------------------------------------------------------------
-- Se suman (OR) a report_ws_isolation de 0010, pero solo para
-- mc_public_share: el creador sigue viendo lo suyo por la suya.
DROP POLICY IF EXISTS report_public_share ON report;
CREATE POLICY report_public_share ON report
  FOR SELECT TO mc_public_share
  USING (status <> 'draft' AND slug = nullif(current_setting('app.public_share', true), ''));

-- Marcar vista y sumar la visita. WITH CHECK con la misma condición: la
-- fila no puede dejar de ser la compartida.
DROP POLICY IF EXISTS report_public_share_state ON report;
CREATE POLICY report_public_share_state ON report
  FOR UPDATE TO mc_public_share
  USING (status <> 'draft' AND slug = nullif(current_setting('app.public_share', true), ''))
  WITH CHECK (status <> 'draft' AND slug = nullif(current_setting('app.public_share', true), ''));

-- ---------------------------------------------------------------------
-- 4 · La puerta
-- ---------------------------------------------------------------------
-- Las fechas salen como el resto de @mc/db: ISO en UTC con «Z» y sin
-- fracción ('2026-09-23T20:07:14Z'), no el to_jsonb de timestamptz
-- ('…14.96+00:00'), para que la vista previa y el enlace digan lo mismo.
CREATE OR REPLACE FUNCTION public_report_iso(p_ts timestamptz)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN p_ts IS NULL THEN 'null'::jsonb
              ELSE to_jsonb(to_char(p_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) END
$$;

-- Con p_count la primera visita marca el reporte como visto; sin él
-- (vista previa del creador, robots que pintan la vista previa de un
-- chat) solo se lee. Devuelve el payload congelado más lo único vivo:
-- el estado del enlace.
--
--   {"status":"not_found"}
--   {"status":"ok","report":{…payload…,"slug":"…","status":"viewed","sentAt":"…","viewedAt":"…",
--                            "superseded":false,"generatedAt":"…"}}
CREATE OR REPLACE FUNCTION public_report_impl(p_slug text, p_count boolean)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  r record;
  nuevo_estado text;
  visto timestamptz;
BEGIN
  SELECT id, slug, status, payload, sent_at, viewed_at, created_at, superseded_by
    INTO r
    FROM report
   WHERE slug = p_slug;

  IF NOT FOUND OR r.status = 'draft' THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  nuevo_estado := r.status;
  visto := r.viewed_at;

  IF p_count AND r.status = 'sent' THEN
    nuevo_estado := 'viewed';
    visto := coalesce(r.viewed_at, now());
    UPDATE report SET status = 'viewed', viewed_at = visto, view_count = view_count + 1 WHERE id = r.id;
  ELSIF p_count THEN
    UPDATE report SET view_count = view_count + 1 WHERE id = r.id;
  END IF;

  RETURN jsonb_build_object(
    'status', 'ok',
    'report', r.payload
              || jsonb_build_object(
                   'slug', r.slug,
                   'status', nuevo_estado,
                   'sentAt', public_report_iso(r.sent_at),
                   'viewedAt', public_report_iso(visto),
                   'superseded', r.superseded_by IS NOT NULL,
                   'createdAt', public_report_iso(r.created_at)));
END;
$$;

CREATE OR REPLACE FUNCTION public_report(p_slug text, p_count boolean DEFAULT true)
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
    r := public_report_impl(p_slug, coalesce(p_count, true));
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.public_share', anterior, true);
    RAISE;
  END;
  PERFORM set_config('app.public_share', anterior, true);
  RETURN r;
END;
$$;

-- ---------------------------------------------------------------------
-- 5 · Privilegios y dueño (mismo orden que 0030 §6)
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION public_report_iso(timestamptz)    FROM PUBLIC;
REVOKE ALL ON FUNCTION public_report_impl(text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_report(text, boolean)      FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_report(text, boolean)   TO mc_app;

ALTER FUNCTION public_report_iso(timestamptz)    OWNER TO mc_public_share;
ALTER FUNCTION public_report_impl(text, boolean) OWNER TO mc_public_share;
ALTER FUNCTION public_report(text, boolean)      OWNER TO mc_public_share;

REVOKE CREATE ON SCHEMA public FROM mc_public_share;

-- ---------------------------------------------------------------------
-- 6 · El permiso de generar (ACC-1 → ACC-3)
-- ---------------------------------------------------------------------
-- 0034 sembró el catálogo con campanas.reporte.enviar; CAM-6 separa
-- generar (congela las cifras en un borrador que nadie más ve) de
-- enviar (lo publica). Lo reciben los roles de sistema que ya tienen
-- todo Campañas —los mismos cinco que enviar—, igual que haría la
-- semilla regenerada (packages/core/scripts/permisos-sql.ts). Los roles
-- propios de un workspace (workspace_id no nulo) no se tocan: su dueño
-- decide. ON CONFLICT DO NOTHING: re-ejecutable.
INSERT INTO permission (key, module, label_es, sensitivity)
VALUES ('campanas.reporte.generar', 'campanas', 'Generar el reporte a la marca', 'normal')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permission (role_id, permission_key)
SELECT r.id, 'campanas.reporte.generar'
  FROM role r
 WHERE r.workspace_id IS NULL
   AND (r.key, r.workspace_kind) IN (('owner', 'creator'), ('manager', 'creator'),
                                     ('owner', 'agency'), ('admin', 'agency'), ('manager', 'agency'))
ON CONFLICT DO NOTHING;
