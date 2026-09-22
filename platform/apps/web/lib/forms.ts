/**
 * Lo que comparten las Server Actions de los módulos: validación de ids,
 * la forma del estado que devuelven a useActionState y el primer error
 * por campo de zod. Finanzas (FIN-1) trae sus copias; se unifican aquí
 * desde CAM-1 y Finanzas migra en su próxima historia.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
