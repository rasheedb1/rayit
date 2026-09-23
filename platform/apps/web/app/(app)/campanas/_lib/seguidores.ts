/**
 * Lo que enseña la sección «Seguidores de la marca» de la ficha (CAM-3),
 * como función pura: de la serie y el ritmo que da @mc/db (la aritmética
 * es de core, ritmoSeguidores) a textos, etiquetas y ventanas sombreadas.
 * Aquí no se calcula ninguna cifra: solo se decide qué frase va y dónde
 * cae cada ventana en el eje.
 */
import { addDays, BRAND_BASELINE_DAYS, isBrandNoDataReason } from "@mc/core";
import type { BrandFollowersAccount } from "@mc/db";
import type { ChartShade } from "@/components/ui/line-chart";
import type { PillKind } from "@/components/ui/pill";
import { isPlatformId, PLATFORM_LABEL } from "@/components/ui/platform-pill";
import type { SeriesColor } from "@/components/ui/chart-utils";
import type { Formatter } from "@/lib/format";
import { MESSAGES } from "./messages";

const t = MESSAGES.seguidores;

/**
 * Desde un ritmo de dos cifras el decimal no aporta: «×12», no «×12,0»;
 * por debajo, sí: «×1,4».
 */
const RATIO_SIN_DECIMAL_DESDE = 10;

export interface Ventanas {
  baselineFrom: string | null;
  startsOn: string | null;
  endsOn: string | null;
}

export interface CuentaVista {
  key: string;
  platformId: string;
  titulo: string;
  ariaLabel: string;
  /** Días con cifra desde brand_baseline_from, ya formateados para el eje. */
  labels: string[];
  data: number[];
  color: SeriesColor | undefined;
  shades: ChartShade[];
  pill: { kind: PillKind; text: string };
  /** «12,9 al día antes · 155 al día en campaña · 1.240 ganados»; null si no hay ninguna cifra. */
  resumen: string | null;
  /** Frases que explican una ausencia o una cifra orientativa. */
  notas: string[];
  asOf: { date: string; source: string } | null;
}

function redDe(platformId: string): string {
  return isPlatformId(platformId) ? PLATFORM_LABEL[platformId] : platformId;
}

/** El primer y el último índice de `days` dentro de [desde, hasta]; null si no cae ninguno. */
export function indicesEntre(days: readonly string[], desde: string, hasta: string | null): { from: number; to: number } | null {
  let from = -1;
  let to = -1;
  days.forEach((d, i) => {
    if (d >= desde && (hasta === null || d <= hasta)) {
      if (from === -1) from = i;
      to = i;
    }
  });
  return from === -1 ? null : { from, to };
}

export function vistaCuenta(a: BrandFollowersAccount, w: Ventanas, f: Formatter): CuentaVista {
  const red = redDe(a.platformId);
  // La curva empieza en brand_baseline_from; la lectura anterior solo es el ancla del cálculo.
  const puntos = a.series.filter((p): p is { day: string; followers: number } => p.followers !== null && (w.baselineFrom === null || p.day >= w.baselineFrom));
  const days = puntos.map((p) => p.day);

  const shades: ChartShade[] = [];
  if (w.startsOn) {
    const base = w.baselineFrom ? indicesEntre(days, w.baselineFrom, addDays(w.startsOn, -1)) : null;
    const camp = indicesEntre(days, w.startsOn, w.endsOn);
    // La línea base se sombrea hasta el primer día de campaña: las dos ventanas se tocan y no queda un hueco de un día.
    if (base) shades.push({ from: base.from, to: camp && camp.from === base.to + 1 ? camp.from : base.to, label: t.shadeBaseline, tone: "muted" });
    if (camp) shades.push({ ...camp, label: t.shadeCampaign, tone: "accent" });
  }

  const r = a.ritmo;
  const notas: string[] = [];
  let pill: CuentaVista["pill"];
  const razon = a.latest && a.latest.followers === null && isBrandNoDataReason(a.latest.source) ? a.latest.source : null;

  if (razon) {
    pill = { kind: "neutral", text: t.razonPill[razon] };
    notas.push(t.razon[razon](a.handle, red));
  } else if (a.latest === null) {
    pill = { kind: "neutral", text: t.pillSinLecturas };
    notas.push(t.sinLecturas(w.baselineFrom ? f.date(w.baselineFrom, "long") : null));
  } else if (r.ratio !== null) {
    const veces = f.number(r.ratio, r.ratio >= RATIO_SIN_DECIMAL_DESDE ? 0 : 1);
    pill = r.fiable ? { kind: "good", text: t.ritmo(veces) } : { kind: "warn", text: t.ritmoCorto(veces) };
  } else {
    pill = { kind: "neutral", text: t.pillSinRitmo };
  }

  // Las frases del ritmo solo tienen sentido con alguna cifra: sin ninguna, la razón (o «sin lecturas») lo dice todo.
  if (puntos.length > 0 && !r.fiable) {
    if (r.baselineRate === null) notas.push(t.sinLineaBase);
    else if (r.baselineDataFrom) notas.push(t.lineaBaseCorta(f.date(r.baselineDataFrom, "long"), r.diasDeLineaBase, BRAND_BASELINE_DAYS));
    if (r.campaignRate === null && !razon) notas.push(t.sinCampana);
  }

  const resumen = t.resumen(
    r.baselineRate === null ? null : f.number(r.baselineRate),
    r.campaignRate === null ? null : f.number(r.campaignRate),
    r.gained === null ? null : f.int(r.gained),
  );

  return {
    key: `${a.platformId}:${a.handle}`,
    platformId: a.platformId,
    titulo: t.cardTitle(red, a.handle),
    ariaLabel: t.ariaChart(red, a.handle),
    labels: days.map((d) => f.dayMonth(d)),
    data: puntos.map((p) => p.followers),
    color: isPlatformId(a.platformId) ? a.platformId : undefined,
    shades,
    pill,
    resumen: resumen || null,
    notas,
    asOf: a.dataAsOf ? { date: a.dataAsOf, source: t.fuente(red) } : null,
  };
}
