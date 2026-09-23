/**
 * Un límite de intentos en memoria, por clave y con ventana fija.
 *
 * Es un freno rápido, POR INSTANCIA y de mejor esfuerzo: corta a 5
 * intentos por minuto por enlace y por IP ANTES de correr scrypt, así
 * que quien insiste desde una máquina no gasta la CPU del servidor. No
 * es la barrera: vive en la memoria de cada proceso, en Vercel cada
 * instancia serverless tiene el suyo y lo pierde al enfriarse, así que
 * con N instancias calientes el techo real es 5 × N por minuto. La
 * barrera que no depende de en qué instancia caiga la petición está en
 * la base: public_media_kit() bloquea 15 minutos al ORIGEN que falla 10
 * veces, y al enlace entero si suma 50 fallos en una hora entre todos
 * los orígenes (migración 0030, cuya cabecera explica el compromiso que
 * queda y cómo lo ve y lo deshace el creador). El origen de la clave es
 * el mismo que el de la base: _lib/origen.ts.
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
