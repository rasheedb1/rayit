"use client";

import { useId } from "react";

export type SegmentedOption<V extends string> = { value: V; label: string; disabled?: boolean };

export type SegmentedProps<V extends string> = {
  /** Qué elige el control: "Red", "Orden"… Va a aria-label. */
  label: string;
  options: SegmentedOption<V>[];
  value: V;
  onChange: (value: V) => void;
  size?: "sm" | "md";
  className?: string;
};

/**
 * Control segmentado (el `.seg` del mock): el filtro por red de Resumen,
 * la ordenación de Mis videos. Un grupo de botones con aria-pressed;
 * flechas para moverse entre opciones.
 */
export function Segmented<V extends string>({ label, options, value, onChange, size = "md", className = "" }: SegmentedProps<V>) {
  const id = useId();
  const pad = size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-sm";
  const move = (from: number, delta: number) => {
    const enabled = options.filter((o) => !o.disabled);
    const i = enabled.findIndex((o) => o.value === options[from]?.value);
    const next = enabled[(i + delta + enabled.length) % enabled.length];
    if (next) onChange(next.value);
  };
  // Con Tab se entra por la opción activa; si no hay ninguna activa y habilitada, por la primera habilitada.
  const activeIsUsable = options.some((o) => o.value === value && !o.disabled);
  const firstEnabled = options.find((o) => !o.disabled)?.value;
  return (
    <div role="group" aria-label={label} id={id} className={`inline-flex max-w-full gap-0.5 overflow-x-auto rounded-[7px] border border-border bg-surface-2 p-0.5 ${className}`}>
      {options.map((o, i) => {
        const on = o.value === value;
        const tabbable = activeIsUsable ? on : o.value === firstEnabled;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            disabled={o.disabled}
            tabIndex={tabbable ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                move(i, 1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                move(i, -1);
              }
            }}
            className={`shrink-0 whitespace-nowrap rounded-[5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${pad} ${
              on ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
