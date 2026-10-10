"use client";

import type { InputHTMLAttributes } from "react";
import { CONTROL, useFieldControl } from "./field";

export type DateInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> & {
  /** Solo fecha, "2026-09-20". El formulario la convierte a timestamptz UTC al guardar. */
  value: string;
  onChange: (isoDate: string) => void;
  invalid?: boolean;
};

/**
 * El anillo de foco también con `focus:`, no solo con `focus-visible:`
 * (CONTROL): en Chromium un `<input type="date">` no casa
 * `:focus-visible` cuando el foco está en su segmento interno (día, mes,
 * año) y el campo quedaba sin anillo al llegar con Tab. `:focus` sí casa
 * en el input, el anfitrión del segmento. Antes lo parcheaba Cotizar en
 * su `_ui/fecha.tsx`; desde el 10-oct-2026 lo trae el kit.
 */
export const FOCO_FECHA = "focus:border-ink focus:ring-2 focus:ring-ink/15";

/** Fecha con el control nativo del navegador. */
export function DateInput({ value, onChange, invalid, className = "", ...rest }: DateInputProps) {
  const a11y = useFieldControl({ id: rest.id, invalid, required: rest.required });
  return (
    <input
      {...rest}
      {...a11y}
      type="date"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${CONTROL} ${FOCO_FECHA} h-9 tabular-nums ${className}`}
    />
  );
}
