"use client";

import type { InputHTMLAttributes } from "react";
import { CONTROL, useFieldControl } from "./field";

export type DateInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> & {
  /** Solo fecha, "2026-09-20". El formulario la convierte a timestamptz UTC al guardar. */
  value: string;
  onChange: (isoDate: string) => void;
  invalid?: boolean;
};

/** Fecha con el control nativo del navegador. */
export function DateInput({ value, onChange, invalid, className = "", ...rest }: DateInputProps) {
  const a11y = useFieldControl({ id: rest.id, invalid, required: rest.required });
  return <input {...rest} {...a11y} type="date" value={value} onChange={(e) => onChange(e.target.value)} className={`${CONTROL} h-9 tabular-nums ${className}`} />;
}
