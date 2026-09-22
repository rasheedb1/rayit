"use client";

import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { controlClasses, useField } from "./field";

export type InputProps = InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean };

/** Envoltorio fino sobre <input>: hereda id, aria-describedby y aria-invalid del Field. */
export function Input({ invalid, className = "", id, ...rest }: InputProps) {
  const field = useField();
  const isInvalid = invalid ?? field?.invalid ?? false;
  return (
    <input
      id={id ?? field?.id}
      aria-describedby={rest["aria-describedby"] ?? field?.describedBy}
      aria-invalid={isInvalid || undefined}
      aria-required={rest.required ?? field?.required ?? undefined}
      className={controlClasses(isInvalid, className)}
      {...rest}
    />
  );
}

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  options: { value: string; label: string }[];
  placeholder?: string;
  invalid?: boolean;
};

export function Select({ options, placeholder, invalid, className = "", id, ...rest }: SelectProps) {
  const field = useField();
  const isInvalid = invalid ?? field?.invalid ?? false;
  return (
    <select
      id={id ?? field?.id}
      aria-describedby={rest["aria-describedby"] ?? field?.describedBy}
      aria-invalid={isInvalid || undefined}
      aria-required={rest.required ?? field?.required ?? undefined}
      className={controlClasses(isInvalid, `appearance-none bg-[length:16px] bg-[right_0.6rem_center] bg-no-repeat pr-8 ${className}`)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='none' stroke='%238a8a8a' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E\")",
      }}
      {...rest}
    >
      {placeholder !== undefined && (
        <option value="" disabled={rest.required}>
          {placeholder}
        </option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean };

export function Textarea({ invalid, className = "", id, ...rest }: TextareaProps) {
  const field = useField();
  const isInvalid = invalid ?? field?.invalid ?? false;
  return (
    <textarea
      id={id ?? field?.id}
      aria-describedby={rest["aria-describedby"] ?? field?.describedBy}
      aria-invalid={isInvalid || undefined}
      className={controlClasses(isInvalid, `h-auto min-h-24 py-2 ${className}`)}
      {...rest}
    />
  );
}
