"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { categoryKey } from "@mc/core";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { MESSAGES } from "../_lib/messages";

export interface Etiqueta {
  value: string;
  label: string;
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
  /** Sin permiso para cambiar el brief: se ven las elegidas, sin agregar ni quitar. */
  disabled?: boolean;
  /**
   * Cambia cada vez que el formulario se guardó bien (BriefState.stamp).
   * Lo que quedó escrito o elegido sin «Agregar» ya viajó en el envío
   * (ver `pendiente`); con esto pasa también a la lista en pantalla.
   */
  saved?: number;
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
 * Agregar es siempre un acto explícito: «Agregar» o Enter, en los dos
 * modos. En el de opciones el menú solo ELIGE: en Windows y Linux las
 * flechas cambian un <select> cerrado y disparan change, y agregar en
 * onChange metía cada país por el que se pasaba (Afganistán, Albania…).
 *
 * Lo escrito o elegido que no se agregó no se pierde al guardar: viaja
 * en el envío con el mismo nombre que las elegidas (una entrada oculta
 * más). Antes, escribir «bebidas» en «Categorías que no aceptas» y pulsar
 * «Guardar» sin «Agregar» guardaba el brief sin ella y decía «Guardado»:
 * en una regla de exclusión, el radar seguía enseñando lo que el creador
 * creía haber dejado fuera.
 *
 * Accesibilidad: el campo para agregar lleva la etiqueta del Field; cada
 * etiqueta elegida es un elemento de lista con su botón «Quitar …», y la
 * lista tiene nombre propio. Al quitar una, el foco pasa a la siguiente
 * (o a la anterior si era la última), y al campo si ya no queda ninguna:
 * el botón quitado desaparece y el foco no puede quedarse en el vacío.
 */
export function ListaDeEtiquetas(props: ListaDeEtiquetasProps) {
  const t = MESSAGES.brief.chips;
  const { name, label, help, error, initial, max, placeholder, disabled = false, saved } = props;
  const [elegidas, setElegidas] = useState<Etiqueta[]>(initial);
  const [texto, setTexto] = useState("");
  const [eleccion, setEleccion] = useState("");
  const [focoEn, setFocoEn] = useState<number | "campo" | null>(null);
  const botones = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const listId = `${id}-sugerencias`;
  const lleno = elegidas.length >= max;

  const yaEsta = (valor: string) => {
    const k = props.mode === "free" ? categoryKey(valor) : valor;
    return !k || elegidas.some((x) => (props.mode === "free" ? categoryKey(x.value) : x.value) === k);
  };

  /** Lo escrito o elegido que todavía no es una etiqueta; null si no hay nada que agregar. */
  const pendiente: Etiqueta | null = (() => {
    if (lleno || disabled) return null;
    if (props.mode === "free") {
      const limpio = texto.trim().replace(/\s+/g, " ");
      return limpio && !yaEsta(limpio) ? { value: limpio, label: limpio } : null;
    }
    const o = props.options.find((x) => x.value === eleccion);
    return o && !yaEsta(o.value) ? o : null;
  })();

  function agregarPendiente() {
    if (pendiente) setElegidas((cur) => [...cur, pendiente]);
    setTexto("");
    setEleccion("");
  }

  function onEnter(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    agregarPendiente();
  }

  function quitar(indice: number) {
    const quedan = elegidas.length - 1;
    setElegidas((cur) => cur.filter((_, i) => i !== indice));
    setFocoEn(quedan === 0 ? "campo" : Math.min(indice, quedan - 1));
  }

  // El foco, después de pintar la lista sin la que se quitó.
  useEffect(() => {
    if (focoEn === null) return;
    if (focoEn === "campo") document.getElementById(id)?.focus();
    else botones.current[focoEn]?.focus();
    setFocoEn(null);
  }, [focoEn, id]);

  // Guardado: lo pendiente ya viajó en el envío; ahora pasa a la lista.
  const ultimoGuardado = useRef(saved);
  useEffect(() => {
    if (saved === undefined || saved === ultimoGuardado.current) return;
    ultimoGuardado.current = saved;
    agregarPendiente();
    // Solo al cambiar `saved`: agregarPendiente lee el estado de ese momento.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const disponibles = props.mode === "options" ? props.options.filter((o) => !elegidas.some((e) => e.value === o.value)) : [];
  const apagado = disabled || lleno;

  return (
    <div className="flex flex-col gap-2">
      <Field label={label} help={help} error={error} htmlFor={id}>
        <div className="flex gap-2">
          {props.mode === "free" ? (
            <>
              <Input
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
                onKeyDown={onEnter}
                list={listId}
                maxLength={props.maxLength}
                placeholder={placeholder}
                disabled={apagado}
                autoComplete="off"
              />
              <datalist id={listId}>
                {props.suggestions
                  .filter((s) => !yaEsta(s))
                  .map((s) => (
                    <option key={s} value={s} />
                  ))}
              </datalist>
            </>
          ) : (
            <Select
              value={eleccion}
              onChange={(e) => setEleccion(e.target.value)}
              onKeyDown={onEnter}
              options={disponibles}
              placeholder={props.options.length === 0 && props.emptyOptions ? props.emptyOptions : placeholder}
              disabled={apagado || disponibles.length === 0}
            />
          )}
          <Button variant="secondary" onClick={agregarPendiente} disabled={!pendiente} aria-label={t.addTo(label)}>
            {t.add}
          </Button>
        </div>
      </Field>

      {/* Lo que quedó escrito o elegido sin «Agregar» viaja igual al guardar. */}
      {pendiente && <input type="hidden" name={name} value={pendiente.value} />}

      {elegidas.length === 0 ? (
        <p className="text-xs text-muted">{t.empty}</p>
      ) : (
        <ul aria-label={t.listLabel(label)} className="flex flex-wrap gap-1.5">
          {elegidas.map((e, i) => (
            <li
              key={e.value}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-surface-2 py-0.5 pl-2.5 pr-1 text-xs text-ink"
            >
              <span className="truncate">{e.label}</span>
              {!disabled && (
                <button
                  type="button"
                  ref={(el) => {
                    botones.current[i] = el;
                  }}
                  onClick={() => quitar(i)}
                  aria-label={t.remove(e.label)}
                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              )}
              <input type="hidden" name={name} value={e.value} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
