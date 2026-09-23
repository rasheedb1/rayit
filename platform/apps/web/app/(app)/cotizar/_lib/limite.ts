/**
 * Un límite de intentos en memoria, por clave y con ventana fija.
 *
 * Es la primera barrera contra probar contraseñas de un media kit sin
 * parar: corta a 5 intentos por minuto por enlace y por IP ANTES de
 * correr scrypt, así que tampoco sirve para gastar la CPU del servidor.
 * La barrera que no depende de en qué instancia caiga la petición está
 * en la base: public_media_kit() bloquea el enlace 15 minutos tras 10
 * fallos (migración 0026). Esta de aquí vive en la memoria de cada
 * instancia y se pierde al reiniciar, y está bien: es el freno rápido.
 * Por qué el bloqueo de la base es por enlace y no por IP (y por qué se
 * acepta que alguien con el enlace pueda dispararlo) está en la
 * cabecera de esa migración.
 */
export class LimiteDeIntentos {
  readonly #cubetas = new Map<string, { usados: number; hasta: number }>();
  readonly #maximo: number;
  readonly #ventanaMs: number;
  readonly #ahora: () => number;

  constructor(maximo: number, ventanaMs: number, ahora: () => number = Date.now) {
    this.#maximo = maximo;
    this.#ventanaMs = ventanaMs;
    this.#ahora = ahora;
  }

  /** true si la clave todavía puede intentar; cuenta el intento. */
  permitir(clave: string): boolean {
    const ahora = this.#ahora();
    // Limpieza perezosa: que el mapa no crezca sin fin con claves viejas.
    if (this.#cubetas.size > 5_000) {
      for (const [k, c] of this.#cubetas) if (c.hasta <= ahora) this.#cubetas.delete(k);
    }
    const cubeta = this.#cubetas.get(clave);
    if (!cubeta || cubeta.hasta <= ahora) {
      this.#cubetas.set(clave, { usados: 1, hasta: ahora + this.#ventanaMs });
      return true;
    }
    if (cubeta.usados >= this.#maximo) return false;
    cubeta.usados += 1;
    return true;
  }
}
