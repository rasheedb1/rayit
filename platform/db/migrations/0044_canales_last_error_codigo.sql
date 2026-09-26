-- =====================================================================
-- canales_last_error_codigo · Canales de outreach: last_error solo guarda códigos
--        (VEN-9, ronda 4 de canales)
-- ---------------------------------------------------------------------
-- Número: detrás de contacto_codigo_de_baja, que tampoco está aplicada en Supabase. El
-- integrador las renumera juntas (canales_outreach a canales_last_error_codigo).
--
-- La regla de la pieza (docs/ventas-outreach.md §9.2) es que en
-- outreach_channel_account.last_error van CÓDIGOS, nunca frases: la web,
-- el webhook y el keepalive escriben CHANNEL_ERROR_CODES de @mc/db
-- ('provider_error', 'gmail_revoked'…) o 'unipile_status:<ESTADO>' para
-- lo que Unipile dijo de la sesión, y la pantalla los traduce al pintar
-- con el idioma del espacio. Hasta aquí la regla solo la cuidaba el
-- código; el seed 0005 se la saltó con una frase y la demo enseñaba el
-- motivo genérico. Desde aquí la cuida la base:
--
--   last_error IS NULL OR last_error ~ '^[a-z_]+(:[A-Z_]+)?$'
--
-- La forma es la de los dos tipos de código: minúsculas y guion bajo, y
-- opcionalmente dos puntos y un estado en mayúsculas (unipileStatusCode
-- limpia el estado a [A-Z_] y lo corta a 40). Un código nuevo con esa
-- forma no pide migración; la pantalla lo enseña con la frase genérica
-- hasta que messages.ts lo traduzca.
--
-- Filas viejas. Un CHECK, aun NOT VALID, se comprueba en CADA UPDATE de
-- la fila (la tupla nueva), no solo cuando cambia last_error: una frase
-- vieja haría fallar el UPDATE de keepalive_checked_at del keepalive y
-- esa cuenta no se volvería a comprobar. Por eso, antes de la
-- restricción, se reescriben:
--
--   · la frase que sembraba 0005 ('LinkedIn cerró la sesión. Vuelve a
--     conectar la cuenta.') pasa a 'unipile_status:CREDENTIALS', que la
--     pantalla traduce igual;
--   · cualquier otra frase pasa a 'unknown' (la pantalla dice el motivo
--     genérico, como ya hacía con una frase). En Supabase no debería
--     haber ninguna: canales_outreach a contacto_codigo_de_baja no se aplicaron, y la web de 0037 no
--     escribía frases en esta columna.
--
-- La tabla tiene RLS forzada y la migración corre sin workspace: se
-- quita FORCE un momento, como en 0032, 0033 y 0037. Después la
-- restricción se valida: si quedara algo fuera, la migración falla
-- entera y no deja una restricción a medias.
-- =====================================================================

DO $$
DECLARE
  forzada boolean;
BEGIN
  SELECT c.relforcerowsecurity INTO forzada
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'outreach_channel_account';
  IF forzada THEN
    ALTER TABLE outreach_channel_account NO FORCE ROW LEVEL SECURITY;
  END IF;

  UPDATE outreach_channel_account
     SET last_error = CASE
           WHEN last_error = 'LinkedIn cerró la sesión. Vuelve a conectar la cuenta.' THEN 'unipile_status:CREDENTIALS'
           ELSE 'unknown'
         END
   WHERE last_error IS NOT NULL AND last_error !~ '^[a-z_]+(:[A-Z_]+)?$';

  IF forzada THEN
    ALTER TABLE outreach_channel_account FORCE ROW LEVEL SECURITY;
  END IF;
END $$;

ALTER TABLE outreach_channel_account
  ADD CONSTRAINT outreach_channel_account_last_error_code_check
  CHECK (last_error IS NULL OR last_error ~ '^[a-z_]+(:[A-Z_]+)?$') NOT VALID;

ALTER TABLE outreach_channel_account
  VALIDATE CONSTRAINT outreach_channel_account_last_error_code_check;

COMMENT ON COLUMN outreach_channel_account.last_error IS
  'Por qué falló la cuenta o el último intento, como CÓDIGO que la pantalla traduce (VEN-9, §9.2): '
  'CHANNEL_ERROR_CODES de @mc/db o unipile_status:<ESTADO>. Nunca una frase ni el texto de un proveedor '
  '(ese va a api_call_log.error_message).';
