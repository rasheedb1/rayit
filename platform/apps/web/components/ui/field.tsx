"use client";

import { createContext, useContext, useId, type ReactNode } from "react";

export interface FieldContextValue {
  id: string;
  /** ids de ayuda y error, para aria-describedby */
  describedBy?: string;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/** Lo leen Input, Select, Textarea, MoneyInput y DateInput para heredar id y aria-*. */
export function useField(): FieldContextValue | null {
  return useContext(FieldContext);
}

export interface FieldProps {
  label: string;
  help?: string;
  /** Mensaje en español; pinta el borde en --bad y lo anuncia con role="alert". */
  error?: string;
  required?: boolean;
  /** Si no viene, Field genera el id con useId y lo pasa por contexto. */
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}

/**
 * Etiqueta + control + ayuda + error, con la accesibilidad resuelta una
 * sola vez: label asociado, aria-describedby con ayuda y error,
 * aria-invalid, y el asterisco de obligatorio con texto para lectores.
 */
export function Field({ label, help, error, required = false, htmlFor, children, className = "" }: FieldProps) {
  const generated = useId();
  const id = htmlFor ?? `f-${generated}`;
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label}
        {required && (
          <>
            <span aria-hidden="true" className="ml-0.5 text-danger">*</span>
            <span className="sr-only"> (obligatorio)</span>
          </>
        )}
      </label>
      <FieldContext.Provider value={{ id, describedBy, invalid: Boolean(error), required }}>{children}</FieldContext.Provider>
      {help && !error && (
        <p id={helpId} className="text-xs text-fg-3">
          {help}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** Clases compartidas por los controles del formulario. */
export function controlClasses(invalid: boolean, extra = ""): string {
  return (
    "h-9 w-full min-w-0 rounded-md border bg-bg px-3 text-sm text-fg placeholder:text-fg-3 transition-colors " +
    "disabled:cursor-not-allowed disabled:bg-bg-2 disabled:text-fg-2 " +
    (invalid ? "border-danger" : "border-line hover:border-line-2 focus:border-line-2") +
    ` ${extra}`
  );
}
