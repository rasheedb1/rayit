import { MESSAGES } from "../../_lib/messages";

/**
 * Esqueleto de Empresas: la cabecera y unas filas del tamaño de la tabla.
 * En el grupo `(lista)`, que no cambia la URL, para no envolver la ficha
 * /ventas/empresas/<id>: un esqueleto por encima de ella mandaba el 200
 * antes de que un id inexistente llegara a notFound().
 */
export default function EmpresasLoading() {
  return (
    <div aria-busy="true" aria-label={MESSAGES.loading.empresas}>
      <div className="mb-8 max-w-2xl">
        <span className="block h-3 w-16 animate-pulse rounded-sm bg-hover" />
        <span className="mt-3 block h-7 w-2/3 animate-pulse rounded-sm bg-hover" />
      </div>
      <span className="block h-9 w-full max-w-md animate-pulse rounded-md bg-hover" />
      <div className="mt-6 flex flex-col gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className="block h-10 w-full animate-pulse rounded-sm bg-hover" />
        ))}
      </div>
    </div>
  );
}
