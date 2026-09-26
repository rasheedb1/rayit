"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { categoryKey } from "@mc/core";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { formatInt } from "@/lib/format";
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
      /** Solo lo que está en la lista (los países). */
      mode: "options";
      options: Etiqueta[];
      /** Lo que se dice cuando la lista está vacía. */
      emptyOptions?: string;
    }
  | {
      /**
       * Lo que devuelve una búsqueda en el servidor (las marcas del CRM,
       * VEN-7 r4): un combobox que ofrece los resultados bajo el campo.
       * Hasta la ronda 3 era un <select> con las primeras 1 000 marcas,
       * que cortaba las demás sin avisar.
       */
      mode: "search";
      search: (q: string) => Promise<{ results: Etiqueta[] } | { error: string }>;
      /** Letras útiles (sin tildes ni signos) para empezar a buscar. */
      minChars: number;
      /** El locale del workspace, para decir las cifras de la búsqueda con Intl (formatInt). */
      locale: string;
    }
);

/**
 * Una lista de etiquetas que se agregan y se quitan: las categorías, los
 * países y las marcas del brief. Tres formas de agregar: texto libre con
 * sugerencias (categorías), un menú cerrado (países) y una búsqueda en el
 * servidor (marcas del CRM, un combobox: flechas, Enter y Escape). No está en el kit porque solo la usa
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
  const statusId = `${id}-estado`;
  const lleno = elegidas.length >= max;

  // La búsqueda en el servidor (modo "search"): lo que devolvió, en qué
  // está, y cuál resultado marcan las flechas.
  const search = props.mode === "search" ? props.search : null;
  const minChars = props.mode === "search" ? props.minChars : 0;
  const cifra = (n: number) => formatInt(n, { locale: props.mode === "search" ? props.locale : undefined });
  const [resultados, setResultados] = useState<Etiqueta[]>([]);
  const [busqueda, setBusqueda] = useState<"idle" | "short" | "loading" | "done" | "error">("idle");
  const [activo, setActivo] = useState(-1);
  const [abierto, setAbierto] = useState(false);

  const yaEsta = (valor: string) => {
    const k = props.mode === "free" ? categoryKey(valor) : valor;
    return !k || elegidas.some((x) => (props.mode === "free" ? categoryKey(x.value) : x.value) === k);
  };
  /** Los resultados que todavía no están elegidos: lo que ofrece el combobox. */
  const ofrecidos = resultados.filter((r) => !yaEsta(r.value));

  /** Lo escrito o elegido que todavía no es una etiqueta; null si no hay nada que agregar. */
  const pendiente: Etiqueta | null = (() => {
    if (lleno || disabled) return null;
    if (props.mode === "free") {
      const limpio = texto.trim().replace(/\s+/g, " ");
      return limpio && !yaEsta(limpio) ? { value: limpio, label: limpio } : null;
    }
    if (props.mode === "search") {
      // Solo una marca cuyo nombre es EXACTAMENTE lo escrito (sin tildes ni
      // mayúsculas): un nombre a medias no excluye «la primera que salga».
      const k = categoryKey(texto);
      return (k && ofrecidos.find((r) => categoryKey(r.label) === k)) || null;
    }
    const o = props.options.find((x) => x.value === eleccion);
    return o && !yaEsta(o.value) ? o : null;
  })();

  function agregar(e: Etiqueta) {
    if (lleno || disabled || yaEsta(e.value)) return;
    setElegidas((cur) => [...cur, e]);
    setTexto("");
    setResultados([]);
    setAbierto(false);
    setActivo(-1);
  }

  function agregarPendiente() {
    if (pendiente) setElegidas((cur) => [...cur, pendiente]);
    setTexto("");
    setEleccion("");
    setResultados([]);
    setAbierto(false);
    setActivo(-1);
  }

  function onEnter(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    agregarPendiente();
  }

  /** El teclado del combobox: flechas para moverse, Enter para elegir, Escape para cerrar. */
  function onComboKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (ofrecidos.length === 0) return;
      event.preventDefault();
      setAbierto(true);
      const paso = event.key === "ArrowDown" ? 1 : -1;
      setActivo((cur) => (cur + paso + ofrecidos.length) % ofrecidos.length);
      return;
    }
    if (event.key === "Escape") {
      if (abierto) {
        event.preventDefault();
        setAbierto(false);
        setActivo(-1);
      }
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const marcado = abierto && activo >= 0 ? ofrecidos[activo] : undefined;
    if (marcado) agregar(marcado);
    else agregarPendiente();
  }

  // Busca al dejar de escribir (250 ms), y descarta la respuesta de una
  // búsqueda vieja si llega después de la nueva.
  useEffect(() => {
    if (!search) return;
    const q = texto.trim();
    if (categoryKey(q).length < minChars) {
      setResultados([]);
      setBusqueda(q ? "short" : "idle");
      return;
    }
    setBusqueda("loading");
    let vigente = true;
    const timer = setTimeout(() => {
      search(q).then(
        (r) => {
          if (!vigente) return;
          if ("error" in r) {
            setResultados([]);
            setBusqueda("error");
          } else {
            setResultados(r.results);
            setBusqueda("done");
            setAbierto(true);
            setActivo(-1);
          }
        },
        () => {
          if (vigente) setBusqueda("error");
        },
      );
    }, 250);
    return () => {
      vigente = false;
      clearTimeout(timer);
    };
  }, [texto, search, minChars]);

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
          ) : props.mode === "search" ? (
            <div className="relative min-w-0 flex-1">
              <Input
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
                onKeyDown={onComboKey}
                onBlur={() => setAbierto(false)}
                onFocus={() => ofrecidos.length > 0 && setAbierto(true)}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={abierto && ofrecidos.length > 0}
                aria-controls={listId}
                aria-activedescendant={abierto && activo >= 0 ? `${listId}-${activo}` : undefined}
                placeholder={placeholder}
                disabled={apagado}
                autoComplete="off"
                maxLength={120}
              />
              {abierto && ofrecidos.length > 0 && (
                <ul
                  id={listId}
                  role="listbox"
                  aria-label={label}
                  className="absolute inset-x-0 top-full z-20 mt-1 max-h-60 overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-lg"
                >
                  {ofrecidos.map((r, i) => (
                    <li
                      key={r.value}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={i === activo}
                      // mousedown y no click: el blur del campo cerraría la lista antes del click.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        agregar(r);
                      }}
                      className={`cursor-pointer truncate px-3 py-1.5 text-sm text-ink ${i === activo ? "bg-hover" : "hover:bg-hover"}`}
                    >
                      {r.label}
                    </li>
                  ))}
                </ul>
              )}
            </div>
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

      {props.mode === "search" && (
        <p id={statusId} role="status" aria-live="polite" className="-mt-1 text-xs text-muted">
          {busqueda === "short"
            ? t.searchMin(cifra(minChars))
            : busqueda === "loading"
              ? t.searching
              : busqueda === "error"
                ? t.searchError
                : busqueda === "done" && texto.trim()
                  ? ofrecidos.length === 0
                    ? t.searchNone
                    : <span className="sr-only">{t.searchResults(cifra(ofrecidos.length), ofrecidos.length)}</span>
                  : null}
        </p>
      )}

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

      {/* Lo que quedó escrito o elegido sin «Agregar» viaja igual al guardar, detrás de las elegidas. */}
      {pendiente && <input type="hidden" name={name} value={pendiente.value} />}
    </div>
  );
}
