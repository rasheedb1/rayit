/**
 * La clave de una categoría del brief de outbound (VEN-7), en un sitio
 * puro: la usan la consulta (@mc/db/queries/brief, para no guardar
 * «Alcohol» y «alcohol» dos veces) y el componente de cliente de la
 * pantalla (para no dejar agregar la misma dos veces). Un componente de
 * cliente no puede importar @mc/db, que arrastra el cliente de Postgres;
 * antes cada capa tenía su copia y podían separarse.
 *
 * Es la misma idea que brand_key en SQL (0031): sin tildes, sin
 * mayúsculas, sin signos. La comparación con las señales la hace la base
 * con brand_key; esta solo decide qué cuenta como repetida al escribir.
 */
export function categoryKey(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}
