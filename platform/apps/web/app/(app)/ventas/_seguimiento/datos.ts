/**
 * La siguiente acción de un negocio, lista para el componente que la
 * pinta y la edita (VEN-4): textos y fechas ya formateados en el servidor
 * con el formateador del espacio, y los valores de los campos (día y hora
 * en la zona del espacio) tal como los devolvió la base.
 *
 * Es de servidor y puro: el componente de cliente solo importa el tipo.
 */
import type { OwnerOption } from "@mc/db/queries/ventas";
import { PITCH_DUE_HOUR } from "@mc/db/queries/ventas";
import type { LocalDates, NextActionRow } from "@mc/db/queries/ventas-ficha";
import type { PillKind } from "@/components/ui/pill";
import type { Formatter } from "@/lib/format";
import { pillForDue } from "../_lib/estado";

export interface SiguienteAccionData {
  dealId: string;
  /** Cómo se nombra el negocio en las etiquetas accesibles: «Café Alma · Renovación Q4». */
  dealLabel: string;
  action: string | null;
  /** «24 sep · 9:30 a. m.», en la zona del espacio; null sin fecha. */
  dueText: string | null;
  /** La pastilla del vencimiento; null si no hay acción. */
  due: { kind: PillKind; text: string } | null;
  responsibleName: string | null;
  /** Los valores con que abre el formulario. */
  form: {
    dueDate: string;
    dueTime: string;
    responsibleUserId: string;
  };
}

/**
 * Lo que el editor necesita del espacio, igual para todos los negocios de
 * la pantalla. Es getLocalDates (queries/ventas-ficha) más las personas.
 */
export interface SeguimientoContexto {
  owners: OwnerOption[];
  /** Hoy en la zona del espacio: el mínimo del campo de fecha. */
  today: string;
  /** Mañana: la fecha que se propone para una acción nueva o vencida. */
  tomorrow: string;
  /** La hora de ahora en la zona del espacio, «17:12», cuando se pintó la pantalla. */
  now: string;
  /** La próxima hora en punto, «18:00»: la que se propone para hoy si la de la acción ya pasó. */
  nextHour: string;
  /**
   * La zona en la que se guarda la hora escrita (la del espacio), por su
   * nombre en el idioma del espacio: «hora estándar de Colombia». El campo
   * «Hora» la dice, porque quien escribe puede estar en otra.
   */
  zoneName: string;
}

/**
 * El contexto del editor para una pantalla: las personas (más quien ya
 * es responsable y no está en el espacio) y el reloj del espacio, con su
 * zona nombrada con el formateador.
 */
export function contextoDeSeguimiento(owners: OwnerOption[], rows: NextActionRow[], dates: LocalDates, f: Formatter): SeguimientoContexto {
  return {
    owners: opcionesDeResponsable(owners, rows),
    today: dates.today,
    tomorrow: dates.tomorrow,
    now: dates.now,
    nextHour: dates.nextHour,
    zoneName: f.zoneName(dates.tz),
  };
}

/** La hora que se propone sin otra: la misma a la que vencen las acciones que pone el producto. */
export const HORA_POR_DEFECTO = `${String(PITCH_DUE_HOUR).padStart(2, "0")}:00`;

export function siguienteAccionData(
  row: NextActionRow,
  f: Formatter,
  ctx: Pick<SeguimientoContexto, "tomorrow">,
  dealLabel: string,
): SiguienteAccionData {
  return {
    dealId: row.dealId,
    dealLabel,
    action: row.action,
    dueText: row.dueAt ? `${f.date(row.dueAt)} · ${f.time(row.dueAt)}` : null,
    due: row.action ? pillForDue(row.dueState) : null,
    responsibleName: row.responsibleName,
    form: {
      // Una acción vencida se reprograma: el campo abre en mañana, no en un día que ya pasó.
      dueDate: row.dueDate && row.dueState !== "vencido" ? row.dueDate : ctx.tomorrow,
      dueTime: row.dueTime ?? HORA_POR_DEFECTO,
      responsibleUserId: row.responsibleUserId ?? row.ownerUserId ?? "",
    },
  };
}

/**
 * Las personas que se pueden elegir como responsables, más el responsable
 * de hoy si ya no está en el espacio (si no, el selector no lo mostraría
 * y guardar lo borraría sin avisar).
 */
export function opcionesDeResponsable(owners: OwnerOption[], rows: NextActionRow[]): OwnerOption[] {
  const extra = new Map<string, string>();
  for (const r of rows) {
    if (r.responsibleUserId && r.responsibleName && !owners.some((o) => o.userId === r.responsibleUserId)) {
      extra.set(r.responsibleUserId, r.responsibleName);
    }
  }
  return [...owners, ...[...extra].map(([userId, label]) => ({ userId, label }))];
}
