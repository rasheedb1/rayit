/**
 * Lo que la pantalla de actividad decide sin tocar la base: qué pestaña y
 * qué filtros pide la URL, qué color lleva cada estado, cómo se dice el
 * motivo de un mensaje y cómo se resume lo que hizo una acción en masa.
 * Puro, con pruebas (vista.test.ts).
 */
import { FAILURE_REASON_TEXTS, holdReasonText, noticeLang, type NoticeLang } from "@mc/core/outreach/messages";
import type { BulkReport, QueueBucket, TouchStatus } from "@mc/db/queries/actividad";
import type { PillKind } from "@/components/ui/pill";
import type { Formatter } from "@/lib/format";
import { IDIOMA_MENSAJES, MESSAGES, motivoTexto } from "../messages";

export const ACTIVIDAD_URL = "/ventas/actividad";

/** El color de cada estado. Lo que terminó bien, en verde; lo que espera a una persona, en ámbar; lo fallido, en rojo. */
export const ESTADO_PILL: Record<TouchStatus, PillKind> = {
  draft: "neutral",
  scheduled: "neutral",
  processing: "neutral",
  held: "warn",
  sent: "good",
  failed: "bad",
  skipped: "neutral",
  canceled: "neutral",
};

/** Una página que no es la primera: las filas después (siguiente) o antes (anterior) de un cursor. */
export interface Pagina {
  direction: "next" | "prev";
  token: string;
}

/** Lo que la URL puede pedir: la pestaña, los tres filtros y la página. */
export interface Filtros {
  vista: QueueBucket;
  cadencia: string | null;
  tipo: string | null;
  contacto: string | null;
  pagina?: Pagina | null;
}

/**
 * La forma de un cursor de @mc/db (listOutboundQueue): el instante en UTC
 * con microsegundos (o «infinity») y el id del toque, con el 0/1 de
 * «fallido primero» delante en la cola. Lo que no tiene esta forma no
 * llega a la base; la base, además, lo vuelve a validar por pestaña.
 */
const CURSOR_RE = /^(?:[01]_)?(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z|infinity)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Params = Record<string, string | string[] | undefined>;

const uno = (v: string | string[] | undefined): string | null => {
  const s = (Array.isArray(v) ? v[0] : v)?.trim();
  return s ? s : null;
};

/** Los filtros de la URL. Lo que no se reconoce se ignora: la base valida los ids y los tipos otra vez. */
export function filtrosDe(params: Params): Filtros {
  return {
    vista: uno(params.vista) === "historial" ? "history" : "queue",
    cadencia: uno(params.cadencia),
    tipo: uno(params.tipo),
    contacto: uno(params.contacto),
    pagina: paginaDe(uno(params.siguiente), uno(params.anterior)),
  };
}

function paginaDe(siguiente: string | null, anterior: string | null): Pagina | null {
  if (siguiente && CURSOR_RE.test(siguiente)) return { direction: "next", token: siguiente };
  if (anterior && CURSOR_RE.test(anterior)) return { direction: "prev", token: anterior };
  return null;
}

/** La URL de unos filtros, sin los vacíos: «/ventas/actividad?vista=historial&tipo=email&siguiente=…». */
export function hrefDe(f: Filtros): string {
  const q = new URLSearchParams();
  if (f.vista === "history") q.set("vista", "historial");
  if (f.cadencia) q.set("cadencia", f.cadencia);
  if (f.tipo) q.set("tipo", f.tipo);
  if (f.contacto) q.set("contacto", f.contacto);
  if (f.pagina) q.set(f.pagina.direction === "next" ? "siguiente" : "anterior", f.pagina.token);
  const s = q.toString();
  return s ? `${ACTIVIDAD_URL}?${s}` : ACTIVIDAD_URL;
}

/** ¿Hay algún filtro puesto (además de la pestaña)? */
export const hayFiltros = (f: Filtros): boolean => Boolean(f.cadencia || f.tipo || f.contacto);

const mayuscula = (s: string) => (s ? s[0]!.toLocaleUpperCase(IDIOMA_MENSAJES) + s.slice(1) : s);

/**
 * El motivo de un mensaje, en una frase que empieza en mayúscula, o null
 * si no tiene. Un retenido dice por qué espera (holdReasonText, lo mismo
 * que la ficha); un fallido, qué dijo el proveedor (FAILURE_REASON_TEXTS,
 * lo mismo que el aviso); un cancelado o saltado, por qué no salió.
 */
export function motivoDe(status: TouchStatus, reason: string | null, locale: string): string | null {
  if (!reason) return null;
  const lang: NoticeLang = noticeLang(locale);
  if (status === "held") return mayuscula(holdReasonText(lang, reason));
  const code = reason.split(":")[0]!;
  const proveedor = Object.hasOwn(FAILURE_REASON_TEXTS[lang], code) ? FAILURE_REASON_TEXTS[lang][code] : undefined;
  return mayuscula(motivoTexto(code) ?? proveedor ?? MESSAGES.motivoGenerico);
}

/** El código del motivo, para soporte: «código: account_auth». Va en el detalle que se despliega en la fila. */
export function codigoDeMotivo(reason: string | null): string | null {
  return reason ? MESSAGES.fila.detalle.codigo(reason) : null;
}

/**
 * El resumen de una acción en masa: cuántos se movieron y, de los que
 * no, cuántos por cada motivo («2 no se movieron: 1 · ya salió un paso
 * posterior, 1 · rebotó o pudo haber salido»).
 */
export function resumenDe<Code extends string>(
  report: BulkReport<Code>,
  hecho: (n: string, count: number) => string,
  motivos: Record<Code, string>,
  f: Pick<Formatter, "int">,
): string {
  const partes: string[] = [];
  if (report.done.length > 0) partes.push(hecho(f.int(report.done.length), report.done.length));
  if (report.skipped.length > 0) {
    const porMotivo = new Map<Code, number>();
    for (const s of report.skipped) porMotivo.set(s.code, (porMotivo.get(s.code) ?? 0) + 1);
    const detalle = [...porMotivo].map(([code, n]) => MESSAGES.resultado.conMotivo(f.int(n), motivos[code])).join(", ");
    partes.push(`${MESSAGES.resultado.saltados(f.int(report.skipped.length), report.skipped.length)} ${detalle}.`);
  }
  return partes.length > 0 ? partes.join(" ") : MESSAGES.resultado.ninguno;
}
