import Link from "next/link";
import type { CompanyDetail } from "@mc/db/queries/ventas";
import type { CompanySignalRow } from "@mc/db/queries/ventas-ficha";
import { Pill } from "@/components/ui/pill";
import type { Formatter } from "@/lib/format";
import { safeHref } from "@/lib/url";
import { SIGNAL_STATUS_META, pillForFit } from "../../_lib/estado";
import { FICHA } from "../messages";

/**
 * «Lo que sabemos» de la marca (VEN-5): lo que dice su ficha enriquecida
 * (tamaño, si pauta y dónde, el encaje con la audiencia) y cada señal que
 * se vio de ella, también las descartadas con su motivo, porque «por qué
 * no» también es algo que se sabe. Una señal pendiente lleva al radar.
 *
 * El sector y el nicho van en la cabecera de la ficha; aquí no se repiten.
 */
export function LoQueSabemos({
  company,
  signals,
  f,
}: {
  company: Pick<CompanyDetail, "sizeBucket" | "runsAds" | "adsPlatforms" | "fitScore">;
  signals: CompanySignalRow[];
  f: Formatter;
}) {
  const t = FICHA.sabemos;
  const fit = pillForFit(company.fitScore, f);
  const hechos: ({ label: string; value: string } | null)[] = [
    company.sizeBucket ? { label: t.size, value: t.sizes[company.sizeBucket] ?? company.sizeBucket } : null,
    company.runsAds === null
      ? null
      : {
          label: t.ads,
          value: company.runsAds
            ? t.adsYes(
                new Intl.ListFormat(f.locale, { type: "conjunction" }).format(company.adsPlatforms.map((p) => t.plataformas[p] ?? p)),
              )
            : t.adsNo,
        },
  ];

  return (
    <div className="space-y-4">
      {hechos.some(Boolean) || fit ? (
        <dl aria-label={t.facts} className="space-y-2 rounded-md border border-border p-4 text-sm">
          {hechos.map((h) => h && (
            <div key={h.label} className="flex justify-between gap-3">
              <dt className="text-muted">{h.label}</dt>
              <dd className="min-w-0 break-words text-right text-ink">{h.value}</dd>
            </div>
          ))}
          {fit && (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted">{t.fit}</dt>
              <dd>
                <Pill kind={fit.kind}>{fit.text}</Pill>
              </dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="text-xs text-muted">{t.noFacts}</p>
      )}

      <div>
        <h3 className="mb-2 text-sm font-semibold">{t.signals}</h3>
        {signals.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted">{t.noSignals}</p>
        ) : (
          <ul className="space-y-3">
            {signals.map((s) => {
              const estado = SIGNAL_STATUS_META[s.status];
              const encaje = pillForFit(s.fitScore, f);
              // Solo http(s): la columna es text libre y la llenarán los conectores del radar.
              const evidencia = safeHref(s.evidenceUrl);
              return (
                <li key={s.id} className="rounded-md border border-border p-3">
                  <p className="text-sm leading-5 text-ink">{s.headline}</p>
                  <p className="mt-1 text-xs text-muted">
                    {s.sourceLabel} ·{" "}
                    <time dateTime={s.detectedAt} className="tabular-nums">
                      {f.date(s.detectedAt)}
                    </time>
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Pill kind={estado.kind}>{estado.label}</Pill>
                    {encaje && <Pill kind={encaje.kind}>{`${t.fit} ${encaje.text}`}</Pill>}
                  </div>
                  {s.budgetEstimate && (
                    <p className="mt-2 text-xs tabular-nums text-ink-2">
                      {t.budget(f.money(s.budgetEstimate, s.budgetCurrency ?? undefined, { mode: "short" }))}
                    </p>
                  )}
                  {s.status === "discarded" && s.discardReason && <p className="mt-1 text-xs text-muted">{t.discarded(s.discardReason)}</p>}
                  {(evidencia || s.status === "pending") && (
                    <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                      {evidencia && (
                        <a href={evidencia} target="_blank" rel="noreferrer noopener" className="text-ink underline underline-offset-4 hover:text-ink-2">
                          {t.evidence}
                        </a>
                      )}
                      {s.status === "pending" && (
                        <Link href="/ventas" className="text-ink underline underline-offset-4 hover:text-ink-2">
                          {t.reviewInRadar}
                        </Link>
                      )}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
