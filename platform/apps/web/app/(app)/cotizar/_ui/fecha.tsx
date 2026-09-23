"use client";

import { DateInput, type DateInputProps } from "@/components/ui/date-input";

/**
 * El anillo de foco que DateInput no enseña al llegar con Tab.
 *
 * El kit pinta el foco con `focus-visible:`, y en Chromium un
 * `<input type="date">` no casa `:focus-visible` cuando el foco está en
 * su segmento interno (día, mes, año): medido, `matches(':focus-visible')`
 * da false y el campo queda sin anillo. `:focus` sí casa en el input
 * (es el anfitrión del segmento), así que se añade el mismo anillo con
 * `focus:`. Va por `className`, que DateInput ya acepta: no cambia la
 * API del kit.
 *
 * Provisional: el arreglo de fondo es que DateInput lo traiga (PR al
 * kit, revisión de Nicolás). Cuando llegue, este archivo se borra y los
 * formularios vuelven a importar DateInput.
 */
export const FOCO_FECHA = "focus:border-ink focus:ring-2 focus:ring-ink/15";

export function FechaInput({ className = "", ...props }: DateInputProps) {
  return <DateInput {...props} className={`${FOCO_FECHA} ${className}`.trim()} />;
}
