import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md py-24 text-center">
      <p className="font-mono text-xs text-fg-3">404</p>
      <h1 className="mt-2 text-xl font-semibold">Esta página no existe</h1>
      <p className="mt-2 text-sm text-fg-2">Puede ser un módulo de la fase 2, que todavía está apagado.</p>
      <Link href="/" className="mt-6 inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg">
        Volver al plan
      </Link>
    </div>
  );
}
