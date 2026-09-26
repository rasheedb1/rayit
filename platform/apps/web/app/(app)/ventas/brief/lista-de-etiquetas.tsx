"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { MESSAGES } from "../_lib/messages";

export interface Etiqueta {
  value: string;
  label: string;
}

/** Sin tildes, sin mayúsculas, sin signos: la misma idea que categoryKey de @mc/db. */
function clave(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export type ListaDeEtiquetasProps = {
  /** El nombre con el que viaja cada elegida (una entrada oculta por valor: FormData.getAll). */
  name: string;
  label: string;
  help?: string;
  error?: string;
  initial: Etiqueta[];
  /** Tope de elegidas; al llegar, el campo para agregar se apaga. */
  max: number;
  placeholder: string;
} & (
  | {
      /** Texto libre, con sugerencias (<datalist>) de lo que ya hay en el workspace. */
      mode: "free";
      suggestions: string[];
      maxLength: number;
    }
  | {
      /** Solo lo que está en la lista (países, marcas del CRM). */
      mode: "options";
      options: Etiqueta[];
      /** Lo que se dice cuando la lista está vacía («Todavía no tienes marcas en tu CRM»). */
      emptyOptions?: string;
    }
);

/**
 * Una lista de etiquetas que se agregan y se quitan: las categorías, los
 * países y las marcas del brief. No está en el kit porque solo la usa
 * el brief; sube a components/ui/ si otro módulo la pide (README del kit).
 *
 * Accesibilidad: el campo para agregar lleva la etiqueta del Field; cada
 * etiqueta elegida es un elemento de lista con su botón «Quitar …», y la
 * lista tiene nombre propio. Enter agrega en vez de enviar el formulario.
 */
export function ListaDeEtiquetas(props: ListaDeEtiquetasProps) {
  const t = MESSAGES.brief.chips;
  const { name, label, help, error, initial, max, placeholder } = props;
  const [elegidas, setElegidas] = useState<Etiqueta[]>(initial);
  const [texto, setTexto] = useState("");
  const id = useId();
  const listId = `${id}-sugerencias`;
  const lleno = elegidas.length >= max;

  function agregar(e: Etiqueta | null) {
    if (!e || lleno) return;
    const k = clave(e.value);
    if (!k || elegidas.some((x) => clave(x.value) === k)) return;
    setElegidas((cur) => [...cur, e]);
  }

  function agregarTexto() {
    const limpio = texto.trim().replace(/\s+/g, " ");
    if (!limpio) return;
    agregar({ value: limpio, label: limpio });
    setTexto("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      agregarTexto();
    }
  }

  const disponibles = props.mode === "options" ? props.options.filter((o) => !elegidas.some((e) => e.value === o.value)) : [];

  return (
    <div className="flex flex-col gap-2">
      <Field label={label} help={help} error={error} htmlFor={id}>
        {props.mode === "free" ? (
          <div className="flex gap-2">
            <Input
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              onKeyDown={onKeyDown}
              list={listId}
              maxLength={props.maxLength}
              placeholder={placeholder}
              disabled={lleno}
              autoComplete="off"
            />
            <datalist id={listId}>
              {props.suggestions
                .filter((s) => !elegidas.some((e) => clave(e.value) === clave(s)))
                .map((s) => (
                  <option key={s} value={s} />
                ))}
            </datalist>
            <Button variant="secondary" onClick={agregarTexto} disabled={lleno || !texto.trim()} aria-label={t.addTo(label)}>
              {t.add}
            </Button>
          </div>
        ) : (
          <Select
            value=""
            onChange={(e) => agregar(props.options.find((o) => o.value === e.target.value) ?? null)}
            options={disponibles}
            placeholder={props.options.length === 0 && props.emptyOptions ? props.emptyOptions : placeholder}
            disabled={lleno || disponibles.length === 0}
          />
        )}
      </Field>

      {elegidas.length === 0 ? (
        <p className="text-xs text-muted">{t.empty}</p>
      ) : (
        <ul aria-label={t.listLabel(label)} className="flex flex-wrap gap-1.5">
          {elegidas.map((e) => (
            <li
              key={e.value}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-surface-2 py-0.5 pl-2.5 pr-1 text-xs text-ink"
            >
              <span className="truncate">{e.label}</span>
              <button
                type="button"
                onClick={() => setElegidas((cur) => cur.filter((x) => x.value !== e.value))}
                aria-label={t.remove(e.label)}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
              <input type="hidden" name={name} value={e.value} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
