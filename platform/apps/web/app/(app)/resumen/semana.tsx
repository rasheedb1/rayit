import { unstable_rethrow } from "next/navigation";
import { channelHealthName } from "@mc/core";
import {
  listWeeklyHighlights,
  MAX_HIGHLIGHTS,
  type HighlightSeverity,
  type WeeklyHighlight,
  type WeeklyHighlights,
} from "@mc/db/queries/resumen-semana";
import type { PillKind } from "@/components/ui/pill";
import { PLATFORM_LABEL, isPlatformId } from "@/components/ui/platform-pill";
import { withWorkspace } from "@/lib/db";
import { formatterFor, type Formatter } from "@/lib/format";
import { permisosDeLaSesion } from "@/lib/permisos/sesion";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { MESSAGES } from "./messages";
import { ListaSemana, type FilaVista } from "./semana-lista";
import { MarcoSemana } from "./semana-marco";
import { arroba, enlacesDeFila, FILAS_A_LA_VISTA, fuentesVisibles } from "./_lib/semana";

/**
 * «Lo que importa esta semana» (RES-3): el bloque de arriba de /resumen.
 *
 * Lee los avisos de los cinco productores (@mc/db/queries/resumen-semana)
 * con las fuentes que la sesión puede ver: sin finanzas.factura.ver no
 * se piden las facturas, así que ni llegan al servidor de la página. El
 * orden, la mora, el saldo y el múltiplo vienen de SQL; aquí solo se
 * eligen las palabras y se formatean las cifras con el workspace. Lo que
 * pasa después del clic (plegar, «Entendido», «Deshacer», el foco) es de
 * la lista del cliente, semana-lista.tsx.
 *
 * Una lista y no tarjetas (Linear Inbox, Vercel): cada fila dice qué
 * pasa, cuánto pesa y a dónde ir, y se despacha con «Entendido».
 */
export async function LoQueImporta() {
  try {
    const [permisos, ws] = await Promise.all([permisosDeLaSesion(), getCurrentWorkspace()]);
    const fuentes = fuentesVisibles(permisos);
    const leidas: WeeklyHighlights =
      fuentes.length === 0 ? { rows: [], more: false } : await withWorkspace((tx) => listWeeklyHighlights(tx, fuentes));
    return <LoQueImportaLista filas={leidas.rows} more={leidas.more} f={formatterFor(ws)} />;
  } catch (err) {
    // Un redirect (sin sesión) o un 404 siguen su camino. Lo demás no tumba
    // el Resumen entero: el bloque lo dice y las cifras de abajo cargan.
    unstable_rethrow(err);
    console.error("[resumen] no se pudo cargar «Lo que importa esta semana»", err);
    return (
      <MarcoSemana>
        <p role="alert" className="rounded-md border border-line px-4 py-3 text-sm text-fg-2">
          {MESSAGES.semana.error}
        </p>
      </MarcoSemana>
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
      // Como Conexiones y «Hasta cuándo llegan los datos»: la red y el @.
      const nombre = fila.handle ? `${red(fila.platformId)} ${arroba(fila.handle)}` : red(fila.platformId);
      return { titulo: t.connection[fila.status](nombre), detalle: fila.detail ?? t.connection.sinDetalle };
    }
    case "channel":
      return { titulo: t.channel[fila.status](channelHealthName(fila.channel), fila.displayName), detalle: t.channel.detalle };
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
      const laRed = red(fila.platformId);
      const corte = fila.ageHoursCut === null ? null : t.outlier.corte[fila.ageHoursCut];
      if (fila.viewsVsMedian === null) {
        return { titulo: t.outlier.sinMultiplo(fila.postTitle, laRed), detalle: t.outlier.sinMultiploDetalle };
      }
      const multiplo = f.multiple(Number(fila.viewsVsMedian));
      return {
        titulo:
          fila.tier === "breakout"
            ? t.outlier.breakout(fila.postTitle, laRed, multiplo)
            : t.outlier.titulo(fila.postTitle, laRed, multiplo),
        detalle: t.outlier.detalle(laRed, corte),
      };
    }
  }
}

/** La fila lista para pintar: palabras, cifras y enlaces, sin nada que formatear en el cliente. */
export function vistaDeFila(fila: WeeklyHighlight, f: Formatter): FilaVista {
  const { titulo, detalle } = textoDeFila(fila, f);
  const plataforma = fila.source === "connection" || fila.source === "outlier" ? fila.platformId : null;
  const { principal, secundario } = enlacesDeFila(fila, plataforma ? red(plataforma) : "");
  return {
    id: fila.id,
    fuente: MESSAGES.semana.fuente[fila.source],
    pill: PILL[fila.severity],
    plataforma,
    titulo,
    detalle,
    principal,
    secundario,
  };
}

/** La lista ya leída: aparte de la consulta para poder probarla con filas de ejemplo. */
export function LoQueImportaLista({ filas, more = false, f }: { filas: readonly WeeklyHighlight[]; more?: boolean; f: Formatter }) {
  // Los números del contador y de «Ver N más», formateados aquí con el locale del espacio.
  const numeros = Array.from({ length: Math.max(filas.length, MAX_HIGHLIGHTS) + 1 }, (_, i) => f.int(i));
  return <ListaSemana filas={filas.map((fila) => vistaDeFila(fila, f))} more={more} aLaVista={FILAS_A_LA_VISTA} numeros={numeros} />;
}

/** El esqueleto del bloque mientras llega: la misma caja, sin texto inventado. */
export function LoQueImportaEsqueleto() {
  return (
    <MarcoSemana>
      <div role="status" aria-label={MESSAGES.semana.cargando} className="divide-y divide-line rounded-md border border-line">
        {[0, 1].map((i) => (
          <div key={i} className="px-4 py-3">
            <div className="h-4 w-20 animate-pulse rounded-full bg-hover" />
            <div className="mt-2 h-4 w-3/4 animate-pulse rounded bg-hover" />
            <div className="mt-1.5 h-3 w-1/2 animate-pulse rounded bg-hover" />
          </div>
        ))}
      </div>
    </MarcoSemana>
  );
}
