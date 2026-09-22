"use client";

import { useEffect, useState } from "react";
import { formatMoneyInputDisplay, parseMoneyInput } from "@/lib/format";
import { controlClasses, useField } from "./field";

export interface MoneyInputProps {
  /** Decimal "5200000.50"; "" = vacío. */
  value: string;
  /** Se muestra como prefijo fijo. */
  currency: string;
  /** Emite "5200000.50" (siempre dos decimales) o "" si el campo queda vacío. */
  onChange: (value: string, currency: string) => void;
  id?: string;
  name?: string;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  className?: string;
}

/**
 * Campo de dinero. type="text" + inputmode="decimal": nunca number.
 * Muestra 5.200.000,50 (es-CO), acepta pegar "5.200.000,50", "5200000.5"
 * o "5,200,000.50", y re-formatea al perder el foco. El valor que emite
 * es un string decimal normalizado; el name lleva ese valor (no lo que
 * se ve) en un input oculto, para que un <form> con Server Action lo
 * reciba listo.
 */
export function MoneyInput({
  value,
  currency,
  onChange,
  id,
  name,
  placeholder = "0",
  disabled = false,
  invalid,
  required,
  autoFocus,
  className = "",
}: MoneyInputProps) {
  const field = useField();
  const isInvalid = invalid ?? field?.invalid ?? false;
  const [text, setText] = useState(() => formatMoneyInputDisplay(value));
  const [focused, setFocused] = useState(false);

  // Si el valor cambia desde fuera (prellenar desde una campaña), se refleja.
  useEffect(() => {
    if (!focused) setText(formatMoneyInputDisplay(value));
  }, [value, focused]);

  return (
    <div className={`relative ${className}`}>
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center font-mono text-xs text-fg-3" aria-hidden="true">
        {currency}
      </span>
      <input
        id={id ?? field?.id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        value={text}
        aria-describedby={field?.describedBy}
        aria-invalid={isInvalid || undefined}
        aria-required={required ?? field?.required ?? undefined}
        className={controlClasses(isInvalid, "pl-12 text-right font-mono tabular-nums")}
        onFocus={() => setFocused(true)}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          if (raw.trim() === "") {
            onChange("", currency);
            return;
          }
          const parsed = parseMoneyInput(raw);
          if (parsed !== null) onChange(parsed, currency);
        }}
        onBlur={() => {
          setFocused(false);
          const parsed = text.trim() === "" ? "" : parseMoneyInput(text);
          if (parsed === null) {
            // Lo escrito no es un monto: se conserva el último válido.
            setText(formatMoneyInputDisplay(value));
            return;
          }
          setText(formatMoneyInputDisplay(parsed));
          if (parsed !== value) onChange(parsed, currency);
        }}
      />
      {name && <input type="hidden" name={name} value={value} />}
    </div>
  );
}
