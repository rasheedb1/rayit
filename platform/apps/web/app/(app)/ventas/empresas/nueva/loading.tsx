import { MESSAGES } from "../../_lib/messages";

/**
 * «Nueva empresa» mientras carga. Aquí sí vale un loading.tsx: la ruta
 * no lee ninguna fila ni puede ser un 404, así que no hay respuesta que
 * adelantar (la ficha /ventas/empresas/<id> es hermana y no la envuelve).
 */
export default function NuevaEmpresaLoading() {
  return (
    <div aria-busy="true" aria-label={MESSAGES.loading.nueva}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-16 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-7 w-1/2 animate-pulse rounded-sm bg-hover" />
      </div>
      <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className={`block h-14 animate-pulse rounded-md bg-hover ${i < 2 ? "sm:col-span-2" : ""}`} />
        ))}
      </div>
    </div>
  );
}
