"use client";

import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmInline } from "@/components/ui/confirm-inline";
import { DateInput } from "@/components/ui/date-input";
import { Field, Select } from "@/components/ui/field";
import { Segmented } from "@/components/ui/segmented";
import { escribiendo } from "@/lib/teclado";
import { Aviso } from "../../_lib/aviso";
import { corregirIntencion, marcarHecho, type ResultadoBandeja } from "./actions";
import { MESSAGES, VISTAS, type Intencion, type VistaBandeja } from "./messages";
import { enfocarRespuesta, ESCRITORIO } from "./responder";

const t = MESSAGES;

/**
 * El teclado de la bandeja, el de Superhuman: j y k abren el hilo
 * siguiente y el anterior de la lista, r lleva a «Tu respuesta», e marca
 * el hilo como hecho y Escape vuelve a la lista (y, dentro de la
 * respuesta, suelta el campo). En un campo de texto las letras escriben.
 * La leyenda solo se ve con teclado (desde sm). Si la página abrió el
 * hilo sola (activoSoloEscritorio), en un teléfono no se ve: j abre el
 * primero de la lista, no el segundo.
 */
export function AtajosBandeja({
  hrefs, activo, listaHref, activoSoloEscritorio = false, puedeOperar = true,
}: {
  hrefs: string[];
  activo: number;
  listaHref: string;
  activoSoloEscritorio?: boolean;
  /** Sin el rol (PUEDEN_OPERAR_VENTAS) no hay respuesta ni «hecha»: la leyenda no ofrece r ni e. */
  puedeOperar?: boolean;
}) {
  const router = useRouter();
  const estado = useRef({ hrefs, activo, listaHref, activoSoloEscritorio });
  useLayoutEffect(() => {
    estado.current = { hrefs, activo, listaHref, activoSoloEscritorio };
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Lo que ya atendió otro (Escape en una confirmación abierta) no es un atajo.
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const { hrefs: lista, listaHref: volver, activoSoloEscritorio: soloEscritorio } = estado.current;
      const enEscritorio = typeof window.matchMedia === "function" && window.matchMedia(ESCRITORIO).matches;
      const i = soloEscritorio && !enEscritorio ? -1 : estado.current.activo;
      if (e.key === "Escape") {
        if (escribiendo(e.target)) {
          (e.target as HTMLElement).blur();
          return;
        }
        e.preventDefault();
        router.push(volver);
        return;
      }
      if (escribiendo(e.target)) return;
      if ((e.key === "j" || e.key === "k") && lista.length > 0) {
        e.preventDefault();
        const siguiente = i < 0 ? 0 : e.key === "j" ? Math.min(i + 1, lista.length - 1) : Math.max(i - 1, 0);
        if (siguiente !== i) router.push(lista[siguiente]!);
        return;
      }
      if (e.key === "r") {
        if (enfocarRespuesta()) e.preventDefault();
        return;
      }
      if (e.key === "e") {
        // La conversación que no se ve (abierta sola, en un teléfono) no se marca a ciegas.
        if (i < 0) return;
        const boton = document.querySelector<HTMLElement>('[data-accion="hecho"] button');
        if (!boton) return;
        e.preventDefault();
        boton.click();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  const atajos = t.atajos.items.filter((a) => puedeOperar || (a.key !== "r" && a.key !== "e"));
  return (
    <p className="hidden text-xs text-ink-2 sm:block" aria-label={t.atajos.label}>
      {atajos.map((a, n) => (
        <span key={a.key}>
          {n > 0 ? " · " : ""}
          <kbd className="rounded border border-border bg-surface-2 px-1 font-mono text-[11px] text-ink">{a.key}</kbd> {a.text}
        </span>
      ))}
    </p>
  );
}

/** Pendientes, hechas o todas: la vista va en la URL (?vista=…) y la lista se pide de nuevo. */
export function FiltroVista({ vista }: { vista: VistaBandeja }) {
  const router = useRouter();
  return (
    <Segmented
      label={t.vistas.label}
      size="sm"
      value={vista}
      options={VISTAS.map((v) => ({ value: v, label: t.vistas[v] }))}
      onChange={(v) => router.push(v === "pendientes" ? "/ventas/bandeja" : `/ventas/bandeja?vista=${v}`)}
    />
  );
}

/** «Marcar como hecha» (la tecla e) o «Reabrir»: el hilo sale de los pendientes o vuelve. */
export function MarcarHecha({
  contactId, channel, hecha,
}: { contactId: string; channel: "email" | "linkedin" | "instagram_dm"; hecha: boolean }) {
  const [pending, start] = useTransition();
  const [resultado, setResultado] = useState<ResultadoBandeja | null>(null);
  return (
    <span className="inline-flex flex-col items-end gap-2">
      <span data-accion="hecho" className="inline-flex">
        <Button
          size="sm"
          variant={hecha ? "ghost" : "primary"}
          loading={pending}
          onClick={() => start(async () => setResultado(await marcarHecho({ contactId, channel, done: !hecha })))}
        >
          {hecha ? t.conversacion.reabrir : t.conversacion.marcarHecha}
        </Button>
      </span>
      <Aviso size="xs" notice={resultado?.ok ? resultado.notice : null} message={resultado && !resultado.ok ? resultado.error : null} />
    </span>
  );
}

/**
 * «Corregir» la intención de una respuesta: la persona dice qué pide (la
 * ambigua, o una que la IA leyó mal) y se aplican los mismos efectos que
 * aplica el job. Una baja pide confirmación antes: no se deshace. A «fuera
 * de la oficina», con la fecha de vuelta (opcional: vacía, se lee del
 * mensaje).
 */
export function CorregirIntencion({
  messageId, actual, opciones,
}: { messageId: string; actual: Intencion | null; opciones: Array<{ value: Intencion; label: string }> }) {
  const [abierto, setAbierto] = useState(false);
  const [elegida, setElegida] = useState<Intencion>(actual && actual !== "ambiguous" ? actual : "interested");
  const [vuelta, setVuelta] = useState("");
  const [pending, start] = useTransition();
  const [resultado, setResultado] = useState<ResultadoBandeja | null>(null);
  // Un div y no un form: la confirmación de la baja (ConfirmInline) es su propio formulario.
  const cajaRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (abierto) cajaRef.current?.querySelector<HTMLSelectElement>("select")?.focus();
  }, [abierto]);

  function aplicar(intent: Intencion) {
    start(async () => {
      const r = await corregirIntencion({ messageId, intent, ...(intent === "ooo" ? { returnDate: vuelta } : {}) });
      setResultado(r);
      if (r.ok) setAbierto(false);
    });
  }

  if (!abierto) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => setAbierto(true)}>
          {t.corregir.abrir}
        </Button>
        <Aviso size="xs" notice={resultado?.ok ? resultado.notice : null} />
      </span>
    );
  }
  const error = resultado && !resultado.ok ? resultado.error : null;
  return (
    <div
      ref={cajaRef}
      role="group"
      aria-label={t.corregir.label}
      className="grid w-full gap-2 rounded-md border border-border bg-surface p-3"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setAbierto(false);
        }
      }}
    >
      <Field label={t.corregir.label} help={t.corregir.ayuda}>
        <Select name="intent" value={elegida} onChange={(e) => setElegida(e.target.value as Intencion)} options={opciones} />
      </Field>
      {elegida === "ooo" ? (
        <Field label={t.corregir.vuelta} help={t.corregir.vueltaAyuda}>
          <DateInput name="returnDate" value={vuelta} onChange={setVuelta} />
        </Field>
      ) : null}
      <Aviso size="xs" message={error} />
      <div className="flex flex-wrap items-start gap-2">
        {elegida === "unsubscribe" ? (
          <ConfirmInline
            action={async () => aplicar("unsubscribe")}
            label={t.corregir.guardar}
            variant="primary"
            question={t.corregir.bajaPregunta}
            consequence={t.corregir.bajaConsecuencia}
            confirmLabel={t.corregir.bajaConfirmar}
            cancelLabel={t.corregir.cancelar}
            openWidth="w-full sm:w-96"
          />
        ) : (
          <Button size="sm" variant="primary" loading={pending} onClick={() => aplicar(elegida)}>
            {t.corregir.guardar}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setAbierto(false)}>
          {t.corregir.cancelar}
        </Button>
      </div>
    </div>
  );
}
