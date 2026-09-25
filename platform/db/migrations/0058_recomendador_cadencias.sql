-- =====================================================================
-- 0058 · El recomendador de cadencias (VEN-13)
-- ---------------------------------------------------------------------
-- Número: va detrás de 0055_motor_equipo_y_reclamo. 0056 y 0057 quedan
-- libres a propósito para las piezas que se construyen a la vez en la
-- fase 5 (perfil y generación, VEN-11 y VEN-12): así las tres ramas no
-- chocan al integrarse. El runner acepta huecos (0046–0049 ya lo son).
--
-- 1 · De qué señal nació una secuencia, y qué propuso el recomendador
--
-- outbound_sequence.signal_id: la señal del radar desde la que se pidió
-- la propuesta («Proponer desde esta señal», docs/ventas-outreach.md
-- §5.5). La pantalla de la cadencia la enseña y la vuelve a usar para
-- proponer otra vez. ON DELETE SET NULL: borrar la señal no borra la
-- cadencia, solo su origen.
--
-- outbound_sequence.proposal: lo que decidió el recomendador, en códigos
-- (la plantilla elegida, el tipo de señal, los pasos que cambió de canal
-- y por qué, si la guía la redactó el modelo o las reglas). Son códigos
-- y no frases: la pantalla los traduce en su messages.ts, así que la
-- explicación sigue el idioma de quien la lee. NULL = la cadencia no
-- salió del recomendador (una plantilla elegida a mano, o anterior).
--
-- 2 · Las plantillas por nicho y por tipo de señal (§5.5)
--
-- 0037 trajo una: «Marca con campaña activa». Aquí siete más, escritas
-- con el mismo criterio (un ángulo por toque, sin repetir el de otro
-- día, mezcla de público, correo y directo), para las otras señales y
-- para tres nichos con reglas propias (cocina, belleza, fitness). Dos
-- de ellas caben en la política por defecto (cuatro mensajes, tres días
-- entre ellos, 0007): la de la colaboración de un competidor y la de la
-- señal manual. Las demás mandan cinco o seis toques; la pantalla avisa
-- antes de activar qué pasos no saldrán con la política del espacio
-- (checkSequenceAgainstPolicy, §8 pregunta 8).
--
-- La guía de cada paso es contenido para el generador (VEN-12) y para
-- quien revisa: dice con qué abrir, qué no mencionar y cómo cerrar. No
-- lleva huecos {{…}}: no se envía, se obedece.
-- =====================================================================


-- =====================================================================
-- 1 · outbound_sequence: señal de origen y propuesta
-- =====================================================================
ALTER TABLE outbound_sequence
  ADD COLUMN signal_id uuid REFERENCES signal(id) ON DELETE SET NULL,
  ADD COLUMN proposal  jsonb CHECK (proposal IS NULL OR jsonb_typeof(proposal) = 'object');

CREATE INDEX ON outbound_sequence (signal_id);

-- La referencia visible de 0025 §3: una secuencia solo puede nombrar una
-- señal que quien escribe puede leer (la de su workspace). Mismo
-- disparador y mismo nombre que crea el bucle de 0037 §7.5.
CREATE TRIGGER ref_visible_signal_id
  BEFORE INSERT OR UPDATE OF signal_id ON outbound_sequence
  FOR EACH ROW WHEN (NEW.signal_id IS NOT NULL)
  EXECUTE FUNCTION assert_reference_visible('signal_id', 'signal', 'id');


-- =====================================================================
-- 2 · Las plantillas
-- ---------------------------------------------------------------------
-- Van sin workspace fijado (la política de alta de 0037 §7.3 es de quien
-- migra). Cada paso tiene la forma de TemplateStep (@mc/db/schema).
-- =====================================================================
INSERT INTO outbound_sequence_template (slug, name_es, description_es, signal_kind, niche_slug, steps) VALUES

-- ---------------------------------------------------------------------
-- 2.1 · Lanzamiento de producto (cualquier nicho)
-- ---------------------------------------------------------------------
-- La marca acaba de sacar algo y necesita que se conozca: la idea
-- creativa va en el primer correo, no en el cuarto. Lo demás respalda
-- esa idea.
('lanzamiento-de-producto',
 'Lanzamiento de producto',
 'Seis toques en diez días para una marca que acaba de lanzar: presencia, una idea para el lanzamiento en el primer '
 'correo, encaje de audiencia, prueba de desempeño, prueba social y cierre con media kit y cotización.',
 'launch', NULL,
 '[
   {"day_offset": 0, "order_in_day": 0, "step_type": "linkedin_comment", "channel": "linkedin", "angle_key": "presencia",
    "scheduled_time": "10:00", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Comenta el post del lanzamiento: qué te llamó la atención del producto, en una o dos frases. No vendas, no menciones tarifas ni pongas enlaces."},
   {"day_offset": 1, "order_in_day": 0, "step_type": "email", "channel": "email", "angle_key": "concepto_creativo",
    "scheduled_time": "09:30", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Abre con el producto que acaban de lanzar y una idea de video concreta para darlo a conocer. No menciones precio ni cifras todavía. Cierra con una sola pregunta."},
   {"day_offset": 3, "order_in_day": 0, "step_type": "linkedin_message", "channel": "linkedin", "angle_key": "encaje_audiencia",
    "scheduled_time": "10:30", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Mensaje corto: quién ve tus videos y por qué es quien compraría el producto nuevo, con una cifra de tu perfil. No repitas la idea del correo."},
   {"day_offset": 5, "order_in_day": 0, "step_type": "email_reply", "channel": "email", "angle_key": "prueba_desempeno",
    "scheduled_time": "09:30", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Responde en el mismo hilo con un video tuyo de un lanzamiento parecido y sus views frente a tu mediana. Sin demografía. Cierra con una sola pregunta."},
   {"day_offset": 7, "order_in_day": 0, "step_type": "linkedin_message", "channel": "linkedin", "angle_key": "prueba_social",
    "scheduled_time": "10:30", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Cuenta el resultado medido de una campaña tuya con una marca del mismo sector. Solo campañas con resultado; no nombres a su competencia directa."},
   {"day_offset": 10, "order_in_day": 0, "step_type": "email", "channel": "email", "angle_key": "sintesis",
    "scheduled_time": "09:30", "generate_with_ai": true, "requires_asset": "media_kit",
    "guidance_es": "Resume en tres líneas la idea para el lanzamiento, enlaza el media kit y la cotización y propón una fecha concreta para hablar. Sin urgencia falsa."}
 ]'::jsonb),

-- ---------------------------------------------------------------------
-- 2.2 · Temporada comercial (cualquier nicho)
-- ---------------------------------------------------------------------
-- Las marcas planean la temporada con semanas de antelación: la idea va
-- atada a la fecha en que tendría que publicarse, y los toques se
-- separan más para no parecer apuro.
('temporada-comercial',
 'Temporada comercial',
 'Cinco toques en once días para una marca que prepara su temporada: presencia, una idea con fecha de '
 'publicación, prueba de desempeño, prueba social y cierre con la cotización.',
 'season', NULL,
 '[
   {"day_offset": 0, "order_in_day": 0, "step_type": "linkedin_comment", "channel": "linkedin", "angle_key": "presencia",
    "scheduled_time": "10:00", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Comenta algo concreto de su último post. No vendas, no hables de la temporada todavía, no pongas enlaces."},
   {"day_offset": 1, "order_in_day": 0, "step_type": "email", "channel": "email", "angle_key": "concepto_creativo",
    "scheduled_time": "09:30", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Abre con la temporada que viene y una idea de video para ella, con la semana en que tendría que publicarse. No menciones precio. Cierra con una sola pregunta."},
   {"day_offset": 4, "order_in_day": 0, "step_type": "linkedin_message", "channel": "linkedin", "angle_key": "prueba_desempeno",
    "scheduled_time": "10:30", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Mensaje corto con un video tuyo de la misma temporada del año pasado y sus views frente a tu mediana. No repitas la idea del correo."},
   {"day_offset": 7, "order_in_day": 0, "step_type": "email_reply", "channel": "email", "angle_key": "prueba_social",
    "scheduled_time": "09:30", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Responde en el mismo hilo con una campaña de temporada que hiciste y su resultado medido. Solo campañas con resultado. Cierra con una sola pregunta."},
   {"day_offset": 11, "order_in_day": 0, "step_type": "email", "channel": "email", "angle_key": "sintesis",
    "scheduled_time": "09:30", "generate_with_ai": true, "requires_asset": "quote",
    "guidance_es": "Resume la idea y la fecha de publicación, enlaza la cotización y el media kit y propón una fecha para cerrar el calendario. Sin presión ni cupos que se acaban."}
 ]'::jsonb),

-- ---------------------------------------------------------------------
-- 2.3 · Colaboración de un competidor (cualquier nicho)
-- ---------------------------------------------------------------------
-- La señal es delicada: la marca no quiere oír que su competencia se
-- movió primero. Nunca se nombra la colaboración vista; se habla de la
-- categoría. Cuatro mensajes a tres días: cabe en la política por
-- defecto.
('colaboracion-de-un-competidor',
 'Colaboración de un competidor',
 'Cuatro mensajes, tres días entre ellos, para una marca cuya categoría ya está trabajando con creadores: encaje '
 'de audiencia, prueba de desempeño, idea propia y cierre. Nunca nombra la colaboración que se vio.',
 'collab', NULL,
 '[
   {"day_offset": 0, "order_in_day": 0, "step_type": "email", "channel": "email", "angle_key": "encaje_audiencia",
    "scheduled_time": "09:30", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Abre con quién ve tus videos y por qué es su cliente, con una cifra de tu perfil. No nombres la colaboración que viste ni a su competencia. Cierra con una sola pregunta."},
   {"day_offset": 3, "order_in_day": 0, "step_type": "linkedin_message", "channel": "linkedin", "angle_key": "prueba_desempeno",
    "scheduled_time": "10:30", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Mensaje corto con un video tuyo de su categoría y sus views frente a tu mediana. No compares con lo que hace su competencia."},
   {"day_offset": 6, "order_in_day": 0, "step_type": "email_reply", "channel": "email", "angle_key": "concepto_creativo",
    "scheduled_time": "09:30", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Responde en el mismo hilo con una idea de video que solo funcione para su marca, no para la categoría. Sin cifras de audiencia. Cierra con una sola pregunta."},
   {"day_offset": 9, "order_in_day": 0, "step_type": "email", "channel": "email", "angle_key": "sintesis",
    "scheduled_time": "09:30", "generate_with_ai": true, "requires_asset": "media_kit",
    "guidance_es": "Resume en tres líneas, enlaza el media kit y la cotización y propón una fecha concreta para hablar. Sin urgencia falsa ni menciones a la competencia."}
 ]'::jsonb),

-- ---------------------------------------------------------------------
-- 2.4 · Señal añadida a mano (cualquier nicho)
-- ---------------------------------------------------------------------
-- Sin evento que citar: la cadencia se apoya en el encaje y en una idea
-- propia. La más corta, y cabe en la política por defecto.
('senal-manual',
 'Marca elegida a mano',
 'Cuatro mensajes, tres días entre ellos, para una marca que elegiste tú sin una señal del radar: encaje de '
 'audiencia, prueba de desempeño, idea para su marca y cierre.',
 'manual', NULL,
 '[
   {"day_offset": 0, "order_in_day": 0, "step_type": "email", "channel": "email", "angle_key": "encaje_audiencia",
    "scheduled_time": "09:30", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Abre con por qué escribes a esta marca y no a otra: la coincidencia entre tu audiencia y su cliente, con una cifra de tu perfil. No menciones precio. Cierra con una sola pregunta."},
   {"day_offset": 3, "order_in_day": 0, "step_type": "linkedin_message", "channel": "linkedin", "angle_key": "prueba_desempeno",
    "scheduled_time": "10:30", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Mensaje corto con un video tuyo parecido a lo que la marca publica y sus views frente a tu mediana. No repitas la demografía del correo."},
   {"day_offset": 6, "order_in_day": 0, "step_type": "email_reply", "channel": "email", "angle_key": "concepto_creativo",
    "scheduled_time": "09:30", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Responde en el mismo hilo con una idea de video concreta para uno de sus productos. Sin cifras de audiencia. Cierra con una sola pregunta."},
   {"day_offset": 9, "order_in_day": 0, "step_type": "email", "channel": "email", "angle_key": "sintesis",
    "scheduled_time": "09:30", "generate_with_ai": true, "requires_asset": "media_kit",
    "guidance_es": "Resume en tres líneas, enlaza el media kit y la cotización y propón una fecha concreta para hablar. Sin urgencia falsa."}
 ]'::jsonb),

-- ---------------------------------------------------------------------
-- 2.5 · Cocina · marca con campaña activa
-- ---------------------------------------------------------------------
-- Una marca de alimentos que ya pauta se compra con recetas: el
-- concepto es un plato con su producto, y la presencia es en Instagram,
-- donde vive su cocina (si el espacio no tiene Instagram, el
-- recomendador la pasa a LinkedIn o a una tarea a mano).
('cocina-campana-activa',
 'Cocina · marca con campaña activa',
 'Seis toques en nueve días para una marca de alimentos que ya está pautando: presencia en su Instagram, encaje '
 'de audiencia, una receta tuya que funcionó, una receta con su producto, prueba social y cierre.',
 'active_campaign', 'cocina',
 '[
   {"day_offset": 0, "order_in_day": 0, "step_type": "instagram_comment", "channel": "instagram_dm", "angle_key": "presencia",
    "scheduled_time": "10:00", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Comenta una de las recetas o piezas de su campaña: qué harías con ese producto en tu cocina. No vendas, no menciones tarifas ni pongas enlaces."},
   {"day_offset": 1, "order_in_day": 0, "step_type": "email", "channel": "email", "angle_key": "encaje_audiencia",
    "scheduled_time": "09:30", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Abre con quién cocina tus recetas y por qué es quien compra su producto, con una cifra de tu perfil. No menciones precio. Cierra con una sola pregunta."},
   {"day_offset": 3, "order_in_day": 0, "step_type": "linkedin_message", "channel": "linkedin", "angle_key": "prueba_desempeno",
    "scheduled_time": "10:30", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Mensaje corto con una receta tuya de la misma categoría y sus views frente a tu mediana, o sus guardados por mil. No repitas la audiencia del correo."},
   {"day_offset": 5, "order_in_day": 0, "step_type": "email_reply", "channel": "email", "angle_key": "concepto_creativo",
    "scheduled_time": "09:30", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Responde en el mismo hilo con una receta concreta que tenga su producto como protagonista, pensada para su campaña activa. Sin cifras de audiencia. Cierra con una sola pregunta."},
   {"day_offset": 7, "order_in_day": 0, "step_type": "linkedin_message", "channel": "linkedin", "angle_key": "prueba_social",
    "scheduled_time": "10:30", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Cuenta el resultado medido de una campaña tuya con otra marca de alimentos que no compita con ella. Solo campañas con resultado."},
   {"day_offset": 9, "order_in_day": 0, "step_type": "email", "channel": "email", "angle_key": "sintesis",
    "scheduled_time": "09:30", "generate_with_ai": true, "requires_asset": "media_kit",
    "guidance_es": "Resume la receta propuesta en tres líneas, enlaza el media kit y la cotización y propón una fecha concreta para hablar. Sin urgencia falsa."}
 ]'::jsonb),

-- ---------------------------------------------------------------------
-- 2.6 · Belleza · lanzamiento
-- ---------------------------------------------------------------------
-- En belleza la prueba es el uso real y la regla es no prometer
-- resultados: nada de «elimina», «cura» ni antes y después retocados.
-- Instagram es el canal natural; donde no esté, el recomendador lo pasa
-- a LinkedIn o a correo.
('belleza-lanzamiento',
 'Belleza · lanzamiento',
 'Cinco toques en nueve días para una marca de belleza que lanza un producto: presencia en su Instagram, encaje '
 'de audiencia, un tutorial tuyo que funcionó, una idea de uso real sin promesas y cierre.',
 'launch', 'belleza',
 '[
   {"day_offset": 0, "order_in_day": 0, "step_type": "instagram_comment", "channel": "instagram_dm", "angle_key": "presencia",
    "scheduled_time": "10:00", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Comenta el post del lanzamiento con una pregunta genuina sobre el producto (textura, uso, tono). No vendas ni pongas enlaces."},
   {"day_offset": 1, "order_in_day": 0, "step_type": "email", "channel": "email", "angle_key": "encaje_audiencia",
    "scheduled_time": "09:30", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Abre con quién sigue tus rutinas y por qué es clienta del producto nuevo, con una cifra de tu perfil. No menciones precio. Cierra con una sola pregunta."},
   {"day_offset": 3, "order_in_day": 0, "step_type": "instagram_dm", "channel": "instagram_dm", "angle_key": "prueba_desempeno",
    "scheduled_time": "10:30", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Mensaje corto con un tutorial o reseña tuya y sus views frente a tu mediana. No repitas la audiencia del correo."},
   {"day_offset": 6, "order_in_day": 0, "step_type": "email_reply", "channel": "email", "angle_key": "concepto_creativo",
    "scheduled_time": "09:30", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Responde en el mismo hilo con una idea de uso real del producto nuevo. No prometas resultados ni hables de antes y después. Cierra con una sola pregunta."},
   {"day_offset": 9, "order_in_day": 0, "step_type": "email", "channel": "email", "angle_key": "sintesis",
    "scheduled_time": "09:30", "generate_with_ai": true, "requires_asset": "media_kit",
    "guidance_es": "Resume en tres líneas, enlaza el media kit y la cotización y propón una fecha concreta para hablar. Sin urgencia falsa."}
 ]'::jsonb),

-- ---------------------------------------------------------------------
-- 2.7 · Fitness · temporada
-- ---------------------------------------------------------------------
-- Enero, el regreso a clases o el verano: la marca de fitness planea con
-- tiempo. La regla del nicho es no prometer cambios físicos ni hablar
-- de salud. Cuatro mensajes a tres días: cabe en la política por
-- defecto.
('fitness-temporada',
 'Fitness · temporada',
 'Cuatro mensajes, tres días entre ellos, para una marca de fitness o bienestar que prepara su temporada: encaje '
 'de audiencia, prueba de desempeño, un reto o rutina con fecha y cierre. Sin promesas de salud.',
 'season', 'fitness',
 '[
   {"day_offset": 0, "order_in_day": 0, "step_type": "email", "channel": "email", "angle_key": "encaje_audiencia",
    "scheduled_time": "09:30", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Abre con quién entrena contigo y por qué es su cliente en la temporada que viene, con una cifra de tu perfil. No menciones precio. Cierra con una sola pregunta."},
   {"day_offset": 3, "order_in_day": 0, "step_type": "linkedin_message", "channel": "linkedin", "angle_key": "prueba_desempeno",
    "scheduled_time": "10:30", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Mensaje corto con una rutina o reto tuyo que funcionó y sus views frente a tu mediana. No repitas la audiencia del correo."},
   {"day_offset": 6, "order_in_day": 0, "step_type": "email_reply", "channel": "email", "angle_key": "concepto_creativo",
    "scheduled_time": "09:30", "generate_with_ai": true, "requires_asset": null,
    "guidance_es": "Responde en el mismo hilo con un reto de varias semanas con su producto y la fecha en que empezaría. No prometas cambios físicos ni hables de salud. Cierra con una sola pregunta."},
   {"day_offset": 9, "order_in_day": 0, "step_type": "email", "channel": "email", "angle_key": "sintesis",
    "scheduled_time": "09:30", "generate_with_ai": true, "requires_asset": "quote",
    "guidance_es": "Resume el reto en tres líneas, enlaza la cotización y el media kit y propón una fecha para cerrar el calendario. Sin presión."}
 ]'::jsonb);


-- ---------------------------------------------------------------------
-- 2.8 · La forma de cada paso, comprobada al migrar
-- ---------------------------------------------------------------------
-- Un paso mal escrito en el jsonb no falla hasta que alguien crea una
-- secuencia con él. Aquí falla la migración: cada paso de cada
-- plantilla tiene un tipo que outbound_step acepta, el canal que ese
-- tipo exige, un ángulo del catálogo global, una hora HH:MM y guía; y
-- dentro de una plantilla no hay dos pasos en el mismo día y orden.
DO $$
DECLARE
  malo record;
BEGIN
  SELECT tpl.slug, p.paso INTO malo
    FROM outbound_sequence_template tpl
   CROSS JOIN LATERAL jsonb_array_elements(tpl.steps) AS p(paso)
   WHERE NOT (
         p.paso->>'step_type' IN ('email','email_reply','linkedin_connect','linkedin_message','linkedin_comment',
                                  'linkedin_like','instagram_dm','instagram_comment','instagram_like',
                                  'whatsapp_message','manual_task')
     AND p.paso->>'channel' = CASE
           WHEN p.paso->>'step_type' IN ('email','email_reply') THEN 'email'
           WHEN p.paso->>'step_type' LIKE 'linkedin\_%' THEN 'linkedin'
           WHEN p.paso->>'step_type' LIKE 'instagram\_%' THEN 'instagram_dm'
           WHEN p.paso->>'step_type' = 'whatsapp_message' THEN 'whatsapp'
           ELSE p.paso->>'channel' END
     AND EXISTS (SELECT 1 FROM outbound_angle a WHERE a.workspace_id IS NULL AND a.key = p.paso->>'angle_key')
     AND (p.paso->>'day_offset')::int BETWEEN 0 AND 60
     AND p.paso->>'scheduled_time' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     AND length(coalesce(p.paso->>'guidance_es', '')) BETWEEN 20 AND 400
     AND coalesce(p.paso->>'requires_asset', 'media_kit') IN ('media_kit', 'quote')
   )
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'La plantilla % tiene un paso que outbound_step no aceptaría: %', malo.slug, malo.paso;
  END IF;

  SELECT tpl.slug INTO malo
    FROM outbound_sequence_template tpl
   CROSS JOIN LATERAL jsonb_array_elements(tpl.steps) AS p(paso)
   GROUP BY tpl.slug, p.paso->>'day_offset', p.paso->>'order_in_day'
  HAVING count(*) > 1
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'La plantilla % tiene dos pasos en el mismo día y orden', malo.slug;
  END IF;
END $$;
