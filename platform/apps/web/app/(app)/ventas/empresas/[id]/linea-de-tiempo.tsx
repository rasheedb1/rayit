"use client";

import { useEffect, useState, useTransition } from "react";
import {
  ArrowRight,
  BarChart3,
  Banknote,
  FileSignature,
  FileText,
  Mail,
  MailOpen,
  MessageCircle,
  Phone,
  Radar,
  StickyNote,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { ActivityKind } from "@mc/db/queries/ventas-ficha";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Aviso } from "../../../_lib/aviso";
import { verMasActividad } from "../actions";
import { FICHA } from "../messages";
import type { ActividadVista } from "./actividad";

/** Un icono por tipo: lo que se registra a mano y lo que deja el producto. */
const ICONO: Record<ActivityKind, LucideIcon> = {
  note: StickyNote,
  email_sent: Mail,
  email_received: MailOpen,
  dm_sent: MessageCircle,
  dm_received: MessageCircle,
  call: Phone,
  meeting: Users,
  proposal_sent: FileText,
  contract_sent: FileSignature,
  signal_detected: Radar,
  stage_change: ArrowRight,
  report_sent: BarChart3,
  payment_received: Banknote,
};

/**
 * La historia de la empresa como una conversación (Attio): la más reciente
 * arriba, cada actividad con su tipo, quién, cuándo, de qué negocio y con
 * quién, y lo que pasó. Lo que deja el producto (una señal aceptada, un
 * cambio de etapa, una cotización cerrada) va en la misma línea que lo que
 * escribe la persona: es la misma historia.
 *
 * La ficha trae las 50 más recientes; «Ver más» trae las anteriores por
 * cursor (occurred_at, id) y las añade debajo, sin recargar la ficha. Si
 * la ficha se revalida (se registró algo), la primera página cambia y las
 * añadidas se descartan: si no, el corte entre páginas se correría y una
 * actividad quedaría en el hueco.
 */
export function LineaDeTiempo({
  companyId,
  items,
  nextCursor,
}: {
  companyId: string;
  /** La primera página, ya formateada en el servidor (vistaDeActividad). */
  items: ActividadVista[];
  /** Dónde sigue; null si no hay más. */
  nextCursor: string | null;
}) {
  const t = FICHA.actividad;
  const [extra, setExtra] = useState<{ base: string | null; items: ActividadVista[]; cursor: string | null }>({
    base: nextCursor,
    items: [],
    cursor: nextCursor,
  });
  const [error, setError] = useState<string | undefined>();
  const [focusId, setFocusId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!focusId) return;
    document.getElementById(`actividad-${focusId}`)?.focus();
    setFocusId(null);
  }, [focusId]);

  // Otra primera página (la ficha se revalidó): lo añadido ya no encaja.
  const vigente = extra.base === nextCursor ? extra : { base: nextCursor, items: [], cursor: nextCursor };
  if (vigente !== extra) setExtra(vigente);

  if (items.length === 0) {
    return <EmptyState title={t.empty.title} description={t.empty.description} className="mt-3" />;
  }

  const todas = [...items, ...vigente.items.filter((a) => !items.some((b) => b.id === a.id))];

  function verMas() {
    const cursor = vigente.cursor;
    if (!cursor) return;
    setError(undefined);
    startTransition(async () => {
      const r = await verMasActividad(companyId, cursor);
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setExtra((prev) => (prev.base !== vigente.base ? prev : { ...prev, items: [...prev.items, ...r.items], cursor: r.nextCursor }));
      // El foco va a la primera actividad nueva: si no, al acabarse la
      // historia el botón desaparece y el foco cae en <body>.
      setFocusId(r.items[0]?.id ?? null);
    });
  }

  return (
    <>
      <ol aria-label={t.listLabel} className="mt-4 space-y-0">
        {todas.map((a, i) => {
          const Icono = ICONO[a.kind] ?? StickyNote;
          return (
            <li key={a.id} id={`actividad-${a.id}`} tabIndex={-1} className="relative flex gap-3 pb-5 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
              {/* El hilo que une una actividad con la siguiente. */}
              {i < todas.length - 1 && <span className="absolute left-[13px] top-7 bottom-0 w-px bg-border" aria-hidden="true" />}
              <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-ink-2">
                <Icono className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <p className="text-sm text-ink">
                  <span className="font-medium">{a.tipo}</span>
                  {a.subject && <span className="text-ink-2"> · {a.subject}</span>}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {a.author} ·{" "}
                  <time dateTime={a.occurredAt} className="tabular-nums">
                    {a.when}
                  </time>
                  {a.detail && ` · ${a.detail}`}
                </p>
                {a.body && <p className="mt-1.5 whitespace-pre-line break-words text-sm leading-6 text-ink-2">{a.body}</p>}
                {a.reason && <p className="mt-1 text-xs text-muted">{a.reason}</p>}
              </div>
            </li>
          );
        })}
      </ol>
      <Aviso message={error} size="xs" className="mb-2" />
      {vigente.cursor && (
        <Button size="sm" variant="secondary" onClick={verMas} loading={pending}>
          {t.more}
        </Button>
      )}
    </>
  );
}
