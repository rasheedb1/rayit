/**
 * Un freno en memoria para quien tantea enlaces del reporte público
 * (CAM-6): cuenta solo los FALLOS (slugs que no existen) por clave y
 * ventana fija, y dice si la clave ya se pasó del tope. A diferencia de
 * LimiteDeIntentos de Cotizar (que cuenta cada intento, porque cada
 * contraseña cuesta un scrypt), aquí mirar no gasta: la marca que
 * recarga su enlace bueno cien veces no se frena nunca.
 *
 * Es POR INSTANCIA y de mejor esfuerzo: en Vercel cada instancia
 * serverless tiene el suyo. La barrera de verdad es la entropía del slug
 * (≈128 bits, nuevoSlug de @mc/db/queries/cotizar), que no se enumera.
 */
export class FrenoDeFallos {
  readonly #cubetas = new Map<string, { fallos: number; hasta: number }>();
  readonly #tope: number;
  readonly #ventanaMs: number;
  readonly #ahora: () => number;

  constructor(tope: number, ventanaMs: number, ahora: () => number = Date.now) {
    this.#tope = tope;
    this.#ventanaMs = ventanaMs;
    this.#ahora = ahora;
  }

  /** true si la clave ya acumuló `tope` fallos en la ventana vigente. No cuenta nada. */
  agotado(clave: string): boolean {
    const c = this.#cubetas.get(clave);
    return c !== undefined && c.hasta > this.#ahora() && c.fallos >= this.#tope;
  }

  /** Anota un fallo de la clave. */
  fallo(clave: string): void {
    const ahora = this.#ahora();
    // Limpieza perezosa: que el mapa no crezca sin fin con claves viejas.
    if (this.#cubetas.size > 5_000) {
      for (const [k, c] of this.#cubetas) if (c.hasta <= ahora) this.#cubetas.delete(k);
    }
    const c = this.#cubetas.get(clave);
    if (!c || c.hasta <= ahora) this.#cubetas.set(clave, { fallos: 1, hasta: ahora + this.#ventanaMs });
    else c.fallos += 1;
  }
}
