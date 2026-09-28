import type { MediaKitSnapshot, MediaKitSnapshotAudiencia, MediaKitSnapshotPost } from "@mc/db/queries/cotizar";
import { cutOf } from "@mc/core/outreach/perfil";
import { PLATFORM_LABEL, PlatformPill, isPlatformId } from "@/components/ui/platform-pill";
import { formatCountry, formatterFor, type Formatter } from "@/lib/format";
import { idiomaDocumento, MESSAGES, nombreModificador } from "../messages";

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
  // La cifra grande de views es la mediana de la MEJOR red, y se rotula
  // con esa red. Un media kit anterior que no guardó la red no la enseña
  // arriba: presentada sola, se leería como el alcance típico de
  // cualquier pieza. Sigue en la lista por red.
  const mejorRed = snapshot.totales.medianViewsMaxPlatform ?? null;
  const viewsMejorRed = mejorRed && isPlatformId(mejorRed) ? snapshot.totales.medianViewsMax : null;
  // Lo que los rangos ya cobran (derechos, exclusividad…). Los media kits
  // anteriores no lo guardaron y no dicen nada.
  const incluyen = Array.isArray(snapshot.tarifasIncluyen) ? snapshot.tarifasIncluyen : [];

  return (
    <article className="space-y-10" lang={idiomaDocumento(snapshot.locale)}>
      <header>
        <p className="font-mono text-xs uppercase tracking-wide text-muted">{t.title}</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-balance">{snapshot.creator.displayName}</h1>
        {snapshot.creator.handle && <p className="mt-1 font-mono text-sm text-ink-2">{snapshot.creator.handle}</p>}
        {snapshot.creator.bio && <p className="mt-3 text-[15px] leading-6 text-ink-2">{snapshot.creator.bio}</p>}
        <p className="mt-3 text-xs text-muted">{t.congelado(f.date(snapshot.capturedAt, "long"))}</p>
      </header>

      {(snapshot.totales.followers !== null || viewsMejorRed !== null) && (
        <section className="grid grid-cols-2 gap-6" aria-label={t.cifras}>
          {snapshot.totales.followers !== null && (
            <div>
              <p className="text-xs uppercase tracking-wide text-muted">{t.seguidores}</p>
              <p className="mt-1 font-mono text-3xl font-medium tabular-nums">{f.compact(snapshot.totales.followers)}</p>
            </div>
          )}
          {viewsMejorRed !== null && mejorRed && isPlatformId(mejorRed) && (
            <div>
              <p className="text-xs uppercase tracking-wide text-muted">{t.viewsMedianasMejorRed}</p>
              <p className="mt-1 font-mono text-3xl font-medium tabular-nums">{f.compact(viewsMejorRed)}</p>
              <p className="mt-1.5">
                <PlatformPill platformId={mejorRed} />
              </p>
            </div>
          )}
        </section>
      )}

      {redes.length > 0 && (
        <section aria-label={t.redes}>
          <ul className="divide-y divide-border rounded-md border border-border">
            {redes.map((r) => (
              <li key={r.platformId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <span className="flex flex-col items-start gap-1">
                  <PlatformPill platformId={r.platformId} />
                  {r.handle && <span className="font-mono text-xs text-muted">{r.handle}</span>}
                </span>
                {/* En móvil, rejilla de tres columnas alineadas a la izquierda:
                    con flex-wrap y text-right, la tercera cifra bajaba de
                    línea y quedaba con el número a la derecha y la etiqueta
                    a la izquierda. Desde sm vuelven a ir a la derecha. */}
                <span
                  data-cifras-red
                  className="grid w-full grid-cols-3 gap-x-4 gap-y-1 text-left sm:flex sm:w-auto sm:items-baseline sm:gap-x-6 sm:text-right"
                >
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
            {/* Pulido r5: a 400 px el video va arriba a todo lo ancho y sus
                cifras debajo. En fila, la columna de la cifra («412 mil ·
                views a los 30 días… · 6× su mediana…») se comía media fila y
                el título quedaba en quince letras. Desde sm vuelven a ir a la
                derecha, con un ancho tope para que el título siga leyéndose. */}
            {snapshot.topPosts.map((p, i) => (
              <li
                key={`${p.url ?? "post"}-${i}`}
                data-post-top
                className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <span className="min-w-0 sm:flex-1">
                  <span className="flex items-center gap-2">
                    <PlatformPill platformId={p.platformId} />
                    <span className="text-xs text-muted">{f.date(p.publishedAt)}</span>
                  </span>
                  {p.caption && (
                    <span data-post-titulo className="mt-1 line-clamp-2 break-words text-sm text-ink-2">
                      {p.caption}
                    </span>
                  )}
                </span>
                <PostCifras post={p} f={f} />
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
              <li key={`${tarifa.labelEs}-${i}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-4 py-3">
                <span className="flex min-w-0 flex-col items-start gap-1">
                  <span className="text-sm">{tarifa.labelEs}</span>
                  {tarifa.platformId && <PlatformPill platformId={tarifa.platformId} />}
                </span>
                <span className="text-right font-mono text-sm tabular-nums">
                  {tarifa.priceLow && tarifa.priceHigh
                    ? `${f.money(tarifa.priceLow, snapshot.currency)} – ${f.money(tarifa.priceHigh, snapshot.currency)}`
                    : "—"}
                </span>
              </li>
            ))}
          </ul>
          {incluyen.length > 0 && (
            <p className="mt-2 text-sm text-ink-2" data-testid="tarifas-incluyen">
              {t.tarifasIncluyen(incluyen.map(nombreModificador))}
            </p>
          )}
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
  if (dimension === "country" && /^[A-Z]{2}$/.test(bucket)) return formatCountry(bucket, { locale });
  return bucket;
}

/**
 * Las cifras de un video: sus views y cuántas veces su mediana. Desde el
 * pulido r2 van medidas a una edad, como en el perfil comercial («views a
 * los 3 días de publicado», «3,7× su mediana a esa edad (106,7 mil)»), y
 * con la mediana contra la que se midió: una marca que divida las dos
 * cifras encuentra el múltiplo. Un kit congelado antes (sin la edad)
 * se lee como se generó.
 */
function PostCifras({ post: p, f }: { post: MediaKitSnapshotPost; f: Formatter }) {
  const t = MESSAGES.publico.kit;
  const corte = p.ageHoursCut === null || p.ageHoursCut === undefined ? null : cutOf(p.ageHoursCut);
  const edad = corte ? t.edad(corte.unit, f.int(corte.amount)) : null;
  const multiplo = p.viewsVsMedian ? f.multiple(Number(p.viewsVsMedian)) : null;
  return (
    <span data-post-cifras className="block text-left sm:max-w-60 sm:shrink-0 sm:text-right">
      {/* En móvil, la cifra y su edad en una línea corta («412 mil views a
          los 30 días de publicado»); la mediana, en la suya. Desde sm, cada
          una en su línea y a la derecha. */}
      {p.views !== null && (
        <span className="flex flex-wrap items-baseline gap-x-1.5 sm:block">
          <span className="font-mono text-sm tabular-nums sm:block">{f.compact(p.views)}</span>
          {edad && <span className="text-xs text-muted sm:block">{t.viewsA(edad)}</span>}
        </span>
      )}
      {multiplo && (
        <span className="block text-xs tabular-nums text-muted">
          {edad && p.medianAtCut ? t.vsMedianaA(multiplo, f.compact(p.medianAtCut)) : t.vsMediana(multiplo)}
        </span>
      )}
    </span>
  );
}
