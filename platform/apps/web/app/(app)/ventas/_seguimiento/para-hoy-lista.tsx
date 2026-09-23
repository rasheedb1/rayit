"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { SectionTitle } from "@/components/page-header";
import { Aviso } from "../../_lib/aviso";
import { FICHA } from "../empresas/messages";
import type { SeguimientoContexto, SiguienteAccionData } from "./datos";
import { SiguienteAccion } from "./siguiente-accion";

/** Una fila de «Para hoy», con todo formateado en el servidor. */
export interface FilaParaHoy {
  dealId: string;
  companyId: string;
  companyName: string;
  /** «Renovación Q4 · Propuesta». */
  subtitle: string;
  data: SiguienteAccionData;
}

type Enlace = { text: string; href: string };

/**
 * La lista de «Para hoy» (VEN-4), de cliente por una sola razón: no
 * soltar la fila que la persona está tocando.
 *
 * «Hecha» deja el negocio sin acción y revalida /ventas; el servidor ya
 * no lo manda (no vence nada), y sin esto el <li> se desmontaba con el
 * editor «Hecha. ¿Qué sigue?» que acababa de abrirse: el foco caía en
 * <body> y el negocio pasaba en silencio a «sin siguiente acción». Lo
 * mismo con «Cambiar» a otro día.
 *
 * Por eso, al tocar una fila (onTouch, antes de que la acción salga), se
 * guarda una copia con su posición, y mientras el servidor no la mande se
 * sigue pintando la copia en su sitio, con la misma key: el editor y su
 * aviso siguen montados. Al cerrarse el editor, si la fila ya no está en
 * lo del servidor, se va con un aviso breve («Guardada para el 24 sep ·
 * 3:00 p. m.», o que quedó sin siguiente acción) y el foco pasa a la
 * fila siguiente o, si no hay, al título «Para hoy».
 */
export function ParaHoyLista({
  filas,
  ctx,
  meta,
  more,
  withoutAction,
}: {
  filas: FilaParaHoy[];
  ctx: SeguimientoContexto;
  /** «1 vencido · 2 vencen hoy», ya formateado; null sin filas. */
  meta: string | null;
  /** «y 3 más en el pipeline», con su enlace filtrado. */
  more: Enlace | null;
  /** «2 negocios abiertos no tienen siguiente acción con fecha.», con «Ponérsela». */
  withoutAction: Enlace | null;
}) {
  const t = FICHA.paraHoy;
  /** Las filas tocadas en esta visita, con la posición en que se veían. */
  const [tocadas, setTocadas] = useState<Map<string, { fila: FilaParaHoy; index: number }>>(() => new Map());
  const [notice, setNotice] = useState<string | undefined>();
  /** A qué posición va el foco cuando una fila se acaba de ir. */
  const [focusAt, setFocusAt] = useState<number | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  // Lo último que mandó el servidor, para decidir al cerrar el editor
  // (el cierre llega en un efecto, después de la revalidación).
  const filasRef = useRef(filas);
  filasRef.current = filas;

  // Lo del servidor, más las tocadas que ya no manda, en su sitio.
  const visibles = [...filas];
  const ausentes = [...tocadas.entries()]
    .filter(([id]) => !filas.some((f) => f.dealId === id))
    .sort((a, b) => a[1].index - b[1].index);
  for (const [, { fila, index }] of ausentes) visibles.splice(Math.min(index, visibles.length), 0, fila);

  useEffect(() => {
    if (focusAt === null) return;
    const items = listRef.current?.querySelectorAll<HTMLLIElement>(":scope > li");
    const destino = items?.[focusAt]?.querySelector<HTMLElement>("a, button");
    (destino ?? titleRef.current)?.focus();
    setFocusAt(null);
  }, [focusAt]);

  if (visibles.length === 0 && !notice && !more && !withoutAction) return null;

  function tocar(fila: FilaParaHoy) {
    setNotice(undefined);
    setTocadas((prev) => {
      const next = new Map(prev);
      next.set(fila.dealId, { fila, index: Math.max(0, visibles.findIndex((v) => v.dealId === fila.dealId)) });
      return next;
    });
  }

  function cerrar(dealId: string, aviso: string | undefined) {
    const sigue = filasRef.current.some((f) => f.dealId === dealId);
    const index = visibles.findIndex((v) => v.dealId === dealId);
    setTocadas((prev) => {
      if (!prev.has(dealId)) return prev;
      const next = new Map(prev);
      next.delete(dealId);
      return next;
    });
    if (sigue) return;
    // La fila se va: se dice dónde quedó y el foco no cae en <body>.
    setNotice(aviso ?? t.leftWithout);
    setFocusAt(Math.max(0, index));
  }

  return (
    <section aria-labelledby="para-hoy" className="mb-8">
      <SectionTitle meta={meta ? <span className="tabular-nums">{meta}</span> : undefined}>
        <span id="para-hoy" ref={titleRef} tabIndex={-1} className="rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
          {t.title}
        </span>
      </SectionTitle>

      <Aviso notice={notice} size="xs" className="mb-2" />

      {visibles.length > 0 && (
        <ul ref={listRef} aria-label={t.listLabel} className="divide-y divide-border rounded-md border border-border">
          {visibles.map((r) => (
            <li key={r.dealId} className="grid gap-2 p-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:gap-4">
              <div className="min-w-0">
                <Link href={`/ventas/empresas/${r.companyId}`} className="text-sm font-medium text-ink hover:underline">
                  {r.companyName}
                </Link>
                {r.subtitle && <p className="mt-0.5 truncate text-xs text-muted">{r.subtitle}</p>}
              </div>
              <SiguienteAccion
                data={r.data}
                ctx={ctx}
                onTouch={() => tocar(r)}
                onEditingChange={(editing, aviso) => {
                  if (!editing) cerrar(r.dealId, aviso);
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {(more || withoutAction) && (
        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-2">
          {more && (
            <Link href={more.href} className="underline underline-offset-4 hover:text-ink">
              {more.text}
            </Link>
          )}
          {withoutAction && (
            <span>
              <span className="text-warn">{withoutAction.text}</span>{" "}
              <Link href={withoutAction.href} className="underline underline-offset-4 hover:text-ink">
                {t.fixWithoutAction}
              </Link>
            </span>
          )}
        </p>
      )}
    </section>
  );
}
