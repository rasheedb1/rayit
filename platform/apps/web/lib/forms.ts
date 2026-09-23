/**
 * Lo que comparten las Server Actions de los módulos: validación de ids,
 * la forma del estado que devuelven a useActionState y el primer error
 * por campo de zod.
 *
 * UUID_RE no se define aquí: la fuente es @mc/db, que ya la exporta
 * junto a isUuid y la usa para validar el workspace de cada
 * transacción. Llegó a haber TRES copias —esta, la de
 * lib/workspace/current.ts y la de finanzas/facturas/actions.ts— y tres
 * definiciones de lo mismo terminan divergiendo (una acepta mayúsculas,
 * otra no). Se reexporta para no tocar los seis usos de
 * campanas/[id]/actions.ts ni la importación desde "@/lib/forms".
 */
export { isUuid, UUID_RE } from "@mc/db";

/** Lo que devuelven las acciones con useActionState. */
export interface ActionState {
  /** Errores por campo, en español. */
  errors?: Record<string, string>;
  /** Error general (base de datos, regla de negocio). */
  message?: string;
  /** La última acción terminó bien; el formulario puede cerrarse. */
  ok?: boolean;
}

/** El primer mensaje de cada campo, en el orden en que zod los reporta. */
export function firstErrors(issues: { path: PropertyKey[]; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "form");
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

/**
 * Un monto como lo escribe un formulario: dígitos y, si hay, hasta dos
 * decimales con punto ("1500000", "1500000.50"). Vivía copiado en cada
 * módulo (Ventas, Cotizar, Finanzas); una sola definición no diverge.
 */
export const DECIMAL_RE = /^\d+(\.\d{1,2})?$/;

/**
 * El valor de texto de un campo del FormData, o "" si no vino o es un
 * archivo. Es lo que zod recibe: un campo vacío es "", no null.
 */
export function formField(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
}
