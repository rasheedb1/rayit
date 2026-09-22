"use client";

import type { InputHTMLAttributes } from "react";
import { controlClasses, useField } from "./field";

export type DateInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
  /** "2026-09-20": solo fecha, sin hora. */
  value: string;
  onChange: (isoDate: string) => void;
  invalid?: boolean;
};

/**
 * Fecha nativa (type="date"). Entra y sale como "YYYY-MM-DD"; quien la
 * consume la convierte a timestamptz UTC en el borde (regla del repo).
 */
export function DateInput({ value, onChange, invalid, className = "", id, ...rest }: DateInputProps) {
  const field = useField();
  const isInvalid = invalid ?? field?.invalid ?? false;
  return (
    <input
      id={id ?? field?.id}
      type="date"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-describedby={rest["aria-describedby"] ?? field?.describedBy}
      aria-invalid={isInvalid || undefined}
      aria-required={rest.required ?? field?.required ?? undefined}
      className={controlClasses(isInvalid, `font-mono tabular-nums ${className}`)}
      {...rest}
    />
  );
}
