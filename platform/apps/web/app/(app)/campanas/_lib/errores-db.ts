/**
 * ¿El error dice que la base todavía no deja a mc_app escribir la tabla?
 * Es el 42501 de «permission denied for table …»: una base sin la
 * migración 0041 (campaign_result), donde la ficha tampoco enseña el botón.
 *
 * Una violación de RLS («new row violates row-level security policy …»)
 * comparte el código 42501 pero NO es eso: el GRANT está y el botón se ve.
 * Esa va por el camino genérico, que la deja en el log del servidor en vez
 * de decir «todavía no se puede» (hallazgo de /code-review del cierre).
 */
export function isGrantMissing(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err) || err.code !== "42501") return false;
  const message = "message" in err && typeof err.message === "string" ? err.message : "";
  return /permission denied/i.test(message) && !/row-level security/i.test(message);
}
