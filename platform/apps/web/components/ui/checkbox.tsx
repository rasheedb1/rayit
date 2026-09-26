"use client";

import { useId } from "react";

export type CheckboxProps = {
  /** La etiqueta, pegada a la casilla: el clic en ella la marca. */
  label: string;
  /** Una línea de ayuda debajo, enlazada con aria-describedby. */
  help?: string;
  /**
   * Sin nombre, la casilla no viaja en el formulario: útil cuando el valor
   * se manda aparte (una entrada oculta por opción elegida).
   */
  name?: string;
  /** Lo que manda al formulario si está marcada; por defecto, "on". */
  value?: string;
  /** Controlada: con `checked` va `onChange`. */
  checked?: boolean;
  /** No controlada: el valor inicial. */
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
};

/**
 * Una casilla con su etiqueta y su ayuda (VEN-7 r4). Nació dos veces
 * igual —en los gastos de Finanzas y en el brief de Ventas— y sube al kit
 * a la segunda, como dice este README.
 *
 * Es un <input type="checkbox"> nativo: el teclado (Espacio), el lector de
 * pantalla y el envío del formulario funcionan sin nada más. El color de
 * la marca es el de la tinta (accent-ink), así que sigue al tema. El foco
 * con teclado se ve como el de Button, Select e Input (un anillo de tinta,
 * focus-visible), no con el contorno de cada navegador (VEN-7 r5).
 */
export function Checkbox({ label, help, name, value, checked, defaultChecked, onChange, disabled, className = "" }: CheckboxProps) {
  const id = useId();
  const helpId = help ? `${id}-help` : undefined;
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id={id}
          name={name}
          value={value}
          checked={checked}
          defaultChecked={defaultChecked}
          onChange={onChange ? (e) => onChange(e.target.checked) : undefined}
          disabled={disabled}
          aria-describedby={helpId}
          className="size-4 shrink-0 rounded-sm border-border accent-ink ring-offset-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-2 disabled:opacity-50"
        />
        <label htmlFor={id} className="min-w-0 text-sm font-medium text-ink">
          {label}
        </label>
      </div>
      {help && (
        <p id={helpId} className="pl-6 text-xs leading-4 text-muted">
          {help}
        </p>
      )}
    </div>
  );
}
