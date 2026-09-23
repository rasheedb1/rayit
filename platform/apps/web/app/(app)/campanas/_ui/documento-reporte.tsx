import type { ReactNode } from "react";
import { deliverableLabel, type MissingInput, type ReportBrandInput, type ReportPayload, type ReportPost, type ReportResult } from "@mc/core";
import { ChartCard } from "@/components/ui/chart-card";
import { Kpi, KpiRow } from "@/components/ui/kpi";
import { Pill } from "@/components/ui/pill";
import { PlatformPill } from "@/components/ui/platform-pill";
import { formatterFor, type Formatter } from "@/lib/format";
import { idiomaDocumento } from "@/app/(app)/cotizar/messages";
import { lineasAcordado } from "@/app/(app)/cotizar/_lib/acordado";
import { MESSAGES } from "../_lib/messages";
import { BotonImprimir } from "./imprimir";

/**
 * El reporte como documento: lo que ve la marca en /reporte/<slug> y lo
 * que ve el creador en la vista previa de la ficha. Es EL MISMO
 * componente en los dos sitios, así que la vista previa no puede mentir
 * sobre lo que la marca tiene delante.
 *
 * Solo props, y solo el payload: no consulta nada, no registra visitas
 * y no lee ninguna cifra viva. Lo primero que se lee es lo acordado
 * antes de publicar; las cifras vienen después. Una ausencia se explica
 * con una frase, nunca con un guion mudo ni con un cero.
 *
 * Referencias: la página alojada de una factura de Stripe y el
 * documento de la cotización (cotizar/_ui/documento-cotizacion.tsx).
 */
export function DocumentoReporte({
  r,
  superseded = false,
  aviso,
}: {
  r: ReportPayload;
  /** Otra versión enviada dejó atrás a esta (0037 §1): se avisa arriba, y el documento sigue diciendo lo suyo. */
  superseded?: boolean;
  /** Lo que va encima del documento (el aviso de la vista previa). */
  aviso?: ReactNode;
}) {
  const t = MESSAGES.documento;
  const f = formatterFor({ locale: r.locale, currency: r.currency, timezone: r.timezone });
  const rango = r.campaign.startsOn && r.campaign.endsOn ? f.dateRange(r.campaign.startsOn, r.campaign.endsOn) : null;

  return (
    <article className="space-y-10" lang={idiomaDocumento(r.locale)}>
      {aviso}
      {superseded && (
        <p role="status" className="rounded-md border border-warn/30 bg-warn-wash px-3 py-2 text-sm text-warn">
          {t.versionAntigua}
        </p>
      )}

      <header>
        <p className="font-mono text-xs uppercase tracking-wide text-muted">{t.eyebrow}</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-balance break-words">{r.campaign.name}</h1>
        <p className="mt-2 text-sm text-ink-2">
          {t.para} {r.company.name}
          {r.creator.displayName ? ` · ${t.de} ${r.creator.displayName}` : ""}
          {r.creator.handle ? ` (@${r.creator.handle.replace(/^@/, "")})` : ""}
        </p>
        <p className="mt-1 text-sm text-ink-2">{rango ? t.fechas(rango) : t.sinFechas}</p>
        <p className="mt-3 text-xs text-muted">{t.congelado(f.dateTime(r.generatedAt))}</p>
      </header>

      <Seccion id="doc-acordado" title={t.acordado} meta={r.agreed ? t.acordadoDe(r.agreed.quoteNumber) : undefined}>
        {r.agreed ? (
          <dl className="divide-y divide-border rounded-md border border-border">
            {lineasAcordado(r.agreed, f).map((linea) => (
              <div key={linea.termino} className="flex flex-wrap justify-between gap-2 px-4 py-2.5 text-sm">
                <dt className="text-ink-2">{linea.termino}</dt>
                <dd className="text-right">{linea.valor}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-ink-2">{t.sinCotizacion}</p>
        )}
      </Seccion>

      <Seccion
        id="doc-resultado"
        title={t.resultado}
        meta={r.result ? `${t.resultadoCorte(horas(r.result.cutHours))} · ${t.resultadoCalculado(f.date(r.result.computedAt))}` : undefined}
      >
        {r.result ? <Resultado result={r.result} f={f} /> : <p className="text-sm text-ink-2">{t.sinResultado}</p>}
      </Seccion>

      <Seccion id="doc-posts" title={t.posts} meta={r.posts.length > 0 ? `${f.int(r.posts.length)} ${r.posts.length === 1 ? "post" : "posts"}` : undefined}>
        {r.posts.length === 0 ? (
          <p className="text-sm text-ink-2">{t.sinPosts}</p>
        ) : (
          <ul className="space-y-4">
            {r.posts.map((p, i) => (
              <li key={`${p.url ?? p.title ?? "post"}-${i}`} className="doc-bloque rounded-md border border-border p-4">
                <PostCard post={p} cutsHours={r.cutsHours} f={f} />
              </li>
            ))}
          </ul>
        )}
      </Seccion>

      <Seccion id="doc-seguidores" title={t.seguidores}>
        <Seguidores r={r} f={f} />
      </Seccion>

      <Seccion id="doc-aportes" title={t.aportes}>
        {r.brandInputs.length === 0 ? (
          <p className="text-sm text-ink-2">{t.sinAportes}</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {r.brandInputs.map((b, i) => (
              <li key={`${b.kind}-${b.receivedAt}-${i}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 px-4 py-2.5 text-sm">
                <span className="min-w-0">
                  <span className="block">{t.aporte[b.kind] ?? b.kind}</span>
                  <span className="block text-xs text-muted">
                    {b.day ? `${t.aporteDia(f.date(b.day))} · ` : ""}
                    {t.aporteFuente[b.source] ?? b.source}
                  </span>
                </span>
                <span className="whitespace-nowrap text-right font-mono tabular-nums">{valorAporte(b, f)}</span>
              </li>
            ))}
          </ul>
        )}
      </Seccion>

      <Seccion id="doc-seguimiento" title={t.seguimiento}>
        {r.campaign.trackingCode || r.campaign.trackingUrl ? (
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            {r.campaign.trackingCode && (
              <div>
                <dt className="text-xs text-muted">{t.codigo}</dt>
                <dd className="font-mono">{r.campaign.trackingCode}</dd>
              </div>
            )}
            {r.campaign.trackingUrl && (
              <div className="min-w-0">
                <dt className="text-xs text-muted">{t.enlaceRastreado}</dt>
                <dd className="break-all font-mono text-xs">{r.campaign.trackingUrl}</dd>
              </div>
            )}
          </dl>
        ) : (
          <p className="text-sm text-ink-2">{t.sinSeguimiento}</p>
        )}
      </Seccion>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-xs text-muted">
        <span>{t.pie(r.creator.displayName)}</span>
        <BotonImprimir />
      </footer>
    </article>
  );
}

function Seccion({ id, title, meta, children }: { id: string; title: string; meta?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="doc-seccion min-w-0">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={id} className="text-sm font-semibold">
          {title}
        </h2>
        {meta && <span className="text-xs text-muted">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

/** «7 días», «30 días», «24 h»: la misma regla que cutHoursLabel de core. */
function horas(h: number): string {
  return h >= 48 && h % 24 === 0 ? `${h / 24} días` : `${h} h`;
}

/** Lo que falta, con las frases de «Resultado» de la ficha (CAM-5): la marca lee lo mismo que el creador. */
const FALTANTES: Record<string, string> = MESSAGES.resultado.missing satisfies Record<MissingInput, string>;

function Resultado({ result, f }: { result: ReportResult; f: Formatter }) {
  const t = MESSAGES.documento;
  const k = t.kpi;
  const entero = (n: number | null) => (n === null ? t.sinDato : f.int(n));
  const dinero = (v: string | null) => (v === null ? t.sinDato : f.money(v, result.currency ?? f.currency, { mode: "full" }));
  return (
    <div className="space-y-4">
      <KpiRow>
        <Kpi label={k.views} value={entero(result.views)} />
        <Kpi label={k.reach} value={entero(result.reach)} />
        <Kpi label={k.interactions} value={entero(result.interactions)} />
        <Kpi label={k.linkClicks} value={entero(result.linkClicks)} />
      </KpiRow>
      <KpiRow>
        <Kpi label={k.brandFollowersGained} value={entero(result.brandFollowersGained)} />
        <Kpi label={k.codeRedemptions} value={entero(result.codeRedemptions)} />
        <Kpi label={k.attributedRevenue} value={dinero(result.attributedRevenue)} />
        <Kpi label={k.cpa} value={dinero(result.cpa)} />
      </KpiRow>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Dato label={k.saves}>{entero(result.saves)}</Dato>
        <Dato label={k.shares}>{entero(result.shares)}</Dato>
        <Dato label={k.reachNonFollowers}>{result.reachNonFollowersPct === null ? t.sinDato : f.pct(Number(result.reachNonFollowersPct))}</Dato>
        <Dato label={k.cpm}>{dinero(result.cpm)}</Dato>
        <Dato label={k.costPerFollower}>{dinero(result.costPerFollower)}</Dato>
        <Dato label={k.emv}>{dinero(result.emv)}</Dato>
      </dl>
      {result.missingInputs.length > 0 && (
        <p className="text-xs text-muted">
          {t.faltantes} {result.missingInputs.map((m) => FALTANTES[m] ?? m).join("; ")}.
        </p>
      )}
    </div>
  );
}

function Dato({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 border-b border-border py-1.5">
      <dt className="text-ink-2">{label}</dt>
      <dd className="font-mono tabular-nums">{children}</dd>
    </div>
  );
}

const METRICAS_POST = ["views", "reach", "likes", "comments", "shares", "saves"] as const;

function PostCard({ post, cutsHours, f }: { post: ReportPost; cutsHours: number[]; f: Formatter }) {
  const t = MESSAGES.documento;
  const titulo = post.title ?? t.post;
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <PlatformPill platformId={post.platformId} />
        {post.isPrimary && <Pill kind="good">{t.principal}</Pill>}
        {post.deliverable && <span className="text-xs text-muted">{deliverableLabel(post.deliverable)}</span>}
      </div>
      <p className="mt-2 text-sm font-medium break-words">
        {post.url ? (
          <a href={post.url} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">
            {titulo}
          </a>
        ) : (
          titulo
        )}
      </p>
      <p className="text-xs text-muted">{post.publishedAt ? t.publicado(f.date(post.publishedAt, "long")) : t.sinFechaPublicacion}</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs sm:text-sm">
          <thead>
            <tr className="text-xs text-muted">
              <th scope="col" className="py-1 text-left font-normal">
                {t.metrica}
              </th>
              {cutsHours.map((h) => (
                <th key={h} scope="col" className="py-1 pl-2 text-right font-normal whitespace-nowrap">
                  {t.corte(horas(h))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {METRICAS_POST.map((m) => (
              <tr key={m} className="border-t border-border">
                <th scope="row" className="py-1.5 pr-2 text-left font-normal text-ink-2">
                  {t.metricaPost[m]}
                </th>
                {post.cuts.map((c, i) => {
                  const v = c === null ? null : c[m];
                  return (
                    <td key={cutsHours[i] ?? i} className="py-1.5 pl-2 text-right tabular-nums whitespace-nowrap">
                      {v === null ? <span className="text-muted">{t.sinDato}</span> : f.compact(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">
        {post.cuts.some((c) => c === null) ? `${t.sinLectura}. ` : ""}
        {post.latest ? t.ultimaLectura(f.date(post.latest.capturedAt)) : ""}
      </p>
    </div>
  );
}

function Seguidores({ r, f }: { r: ReportPayload; f: Formatter }) {
  const t = MESSAGES.documento;
  const b = r.brandFollowers;
  if (!b) return <p className="text-sm text-ink-2">{t.sinSeguidores(null)}</p>;
  const puntos = b.points.filter((p): p is { day: string; followers: number } => p.followers !== null);
  if (puntos.length === 0) return <p className="text-sm text-ink-2">{t.sinSeguidores(b.handle)}</p>;
  const labels = puntos.map((p) => f.dayMonth(p.day));
  const inicio = r.campaign.startsOn;
  const fin = r.campaign.endsOn;
  const desde = inicio ? puntos.findIndex((p) => p.day >= inicio) : -1;
  let hasta = fin ? puntos.findLastIndex((p) => p.day <= fin) : -1;
  if (desde >= 0 && hasta < desde) hasta = desde;
  const rango = inicio && fin ? f.dayMonthRange(inicio, fin) : null;
  const shade = desde >= 0 && hasta >= 0 && rango ? { from: desde, to: hasta, label: t.seguidoresVentana(rango) } : undefined;
  return (
    <ChartCard
      title={t.seguidoresDe(b.handle)}
      subtitle={b.baselineFrom ? t.seguidoresLineaBase(f.date(b.baselineFrom, "long")) : undefined}
      chart="line"
      series={[{ name: t.seguidoresSerie, data: puntos.map((p) => p.followers), color: b.platformId }]}
      labels={labels}
      line={{ fromZero: false, shade, endLabels: false }}
      ariaLabel={t.seguidoresAria(b.handle)}
      format="int"
      legend={false}
      asOf={{ date: puntos[puntos.length - 1]!.day }}
    />
  );
}

function valorAporte(b: ReportBrandInput, f: Formatter): string {
  const t = MESSAGES.documento;
  if (b.value === null) return t.sinDato;
  if (b.currency) return f.money(b.value, b.currency, { mode: "full" });
  const n = Number(b.value);
  return Number.isInteger(n) ? f.int(n) : b.value;
}
