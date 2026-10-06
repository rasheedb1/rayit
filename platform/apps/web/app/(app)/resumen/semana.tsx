import { unstable_rethrow } from "next/navigation";
import type { ReactNode } from "react";
import { listWeeklyHighlights, type HighlightSeverity, type WeeklyHighlight } from "@mc/db/queries/resumen-semana";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill, type PillKind } from "@/components/ui/pill";
import { PLATFORM_LABEL, PlatformPill, isPlatformId } from "@/components/ui/platform-pill";
import { withWorkspace } from "@/lib/db";
import { formatterFor, type Formatter } from "@/lib/format";
import { permisosDeLaSesion } from "@/lib/permisos/sesion";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { entenderAviso } from "./actions";
import { MESSAGES } from "./messages";
import { BotonEntendido } from "./semana-entendido";
import { fuentesVisibles, hrefDeFila } from "./_lib/semana";

/**
 * «Lo que importa esta semana» (RES-3): el bloque de arriba de /resumen.
 *
 * Lee los avisos de los cuatro productores (@mc/db/queries/resumen-semana)
 * con las fuentes que la sesión puede ver: sin finanzas.factura.ver no
 * se piden las facturas, así que ni llegan al servidor de la página. El
 * orden, la mora, el saldo y el múltiplo vienen de SQL; aquí solo se
 * eligen las palabras y se formatean las cifras con el workspace.
 *
 * Una lista y no tarjetas (Linear Inbox, Vercel): cada fila dice qué
 * pasa, cuánto pesa y a dónde ir, y se despacha con «Entendido».
 */
export async function LoQueImporta() {
  try {
    const [permisos, ws] = await Promise.all([permisosDeLaSesion(), getCurrentWorkspace()]);
    const fuentes = fuentesVisibles(permisos);
    const filas = fuentes.length === 0 ? [] : await withWorkspace((tx) => listWeeklyHighlights(tx, fuentes));
    return <LoQueImportaLista filas={filas} f={formatterFor(ws)} />;
  } catch (err) {
    // Un redirect (sin sesión) o un 404 siguen su camino. Lo demás no tumba
    // el Resumen entero: el bloque lo dice y las cifras de abajo cargan.
    unstable_rethrow(err);
    console.error("[resumen] no se pudo cargar «Lo que importa esta semana»", err);
    return (
      <Marco>
        <p role="alert" className="rounded-md border border-line px-4 py-3 text-sm text-fg-2">
          {MESSAGES.semana.error}
        </p>
      </Marco>
    );
  }
}

const PILL: Readonly<Record<HighlightSeverity, PillKind>> = {
  critical: "bad",
  warning: "warn",
  info: "neutral",
  success: "good",
};

/** El nombre de la red para una frase; una red desconocida se dice tal cual. */
function red(platformId: string): string {
  return isPlatformId(platformId) ? PLATFORM_LABEL[platformId] : platformId;
}

/** Qué dice la fila y su línea de detalle, con las cifras ya formateadas. */
export function textoDeFila(fila: WeeklyHighlight, f: Formatter): { titulo: string; detalle: string } {
  const t = MESSAGES.semana;
  switch (fila.source) {
    case "connection": {
      const nombre = `${red(fila.platformId)}${fila.handle ? ` (${fila.handle})` : ""}`;
      return { titulo: t.connection[fila.status](nombre), detalle: fila.detail ?? t.connection.sinDetalle };
    }
    case "invoice":
      return {
        titulo: t.invoice.titulo(fila.invoiceNumber, fila.companyName),
        detalle: t.invoice.detalle(f.money(fila.outstanding, fila.currency, { mode: "full" }), f.relativeDays(-fila.daysOverdue)),
      };
    case "deal":
      return fila.dueState === "hoy"
        ? { titulo: t.deal.hoy(fila.nextAction), detalle: t.deal.detalleHoy(fila.companyName, fila.dealName) }
        : {
            titulo: t.deal.vencido(fila.nextAction),
            detalle: t.deal.detalleVencido(fila.companyName, fila.dealName, f.relativeDays(-fila.daysOverdue)),
          };
    case "outlier": {
      const video = fila.postTitle ?? t.outlier.sinTitulo;
      const corte = fila.ageHoursCut === null ? null : (t.outlier.corte[fila.ageHoursCut] ?? null);
      if (fila.viewsVsMedian === null) {
        return { titulo: t.outlier.sinMultiplo(video), detalle: t.outlier.sinMultiploDetalle };
      }
      const multiplo = f.multiple(Number(fila.viewsVsMedian));
      return {
        titulo: fila.tier === "breakout" ? t.outlier.breakout(video, multiplo) : t.outlier.titulo(video, multiplo),
        detalle: t.outlier.detalle(red(fila.platformId), corte),
      };
    }
  }
}

/** La lista ya leída: aparte de la consulta para poder probarla con filas de ejemplo. */
export function LoQueImportaLista({ filas, f }: { filas: readonly WeeklyHighlight[]; f: Formatter }) {
  const t = MESSAGES.semana;
  if (filas.length === 0) {
    return (
      <Marco>
        <EmptyState title={t.vacio.title} description={t.vacio.description} />
      </Marco>
    );
  }
  return (
    <Marco meta={t.pendientes(filas.length, f.int(filas.length))}>
      <ul className="divide-y divide-line rounded-md border border-line">
        {filas.map((fila) => (
          <Fila key={fila.id} fila={fila} f={f} />
        ))}
      </ul>
    </Marco>
  );
}

function Fila({ fila, f }: { fila: WeeklyHighlight; f: Formatter }) {
  const t = MESSAGES.semana;
  const { titulo, detalle } = textoDeFila(fila, f);
  const plataforma = fila.source === "connection" || fila.source === "outlier" ? fila.platformId : null;
  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Pill kind={PILL[fila.severity]}>{t.fuente[fila.source]}</Pill>
          {plataforma && <PlatformPill platformId={plataforma} />}
        </div>
        <p className="mt-1.5 text-sm font-medium text-ink [overflow-wrap:anywhere]">{titulo}</p>
        <p className="mt-0.5 text-xs text-fg-3 tabular-nums [overflow-wrap:anywhere]">{detalle}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button size="sm" href={hrefDeFila(fila)}>
          {t.ir[fila.source]}
        </Button>
        {fila.source === "outlier" && fila.postUrl && /^https:\/\//.test(fila.postUrl) && (
          <a
            href={fila.postUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-ink-2 underline-offset-2 hover:text-ink hover:underline"
          >
            {t.outlier.verVideo}
          </a>
        )}
        <form action={entenderAviso.bind(null, fila.id)}>
          <BotonEntendido label={t.entendido} ariaLabel={t.entendidoDe(titulo)} />
        </form>
      </div>
    </li>
  );
}

/** El esqueleto del bloque mientras llega: la misma caja, sin texto inventado. */
export function LoQueImportaEsqueleto() {
  return (
    <Marco>
      <div role="status" aria-label={MESSAGES.semana.cargando} className="divide-y divide-line rounded-md border border-line">
        {[0, 1].map((i) => (
          <div key={i} className="px-4 py-3">
            <div className="h-4 w-20 animate-pulse rounded-full bg-hover" />
            <div className="mt-2 h-4 w-3/4 animate-pulse rounded bg-hover" />
            <div className="mt-1.5 h-3 w-1/2 animate-pulse rounded bg-hover" />
          </div>
        ))}
      </div>
    </Marco>
  );
}

function Marco({ meta, children }: { meta?: string; children: ReactNode }) {
  const t = MESSAGES.semana;
  return (
    <section className="mb-8" aria-labelledby="lo-que-importa">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="lo-que-importa" className="text-sm font-semibold">
          {t.titulo}
        </h2>
        {meta && <span className="text-xs text-fg-3 tabular-nums">{meta}</span>}
      </div>
      <p className="mb-3 max-w-2xl text-xs text-fg-3">{t.descripcion}</p>
      {children}
    </section>
  );
}
