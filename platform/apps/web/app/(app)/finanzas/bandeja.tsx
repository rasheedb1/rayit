import type { ReminderRow } from "@mc/db/queries/finanzas";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill, type PillKind } from "@/components/ui/pill";
import type { Formatter } from "@/lib/format";
import { CopiarCorreo } from "./copiar";
import { MESSAGES } from "./_lib/messages";
import { marcarRecordatorioEnviado } from "./recordatorios-actions";

/**
 * La bandeja de recordatorios de cobro (FIN-4).
 *
 * Todo lo que se lee aquí lo escribió el job `finance.reminders`: el
 * asunto y el cuerpo del correo vienen ya redactados por @mc/core con
 * la moneda y el locale del workspace, así que esta pantalla no
 * calcula ni formatea ni un peso ni un día. Solo los enmarca, y añade
 * «Copiar» y «Marcar como enviado».
 */

/** La severidad que guardó el job decide el color; el texto lo dice igual. */
const PILL: Record<ReminderRow["severity"], PillKind> = {
  info: "neutral",
  warning: "warn",
  critical: "bad",
};

/** «vence en 3 días» · «41 días de mora». El job ya decidió el tono; esto es la etiqueta de la fila. */
function cuando(r: ReminderRow, f: Formatter): string {
  if (r.daysOverdue > 0) return `${r.daysOverdue} ${r.daysOverdue === 1 ? "día" : "días"} de mora`;
  if (r.daysOverdue === 0) return "vence hoy";
  return f.daysRelative(-r.daysOverdue);
}

export function RecordatorioCard({ r, f }: { r: ReminderRow; f: Formatter }) {
  const t = MESSAGES.bandeja;
  const enviado = r.sentAt !== null;
  return (
    <article className="rounded-md border border-line p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-sm font-medium">
          {r.companyName} · {r.invoiceNumber}
        </h3>
        <span className="flex flex-wrap items-center gap-2 text-xs text-fg-3">
          <Pill kind={PILL[r.severity]}>{r.etiquetaEs}</Pill>
          <span>{cuando(r, f)}</span>
          <span className="font-mono tabular-nums">{f.money(r.outstanding, r.currency, { mode: "full" })}</span>
        </span>
      </div>

      <p className="mt-3 text-sm">
        <span className="text-xs text-fg-3">{t.asunto}: </span>
        {r.asunto}
      </p>
      {/* El cuerpo es texto plano con saltos de línea: se respeta tal cual
          y se parte por palabras, para que a 400 px no empuje la página. */}
      <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-bg-2 p-3 font-sans text-xs leading-relaxed text-fg-2">
        {r.cuerpo}
      </pre>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <CopiarCorreo asunto={r.asunto} cuerpo={r.cuerpo} etiqueta={`${r.etiquetaEs} de ${r.invoiceNumber}`} />
        {enviado ? (
          <span className="text-xs text-fg-3">
            {t.enviadoEl} {f.date(r.sentAt!)}
          </span>
        ) : (
          <form action={marcarRecordatorioEnviado.bind(null, r.id, r.invoiceId)}>
            <Button type="submit" size="sm">
              {t.marcar}
            </Button>
          </form>
        )}
        <Button size="sm" variant="ghost" href={`/finanzas/facturas/${r.invoiceId}`}>
          {t.verFactura}
        </Button>
      </div>
    </article>
  );
}

/** La bandeja de /finanzas: lo que hay por enviar hoy. */
export function BandejaRecordatorios({ rows, f }: { rows: readonly ReminderRow[]; f: Formatter }) {
  const t = MESSAGES.bandeja;
  return (
    <section className="mt-10" aria-labelledby="recordatorios">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="recordatorios" className="text-sm font-semibold">
          {t.titulo}
        </h2>
        <span className="text-xs text-fg-3">
          {rows.length} {rows.length === 1 ? "recordatorio por enviar" : "recordatorios por enviar"}
        </span>
      </div>
      <p className="mb-3 max-w-2xl text-xs text-fg-3">{t.descripcion}</p>
      {rows.length === 0 ? (
        <EmptyState title={t.vacioTitulo} description={t.vacioDescripcion} />
      ) : (
        <div className="grid gap-3">
          {rows.map((r) => (
            <RecordatorioCard key={r.id} r={r} f={f} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Los recordatorios de UNA factura, en su detalle: incluye los ya marcados. */
export function RecordatoriosDeLaFactura({ rows, f }: { rows: readonly ReminderRow[]; f: Formatter }) {
  const t = MESSAGES.bandeja;
  return (
    <section className="rounded-md border border-line p-4" aria-labelledby="recordatorios-factura">
      <h2 id="recordatorios-factura" className="text-sm font-semibold">
        {t.enLaFactura}
      </h2>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-fg-3">{t.sinRecordatorios}</p>
      ) : (
        <div className="mt-3 grid gap-3">
          {rows.map((r) => (
            <RecordatorioCard key={r.id} r={r} f={f} />
          ))}
        </div>
      )}
    </section>
  );
}
