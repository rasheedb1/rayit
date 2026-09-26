"use client";

import Link from "next/link";
import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmInline } from "@/components/ui/confirm-inline";
import { Pill, type PillKind } from "@/components/ui/pill";
import { formatInt } from "@/lib/format";
import { cancelarSeleccion, reintentarUno, type ActividadState } from "./actions";
import { MESSAGES } from "./messages";

/** Una fila ya formateada en el servidor: aquí no se calcula ni se formatea nada. */
export interface FilaVista {
  id: string;
  estado: string;
  estadoKind: PillKind;
  /** El asunto del correo, o el paso si no lleva asunto. */
  titulo: string;
  contacto: string;
  /** La marca y la cadencia. */
  contexto: string;
  paso: string;
  cuando: string;
  cuandoTitulo: string | null;
  /** La frase del motivo (se corta en la fila) y su detalle con el código (el título al pasar el cursor). */
  motivo: string | null;
  motivoDetalle: string | null;
  motivoTono: "bad" | "warn" | "muted";
  marcas: string[];
  intentos: string | null;
  reintentable: boolean;
  /** Fallido pero no reintentable: se dice por qué, en vez de ofrecer el botón. */
  noReintentable: boolean;
  cancelable: boolean;
  enviando: boolean;
  fichaHref: string;
}

const TONO = { bad: "text-bad", warn: "text-warn", muted: "text-fg-2" } as const;

/**
 * La cola o el historial, como la lista de eventos de Stripe: una fila por
 * mensaje, con su estado, a quién, qué paso y cuándo; el motivo cortado en
 * una línea, entero al pasar el cursor (y entero para un lector de
 * pantalla, que lee el texto y no el corte). En la cola, cada fila
 * cancelable lleva su casilla y la barra de arriba cancela lo
 * seleccionado, con una confirmación en el sitio; un fallido reintentable
 * lleva su «Reintentar».
 */
export function ListaActividad({
  filas, seleccionable, caption, locale,
}: { filas: FilaVista[]; seleccionable: boolean; caption: string; locale: string }) {
  const [seleccion, setSeleccion] = useState<ReadonlySet<string>>(new Set());
  const [estado, setEstado] = useState<ActividadState>({});
  const [ocupada, empezar] = useTransition();
  const [reintentando, setReintentando] = useState<string | null>(null);
  const idTodas = useId();
  const cancelables = filas.filter((f) => f.cancelable).map((f) => f.id);
  const todas = cancelables.length > 0 && cancelables.every((id) => seleccion.has(id));
  const t = MESSAGES.seleccion;

  function alternar(id: string) {
    setSeleccion((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function cancelar() {
    const ids = [...seleccion].filter((id) => cancelables.includes(id));
    const r = await cancelarSeleccion(ids);
    setEstado(r);
    if (r.ok) setSeleccion(new Set());
  }

  function reintentar(id: string) {
    setReintentando(id);
    empezar(async () => {
      setEstado(await reintentarUno(id));
      setReintentando(null);
    });
  }

  const n = seleccion.size;
  return (
    <div className="flex flex-col gap-3">
      {seleccionable && cancelables.length > 0 && (
        <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <label htmlFor={idTodas} className="inline-flex cursor-pointer items-center gap-2 text-sm text-fg-2">
            <input
              id={idTodas}
              type="checkbox"
              className="h-4 w-4 accent-[var(--accent)]"
              checked={todas}
              onChange={() => setSeleccion(todas ? new Set() : new Set(cancelables))}
            />
            {n > 0 ? t.n(formatInt(n, { locale }), n) : t.todas}
          </label>
          {n > 0 && (
            <ConfirmInline
              action={cancelar}
              label={t.cancelar}
              variant="danger"
              question={t.pregunta(formatInt(n, { locale }), n)}
              consequence={t.consecuencia}
              confirmLabel={t.confirmar}
              cancelLabel={t.volver}
              openWidth="w-full sm:w-96"
            />
          )}
        </div>
      )}
      <p role="status" aria-live="polite" className={estado.error ? "text-sm text-bad" : "text-sm text-fg-2"}>
        {estado.error ?? estado.ok ?? ""}
      </p>
      <ul aria-label={caption} className="divide-y divide-line rounded-md border border-line bg-surface">
        {filas.map((f) => (
          <li key={f.id} className="flex items-start gap-3 px-3 py-3 sm:px-4">
            {seleccionable && (
              <span className="flex h-5 w-4 shrink-0 items-center">
                {f.cancelable ? (
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[var(--accent)]"
                    aria-label={t.una(f.contacto)}
                    checked={seleccion.has(f.id)}
                    onChange={() => alternar(f.id)}
                  />
                ) : f.enviando ? (
                  <span className="sr-only">{t.enviando}</span>
                ) : null}
              </span>
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium" title={f.titulo}>{f.titulo}</p>
                  <p className="truncate text-xs text-fg-2">
                    <Link href={f.fichaHref} className="hover:text-fg hover:underline" title={MESSAGES.fila.verFicha}>{f.contacto}</Link>
                    <span aria-hidden="true"> · </span>
                    {f.contexto}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                  <Pill kind={f.estadoKind}>{f.estado}</Pill>
                  <span className="text-xs tabular-nums text-fg-2" title={f.cuandoTitulo ?? undefined}>{f.cuando}</span>
                </div>
              </div>
              <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-fg-3">
                <span>{f.paso}</span>
                {f.intentos && <span className="tabular-nums">{f.intentos}</span>}
                {f.marcas.map((m) => <span key={m} className="text-good">{m}</span>)}
              </p>
              {f.motivo && (
                <p className={`truncate text-xs ${TONO[f.motivoTono]}`} title={f.motivoDetalle ?? undefined}>
                  <span className="sr-only">{MESSAGES.fila.motivo}: </span>
                  {f.motivo}
                </p>
              )}
              {f.noReintentable && <p className="text-xs text-fg-3">{MESSAGES.reintentar.noReintentable}</p>}
            </div>
            {f.reintentable && (
              <Button size="sm" variant="secondary" loading={ocupada && reintentando === f.id} disabled={ocupada} onClick={() => reintentar(f.id)}>
                {MESSAGES.reintentar.uno}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
