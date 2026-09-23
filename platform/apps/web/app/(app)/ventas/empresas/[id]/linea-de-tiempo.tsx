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
import { LOST_REASONS, type LostReason } from "@mc/db/queries/ventas";
import type { ActivityKind, ActivityRow } from "@mc/db/queries/ventas-ficha";
import { EmptyState } from "@/components/ui/empty-state";
import type { Formatter } from "@/lib/format";
import { dealLabel } from "@/lib/negocio";
import { lostReasonText } from "../../_lib/estado";
import { FICHA } from "../messages";

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

function motivo(reason: string | null): string | null {
  return reason && (LOST_REASONS as readonly string[]).includes(reason) ? lostReasonText(reason as LostReason) : null;
}

/**
 * La historia de la empresa como una conversación (Attio): la más reciente
 * arriba, cada actividad con su tipo, quién, cuándo, de qué negocio y con
 * quién, y lo que pasó. Lo que deja el producto (una señal aceptada, un
 * cambio de etapa, una cotización cerrada) va en la misma línea que lo que
 * escribe la persona: es la misma historia.
 */
export function LineaDeTiempo({
  rows,
  hasMore,
  companyName,
  f,
}: {
  rows: ActivityRow[];
  hasMore: boolean;
  companyName: string;
  f: Formatter;
}) {
  const t = FICHA.actividad;
  if (rows.length === 0) {
    return <EmptyState title={t.empty.title} description={t.empty.description} className="mt-3" />;
  }
  return (
    <>
      <ol aria-label={t.listLabel} className="mt-4 space-y-0">
        {rows.map((a, i) => {
          const Icono = ICONO[a.kind] ?? StickyNote;
          const tipo = FICHA.tipos[a.kind] ?? a.kind;
          const negocio = a.dealName ? dealLabel(companyName, a.dealName) : null;
          const razon = motivo(a.meta.lostReason);
          const detalle = [
            negocio,
            a.contactName ? t.with(a.contactName) : null,
            a.meta.durationMin ? t.minutes(a.meta.durationMin) : null,
          ].filter(Boolean);
          return (
            <li key={a.id} className="relative flex gap-3 pb-5">
              {/* El hilo que une una actividad con la siguiente. */}
              {i < rows.length - 1 && <span className="absolute left-[13px] top-7 bottom-0 w-px bg-border" aria-hidden="true" />}
              <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-ink-2">
                <Icono className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <p className="text-sm text-ink">
                  <span className="font-medium">{tipo}</span>
                  {a.subject && <span className="text-ink-2"> · {a.subject}</span>}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {a.userName ?? t.system} ·{" "}
                  <time dateTime={a.occurredAt} className="tabular-nums">
                    {f.date(a.occurredAt)} · {f.time(a.occurredAt)}
                  </time>
                  {detalle.length > 0 && ` · ${detalle.join(" · ")}`}
                </p>
                {a.body && <p className="mt-1.5 whitespace-pre-line break-words text-sm leading-6 text-ink-2">{a.body}</p>}
                {razon && <p className="mt-1 text-xs text-muted">{razon}</p>}
              </div>
            </li>
          );
        })}
      </ol>
      {hasMore && <p className="text-xs text-muted">{t.hasMore(rows.length)}</p>}
    </>
  );
}
