/**
 * Una actividad de la línea de tiempo, lista para pintar: los textos, las
 * fechas y el autor ya resueltos en el servidor con el formateador del
 * espacio. La usan la primera página (la ficha) y las siguientes («Ver
 * más», por la acción verMasActividad), así que las dos se ven igual.
 *
 * Es de servidor y pura: el componente de cliente solo importa el tipo.
 */
import { LOST_REASONS, type LostReason } from "@mc/db/queries/ventas";
import { LOGGABLE_ACTIVITY_KINDS, type ActivityKind, type ActivityRow } from "@mc/db/queries/ventas-ficha";
import type { Formatter } from "@/lib/format";
import { dealLabel } from "@/lib/negocio";
import { lostReasonText } from "../../_lib/estado";
import { FICHA } from "../messages";

export interface ActividadVista {
  id: string;
  kind: ActivityKind;
  /** «Llamada», «Cambio de etapa»… */
  tipo: string;
  subject: string | null;
  /** Quién: la persona, «On Cue» en lo que deja el producto, o «Alguien del equipo». */
  author: string;
  /** El instante, ISO en UTC, para el dateTime de <time>. */
  occurredAt: string;
  /** «23 sep · 10:00 a. m.», o solo «22 sep» si se registró sin hora. */
  when: string;
  /** Negocio, con quién y cuánto duró, ya unidos por « · ». */
  detail: string | null;
  body: string | null;
  /** El motivo de una pérdida, en palabras. */
  reason: string | null;
}

function motivo(reason: string | null): string | null {
  return reason && (LOST_REASONS as readonly string[]).includes(reason) ? lostReasonText(reason as LostReason) : null;
}

const MANUALES = new Set<ActivityKind>(LOGGABLE_ACTIVITY_KINDS);

/**
 * Quién firma. Lo que se registra a mano (nota, llamada, correo,
 * reunión) lo escribió una persona aunque no se guardara quién (el modo
 * demo, una sesión sin usuario): «Alguien del equipo», nunca «On Cue».
 * Lo demás lo deja el producto.
 */
export function autorDeActividad(kind: ActivityKind, userName: string | null): string {
  if (userName) return userName;
  return MANUALES.has(kind) ? FICHA.actividad.unknownAuthor : FICHA.actividad.system;
}

export function vistaDeActividad(rows: ActivityRow[], companyName: string, f: Formatter): ActividadVista[] {
  const t = FICHA.actividad;
  return rows.map((a) => {
    const negocio = a.dealName ? dealLabel(companyName, a.dealName) : null;
    const detalle = [negocio, a.contactName ? t.with(a.contactName) : null, a.meta.durationMin ? t.minutes(a.meta.durationMin) : null].filter(
      (x): x is string => Boolean(x),
    );
    return {
      id: a.id,
      kind: a.kind,
      tipo: FICHA.tipos[a.kind] ?? a.kind,
      subject: a.subject,
      author: autorDeActividad(a.kind, a.userName),
      occurredAt: a.occurredAt,
      when: a.meta.timeUnknown ? f.date(a.occurredAt) : f.dateTimeShort(a.occurredAt),
      detail: detalle.length > 0 ? detalle.join(" · ") : null,
      body: a.body,
      reason: motivo(a.meta.lostReason),
    };
  });
}
