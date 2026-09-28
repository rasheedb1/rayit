import { MESSAGES } from "../_lib/messages";

const t = MESSAGES.configuracion;

/**
 * Esqueleto de la configuración mientras la base responde: los cuatro
 * bloques del formulario, con el mismo alto, para que una consulta lenta
 * no deje la pantalla en blanco ni dé un salto al llegar.
 */
export default function ConfiguracionLoading() {
  // Cuántos campos tiene cada bloque: porcentajes 4, moneda 1,
  // fiscales 5, cómo te pagan 3. Es el mismo reparto que form.tsx.
  const bloques = [4, 1, 5, 3];
  return (
    <div aria-busy="true" aria-label={t.cargando}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-16 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-7 w-3/4 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-4 w-full animate-pulse rounded-sm bg-hover" />
      </div>
      <div className="grid max-w-3xl gap-6">
        {bloques.map((campos, i) => (
          <section key={i} className="rounded-md border border-border p-4">
            <span className="block h-4 w-40 animate-pulse rounded-sm bg-hover" />
            <span className="mt-2 block h-3 w-2/3 animate-pulse rounded-sm bg-hover" />
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {Array.from({ length: campos }, (_, j) => (
                <div key={j}>
                  <span className="block h-3 w-24 animate-pulse rounded-sm bg-hover" />
                  <span className="mt-1.5 block h-9 w-full animate-pulse rounded-md bg-hover" />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
