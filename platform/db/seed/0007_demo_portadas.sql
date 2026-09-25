-- =====================================================================
-- Seed 7 · Portadas de los videos de la demo (VEN-11)
-- ---------------------------------------------------------------------
-- Hasta aquí ningún post de la demo tenía cover_url: en /ventas/perfil
-- «Tus cinco mejores videos» salía sin una sola portada, y en un media
-- kit (Beacons, Passionfroot) la portada es lo primero que mira una
-- marca. Las plataformas reales la dan (cover_image_url de TikTok,
-- thumbnail_url de Instagram, thumbnails de YouTube); la demo no tiene
-- plataforma, así que usa ocho ilustraciones propias que sirve la web
-- (apps/web/public/demo/portadas/1..8.svg): una ruta de la aplicación,
-- que coverSrcOrNull de @mc/core acepta como portada.
--
-- Reglas del archivo (las de 0002, 0004, 0005 y 0006):
--   * Idempotente: solo llena la portada que falta (cover_url IS NULL).
--     Lo que un conector o una persona haya puesto no se pisa, y una
--     segunda corrida no cambia nada. Los videos que 0002 añade con el
--     reloj reciben la suya en la corrida siguiente.
--   * Determinista: la ilustración sale del id del post (sus últimos
--     cuatro dígitos hexadecimales, módulo ocho), así que el mismo video
--     tiene siempre la misma portada.
--   * Solo el workspace de la demo (Laura · Cocina fácil).
-- =====================================================================

SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);

UPDATE post
   SET cover_url = '/demo/portadas/' || ((('x' || right(replace(id::text, '-', ''), 4))::bit(16)::int % 8) + 1) || '.svg'
 WHERE workspace_id = '00000002-0000-4000-8000-000000000001'
   AND creator_id = '00000002-0000-4000-8000-000000000003'
   AND cover_url IS NULL;
