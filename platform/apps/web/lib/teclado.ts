/**
 * Lo que comparten los atajos de teclado de las pantallas (la ficha de
 * una empresa, la bandeja de aprobación y la bandeja unificada). Antes
 * estaba copiado en las tres: una corrección en una no llegaba a las
 * otras.
 */

/**
 * ¿La tecla viene de un sitio donde la letra se escribe (un campo, un
 * selector o un texto editable)? Entonces no es un atajo: escribir «a»
 * en un campo es escribir una a.
 */
export function escribiendo(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}
