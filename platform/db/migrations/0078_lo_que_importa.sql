-- =====================================================================
-- 0078 · «Lo que importa esta semana»: el «Entendido» de cada persona
--        (RES-3)
-- ---------------------------------------------------------------------
-- Número: 0078, la siguiente libre detrás de 0077. No está aplicada en
-- ningún sitio: la aplica el integrador.
--
-- Qué es. El bloque de arriba de /resumen lee `notification` (0009) y
-- enseña cuatro fuentes: videos destacados (CON-6), cuentas que no se
-- pueden leer (Conexiones), facturas vencidas (FIN-4) y seguimientos
-- vencidos (VEN-4). Cada fila lleva un «Entendido» que la marca leída.
--
-- Por qué no basta `notification.read_at`. Dos razones, las dos medidas
-- en el código que ya existe:
--
--   1 · En los recordatorios de cobro, `read_at` YA significa otra cosa:
--       «ya lo mandé» (FIN-4, queries/finanzas.ts · markReminderSent; la
--       bandeja de Finanzas lo enseña como «Enviado el …»). Sellarlo
--       desde Resumen haría que Finanzas dijera que un correo salió
--       cuando nadie lo mandó.
--   2 · Casi todos los avisos van a TODO el espacio (user_id NULL: el
--       puntaje, la cuenta caída, el cobro). Con `read_at`, el
--       «Entendido» de la mánager se lo borraba también a la creadora.
--
-- Así que «leído» es de la persona y vive aparte: una fila por
-- (aviso, persona). Siempre CON persona (user_id NOT NULL). El modo
-- demo corre sin sesión (app.user_id NULL) y en producción lo comparten
-- todos los visitantes: un «Entendido» sin persona vaciaba el bloque
-- para todos los demás, y para siempre. Sin sesión, el «Entendido» es
-- de quien visita y vive en su navegador (una cookie, ver
-- apps/web/app/(app)/resumen/_lib/entendidos.ts); aquí no se escribe.
--
-- «Entendido» se puede deshacer, y sigue sin borrarse nada. Cada gesto
-- es una fila nueva: 'ack' (Entendido) o 'undo' (Deshacer). Lo que vale
-- es el ÚLTIMO gesto de esa persona sobre ese aviso. Así un clic por
-- error no esconde para siempre un cobro vencido (la pantalla ofrece
-- «Deshacer» justo después), y la constancia de lo que pasó no se
-- reescribe: no hace falta ni UPDATE ni DELETE, ni una función
-- SECURITY DEFINER que los rodee.
--
-- Aislamiento:
--   · RLS por workspace con FORCE, como todas (0010, 0024).
--   · Al escribir, además, la fila es de quien escribe: WITH CHECK pide
--     user_id = current_user_id(). Nadie marca leído —ni deshace— por
--     otro, y sin sesión no se escribe nada (NOT NULL).
--   · Y al leer, también: cada persona ve solo SUS gestos. Quién dio
--     «Entendido» a qué y cuándo no es asunto del resto del espacio, y
--     ninguna consulta lo necesita (el bloque pregunta por los propios).
--   · mc_app solo lee e inserta: un gesto no se corrige ni se borra.
--     Ni UPDATE ni DELETE (packages/db/src/esquema.ts,
--     PRIVILEGIOS_DE_LA_APP).
--   · Las tres claves ajenas llevan assert_reference_visible (0025 §3):
--     nadie apunta a un aviso, una persona o un espacio que no ve.
--
-- Rendimiento. El bloque elige, por cada cosa (video, cuenta, factura,
-- negocio, cuenta de envío), su aviso MÁS RECIENTE (DISTINCT ON
-- entity_id … ORDER BY created_at DESC), y el productor de las cuentas
-- rotas pregunta lo mismo antes de escribir. El único índice útil de
-- 0009 era (workspace_id, created_at DESC), y sales.follow_ups y
-- finance.reminders escriben a diario: sin el índice de abajo, la
-- consulta de arriba del panel recorría todo el historial del espacio.
-- Parcial (entity_id IS NOT NULL): los avisos sin cosa no lo usan.
--
-- Idempotente: IF NOT EXISTS, DROP … IF EXISTS antes de cada CREATE.
-- =====================================================================

-- Para el filtro de cada rama del bloque: el aviso más reciente de cada
-- cosa, por espacio, tipo de cosa y cosa (ver «Rendimiento» arriba).
CREATE INDEX IF NOT EXISTS notification_entity_recent_idx
  ON notification (workspace_id, entity_type, entity_id, created_at DESC)
  WHERE entity_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS notification_ack (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  notification_id     uuid NOT NULL REFERENCES notification(id) ON DELETE CASCADE,
  -- Siempre una persona: sin sesión no se escribe aquí (ver arriba).
  user_id             uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  -- 'ack' = «Entendido»; 'undo' = «Deshacer». Vale el último.
  action              text NOT NULL DEFAULT 'ack' CHECK (action IN ('ack', 'undo')),
  -- clock_timestamp() y no now(): dos gestos de la misma transacción
  -- (una prueba, un script) no empatan, y «el último» queda claro.
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- El último gesto de una persona sobre un aviso. Sin UNIQUE: cada gesto
-- es su fila.
CREATE INDEX IF NOT EXISTS notification_ack_last_idx
  ON notification_ack (workspace_id, notification_id, user_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notification_ack' AND column_name = 'workspace_id'
  ) THEN
    RAISE EXCEPTION 'notification_ack está en la lista de RLS pero no tiene workspace_id';
  END IF;
END $$;
ALTER TABLE notification_ack ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_ack FORCE ROW LEVEL SECURITY;

-- Cada persona lee solo sus gestos (ver «Aislamiento» arriba).
DROP POLICY IF EXISTS notification_ack_ws_read ON notification_ack;
DROP POLICY IF EXISTS notification_ack_own_read ON notification_ack;
CREATE POLICY notification_ack_own_read ON notification_ack FOR SELECT
  USING (workspace_id = current_workspace_id() AND user_id = current_user_id());

DROP POLICY IF EXISTS notification_ack_own_insert ON notification_ack;
CREATE POLICY notification_ack_own_insert ON notification_ack FOR INSERT
  WITH CHECK (workspace_id = current_workspace_id() AND user_id IS NOT DISTINCT FROM current_user_id());

REVOKE UPDATE, DELETE ON notification_ack FROM mc_app;

DROP TRIGGER IF EXISTS ref_visible_workspace_id ON notification_ack;
CREATE TRIGGER ref_visible_workspace_id
  BEFORE INSERT OR UPDATE OF workspace_id ON notification_ack
  FOR EACH ROW WHEN (NEW.workspace_id IS NOT NULL)
  EXECUTE FUNCTION assert_reference_visible('workspace_id', 'workspace', 'id');
DROP TRIGGER IF EXISTS ref_visible_notification_id ON notification_ack;
CREATE TRIGGER ref_visible_notification_id
  BEFORE INSERT OR UPDATE OF notification_id ON notification_ack
  FOR EACH ROW WHEN (NEW.notification_id IS NOT NULL)
  EXECUTE FUNCTION assert_reference_visible('notification_id', 'notification', 'id');
DROP TRIGGER IF EXISTS ref_visible_user_id ON notification_ack;
CREATE TRIGGER ref_visible_user_id
  BEFORE INSERT OR UPDATE OF user_id ON notification_ack
  FOR EACH ROW WHEN (NEW.user_id IS NOT NULL)
  EXECUTE FUNCTION assert_reference_visible('user_id', 'app_user', 'id');

COMMENT ON TABLE notification_ack IS
  'El «Entendido» (y su «Deshacer») de una persona sobre un aviso de notification (RES-3, «Lo que importa esta '
  'semana»). Es de la persona y no del aviso: notification.read_at ya significa «ya lo mandé» en los recordatorios '
  'de cobro (FIN-4) y casi todos los avisos van a todo el espacio. Cada gesto es una fila y vale el último. Siempre '
  'con persona: sin sesión (modo demo) el gesto vive en el navegador de quien visita. mc_app lee e inserta solo las '
  'suyas; no se corrigen ni se borran.';
