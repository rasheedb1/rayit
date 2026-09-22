"use client";

import { useState } from "react";
import { CONTROL, useFieldControl } from "./field";

export type MoneyInputProps = {
  /** Decimal como string: "5200000.50". Vacío = sin valor. */
  value: string;
  /** Se muestra como prefijo fijo y se devuelve en onChange. */
  currency: string;
  /** Emite siempre dos decimales: "5200000.50". Vacío si el campo queda vacío. */
  onChange: (value: string, currency: string) => void;
  id?: string;
  name?: string;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  className?: string;
};

const GROUP = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 0 });
const nbsp = (s: string) => s.replace(/[  ]/g, " ");

/**
 * "5.200.000,50" · "5,200,000.50" · "5200000.5" · "5200000" → "5200000.50".
 * Si hay punto y coma, el último es el separador decimal. Si hay uno solo
 * y aparece una vez con una o dos cifras detrás, es decimal; si no, es de
 * miles. Devuelve null si no hay cifras.
 */
export function parseMoneyText(text: string): string | null {
  const s = text.replace(/[^\d.,-]/g, "");
  if (!/\d/.test(s)) return null;
  const negative = s.startsWith("-");
  const body = s.replace(/-/g, "");
  const lastDot = body.lastIndexOf("."), lastComma = body.lastIndexOf(",");
  let intPart = body, decPart = "";
  const split = (i: number) => {
    intPart = body.slice(0, i);
    decPart = body.slice(i + 1);
  };
  if (lastDot >= 0 && lastComma >= 0) split(Math.max(lastDot, lastComma));
  else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ",";
    const idx = lastDot >= 0 ? lastDot : lastComma;
    const once = body.indexOf(sep) === idx;
    const after = body.length - idx - 1;
    if (once && after >= 1 && after <= 2) split(idx);
  }
  const digits = intPart.replace(/\D/g, "").replace(/^0+(?=\d)/, "") || "0";
  const cents = (decPart.replace(/\D/g, "") + "00").slice(0, 2);
  return `${negative && digits !== "0" ? "-" : ""}${digits}.${cents}`;
}

/** "5200000.50" → "5.200.000,50" · "5200000.00" → "5.200.000" */
export function displayMoney(value: string): string {
  if (!value) return "";
  const [int = "0", dec = "00"] = value.split(".");
  const grouped = nbsp(GROUP.format(Math.abs(Number(int))));
  const sign = value.startsWith("-") ? "-" : "";
  return dec === "00" ? `${sign}${grouped}` : `${sign}${grouped},${dec}`;
}

/** Dinero como texto (nunca type="number"): separador de miles es-CO y coma decimal. */
export function MoneyInput({ value, currency, onChange, placeholder = "0", disabled, invalid, required, className = "", ...rest }: MoneyInputProps) {
  const a11y = useFieldControl({ id: rest.id, invalid, required });
  // Mientras se escribe se respeta el texto tal cual; al salir se reformatea.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? displayMoney(value);
  return (
    <span className="relative block">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-muted" aria-hidden="true">
        {currency}
      </span>
      <input
        {...a11y}
        name={rest.name}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={shown}
        placeholder={placeholder}
        disabled={disabled}
        className={`${CONTROL} h-9 pl-12 text-right font-mono tabular-nums ${className}`}
        onFocus={() => setDraft(displayMoney(value))}
        onChange={(e) => {
          const text = e.target.value;
          setDraft(text);
          const parsed = parseMoneyText(text);
          onChange(parsed ?? "", currency);
        }}
        onBlur={() => setDraft(null)}
      />
    </span>
  );
}
