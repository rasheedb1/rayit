import type { AccountAudience, AudienceDimension } from "@mc/db";
import { genderCode } from "@mc/core/outreach/perfil";
import { BarChart } from "@/components/ui/bar-chart";
import { DataAsOf } from "@/components/ui/data-as-of";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionTitle } from "@/components/page-header";
import type { Formatter } from "@/lib/format";
import { MESSAGES } from "../_lib/messages";

const t = MESSAGES.ficha.audiencia;

/** Cuántas barras caben con nombre legible: el resto se cuenta en una frase. */
const MAX_BARRAS = 10;

/**
 * El nombre de un tramo tal como lo lee una persona: la edad y los
 * tramos de la red van tal cual, el género por su palabra, el país por
 * su nombre en el idioma del workspace, la ciudad sin la región cuando
 * la red la pega con coma («Bogotá, Distrito Especial» → «Bogotá»).
 */
export function etiquetaDeTramo(dimension: AudienceDimension["dimension"], bucket: string, f: Formatter): string {
  switch (dimension) {
    case "gender":
      return t.generos[genderCode(bucket)] ?? bucket;
    case "country":
      return f.country(bucket);
    case "city":
      return bucket.split(",")[0]?.trim() || bucket;
    case "age_gender": {
      const [edad, genero] = bucket.split("|");
      return genero ? `${edad} · ${t.generos[genderCode(genero)] ?? genero}` : bucket;
    }
    default:
      return bucket;
  }
}

/**
 * Una dimensión como la pinta el kit: las barras con lo que dio la red
 * (personas, o el porcentaje si solo dio porcentajes) y, cuando hay
 * más tramos de los que caben, cuántos quedaron fuera.
 */
export function barrasDe(dim: AudienceDimension, f: Formatter): { cats: string[]; data: number[]; format: "int" | "pct"; fuera: number } {
  const enPersonas = dim.buckets.some((b) => b.absolute !== null);
  const visibles = dim.buckets.slice(0, MAX_BARRAS);
  return {
    cats: visibles.map((b) => etiquetaDeTramo(dim.dimension, b.bucket, f)),
    data: visibles.map((b) => (enPersonas ? (b.absolute ?? 0) : (b.share ?? 0))),
    format: enPersonas ? "int" : "pct",
    fuera: Math.max(0, dim.buckets.length - visibles.length),
  };
}

function Dimension({ dim, f }: { dim: AudienceDimension; f: Formatter }) {
  const nombre = t.dimensiones[dim.dimension] ?? dim.dimension;
  const poblacion = t.poblaciones[dim.population] ?? dim.population;
  const barras = barrasDe(dim, f);
  const total = dim.buckets.reduce((acc, b) => acc + (b.absolute ?? 0), 0);
  return (
    <section aria-labelledby={`aud-${dim.population}-${dim.dimension}`} className="min-w-0 rounded-md border border-border bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={`aud-${dim.population}-${dim.dimension}`} className="text-sm font-medium text-ink">
          {nombre} <span className="font-normal text-muted">· {poblacion}</span>
        </h3>
        <span className="text-xs text-muted">
          {barras.format === "int" && total > 0 && <span>{t.personas(f.int(total))} · </span>}
          <DataAsOf date={dim.day} opts={{ locale: f.locale, timeZone: f.timeZone }} className="inline" />
        </span>
      </div>
      <BarChart
        cats={barras.cats}
        series={[{ name: poblacion, data: barras.data, color: "accent" }]}
        mode="group"
        showTotal={false}
        format={barras.format}
        axisFormat={barras.format === "int" ? "compact" : "pct"}
        ariaLabel={t.aria(nombre)}
        height={220}
      />
      {barras.fuera > 0 && <p className="mt-2 text-xs text-muted">{t.masDe(barras.fuera)}</p>}
    </section>
  );
}

/** El orden en que se leen: quién (edad, género), dónde (país, ciudad) y después lo demás. */
const ORDEN: Record<string, number> = { age: 0, gender: 1, age_gender: 2, country: 3, city: 4 };

export function Audiencia({ audiencia, autorizada, f }: { audiencia: AccountAudience; autorizada: boolean; f: Formatter }) {
  const dims = [...audiencia.dimensions].sort((a, b) => (ORDEN[a.dimension] ?? 9) - (ORDEN[b.dimension] ?? 9) || a.population.localeCompare(b.population));
  return (
    <section aria-labelledby="audiencia" className="mt-10">
      <SectionTitle meta={audiencia.day ? t.subtitulo(f.date(audiencia.day)) : undefined}>
        <span id="audiencia">{t.titulo}</span>
      </SectionTitle>
      {audiencia.gaps.length > 0 && (
        <ul className="mb-4 space-y-1 text-sm text-ink-2">
          {audiencia.gaps.map((g) => (
            <li key={`${g.metricGroup}-${g.requirementId}`}>
              {g.messageEs}
              {g.fixUrl && (
                <>
                  {" "}
                  <a href={g.fixUrl} target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-2">
                    {MESSAGES.tabla.comoArreglarlo}
                  </a>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {dims.length === 0 ? (
        <EmptyState title={t.vacio} description={autorizada ? t.vacioAutorizada : t.vacioPorArroba} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {dims.map((d) => (
            <Dimension key={`${d.population}-${d.dimension}`} dim={d} f={f} />
          ))}
        </div>
      )}
    </section>
  );
}
