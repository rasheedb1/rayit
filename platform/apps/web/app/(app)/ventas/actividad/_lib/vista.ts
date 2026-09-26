/**
 * Lo que la pantalla de actividad decide sin tocar la base: qué pestaña y
 * qué filtros pide la URL, qué color lleva cada estado, cómo se dice el
 * motivo de un mensaje y cómo se resume lo que hizo una acción en masa.
 * Puro, con pruebas (vista.test.ts).
 */
import { FAILURE_REASON_TEXTS, holdReasonText, noticeLang, parseHoldReason, type NoticeLang } from "@mc/core/outreach/messages";
import { isQueueCursorToken, type BulkReport, type QueueBucket, type SequenceHealthLevel, type TouchStatus } from "@mc/db/queries/actividad";
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

/** El color del semáforo de la salud de una cadencia: el embudo de su detalle y la columna de la lista de /ventas/cadencias. */
export const SALUD_PILL: Record<SequenceHealthLevel, PillKind> = { inactive: "neutral", failing: "bad", attention: "warn", healthy: "good" };

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

/**
 * La página que pide la URL, si su cursor es uno de @mc/db
 * (isQueueCursorToken: la misma regla con la que listOutboundQueue lo
 * lee, no una copia de su formato). Lo que no lo es no llega a la base;
 * la base, además, lo vuelve a validar por pestaña.
 */
function paginaDe(siguiente: string | null, anterior: string | null): Pagina | null {
  if (siguiente && isQueueCursorToken(siguiente)) return { direction: "next", token: siguiente };
  if (anterior && isQueueCursorToken(anterior)) return { direction: "prev", token: anterior };
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
 * El idioma de los motivos que vienen de @mc/core (la retención y el
 * fallo del proveedor): el del archivo de mensajes, no el locale del
 * espacio. Todo lo demás de la fila («Falló», «Paso 2 · Correo») sale de
 * messages.ts; si el motivo siguiera el locale del espacio, un espacio
 * en en-US leería la misma fila mitad en español y mitad en inglés. El
 * locale del espacio sigue mandando en las cifras y las fechas.
 */
const IDIOMA_MOTIVOS: NoticeLang = noticeLang(IDIOMA_MENSAJES);

/**
 * El motivo de un mensaje, en una frase que empieza en mayúscula, o null
 * si no tiene. Un retenido dice por qué espera (holdReasonText, lo mismo
 * que la ficha); un fallido, qué dijo el proveedor (FAILURE_REASON_TEXTS,
 * lo mismo que el aviso); un cancelado o saltado, por qué no salió.
 */
export function motivoDe(status: TouchStatus, reason: string | null): string | null {
  if (!reason) return null;
  const lang = IDIOMA_MOTIVOS;
  if (status === "held") return mayuscula(holdReasonText(lang, reason));
  const code = reason.split(":")[0]!;
  const proveedor = Object.hasOwn(FAILURE_REASON_TEXTS[lang], code) ? FAILURE_REASON_TEXTS[lang][code] : undefined;
  return mayuscula(motivoTexto(code) ?? proveedor ?? MESSAGES.motivoGenerico);
}

/** La forma de un código del motor: minúsculas y guiones bajos, con su dato opcional tras «:» («quality_low:7.6»). */
const CODIGO_RE = /^[a-z_]+(:.*)?$/s;

/**
 * El código del motivo, para soporte: «código: account_auth». Va en el
 * detalle que se despliega en la fila, y solo cuando `reason` ES un
 * código: una frase libre (un held_reason escrito a mano, o uno heredado
 * de antes de HOLD_CODES) ya se lee entera en la fila, y rotularla
 * «código:» la repetía con un nombre que no es. En lo retenido manda
 * parseHoldReason, la misma regla con la que holdReasonText decide si lo
 * traduce.
 */
export function codigoDeMotivo(status: TouchStatus, reason: string | null): string | null {
  if (!reason) return null;
  const esCodigo = status === "held" ? parseHoldReason(reason) !== null : CODIGO_RE.test(reason);
  return esCodigo ? MESSAGES.fila.detalle.codigo(reason) : null;
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
