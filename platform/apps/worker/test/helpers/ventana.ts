/**
 * Un instante dentro del horario de envío que YA llegó, para las pruebas
 * que despachan la demo «ahora» (CIM-12).
 *
 * Antes usaban nextWindowSlot(new Date()): «ahora, o la PRÓXIMA apertura».
 * Un sábado, un domingo o un festivo de Colombia eso cae en el futuro del
 * reloj de la base (el now() de PGlite), el despacho no reclama nada y la
 * prueba da rojo según el día de la semana; lo encontró
 * `estres-verificar.sh --ancla-rotando`. Aquí: ahora, si la ventana está
 * abierta; si no, las 10:00 del último día hábil.
 */
import { isInsideWindow, type SendWindow } from '@mc/core';

export function aperturaReciente(timeZone: string, window: SendWindow, ahora: Date = new Date()): Date {
  if (isInsideWindow(ahora, timeZone, window)) return ahora;
  for (let d = 0; d <= 14; d++) {
    const dia = new Date(ahora.getTime() - d * 86_400_000).toLocaleDateString('en-CA', { timeZone });
    // Las 10:00 de ese día en la zona: se busca el instante cuya hora local es esa.
    const t = diezEn(dia, timeZone);
    if (t.getTime() <= ahora.getTime() && isInsideWindow(t, timeZone, window)) return t;
  }
  throw new Error(`sin horario de envío en las dos últimas semanas (${timeZone})`);
}

/** Las 10:00 de `dia` (AAAA-MM-DD) en `timeZone`, sin tablas de desfases: se corrige con el que da Intl. */
function diezEn(dia: string, timeZone: string): Date {
  const utc = new Date(`${dia}T10:00:00Z`);
  const local = new Date(utc.toLocaleString('en-US', { timeZone }));
  const enUtc = new Date(utc.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(utc.getTime() + (enUtc.getTime() - local.getTime()));
}
