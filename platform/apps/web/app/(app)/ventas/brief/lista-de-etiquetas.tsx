"use client";

import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { categoryKey } from "@mc/core";
import { Button } from "@/components/ui/button";
import { CONTROL, Field, Input, Select, useFieldControl } from "@/components/ui/field";
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
  /**
   * Avisa cuando el campo tiene texto escrito que no es ninguna etiqueta
   * (modo "search": un nombre a medias). El formulario no se envía así
   * (VEN-7 r5): la marca no viajaría y el creador creería haberla excluido.
   */
  onUnresolvedChange?: (unresolved: boolean) => void;
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
      /**
       * Si la búsqueda no encuentra nada, ofrece «No aceptar «…»», que da
       * de alta lo escrito y devuelve la etiqueta (VEN-7 r5). Sin ella,
       * solo se elige lo que ya está.
       */
      create?: (texto: string) => Promise<{ result: Etiqueta } | { error: string }>;
    }
);

/** Una opción del combobox: una marca encontrada, o dar de alta lo escrito. */
type Opcion = { kind: "result"; etiqueta: Etiqueta } | { kind: "create" };

/**
 * El campo del combobox. Es un <input> con el estilo del kit (CONTROL) y
 * las props de accesibilidad del Field (useFieldControl), más el estado
 * de la búsqueda en aria-describedby: el Input del kit pone el suyo
 * encima del que se le pase, y cambiar su API pide revisión.
 */
function ComboInput({ statusId, ...rest }: InputHTMLAttributes<HTMLInputElement> & { statusId: string }) {
  const a11y = useFieldControl({});
  const describedBy = [a11y["aria-describedby"], statusId].filter(Boolean).join(" ");
  return <input {...rest} {...a11y} aria-describedby={describedBy} className={`${CONTROL} h-9`} />;
}

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
 * En las marcas (modo "search") lo escrito solo viaja si es EXACTAMENTE
 * una marca de la lista. Un nombre a medias no se pierde nunca en
 * silencio (VEN-7 r5):
 *   · Enter sin opción marcada agrega la única que se ofrece; con varias,
 *     abre la lista en la primera y deja lo escrito;
 *   · al guardar, el formulario no se envía y el campo dice por qué
 *     (onUnresolvedChange);
 *   · sin ninguna en el CRM, ofrece «No aceptar «…»» (`create`), que la da
 *     de alta bloqueada y la agrega.
 *
 * Accesibilidad: el campo para agregar lleva la etiqueta del Field; cada
 * etiqueta elegida es un elemento de lista con su botón «Quitar …», y la
 * lista tiene nombre propio. Al quitar una, el foco pasa a la siguiente
 * (o a la anterior si era la última), y al campo si ya no queda ninguna:
 * el botón quitado desaparece y el foco no puede quedarse en el vacío.
 */
export function ListaDeEtiquetas(props: ListaDeEtiquetasProps) {
  const t = MESSAGES.brief.chips;
  const { name, label, help, error, initial, max, placeholder, disabled = false, saved, onUnresolvedChange } = props;
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
  const create = props.mode === "search" ? props.create : undefined;
  const [creando, setCreando] = useState(false);
  /** Lo que pasó al dar de alta una marca con «No aceptar «…»»: se dice en la línea de estado. */
  const [alta, setAlta] = useState<{ ok: boolean; text: string } | null>(null);

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

  const apagado = disabled || lleno;
  const escrito = texto.trim();
  /**
   * «No aceptar «…»»: solo cuando la búsqueda terminó y no hay ninguna
   * marca en el CRM que contenga lo escrito. Si hay alguna, se elige esa:
   * dar de alta un duplicado de «Nutrivé» por escribir «nutri» ensuciaría
   * el CRM.
   */
  const puedeCrear =
    Boolean(create) && !apagado && busqueda === "done" && resultados.length === 0 && categoryKey(escrito).length >= minChars;
  const opciones: Opcion[] = [
    ...ofrecidos.map((etiqueta): Opcion => ({ kind: "result", etiqueta })),
    ...(puedeCrear ? [{ kind: "create" } as const] : []),
  ];
  const listaAbierta = abierto && opciones.length > 0;
  /** Texto en el combobox que no es ninguna marca: guardar no puede tragárselo (VEN-7 r5). */
  const sinResolver = props.mode === "search" && !apagado && escrito !== "" && pendiente === null;

  // El formulario se entera de si hay algo sin resolver. Por ref: quien
  // lo pide suele pasar una función nueva en cada render.
  const avisar = useRef(onUnresolvedChange);
  avisar.current = onUnresolvedChange;
  useEffect(() => {
    avisar.current?.(sinResolver);
  }, [sinResolver]);

  function limpiar() {
    setTexto("");
    setEleccion("");
    setResultados([]);
    setAbierto(false);
    setActivo(-1);
  }

  function agregar(e: Etiqueta) {
    if (lleno || disabled || yaEsta(e.value)) return;
    setElegidas((cur) => [...cur, e]);
    setAlta(null);
    limpiar();
  }

  /**
   * «Agregar», Enter y el guardado. Sin nada que agregar, lo escrito se
   * queda en el campo (VEN-7 r5): borrarlo sin agregar nada hacía creer
   * que la marca estaba excluida. Solo una categoría que ya está (en otra
   * grafía) se limpia: no hay nada pendiente, ya está en la lista.
   */
  function agregarPendiente() {
    if (pendiente) {
      agregar(pendiente);
      return;
    }
    if (props.mode === "free" && escrito && yaEsta(escrito)) setTexto("");
  }

  /** Da de alta lo escrito como marca bloqueada y la agrega (`create`, VEN-7 r5). */
  async function crear() {
    if (!create || creando || !escrito) return;
    setCreando(true);
    setAlta(null);
    const r = await create(escrito).catch(() => ({ error: t.createError }));
    setCreando(false);
    if ("error" in r) {
      setAlta({ ok: false, text: r.error });
      return;
    }
    agregar(r.result);
    setAlta({ ok: true, text: t.created(r.result.label) });
  }

  function elegir(o: Opcion) {
    if (o.kind === "create") void crear();
    else agregar(o.etiqueta);
  }

  function onEnter(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    agregarPendiente();
  }

  /** El teclado del combobox: flechas para moverse, Enter para elegir, Escape para cerrar. */
  function onComboKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (opciones.length === 0) return;
      event.preventDefault();
      setAbierto(true);
      const paso = event.key === "ArrowDown" ? 1 : -1;
      setActivo((cur) => (cur + paso + opciones.length) % opciones.length);
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
    const marcada = listaAbierta && activo >= 0 ? opciones[activo] : undefined;
    if (marcada) return elegir(marcada);
    if (pendiente) return agregar(pendiente);
    // Un nombre a medias con una sola marca que lo contiene: es esa. Con
    // varias (o con «No aceptar…»), se abre la lista en la primera y lo
    // escrito se queda: Enter no decide por nadie ni borra nada.
    const unica = ofrecidos.length === 1 ? ofrecidos[0] : undefined;
    if (unica) return agregar(unica);
    if (opciones.length > 0) {
      setAbierto(true);
      setActivo(0);
    }
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

  /** La línea de estado del combobox: lo que pasó al dar de alta, o en qué va la búsqueda. */
  const estado: { text: string; visible: boolean; bad?: boolean } | null = creando
    ? { text: t.creating, visible: true }
    : alta
      ? { text: alta.text, visible: true, bad: !alta.ok }
      : busqueda === "short"
        ? { text: t.searchMin(cifra(minChars)), visible: true }
        : busqueda === "loading"
          ? { text: t.searching, visible: true }
          : busqueda === "error"
            ? { text: t.searchError, visible: true, bad: true }
            : busqueda === "done" && escrito
              ? ofrecidos.length > 0
                ? { text: t.searchResults(cifra(ofrecidos.length), ofrecidos.length), visible: false }
                : { text: puedeCrear ? t.createHint : t.searchNone, visible: true }
              : null;

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
              <ComboInput
                statusId={statusId}
                value={texto}
                onChange={(e) => {
                  setTexto(e.target.value);
                  setAlta(null);
                }}
                onKeyDown={onComboKey}
                onBlur={() => setAbierto(false)}
                onFocus={() => opciones.length > 0 && setAbierto(true)}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={listaAbierta}
                aria-controls={listId}
                aria-activedescendant={listaAbierta && activo >= 0 ? `${listId}-${activo}` : undefined}
                aria-busy={creando || undefined}
                data-unresolved={sinResolver || undefined}
                placeholder={placeholder}
                disabled={apagado}
                readOnly={creando}
                autoComplete="off"
                maxLength={120}
              />
              {/*
                La lista existe siempre (oculta si no hay nada que ofrecer):
                aria-controls no puede apuntar a un id que no está en la página.
              */}
              <ul
                id={listId}
                role="listbox"
                aria-label={label}
                hidden={!listaAbierta}
                className="absolute inset-x-0 top-full z-20 mt-1 max-h-60 overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-lg"
              >
                {listaAbierta &&
                  opciones.map((o, i) => (
                    <li
                      key={o.kind === "create" ? "__crear" : o.etiqueta.value}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={i === activo}
                      // mousedown y no click: el blur del campo cerraría la lista antes del click.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        elegir(o);
                      }}
                      className={`cursor-pointer truncate px-3 py-1.5 text-sm ${o.kind === "create" ? "text-bad" : "text-ink"} ${
                        i === activo ? "bg-hover" : "hover:bg-hover"
                      }`}
                    >
                      {o.kind === "create" ? t.createOption(escrito) : o.etiqueta.label}
                    </li>
                  ))}
              </ul>
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
        <p id={statusId} role="status" aria-live="polite" className={`-mt-1 text-xs ${estado?.bad ? "text-bad" : "text-muted"}`}>
          {estado && (estado.visible ? estado.text : <span className="sr-only">{estado.text}</span>)}
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
