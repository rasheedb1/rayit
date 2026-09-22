import type { MediaKitSnapshot } from "@mc/db/queries/cotizar";
import { Pill } from "@/components/ui/pill";
import { PlatformPill } from "@/components/ui/platform-pill";
import { formatterFor } from "@/lib/format";
import { MESSAGES } from "@/app/(app)/cotizar/messages";

/**
 * El media kit tal como lo ve la marca.
 *
 * Una columna, cifras grandes y las tarifas al final, como los media
 * kits de Beacons y Passionfroot: quien lo abre está decidiendo si
 * escribe, no auditando una hoja de cálculo.
 *
 * Solo props: no consulta nada. Por eso sirve igual dentro del
 * componente de servidor de la página y dentro del cliente que pide la
 * contraseña.
 */
export function MediaKitVista({ snapshot }: { snapshot: MediaKitSnapshot }) {
  const t = MESSAGES.publico.kit;
  const f = formatterFor({ locale: snapshot.locale, currency: snapshot.currency, timezone: snapshot.timezone });
  const redes = snapshot.redes.filter((r) => r.followers !== null || r.medianViews !== null);

  return (
    <article className="space-y-10">
      <header>
        <p className="font-mono text-xs uppercase tracking-wide text-muted">{t.title}</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-balance">{snapshot.creator.displayName}</h1>
        {snapshot.creator.handle && <p className="mt-1 font-mono text-sm text-ink-2">{snapshot.creator.handle}</p>}
        {snapshot.creator.bio && <p className="mt-3 text-[15px] leading-6 text-ink-2">{snapshot.creator.bio}</p>}
        <p className="mt-3 text-xs text-muted">{t.congelado(f.date(snapshot.capturedAt, "long"))}</p>
      </header>

      {(snapshot.totales.followers !== null || snapshot.totales.medianViewsMax !== null) && (
        <section className="grid grid-cols-2 gap-6" aria-label={t.seguidores}>
          {snapshot.totales.followers !== null && (
            <div>
              <p className="text-xs uppercase tracking-wide text-muted">{t.seguidores}</p>
              <p className="mt-1 font-mono text-3xl font-medium tabular-nums">{f.compact(snapshot.totales.followers)}</p>
            </div>
          )}
          {snapshot.totales.medianViewsMax !== null && (
            <div>
              <p className="text-xs uppercase tracking-wide text-muted">{t.viewsMedianas}</p>
              <p className="mt-1 font-mono text-3xl font-medium tabular-nums">{f.compact(snapshot.totales.medianViewsMax)}</p>
            </div>
          )}
        </section>
      )}

      {redes.length > 0 && (
        <section aria-label="Redes">
          <ul className="divide-y divide-border rounded-md border border-border">
            {redes.map((r) => (
              <li key={r.platformId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <span className="flex flex-col gap-1">
                  <PlatformPill platformId={r.platformId} />
                  {r.handle && <span className="font-mono text-xs text-muted">{r.handle}</span>}
                </span>
                <span className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-right">
                  {r.followers !== null && (
                    <span>
                      <span className="block font-mono text-sm tabular-nums">{f.compact(r.followers)}</span>
                      <span className="block text-xs text-muted">{t.seguidores}</span>
                    </span>
                  )}
                  {r.medianViews !== null && (
                    <span>
                      <span className="block font-mono text-sm tabular-nums">{f.compact(r.medianViews)}</span>
                      <span className="block text-xs text-muted">{t.viewsMedianas}</span>
                    </span>
                  )}
                  {r.engagement && (
                    <span>
                      <span className="block font-mono text-sm tabular-nums">{f.pct(Number(r.engagement), 1)}</span>
                      <span className="block text-xs text-muted">{t.engagement}</span>
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {snapshot.topPosts.length > 0 && (
        <section aria-labelledby="top">
          <h2 id="top" className="text-sm font-semibold">
            {t.topPosts}
          </h2>
          <ul className="mt-3 divide-y divide-border rounded-md border border-border">
            {snapshot.topPosts.map((p, i) => (
              <li key={`${p.url ?? "post"}-${i}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <PlatformPill platformId={p.platformId} />
                    <span className="text-xs text-muted">{f.date(p.publishedAt)}</span>
                  </span>
                  {p.caption && <span className="mt-1 block truncate text-sm text-ink-2">{p.caption}</span>}
                </span>
                <span className="text-right">
                  {p.views !== null && <span className="block font-mono text-sm tabular-nums">{f.compact(p.views)}</span>}
                  {p.viewsVsMedian && (
                    <span className="block text-xs text-muted">
                      {f.compact(Number(p.viewsVsMedian))} {t.vsMediana}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {snapshot.audiencia.length > 0 && (
        <section aria-labelledby="audiencia">
          <h2 id="audiencia" className="text-sm font-semibold">
            {t.audiencia}
          </h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {snapshot.audiencia.slice(0, 8).map((a, i) => (
              <li key={`${a.dimension}-${a.bucket}-${i}`}>
                <Pill kind="neutral">{a.share ? `${a.bucket} · ${f.pct(Number(a.share))}` : a.bucket}</Pill>
              </li>
            ))}
          </ul>
        </section>
      )}

      {snapshot.tarifas.length > 0 && (
        <section aria-labelledby="tarifas">
          <h2 id="tarifas" className="text-sm font-semibold">
            {t.tarifas}
          </h2>
          <ul className="mt-3 divide-y divide-border rounded-md border border-border">
            {snapshot.tarifas.map((tarifa, i) => (
              <li key={`${tarifa.labelEs}-${i}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <span className="flex flex-col gap-1">
                  <span className="text-sm">{tarifa.labelEs}</span>
                  {tarifa.platformId && <PlatformPill platformId={tarifa.platformId} />}
                </span>
                <span className="font-mono text-sm tabular-nums">
                  {tarifa.priceLow && tarifa.priceHigh
                    ? `${f.money(tarifa.priceLow, snapshot.currency)} – ${f.money(tarifa.priceHigh, snapshot.currency)}`
                    : "—"}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">{t.tarifasAyuda}</p>
        </section>
      )}

      <footer className="border-t border-border pt-4 text-xs text-muted">
        {MESSAGES.publico.cotizacion.pie}
      </footer>
    </article>
  );
}
