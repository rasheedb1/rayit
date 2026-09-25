/**
 * Cómo se nombra una cuenta de canal en una alerta o en la pantalla.
 * Utilidad de presentación, fuera de la entregabilidad (r5). Cuando se
 * integre VEN-9, va junto a sus textos de canales
 * (packages/core/src/canales-textos.ts en esa rama).
 */

/**
 * «LinkedIn: Laura · Cocina fácil». Si el nombre que dio la persona ya
 * dice el canal como palabra suelta («Laura (LinkedIn)»), va solo: el
 * canal no se repite. Dentro de una dirección («laura@gmail.com») no
 * cuenta.
 * `channelLabel` llega traducido (messages.ts de quien pinta).
 */
export function channelAccountLabel(channelLabel: string, name: string): string {
  const canal = channelLabel.trim();
  const nombre = name.trim();
  if (!canal) return nombre;
  if (!nombre) return canal;
  // Como palabra suelta: «Laura (LinkedIn)» ya lo dice; «laura@gmail.com» no.
  const escapado = canal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const suelto = new RegExp(`(^|[^\\p{L}\\p{N}@.])${escapado}($|[^\\p{L}\\p{N}@.])`, 'iu');
  return suelto.test(nombre) ? nombre : `${canal}: ${nombre}`;
}
