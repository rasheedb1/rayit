import Link from "next/link";
import type { SequenceDetail } from "@mc/db/queries/cadencias";
import { OUTREACH_URLS } from "@mc/core/outreach/messages";
import type { Formatter } from "@/lib/format";
import { MESSAGES } from "../messages";
import { textoDeGuia, textoDeNota } from "../_lib/vista";

/**
 * «Por qué esta propuesta»: las decisiones del recomendador en frases
 * (qué plantilla, qué paso cambió de canal y por qué, qué cuenta hay que
 * reconectar, quién redactó la guía) y lo que la política del espacio no
 * va a dejar cumplir. Como el «por qué» de Stripe Radar: cada regla que
 * decidió, dicha.
 */
export function Notas({ d, f, plantillas }: { d: SequenceDetail; f: Formatter; plantillas: ReadonlyMap<string, string> }) {
  const t = MESSAGES.notas;
  const notas = d.proposal ? d.proposal.notes.map((n) => textoDeNota(n, f, plantillas)).filter((x): x is string => x !== null) : [];
  const caida = d.proposal?.notes.some((n) => n.code === "channel_down") ?? false;
  const overCap = d.policy.overCap.length;
  const gap = d.policy.closerThanGap.length;
  if (notas.length === 0 && overCap === 0 && gap === 0) return null;

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {d.proposal && (
        <section aria-labelledby="por-que" className="rounded-md border border-line bg-surface p-4">
          <h2 id="por-que" className="text-sm font-semibold">
            {t.titulo}
          </h2>
          <ul className="mt-2 grid list-disc gap-1.5 pl-4 text-sm text-fg-2">
            {notas.map((n) => (
              <li key={n}>{n}</li>
            ))}
            <li>{textoDeGuia(d.proposal)}</li>
          </ul>
          {caida && (
            <Link href={OUTREACH_URLS.channels} className="mt-2 inline-block text-sm underline underline-offset-2">
              {t.reconectar}
            </Link>
          )}
        </section>
      )}
      {(overCap > 0 || gap > 0) && (
        <section aria-labelledby="politica" className="rounded-md border border-warn/40 bg-warn-wash p-4">
          <h2 id="politica" className="text-sm font-semibold">
            {t.politica.titulo}
          </h2>
          <ul className="mt-2 grid list-disc gap-1.5 pl-4 text-sm">
            {overCap > 0 && <li>{t.politica.overCap(f.int(overCap), f.int(d.policy.maxTouchesPerCompany))}</li>}
            {gap > 0 && <li>{t.politica.gap(f.int(d.policy.minDaysBetweenTouches))}</li>}
          </ul>
          <Link href="/ventas/politica" className="mt-2 inline-block text-sm underline underline-offset-2">
            {t.politica.ir}
          </Link>
        </section>
      )}
    </div>
  );
}
