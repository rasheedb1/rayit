/**
 * La siguiente acción de un negocio, lista para el componente que la
 * pinta y la edita (VEN-4): textos y fechas ya formateados en el servidor
 * con el formateador del espacio, y los valores de los campos (día y hora
 * en la zona del espacio) tal como los devolvió la base.
 *
 * Es de servidor y puro: el componente de cliente solo importa el tipo.
 */
import type { OwnerOption, PipelineDealRow } from "@mc/db/queries/ventas";
import { PITCH_DUE_HOUR } from "@mc/db/queries/ventas";
import type { LocalDates, NextActionRow } from "@mc/db/queries/ventas-ficha";
import type { PillKind } from "@/components/ui/pill";
import type { Formatter } from "@/lib/format";
import { pillForDue } from "../_lib/estado";
import { FICHA } from "../empresas/messages";

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
  ctx: Pick<SeguimientoContexto, "tomorrow" | "owners">,
  dealLabel: string,
): SiguienteAccionData {
  // Sin responsable de la acción se propone el del negocio, pero solo si
  // se puede elegir: uno que ya dejó el espacio no está en «Quién», el
  // Select caería en «Sin responsable» y guardar lo mandaría igual, para
  // fallar con «Elige a alguien de tu espacio» en un campo que no tocó.
  const propuesto =
    row.responsibleUserId ?? (row.ownerUserId && ctx.owners.some((o) => o.userId === row.ownerUserId) ? row.ownerUserId : null);
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
      responsibleUserId: propuesto ?? "",
    },
  };
}

/**
 * Las personas que se pueden elegir como responsables, más el responsable
 * de hoy si ya no está en el espacio: si no, el selector no lo mostraría,
 * caería en «Sin responsable» y guardar lo borraría sin avisar.
 * setNextAction lo acepta mientras no cambie (solo un responsable NUEVO
 * tiene que ser del espacio). Si la base no deja leer su nombre (RLS
 * esconde a quien ya no comparte espacio), la opción se ofrece igual,
 * con «Alguien que ya no está en el espacio».
 */
export function opcionesDeResponsable(owners: OwnerOption[], rows: NextActionRow[]): OwnerOption[] {
  const extra = new Map<string, string>();
  for (const r of rows) {
    if (r.responsibleUserId && !owners.some((o) => o.userId === r.responsibleUserId)) {
      extra.set(r.responsibleUserId, r.responsibleName ?? FICHA.siguiente.formerMember);
    }
  }
  return [...owners, ...[...extra].map(([userId, label]) => ({ userId, label }))];
}

/** El último contacto de un negocio abierto, ya escrito: «Último contacto: hace 3 días», con la fecha para el title. */
export interface UltimoContactoData {
  /** «Último contacto: hace 3 días», o «Sin contacto todavía». */
  text: string;
  /** Solo «hace 3 días» (o «Sin contacto todavía»): para la columna que ya se llama «Último contacto». */
  short: string;
  /** El instante, ISO en UTC, para <time dateTime>; null sin contacto. */
  iso: string | null;
  /** «20 sep», la fecha en la zona del espacio, para el title; null sin contacto. */
  date: string | null;
}

/**
 * «Hace cuántos días no le hablo»: la señal de que un negocio se enfría.
 * Los días los cuenta listPipeline en SQL, en la zona del espacio; aquí
 * solo se escriben con Intl. Un negocio cerrado no la lleva (null).
 */
export function ultimoContacto(d: Pick<PipelineDealRow, "isWon" | "isLost" | "lastContactAt" | "lastContactDays">, f: Formatter): UltimoContactoData | null {
  if (d.isWon || d.isLost) return null;
  const t = FICHA.ultimoContacto;
  if (!d.lastContactAt || d.lastContactDays === null) return { text: t.none, short: t.none, iso: null, date: null };
  const relativo = f.relativeDays(-d.lastContactDays);
  return { text: t.text(relativo), short: relativo, iso: d.lastContactAt, date: f.date(d.lastContactAt) };
}
