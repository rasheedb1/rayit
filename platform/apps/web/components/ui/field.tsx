"use client";

import { createContext, useContext, useId } from "react";
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";

// Field pinta etiqueta, ayuda y error, y le pasa al control (Input,
// Select, Textarea, MoneyInput, DateInput) el id, aria-describedby,
// aria-invalid y required por contexto. La validación no vive aquí:
// la hace el formulario (zod) y solo manda `error`.

type FieldCtx = { id: string; describedBy?: string; invalid: boolean; required: boolean };
const Ctx = createContext<FieldCtx | null>(null);

/** Props de accesibilidad que un control toma del Field que lo envuelve. */
export function useFieldControl(own: { id?: string; invalid?: boolean; required?: boolean }) {
  const ctx = useContext(Ctx);
  const fallbackId = useId();
  return {
    id: own.id ?? ctx?.id ?? fallbackId,
    "aria-describedby": ctx?.describedBy,
    "aria-invalid": (own.invalid ?? ctx?.invalid) ? true : undefined,
    required: own.required ?? ctx?.required ?? undefined,
  };
}

export type FieldProps = {
  label: string;
  help?: string;
  error?: string;
  required?: boolean;
  /** Id del control. Si no viene, Field lo genera y se lo pasa por contexto. */
  htmlFor?: string;
  children: ReactNode;
  className?: string;
};

export function Field({ label, help, error, required = false, htmlFor, children, className = "" }: FieldProps) {
  const generated = useId();
  const id = htmlFor ?? generated;
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, helpId].filter(Boolean).join(" ") || undefined;
  return (
    <Ctx.Provider value={{ id, describedBy, invalid: Boolean(error), required }}>
      <div className={`flex flex-col gap-1.5 ${className}`}>
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {label}
          {required && (
            <span className="ml-0.5 text-bad" aria-hidden="true">
              *
            </span>
          )}
          {required && <span className="sr-only"> (obligatorio)</span>}
        </label>
        {children}
        {error ? (
          <p id={errorId} className="text-xs text-bad" role="alert">
            {error}
          </p>
        ) : (
          help && (
            <p id={helpId} className="text-xs text-muted">
              {help}
            </p>
          )
        )}
      </div>
    </Ctx.Provider>
  );
}

/** Estilo común de los controles: borde --border, hover --axis, foco --ink, error --bad. */
export const CONTROL =
  "w-full min-w-0 rounded-md border border-border bg-surface px-3 text-sm text-ink placeholder:text-muted " +
  "transition-colors hover:border-axis focus:outline-none focus-visible:border-ink focus-visible:ring-2 focus-visible:ring-ink/15 " +
  "disabled:cursor-not-allowed disabled:bg-surface-2 disabled:opacity-60 aria-invalid:border-bad aria-invalid:hover:border-bad";

export type InputProps = InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean };

export function Input({ invalid, className = "", ...rest }: InputProps) {
  const a11y = useFieldControl({ id: rest.id, invalid, required: rest.required });
  return <input {...rest} {...a11y} className={`${CONTROL} h-9 ${className}`} />;
}

export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> & {
  options: { value: string; label: string; disabled?: boolean }[];
  /** Opción vacía inicial ("Elige una etapa"). */
  placeholder?: string;
  invalid?: boolean;
};

export function Select({ options, placeholder, invalid, className = "", ...rest }: SelectProps) {
  const a11y = useFieldControl({ id: rest.id, invalid, required: rest.required });
  return (
    <span className="relative block">
      <select {...rest} {...a11y} className={`${CONTROL} h-9 appearance-none pr-9 ${className}`}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
    </span>
  );
}

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean };

export function Textarea({ invalid, className = "", rows = 3, ...rest }: TextareaProps) {
  const a11y = useFieldControl({ id: rest.id, invalid, required: rest.required });
  return <textarea {...rest} {...a11y} rows={rows} className={`${CONTROL} resize-y py-2 leading-6 ${className}`} />;
}
