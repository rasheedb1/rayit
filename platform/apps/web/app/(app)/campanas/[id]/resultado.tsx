import Link from "next/link";
import { cutHoursLabel, followerRateMultiple, isResultComplete, RESULT_COMPUTE_STATUSES, RESULT_FULL_CUT_HOURS, type CampaignStatus, type MissingInput } from "@mc/core";
import type { BrandInputs, CampaignResultRow } from "@mc/db";
import { Button } from "@/components/ui/button";
import { DataAsOf } from "@/components/ui/data-as-of";
import { EmptyState } from "@/components/ui/empty-state";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { parseDecimal, type Formatter } from "@/lib/format";
import { MESSAGES } from "../_lib/messages";

const t = MESSAGES.resultado;

/** Dónde se arregla cada cosa que falta. Sin enlace: no hay un sitio en la ficha que lo arregle. */
const FIX_HREF: Partial<Record<MissingInput, string>> = {
  posts: "#asociar",
  baseline: "/conexiones",
  brand_followers: "#seguidores",
  brand_followers_baseline_short: "#seguidores",
  brand_inputs: "#aporte",
  brand_csv_sales: "#aporte",
};

export interface ResultadoProps {
  campaignId: string;
  status: CampaignStatus;
  editable: boolean;
  result: CampaignResultRow | null;
  brandInputs: BrandInputs;
  /** La base deja escribir campaign_result como mc_app (el GRANT de docs/propuestas/CAM-5.md §2). */
  canRecompute: boolean;
  /** Server Action ya ligada al id de la campaña. */
  recompute: () => Promise<void>;
  f: Formatter;
}

/** Un KPI de la marca: su cifra, o «Sin datos de la marca». Nunca cero. */
function brandValue(n: number | null, f: Formatter): string {
  return n === null ? t.absent.brand : f.int(n);
}

/** El pie con qué hacer: el botón si la base lo deja, o por qué no hay. */
function RecomputeFooter({ status, canRecompute, recompute }: Pick<ResultadoProps, "status" | "canRecompute" | "recompute">) {
  if (!RESULT_COMPUTE_STATUSES.includes(status)) {
    return status === "closed" ? <p className="text-xs text-fg-3">{t.frozen}</p> : null;
  }
  if (!canRecompute) return <p className="text-xs text-fg-3">{t.daily}</p>;
  return (
    <form action={recompute}>
      <Button type="submit" size="sm">
        {t.recompute}
      </Button>
    </form>
  );
}

/**
 * «Resultado» (CAM-5): los seis KPIs tal como están en campaign_result.
 * No calcula nada: las cifras llegan hechas de la tabla y el «×12 el
 * ritmo» sale de core (followerRateMultiple). Donde falta un dato, la
 * frase que lo dice; debajo, qué falta y dónde se arregla.
 */
export function Resultado({ campaignId, status, editable, result, brandInputs, canRecompute, recompute, f }: ResultadoProps) {
  if (!result) {
    return (
      <div className="space-y-3">
        <EmptyState title={t.empty.title} description={status === "planned" ? t.empty.planned : t.empty.description} />
        <RecomputeFooter status={status} canRecompute={canRecompute} recompute={recompute} />
      </div>
    );
  }
  const r = result;
  // Ingresos abreviados («COP 8,4 M»); CPM y CPA enteros: abreviar 4.353,93 a «4 mil» pierde la cifra.
  const money = (v: string) => f.money(v, r.currency ?? undefined, { mode: "short" });
  const exact = (v: string) => f.money(v, r.currency ?? undefined, { mode: "full" });
  const multiple = followerRateMultiple(r.brandFollowersBaselineRate, r.brandFollowersCampaignRate);
  const cutLabel = cutHoursLabel(r.cutHours);
  const fromCsv =
    brandInputs.totals.some((x) => x.source === "brand_csv") && brandInputs.totals.some((x) => x.source === "brand_manual");
  // Por qué no hay CPM: lo dice missing_inputs, no se deduce de otra celda.
  const cpmAbsent = r.missingInputs.includes("amount") ? t.absent.amount : r.views === null ? t.absent.posts : t.absent.notComputed;
  // «Asociar post» solo existe si la campaña admite cambios: sin ella, «posts» va sin enlace.
  const hrefOf = (m: MissingInput) => (m === "posts" && !editable ? undefined : FIX_HREF[m]);

  return (
    <div className="space-y-4">
      <KpiRow className="lg:grid-cols-3">
        <Kpi
          label={t.kpi.views}
          value={r.views === null ? t.absent.posts : f.int(r.views)}
          note={r.viewsVsMedian === null ? undefined : t.note.vsMedian(f.multiple(parseDecimal(r.viewsVsMedian), 1))}
        />
        <Kpi
          label={t.kpi.reach}
          value={r.reach === null ? t.absent.posts : f.int(r.reach)}
          note={r.reachNonFollowersPct === null ? undefined : t.note.nonFollowers(f.pct(parseDecimal(r.reachNonFollowersPct)))}
        />
        <Kpi label={t.kpi.clicks} value={r.linkClicks === null ? (r.views === null ? t.absent.posts : t.absent.clicks) : f.int(r.linkClicks)} />
        <Kpi
          label={t.kpi.redemptions}
          value={brandValue(r.codeRedemptions, f)}
          note={r.attributedRevenue === null ? undefined : t.note.revenue(money(r.attributedRevenue))}
        />
        <Kpi
          label={t.kpi.followers}
          value={brandValue(r.brandFollowersGained, f)}
          note={multiple === null ? undefined : t.note.rate(f.multiple(multiple, 0))}
        />
        <Kpi
          label={t.kpi.cpm}
          value={r.cpm === null ? cpmAbsent : exact(r.cpm)}
          note={r.cpa === null ? t.note.cpaAbsent : t.note.cpa(exact(r.cpa))}
        />
      </KpiRow>

      <DataAsOf
        date={r.computedAt}
        source={t.asOfSource(r.cutHours < RESULT_FULL_CUT_HOURS ? t.partialCut(cutLabel) : t.cut(cutLabel))}
      />
      {fromCsv && <p className="text-xs text-fg-3">{t.fromCsv}</p>}

      {r.missingInputs.length > 0 && (
        <div>
          <p className="text-sm font-medium text-ink">{t.missingTitle}</p>
          <ul className="mt-1 space-y-1 text-sm text-fg-2">
            {r.missingInputs.map((m) => {
              const href = hrefOf(m);
              return (
                <li key={m}>
                  {href ? (
                    <Link href={href.startsWith("#") ? `/campanas/${campaignId}${href}` : href} className="underline underline-offset-2">
                      {t.missing[m]}
                    </Link>
                  ) : (
                    t.missing[m]
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {status === "measuring" && isResultComplete(r) && (
        <p role="status" className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-fg-2">
          {t.complete}
        </p>
      )}
      <RecomputeFooter status={status} canRecompute={canRecompute} recompute={recompute} />
    </div>
  );
}
