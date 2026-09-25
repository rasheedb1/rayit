import type { ReactNode } from "react";
import Link from "next/link";
import { genderCode, shortId, type Claim, type OutlierTier, type PerfilComercial, type TopVideo } from "@mc/core/outreach/perfil";
import { SectionTitle } from "@/components/page-header";
import { Pill, type PillKind } from "@/components/ui/pill";
import { PLATFORM_LABEL, PlatformPill } from "@/components/ui/platform-pill";
import { RANGE_DASH, type Formatter } from "@/lib/format";
import { Cifra } from "./cifra";
import { corteTexto, origenId, type CifraVista } from "./cifras";
import { MESSAGES } from "./messages";
import { Plegable } from "./plegable";

/**
 * Las secciones del perfil, en una columna y en el orden de un media kit
 * (Beacons, Passionfroot): quién eres, qué te funciona, a quién llegas,
 * qué haces, con quién trabajaste, cuánto cobras y, al final, de dónde
 * sale cada cifra. Cada número es una <Cifra> con su origen; aquí no se
 * calcula nada, solo se pinta lo que trae el perfil guardado.
 */

type Cifras = Record<string, CifraVista>;

export function Seccion({ id, title, meta, children }: { id: string; title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="border-t border-line pt-6">
      <SectionTitle meta={meta}>
        <span id={id}>{title}</span>
      </SectionTitle>
      {children}
    </section>
  );
}

/** Una cifra por id, o nada si el id no está (un perfil viejo frente a un claim que ya no existe). */
function C({ id, cifras, lugar, grande }: { id: string | null; cifras: Cifras; lugar: string; grande?: boolean }) {
  const c = id ? cifras[id] : undefined;
  return c ? <Cifra cifra={c} tipId={`${lugar}-${c.id}`} grande={grande} /> : null;
}

function Vacio({ children }: { children: ReactNode }) {
  return <p className="text-sm text-fg-2">{children}</p>;
}

// ---------------------------------------------------------------------
// Quién eres
// ---------------------------------------------------------------------

export function Identidad({ perfil, cifras, f }: { perfil: PerfilComercial; cifras: Cifras; f: Formatter }) {
  const t = MESSAGES.identidad;
  const id = perfil.identity;
  const idiomas = id.languages.map((l) => {
    try {
      return new Intl.DisplayNames([f.locale], { type: "language" }).of(l) ?? l;
    } catch {
      return l;
    }
  });
  const datos: { k: string; v: string }[] = [];
  if (id.niches.length) datos.push({ k: t.nichos, v: id.niches.join(", ") });
  if (id.country) datos.push({ k: t.pais, v: f.country(id.country) });
  if (idiomas.length) datos.push({ k: t.idiomas, v: idiomas.join(", ") });
  return (
    <section aria-labelledby="perfil-identidad" className="space-y-5">
      <div>
        <h2 id="perfil-identidad" className="text-xl font-semibold tracking-tight">{id.displayName}</h2>
        {id.handle && <p className="text-sm text-fg-2">@{id.handle.replace(/^@/, "")}</p>}
        {id.bio && <p className="mt-2 max-w-prose text-sm leading-6 text-fg-2">{id.bio}</p>}
      </div>
      {datos.length > 0 && (
        <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {datos.map((d) => (
            <div key={d.k} className="flex gap-1.5">
              <dt className="text-fg-3">{d.k}</dt>
              <dd>{d.v}</dd>
            </div>
          ))}
        </dl>
      )}
      {id.networks.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-medium text-fg-3">{t.redes}</h3>
          <ul className="grid grid-cols-1 gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-2">
            {id.networks.map((n) => (
              <li key={n.platformId} className="bg-surface p-3">
                <div className="flex items-center justify-between gap-2">
                  <PlatformPill platformId={n.platformId} />
                  {n.handle && <span className="truncate text-xs text-fg-3">@{n.handle.replace(/^@/, "")}</span>}
                </div>
                <p className="mt-2">
                  {n.followersClaimId ? (
                    <>
                      <C id={n.followersClaimId} cifras={cifras} lugar="identidad" grande />{" "}
                      <span className="text-sm text-fg-2">{t.seguidores}</span>
                    </>
                  ) : (
                    <span className="text-sm text-fg-3">{t.sinSeguidores}</span>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------
// Qué te funciona
// ---------------------------------------------------------------------

const TIER_KIND: Record<OutlierTier, PillKind> = {
  breakout: "good", outlier: "good", good: "neutral", normal: "neutral", under: "warn",
};

/** Cómo es el video: «abre con una promesa concreta · reel · colaboración con marca · corto». */
function descripcion(v: TopVideo): string {
  const t = MESSAGES.desempeno;
  return [
    t.gancho[v.why.hook] + (v.why.hookSource === "video_analysis" ? ` (${t.ganchoLab})` : ""),
    t.pieza[v.why.piece],
    t.contenido[v.why.content],
    v.why.duration ? t.duracionBucket[v.why.duration] : "",
    v.why.durationVsTypical ? t.vsTipico[v.why.durationVsTypical] : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Por qué funcionó: primero cómo es el video (gancho, pieza, tipo y
 * duración frente a la típica), que es la explicación que siempre se
 * puede dar. Debajo, solo si los datos la sostienen, lo que lo distingue:
 * el rasgo cuyos OTROS videos rinden claramente más que los que no lo
 * tienen, con las dos medianas como cifras. Core ya deja fuera al video
 * y elige la razón más fuerte; aquí solo se pinta.
 */
function PorQue({ v, cifras }: { v: TopVideo; cifras: Cifras }) {
  const t = MESSAGES.desempeno;
  const lugar = `porque-${shortId(v.postId)}`;
  const razon = v.why.reasons[0];
  return (
    <dl className="mt-2 space-y-1 text-xs leading-5 text-fg-2">
      <div>
        <dt className="inline text-fg-3">{t.comoEs}: </dt>
        <dd className="inline">{descripcion(v)}</dd>
      </div>
      {razon && (
        <div>
          <dt className="inline text-fg-3">{t.distingue}: </dt>
          <dd className="inline">
            {t.grupos[razon.axis][razon.group] ?? razon.group} {t.razonHacen} <C id={razon.groupClaimId} cifras={cifras} lugar={lugar} />{" "}
            {t.razonFrente} <C id={razon.restClaimId} cifras={cifras} lugar={lugar} /> {t.razonResto(razon.axis, razon.group)}
          </dd>
        </div>
      )}
    </dl>
  );
}

/**
 * La portada del video, 9:16 como en la red: lo primero que mira una
 * marca en un media kit (Beacons, Passionfroot). Sin portada, un hueco
 * del mismo tamaño para que la lista no baile.
 */
function Portada({ v }: { v: TopVideo }) {
  const t = MESSAGES.desempeno;
  const caja = "h-[100px] w-14 shrink-0 overflow-hidden rounded-md bg-hover";
  if (!v.coverUrl) return <span className={caja} aria-hidden="true" />;
  // Las portadas vienen de las plataformas (dominios que no controlamos):
  // next/image exigiría declararlos (el mismo criterio que Campañas).
  // eslint-disable-next-line @next/next/no-img-element
  const img = <img src={v.coverUrl} alt={t.portada(v.title)} width={56} height={100} loading="lazy" className={`${caja} object-cover`} />;
  return v.url ? (
    <a href={v.url} target="_blank" rel="noopener noreferrer" tabIndex={-1} className="shrink-0">
      {img}
    </a>
  ) : (
    img
  );
}

export function Desempeno({ perfil, cifras, f }: { perfil: PerfilComercial; cifras: Cifras; f: Formatter }) {
  const t = MESSAGES.desempeno;
  const { medians, top, scoredClaimId } = perfil.performance;
  const puntuados = scoredClaimId ? cifras[scoredClaimId]?.valor : undefined;
  return (
    <Seccion id="perfil-desempeno" title={t.title}>
      {medians.length > 0 && (
        <div className="mb-6">
          <h3 className="mb-2 text-xs font-medium text-fg-3">{t.medianas}</h3>
          <ul className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line lg:grid-cols-4">
            {medians.map((m) => (
              <li key={m.platformId} className="bg-surface p-3">
                <PlatformPill platformId={m.platformId} />
                <p className="mt-2"><C id={m.claimId} cifras={cifras} lugar="mediana" grande /></p>
                {/* Cada mediana con su propio corte: una red sin línea base a 7 días usa otro. */}
                <p className="mt-0.5 text-xs text-fg-3">{t.medianaNota(f.int(m.sampleSize), m.isReliable, corteTexto(m.cutHours, f))}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
      <h3 className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 text-xs font-medium text-fg-3">
        <span>{t.mejores}</span>
        {puntuados && <span className="font-normal">{t.mejoresMeta(puntuados)}</span>}
      </h3>
      {top.length === 0 ? (
        <Vacio>{t.sinVideos}</Vacio>
      ) : (
        <ol className="divide-y divide-line rounded-md border border-line">
          {top.map((v, i) => (
            <li key={v.postId} className="flex gap-3 p-3 sm:gap-4">
              <span className="w-4 shrink-0 pt-0.5 text-right text-sm tabular-nums text-fg-3">{f.int(i + 1)}</span>
              <Portada v={v} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <PlatformPill platformId={v.platformId} />
                  {v.outlierTier && <Pill kind={TIER_KIND[v.outlierTier]}>{t.tier[v.outlierTier]}</Pill>}
                </div>
                <p className="mt-1.5 text-sm font-medium break-words">
                  {v.url ? (
                    <a href={v.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                      {v.title}
                    </a>
                  ) : (
                    v.title
                  )}
                </p>
                <p className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm text-fg-2">
                  <span>
                    <C id={v.multipleClaimId} cifras={cifras} lugar="top" grande /> {t.veces}
                  </span>
                  {v.viewsClaimId && (
                    <span>
                      <C id={v.viewsClaimId} cifras={cifras} lugar="top" /> {t.views(corteTexto(v.cutHours, f))}
                    </span>
                  )}
                  {v.durationClaimId && (
                    <span>
                      <C id={v.durationClaimId} cifras={cifras} lugar="top" /> {t.duracion}
                    </span>
                  )}
                </p>
                {v.baselineClaimId && (
                  <p className="mt-1 text-xs text-fg-3">
                    {t.frenteA(PLATFORM_LABEL[v.platformId])}{" "}
                    <C id={v.baselineClaimId} cifras={cifras} lugar={`base-${shortId(v.postId)}`} /> {t.viewsPalabra}
                  </p>
                )}
                <PorQue v={v} cifras={cifras} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </Seccion>
  );
}

// ---------------------------------------------------------------------
// A quién llegas
// ---------------------------------------------------------------------

/** Una lista corta de «etiqueta … cifra», la forma de cada grupo de audiencia y de formatos. */
function Lista({ titulo, filas }: { titulo: string; filas: { key: string; label: string; cifra: ReactNode }[] }) {
  if (!filas.length) return null;
  return (
    <div>
      <h3 className="mb-1.5 text-xs font-medium text-fg-3">{titulo}</h3>
      <ul className="space-y-1 text-sm">
        {filas.map((r) => (
          <li key={r.key} className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 text-fg-2">{r.label}</span>
            <span className="shrink-0">{r.cifra}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Audiencia({ perfil, cifras, f }: { perfil: PerfilComercial; cifras: Cifras; f: Formatter }) {
  const t = MESSAGES.audiencia;
  const a = perfil.audience;
  const fila = (dim: "age" | "gender" | "country", label: (b: string) => string) =>
    a.lines
      .filter((l) => l.dimension === dim)
      .map((l) => ({ key: l.claimId, label: label(l.bucket), cifra: <C id={l.claimId} cifras={cifras} lugar="audiencia" /> }));
  const red = a.platformId ? PLATFORM_LABEL[a.platformId] : null;
  return (
    <Seccion id="perfil-audiencia" title={t.title} meta={red && a.day ? t.meta(red, f.date(a.day, "long")) : undefined}>
      {a.lines.length === 0 && a.nonFollowers.length === 0 ? (
        <Vacio>{t.sinDatos}</Vacio>
      ) : (
        <div className="grid gap-6 sm:grid-cols-3">
          <Lista titulo={t.edad} filas={fila("age", (b) => b)} />
          <Lista titulo={t.genero} filas={fila("gender", (b) => t.generos[genderCode(b)])} />
          <Lista titulo={t.pais} filas={fila("country", (b) => f.country(b))} />
        </div>
      )}
      {a.nonFollowers.length > 0 && (
        <div className="mt-6">
          <h3 className="text-xs font-medium text-fg-3">{t.noSeguidores}</h3>
          <p className="mb-2 text-xs text-fg-3">{t.noSeguidoresNota}</p>
          <ul className="flex flex-wrap gap-x-6 gap-y-2">
            {a.nonFollowers.map((n) => (
              <li key={n.platformId} className="flex items-center gap-2">
                <PlatformPill platformId={n.platformId} />
                <C id={n.claimId} cifras={cifras} lugar="no-seguidores" />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Seccion>
  );
}

// ---------------------------------------------------------------------
// Qué haces y cómo hablas
// ---------------------------------------------------------------------

export function Formatos({ perfil, cifras }: { perfil: PerfilComercial; cifras: Cifras }) {
  const t = MESSAGES.formatos;
  const fm = perfil.formats;
  const leidos = fm.captionsClaimId ? cifras[fm.captionsClaimId]?.valor : undefined;
  const cifra = (id: string) => <C id={id} cifras={cifras} lugar="formatos" />;
  return (
    <Seccion id="perfil-formatos" title={t.title} meta={leidos ? t.meta(leidos) : undefined}>
      {fm.pieces.length === 0 ? (
        <Vacio>{t.sinDatos}</Vacio>
      ) : (
        <div className="grid gap-6 sm:grid-cols-3">
          <Lista titulo={t.piezas} filas={fm.pieces.map((p) => ({ key: p.key, label: t.pieza[p.key], cifra: cifra(p.claimId) }))} />
          <Lista titulo={t.contenidos} filas={fm.contents.map((p) => ({ key: p.key, label: t.contenido[p.key], cifra: cifra(p.claimId) }))} />
          <Lista titulo={t.tono} filas={fm.tone.map((p) => ({ key: p.key, label: t.rasgo[p.key], cifra: cifra(p.claimId) }))} />
        </div>
      )}
    </Seccion>
  );
}

// ---------------------------------------------------------------------
// Con quién has trabajado · Cuánto cobras
// ---------------------------------------------------------------------

export function PruebaSocial({ perfil, cifras }: { perfil: PerfilComercial; cifras: Cifras }) {
  const t = MESSAGES.pruebaSocial;
  return (
    <Seccion id="perfil-prueba" title={t.title} meta={t.meta}>
      {perfil.socialProof.length === 0 ? (
        <Vacio>{t.sinDatos}</Vacio>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {perfil.socialProof.map((c) => (
            <li key={c.campaignId} className="p-3">
              <p className="text-sm">
                <span className="font-medium">{c.companyName}</span>
                <span className="text-fg-3"> · </span>
                <Link href={`/campanas/${c.campaignId}`} className="text-fg-2 hover:underline">
                  {c.name}
                </Link>
              </p>
              <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm text-fg-2">
                {c.claimIds.map((id) => (
                  <span key={id}>
                    <C id={id} cifras={cifras} lugar="prueba" /> {cifras[id] ? t.etiquetas[cifras[id].key] : ""}
                  </span>
                ))}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Seccion>
  );
}

export function Tarifas({ perfil, cifras }: { perfil: PerfilComercial; cifras: Cifras }) {
  const t = MESSAGES.tarifas;
  const lineas = perfil.rates?.lines ?? [];
  return (
    <Seccion id="perfil-tarifas" title={t.title} meta={<Link href="/cotizar" className="hover:underline">{t.verTarifario}</Link>}>
      {lineas.length === 0 ? (
        <Vacio>{t.sinDatos}</Vacio>
      ) : (
        <ul className="space-y-2 text-sm">
          {lineas.map((l) => (
            <li key={l.itemId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="flex min-w-0 items-center gap-2">
                {l.platformId && <PlatformPill platformId={l.platformId} />}
                <span className="min-w-0 break-words">{l.label}</span>
              </span>
              <span className="shrink-0">
                <C id={l.lowClaimId} cifras={cifras} lugar="tarifa" />
                {l.lowClaimId && l.highClaimId && <span className="text-fg-3"> {RANGE_DASH} </span>}
                <C id={l.highClaimId} cifras={cifras} lugar="tarifa" />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Seccion>
  );
}

// ---------------------------------------------------------------------
// De dónde sale cada cifra
// ---------------------------------------------------------------------

type GrupoFuente = keyof typeof MESSAGES.fuentes.grupos;

/** En qué grupo de «De dónde sale cada cifra» va una cifra, por su clave. */
function grupoDe(key: Claim["key"]): GrupoFuente {
  if (key.startsWith("audience.") || key === "non_followers") return "audiencia";
  if (key === "median") return "base";
  if (key.startsWith("format.") || key === "tone" || key === "captions_read") return "captions";
  return "porque";
}

/** Cuántos videos de un agregado se enlazan por fila; el resto se cuenta. */
const VIDEOS_POR_FILA = 5;

/**
 * La fila de origen de cada cifra que no tiene otra pantalla a la que ir
 * (línea base, demografía, alcance en no seguidores, los agregados de
 * captions y del porqué): qué es, cuánto, de qué tabla, red y fecha, y
 * los videos que la forman con su enlace. Es el «cada dato con su
 * fuente» del perfil de Stripe Atlas, legible: los nombres de tabla, de
 * columna y la fila quedan en el title de cada fila, para soporte.
 *
 * Plegado por defecto (Plegable): un media kit que se le enseña a una
 * marca no termina en una cola técnica. El enlace de una cifra
 * (#origen-<id>) lo abre al llegar y la fila se resalta.
 */
export function Fuentes({ perfil, cifras, f }: { perfil: PerfilComercial; cifras: Cifras; f: Formatter }) {
  const t = MESSAGES.fuentes;
  const aqui = perfil.claims.filter((c) => cifras[c.id]?.href === `#${origenId(c.id)}`);
  if (!aqui.length) return null;
  const posts = new Map(perfil.posts.map((p) => [p.postId, p]));
  const grupos = (Object.keys(t.grupos) as GrupoFuente[])
    .map((g) => ({ g, claims: aqui.filter((c) => grupoDe(c.key) === g) }))
    .filter((x) => x.claims.length > 0);
  return (
    <Seccion id="perfil-fuentes" title={t.title} meta={t.meta}>
      <Plegable resumen={t.ver(f.int(aqui.length))}>
        <div className="space-y-6">
          {grupos.map(({ g, claims }) => (
            <div key={g}>
              <h3 className="mb-1 text-xs font-medium text-fg-3">{t.grupos[g]}</h3>
              <ul className="divide-y divide-line text-sm">
                {claims.map((c) => {
                  const v = cifras[c.id]!;
                  const filas = (c.source.rows ?? []).map((id) => posts.get(id)).filter((p) => p !== undefined);
                  const fuera = (c.source.rows?.length ?? 0) - Math.min(filas.length, VIDEOS_POR_FILA);
                  return (
                    <li
                      key={c.id}
                      id={origenId(c.id)}
                      title={t.soporte(c.source.table, c.source.field, c.source.id)}
                      className="scroll-mt-24 px-2 py-2.5 target:rounded-md target:bg-accent-wash target:ring-1 target:ring-accent"
                    >
                      <p className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 text-fg-2">{v.que}</span>
                        <span className="shrink-0 font-medium tabular-nums text-fg">{v.valor}</span>
                      </p>
                      <p className="mt-0.5 text-xs text-fg-3">{v.origen}</p>
                      {filas.length > 0 && (
                        <p className="mt-1 text-xs leading-5 text-fg-3">
                          {t.videos}{" "}
                          {filas.slice(0, VIDEOS_POR_FILA).map((p, i) => (
                            <span key={p.postId}>
                              {i > 0 && ", "}
                              {p.url ? (
                                <a href={p.url} target="_blank" rel="noopener noreferrer" className="break-words text-fg-2 hover:underline">
                                  {p.title}
                                </a>
                              ) : (
                                <span className="break-words text-fg-2">{p.title}</span>
                              )}
                            </span>
                          ))}
                          {fuera > 0 && <> {t.yMas(f.int(fuera))}</>}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </Plegable>
    </Seccion>
  );
}
