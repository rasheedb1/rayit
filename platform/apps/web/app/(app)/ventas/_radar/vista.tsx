import type { SignalRow } from "@mc/db/queries/ventas";
import { SectionTitle } from "@/components/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import type { Formatter } from "@/lib/format";
import { MESSAGES } from "../_lib/messages";
import { pillForFit } from "../_lib/estado";

/**
 * La bandeja del radar: las señales por revisar, de mayor a menor
 * encaje, que es el orden en que conviene mirarlas.
 *
 * Cada señal es una tarjeta y no una fila de tabla porque lo que se
 * decide aquí no es «cuál ordeno por monto» sino «esta sí, esta no»:
 * hace falta ver el titular entero, de dónde salió y la evidencia antes
 * de aceptar. Es la bandeja de Attio y de Folk, no un listado.
 */
export function RadarView({ signals, f }: { signals: SignalRow[]; f: Formatter }) {
  const t = MESSAGES.radar;

  if (signals.length === 0) {
    return (
      <section aria-labelledby="radar">
        <SectionTitle>
          <span id="radar">{t.title}</span>
        </SectionTitle>
        <EmptyState title={t.empty.title} description={t.empty.description} />
        <p className="mt-6 text-xs leading-5 text-muted">{t.manualOnly}</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="radar">
      <SectionTitle meta={t.meta(signals.length)}>
        <span id="radar">{t.title}</span>
      </SectionTitle>

      <ul className="flex flex-col gap-2">
        {signals.map((s) => (
          <SignalCard key={s.id} signal={s} f={f} />
        ))}
      </ul>

      <p className="mt-6 text-xs leading-5 text-muted">{t.manualOnly}</p>
    </section>
  );
}

function SignalCard({ signal, f }: { signal: SignalRow; f: Formatter }) {
  const t = MESSAGES.radar;
  const fit = pillForFit(signal.fitScore);

  return (
    <li className="rounded-md border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink">{signal.companyName ?? "Marca sin identificar"}</span>
            {fit && <Pill kind={fit.kind}>{fit.text}</Pill>}
          </div>
          <p className="mt-1 text-sm leading-5 text-ink-2">{signal.headlineEs}</p>
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span>
              {t.source}: {signal.sourceLabel}
            </span>
            <span className="tabular-nums">
              {t.detected} {f.date(signal.detectedAt)}
            </span>
            {signal.budgetEstimate && (
              <span className="tabular-nums">
                {t.budget}: {f.money(signal.budgetEstimate, signal.budgetCurrency ?? undefined, { mode: "compact" })}
              </span>
            )}
            {signal.evidenceUrl && (
              <a
                href={signal.evidenceUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="underline underline-offset-2 hover:text-ink"
              >
                {t.evidence}
              </a>
            )}
          </p>
        </div>
      </div>
    </li>
  );
}
