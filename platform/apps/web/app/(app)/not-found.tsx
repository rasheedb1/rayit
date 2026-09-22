import Link from "next/link";

/**
 * El 404 de dentro del producto: lo que ve quien abre una cotización o
 * una campaña que no existe. Va aquí, y no solo en app/not-found.tsx,
 * para que conserve la navegación del marco ahora que el Shell se monta
 * en (app)/layout.tsx.
 */
export default function AppNotFound() {
  return (
    <div className="mx-auto max-w-md py-24 text-center">
      <p className="font-mono text-xs text-fg-3">404</p>
      <h1 className="mt-2 text-xl font-semibold">Esto no existe</h1>
      <p className="mt-2 text-sm text-fg-2">
        Puede que lo hayas borrado, que el enlace esté mal copiado, o que sea de otro espacio de trabajo.
      </p>
      <Link
        href="/"
        className="mt-6 inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg"
      >
        Volver al plan
      </Link>
    </div>
  );
}
