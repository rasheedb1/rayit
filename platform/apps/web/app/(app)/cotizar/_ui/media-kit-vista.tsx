import type { MediaKitSnapshot, MediaKitSnapshotAudiencia } from "@mc/db/queries/cotizar";
import { PLATFORM_LABEL, PlatformPill, isPlatformId } from "@/components/ui/platform-pill";
import { formatterFor, type Formatter } from "@/lib/format";
import { MESSAGES } from "../messages";

/**
 * El media kit tal como lo ve la marca, en /kit/<slug> y en la vista
 * previa del panel (el mismo componente en los dos sitios).
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
  const audiencia = audienciaAgrupada(snapshot);

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
        <section aria-label={t.redes}>
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
        <section aria-labelledby="kit-top">
          <h2 id="kit-top" className="text-sm font-semibold">
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
                    <span className="block text-xs tabular-nums text-muted">{t.vsMediana(f.multiple(Number(p.viewsVsMedian)))}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {audiencia.length > 0 && (
        <section aria-labelledby="kit-audiencia">
          <h2 id="kit-audiencia" className="text-sm font-semibold">
            {t.audiencia}
          </h2>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {audiencia.map((a) => (
              <BloqueAudiencia key={`${a.platformId}-${a.dimension}`} a={a} f={f} locale={snapshot.locale} />
            ))}
          </div>
        </section>
      )}

      {snapshot.tarifas.length > 0 && (
        <section aria-labelledby="kit-tarifas">
          <h2 id="kit-tarifas" className="text-sm font-semibold">
            {t.tarifas}
          </h2>
          <ul className="mt-3 divide-y divide-border rounded-md border border-border">
            {snapshot.tarifas.map((tarifa, i) => (
              <li key={`${tarifa.labelEs}-${i}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <span className="flex min-w-0 flex-col gap-1">
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

      <footer className="border-t border-border pt-4 text-xs text-muted">{MESSAGES.publico.cotizacion.pie}</footer>
    </article>
  );
}

/**
 * La audiencia del snapshot. Los media kits de la primera versión (v1)
 * guardaban una lista plana sin red ni agrupar, que se leía como un
 * error; esos no enseñan la sección.
 */
function audienciaAgrupada(snapshot: MediaKitSnapshot): MediaKitSnapshotAudiencia[] {
  if (!Array.isArray(snapshot.audiencia)) return [];
  return snapshot.audiencia.filter((a) => Array.isArray((a as Partial<MediaKitSnapshotAudiencia>).buckets) && a.buckets.length > 0);
}

/** Un bloque por dimensión: «Edad · Instagram» y una barra por segmento. */
function BloqueAudiencia({ a, f, locale }: { a: MediaKitSnapshotAudiencia; f: Formatter; locale: string }) {
  const t = MESSAGES.publico.kit;
  const red = isPlatformId(a.platformId) ? PLATFORM_LABEL[a.platformId] : a.platformId;
  const titulo = t.audienciaDe(t.dimensiones[a.dimension] ?? a.dimension, red);
  return (
    <figure className="min-w-0 rounded-md border border-border p-4">
      <figcaption className="text-xs font-medium text-ink-2">{titulo}</figcaption>
      <ul className="mt-3 space-y-2">
        {a.buckets.map((b) => {
          const share = b.share === null ? null : Number(b.share);
          return (
            <li key={b.bucket} className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_3rem] items-center gap-2 text-xs">
              <span className="truncate text-ink-2">{nombreSegmento(a.dimension, b.bucket, locale)}</span>
              <span className="h-1.5 overflow-hidden rounded-full bg-hover" aria-hidden="true">
                {share !== null && (
                  <span className="block h-full rounded-full bg-ink-2" style={{ width: `${Math.min(100, Math.max(0, share * 100))}%` }} />
                )}
              </span>
              <span className="text-right font-mono tabular-nums">{share === null ? "—" : f.pct(share)}</span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

/** «CO» → «Colombia» con Intl en el idioma del media kit; «F» → «Mujeres». */
function nombreSegmento(dimension: string, bucket: string, locale: string): string {
  const t = MESSAGES.publico.kit;
  if (bucket === "OTHER") return t.otros;
  if (dimension === "gender") return t.generos[bucket] ?? bucket;
  if (dimension === "country" && /^[A-Z]{2}$/.test(bucket)) {
    try {
      return new Intl.DisplayNames([locale], { type: "region" }).of(bucket) ?? bucket;
    } catch {
      return bucket;
    }
  }
  return bucket;
}
