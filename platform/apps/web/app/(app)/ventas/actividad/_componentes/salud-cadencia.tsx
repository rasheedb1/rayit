import type { SequenceHealth } from "@mc/db/queries/actividad";
import type { Column } from "@/components/ui/data-table";
import { Pill } from "@/components/ui/pill";
import { SALUD_PILL } from "../_lib/vista";
import { MESSAGES } from "../messages";

const E = MESSAGES.embudo;

/**
 * El semáforo de la salud de una cadencia (outbound_sequence_health), en
 * palabras y con su explicación al pasar el cursor y para el lector de
 * pantalla. Una cadencia que no está activa no tiene semáforo: su estado
 * ya lo dice la columna de al lado, así que va una raya.
 */
export function SaludCadencia({ salud }: { salud: SequenceHealth | undefined }) {
  if (!salud || salud.health === "inactive") {
    return (
      <span className="relative">
        <span aria-hidden="true" className="text-muted">—</span>
        <span className="sr-only">{E.saludAyuda.inactive}</span>
      </span>
    );
  }
  return (
    <span className="relative inline-flex" title={E.saludAyuda[salud.health]}>
      <Pill kind={SALUD_PILL[salud.health]}>{E.salud[salud.health]}</Pill>
      <span className="sr-only">{E.saludAyuda[salud.health]}</span>
    </span>
  );
}

/**
 * La columna «Salud» para la lista de /ventas/cadencias, montable con una
 * línea: la lista pide la salud de sus filas (listSequenceHealth, por id)
 * y añade `columnaSalud(salud)` a sus columnas. Lo mismo que el semáforo
 * del detalle de la cadencia (MetricasCadencia), con el mismo color.
 */
export function columnaSalud<Row extends { id: string }>(salud: ReadonlyMap<string, SequenceHealth>): Column<Row> {
  return { key: "salud", header: E.columnaSalud, render: (r) => <SaludCadencia salud={salud.get(r.id)} /> };
}
