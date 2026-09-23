/**
 * Consultas del módulo Cotizar. Dueño: Rasheed (COT-1 … COT-4).
 *
 * Tres cosas viven aquí: el tarifario (rate_card), el media kit
 * congelado (media_kit) y la cotización con su enlace público (quote).
 *
 * Este archivo es solo la ENTRADA de @mc/db/queries/cotizar: el código
 * vive repartido por pieza en queries/cotizar/, para que se lea y se
 * revise por partes y dos rondas no se pisen en un archivo de dos mil
 * líneas. La API no cambia: quien importa de aquí recibe lo mismo.
 *
 *   errores.ts    Los errores del dominio, con su código
 *   enlace.ts     El slug y la contraseña de los enlaces
 *   tarifario.ts  COT-1 · rate_card y lo que su precio incluye
 *   media-kit.ts  COT-2 · el snapshot congelado y su enlace
 *   cotizacion.ts COT-3 · borrador, envío, aceptar y rechazar desde el panel
 *   publico.ts    Las tres funciones sin sesión (PublicShareTx)
 *   campana.ts    COT-4 · el cruce con Campañas (CAM-2)
 *   avisos.ts     Los avisos de «la marca aceptó»
 *   interno.ts    Lo que las piezas comparten; NO se reexporta
 *
 * Reglas de todas las piezas, las mismas de todo queries/:
 *   - Toda función del panel recibe un WorkspaceTx: RLS filtra las
 *     lecturas y los INSERT usan current_workspace_id(). Nadie pasa un
 *     workspace_id suelto.
 *   - Un id que llega de fuera se valida con `isUuid` ANTES de
 *     consultar: `/cotizar/no-soy-uuid` tiene que ser un 404 del
 *     producto, no un 22P02 convertido en 500.
 *   - El dinero entra y sale como string decimal. Ninguna consulta hace
 *     aritmética de dinero: la hace packages/core (tarifas.ts), y por
 *     eso el número que el creador ve mientras edita es el que se
 *     guarda.
 *   - Las fechas `date` salen como 'YYYY-MM-DD' (to_char), sin depender
 *     de la zona del driver.
 *
 * Y las TRES funciones públicas de publico.ts (readPublicMediaKit,
 * readPublicQuote, acceptPublicQuote) son la excepción explicada: no
 * reciben WorkspaceTx porque la marca abre el enlace sin sesión, sino un
 * PublicShareTx, que solo abre `db.withPublicShare`. No consultan
 * tablas: llaman a las funciones SECURITY DEFINER de la migración 0030,
 * que corren como mc_public_share y son a la vez la puerta y el registro
 * de la visita. Ver su cabecera para por qué las políticas llevan
 * `TO mc_public_share`.
 *
 * Texto de interfaz: este paquete no escribe frases. Lo que Cotizar deja
 * escrito en tablas de otros módulos (el asunto de una actividad del
 * negocio, el aviso al creador) lo compone la web con su messages.ts y
 * llega aquí como `TextosCotizar`; la fila guarda además el código y
 * los parámetros (activity.metadata.kind, notification.kind +
 * entity_id), para que otra pantalla u otro idioma lo recomponga.
 */

// La API pública, repartida por pieza en queries/cotizar/. interno.ts
// no se reexporta: lo que comparten las piezas no es API.
export * from './cotizar/errores.ts';
export * from './cotizar/enlace.ts';
export * from './cotizar/tarifario.ts';
export * from './cotizar/media-kit.ts';
export * from './cotizar/cotizacion.ts';
export * from './cotizar/publico.ts';
export * from './cotizar/campana.ts';
export * from './cotizar/avisos.ts';
