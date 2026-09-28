import { cutOf, genderCode, type Claim } from "@mc/core/outreach/perfil";
import { PLATFORM_LABEL } from "@/components/ui/platform-pill";
import type { Formatter } from "@/lib/format";
import { MESSAGES } from "./messages";

/**
 * Cómo se escribe, qué es y adónde lleva cada cifra del perfil. Se
 * resuelve en el servidor, con el formateador y el locale del workspace,
 * y viaja al cliente como datos planos (CifraVista): un componente de
 * cliente no recibe funciones. El texto sale de messages.ts a partir de
 * la clave y los parámetros del claim; @mc/core no escribe nada.
 */
export interface CifraVista {
  id: string;
  /** La clave del claim (campaign.views, median…): para rotular sin leer el id. */
  key: Claim["key"];
  /** La cifra escrita con Intl y el locale, la moneda y la zona del workspace. */
  valor: string;
  /** Qué es («Visualizaciones medianas por video en TikTok, a los 7 días de publicado»). */
  que: string;
  /** De dónde sale: tabla, red y fecha de la lectura («Demografía de la cuenta · TikTok · al 24 de septiembre de 2026»). */
  origen: string;
  href: string;
  /** true si el enlace sale de On Cue (el post en su red). */
  externo: boolean;
  /**
   * Solo las de campaña: la marca y la fecha del reporte del que salen
   * (campaign_result.computed_at), ya escrita. Campañas enseña las views
   * de hoy; aquí se dice de cuándo es cada cifra (pulido r3).
   */
  corte?: { marca: string; fecha: string } | null;
}

/** Desde aquí un conteo se abrevia («412 mil»): por debajo se lee entero. */
const COMPACTO_DESDE = 10_000;

/** La cifra escrita. Nunca a mano: todo pasa por lib/format.ts. */
export function formatClaim(c: Claim, f: Formatter): string {
  const n = typeof c.value === "number" ? c.value : Number(c.value);
  switch (c.kind) {
    case "count":
      return n >= COMPACTO_DESDE ? f.compact(n) : f.int(n);
    case "share":
      return f.pct(n, 0);
    case "multiple":
      // Siempre con un decimal: «1,2× frente a 1,0×» se lee parejo.
      return f.multiple(n, 1, 1);
    case "money":
      return f.money(String(c.value), c.unit, { mode: "short" });
    case "duration":
      return MESSAGES.unidades.segundos(f.int(Math.round(n)));
  }
}

/** El corte de una cifra dicho en palabras, con la unidad que decide core. */
export function corteTexto(hours: number, f: Formatter): string {
  const c = cutOf(hours);
  return MESSAGES.cifra.corte(c, f.int(c.amount));
}

/** Qué es una cifra, en la voz de la pantalla y con el locale del workspace. */
export function claimQue(c: Claim, f: Formatter): string {
  const q = MESSAGES.cifra.que;
  const p = c.params;
  const red = p.platform ? PLATFORM_LABEL[p.platform] : "";
  const corte = p.cutHours !== undefined ? corteTexto(p.cutHours, f) : "";
  switch (c.key) {
    case "followers": return q.followers(red);
    case "audience.age": return q.audienceAge(red, p.bucket ?? "");
    case "audience.gender": return q.audienceGender(red, genderCode(p.bucket ?? ""));
    case "audience.country": return q.audienceCountry(red, f.country(p.bucket ?? ""));
    case "non_followers": return q.nonFollowers(red);
    case "median": return q.median(red, corte);
    case "scored_videos": return q.scoredVideos;
    case "video.multiple": return q.videoMultiple(p.title ?? "", red, corte);
    case "video.views": return q.videoViews(p.title ?? "", red, corte);
    case "video.duration": return q.videoDuration(p.title ?? "");
    case "why.group": return q.whyGroup(p.axis!, p.group ?? "", p.title ?? "");
    case "why.rest": return q.whyRest(p.axis!, p.group ?? "");
    case "format.piece": return q.formatPiece(p.piece!);
    case "format.content": return q.formatContent(p.content!);
    case "tone": return q.tone(p.trait!);
    case "captions_read": return q.captionsRead;
    case "campaign.views": return q.campaignViews(p.company ?? "");
    case "campaign.multiple": return q.campaignMultiple(p.company ?? "");
    case "campaign.brand_followers": return q.campaignBrandFollowers(p.company ?? "");
    case "campaign.redemptions": return q.campaignRedemptions(p.company ?? "");
    case "campaign.revenue": return q.campaignRevenue(p.company ?? "");
    case "rate.low": return q.rateLow(p.item ?? "");
    case "rate.high": return q.rateHigh(p.item ?? "");
  }
}

/** El id del elemento de «De dónde sale cada cifra» que sostiene una cifra agregada. */
export function origenId(claimId: string): string {
  return `origen-${claimId}`;
}

/**
 * Adónde lleva una cifra:
 *   · un video → el post en su red;
 *   · una campaña → su ficha en Campañas; una tarifa → el tarifario;
 *   · los seguidores → su serie en Resumen, filtrada a la red (#seguidores);
 *   · lo demás (línea base, demografía, alcance en no seguidores, los
 *     agregados de captions y del porqué) → su fila en «De dónde sale
 *     cada cifra», al final de esta misma página, con tabla, red, fecha
 *     y cuántas publicaciones la forman. Ninguna otra pantalla enseña
 *     esas filas: Resumen no tiene demografía ni líneas base.
 */
export function claimHref(c: Claim): { href: string; externo: boolean } {
  const s = c.source;
  switch (s.table) {
    case "post":
    case "post_score":
      if (s.url && !s.rows) return { href: s.url, externo: true };
      break;
    case "campaign_result":
      return { href: `/campanas/${s.id}`, externo: false };
    case "rate_card_item":
      return { href: "/cotizar", externo: false };
    case "account_metric_snapshot":
      if (c.params.platform) return { href: `/resumen?red=${c.params.platform}#seguidores`, externo: false };
      break;
    default:
      break;
  }
  return { href: `#${origenId(c.id)}`, externo: false };
}

/** De dónde sale: la tabla, la red, la fecha de la lectura y, si es un agregado, cuántas filas. */
export function claimOrigin(c: Claim, f: Formatter): string {
  const t = MESSAGES.cifra;
  const partes: string[] = [t.tablas[c.source.table]];
  if (c.params.platform) partes.push(PLATFORM_LABEL[c.params.platform]);
  if (c.source.asOf) partes.push(t.fecha(f.date(c.source.asOf, "long")));
  const filas = c.source.rows?.length;
  if (filas) partes.push(t.filas(filas, f.int(filas)));
  return partes.join(" · ");
}

export function cifraVista(c: Claim, f: Formatter): CifraVista {
  const destino = claimHref(c);
  return {
    id: c.id,
    key: c.key,
    valor: formatClaim(c, f),
    que: claimQue(c, f),
    origen: claimOrigin(c, f),
    href: destino.href,
    externo: destino.externo,
    corte:
      c.source.table === "campaign_result" && c.source.asOf
        ? { marca: c.params.company ?? "", fecha: f.date(c.source.asOf) }
        : null,
  };
}

/** Todas las cifras del perfil, por id: lo que la pantalla y la narrativa necesitan. */
export function cifrasVista(claims: readonly Claim[], f: Formatter): Record<string, CifraVista> {
  return Object.fromEntries(claims.map((c) => [c.id, cifraVista(c, f)]));
}
