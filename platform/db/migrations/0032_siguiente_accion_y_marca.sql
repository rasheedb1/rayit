-- =====================================================================
-- 0032 · La siguiente acción del producto se reconoce por un marcador,
--        no por su frase; y la llave de marca no depende de la
--        intercalación (VEN-2, VEN-3, pulido r5)
-- ---------------------------------------------------------------------
-- Número: 0031 es la última de rasheed/integracion (mover negocio).
-- Ninguna de 0024–0031 está aplicada en Supabase; esta va detrás de
-- todas porque reemplaza brand_key de 0031. Si otra área eligió también
-- 0032, el integrador renumera: no depende de nada que venga después.
--
-- 1 · deal.next_action_kind
--
--   @mc/db no tiene idioma: las frases las pone cada módulo. Pero el
--   negocio guardaba en next_action la frase «Enviar pitch» y, al enviar
--   una cotización, followUpAfterProposal comparaba contra esa misma
--   frase para saber si la siguiente acción era el pitch del radar (que
--   una propuesta con precio deja atrás) o una que escribió la persona
--   (que se respeta). Un espacio en otro idioma guarda «Send pitch», y el
--   día que se traduzca Ventas la comparación dejaba de reconocerla.
--
--   Ahora lo que se compara es un marcador estable:
--     'pitch'            la que pone el producto al abrir un negocio
--     'quote_follow_up'  la que pone al enviar una cotización
--     NULL               la escribió una persona: nadie la reemplaza
--   La frase sigue en next_action, en el idioma de quien la puso.
--
--   Un disparador vuelve el marcador a NULL cuando alguien cambia la
--   frase sin decir qué es (la editará a mano, VEN-4): así el marcador
--   nunca dice «es el pitch» de un texto que ya no lo es. Quien cambia
--   la frase Y el marcador en el mismo UPDATE (el seguimiento de una
--   cotización) conserva el suyo. No es SECURITY DEFINER: solo cambia
--   NEW y corre con los permisos de quien escribe.
--
--   Relleno: las filas que ya existen con la frase del producto reciben
--   su marcador. deal tiene FORCE ROW LEVEL SECURITY y la migración corre
--   sin workspace fijado, así que las políticas le esconderían todas las
--   filas; como en 0026, el rol que migra (dueño de la tabla) le quita
--   FORCE solo durante el relleno y se lo devuelve, dentro de la misma
--   transacción.
--
-- 2 · brand_key sin depender de lower()
--
--   brand_key (0031) hacía lower() y después quitaba las tildes de las
--   minúsculas. lower() de una letra no ASCII depende de la intercalación
--   de la base: con la «C» deja «Ñ» y «É» como están, y entonces
--   «ZETA BEBIDAS ÑANDÚ» perdía la eñe entera («zetabebidasandu») y la
--   búsqueda de Empresas por «nandu» no la encontraba. Ahora translate
--   cubre también las mayúsculas, y el resultado es el mismo en
--   cualquier base. Sigue siendo IMMUTABLE y nada la indexa todavía.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1 · El marcador de la siguiente acción
-- ---------------------------------------------------------------------
ALTER TABLE deal
  ADD COLUMN next_action_kind text
    CHECK (next_action_kind IN ('pitch', 'quote_follow_up'));

CREATE FUNCTION deal_next_action_kind_reset()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.next_action IS DISTINCT FROM OLD.next_action
     AND NEW.next_action_kind IS NOT DISTINCT FROM OLD.next_action_kind THEN
    NEW.next_action_kind := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER deal_next_action_kind_reset
  BEFORE UPDATE OF next_action ON deal
  FOR EACH ROW EXECUTE FUNCTION deal_next_action_kind_reset();

DO $$
DECLARE
  forzada boolean;
BEGIN
  SELECT c.relforcerowsecurity INTO forzada
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'deal';
  IF forzada THEN
    ALTER TABLE deal NO FORCE ROW LEVEL SECURITY;
  END IF;

  -- Las frases que el producto escribía hasta hoy (0031 y antes).
  UPDATE deal SET next_action_kind = 'pitch'
   WHERE next_action_kind IS NULL AND btrim(next_action) = 'Enviar pitch';
  UPDATE deal SET next_action_kind = 'quote_follow_up'
   WHERE next_action_kind IS NULL AND btrim(next_action) = 'Seguimiento a la cotización';

  IF forzada THEN
    ALTER TABLE deal FORCE ROW LEVEL SECURITY;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2 · brand_key, igual en cualquier intercalación
-- ---------------------------------------------------------------------
-- CREATE OR REPLACE conserva el dueño y el GRANT EXECUTE de 0031.
CREATE OR REPLACE FUNCTION brand_key(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT nullif(
           regexp_replace(
             lower(translate(btrim(coalesce(p_name, '')),
                             'áàäâãåéèëêíìïîóòöôõúùüûñçýÁÀÄÂÃÅÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇÝ',
                             'aaaaaaeeeeiiiiooooouuuuncyAAAAAAEEEEIIIIOOOOOUUUUNCY')),
             '[^a-z0-9]+', '', 'g'),
           '')
$$;
