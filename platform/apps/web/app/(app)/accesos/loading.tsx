import { MESSAGES } from "./_lib/messages";

/**
 * Esqueleto de Equipo mientras la base responde: el formulario de
 * invitar y la tabla de personas, con el alto de la pantalla real.
 *
 * Mismos tokens que page.tsx y que la tabla del kit (border-border, la
 * cabecera en bg-surface-2 y el pulso en bg-hover, como el esqueleto de
 * DataTable): al llegar los datos, el borde y el fondo no cambian.
 */
export default function AccesosLoading() {
  const t = MESSAGES.miembros.columnas;
  return (
    <div aria-busy="true" aria-label={MESSAGES.cargando}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-16 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-7 w-1/2 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-4 w-full animate-pulse rounded-sm bg-hover" />
      </div>
      <div className="mb-12 grid max-w-3xl gap-4 sm:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i}>
            <span className="block h-3 w-20 animate-pulse rounded-sm bg-hover" />
            <span className="mt-1.5 block h-9 w-full animate-pulse rounded-md bg-hover" />
          </div>
        ))}
      </div>
      <div className="max-w-3xl overflow-hidden rounded-md border border-border">
        <div className="flex gap-6 border-b border-border bg-surface-2 px-2.5 py-2 text-xs font-medium text-muted" aria-hidden="true">
          <span className="flex-1">{t.persona}</span>
          <span className="w-24 sm:w-40">{t.rol}</span>
        </div>
        {/* Las dos columnas de la tabla real: la persona (nombre, correo y
            «Desde el …», y debajo sus acciones) y el rol. */}
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex gap-6 border-b border-border px-2.5 py-3 last:border-b-0">
            <span className="min-w-0 flex-1">
              <span className="block h-4 w-40 max-w-full animate-pulse rounded-sm bg-hover" />
              <span className="mt-2 block h-3 w-56 max-w-full animate-pulse rounded-sm bg-hover" />
              <span className="mt-3 block h-7 w-36 max-w-full animate-pulse rounded-md bg-hover" />
            </span>
            <span className="w-24 sm:w-40">
              <span className="block h-4 w-20 max-w-full animate-pulse rounded-sm bg-hover" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
