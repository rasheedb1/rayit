import type { Metadata } from "next";
import Link from "next/link";
import { MESSAGES } from "@/lib/auth/messages";

export const metadata: Metadata = { title: "Términos y privacidad" };

/**
 * La página a la que apunta el pie de /login. Vive FUERA del grupo
 * (app) y es pública: quien todavía no ha entrado tiene que poder leer
 * qué pasa con su correo ANTES de escribirlo, y una página dentro de
 * (app) lo mandaría a /login, que es de donde viene.
 *
 * El texto está en lib/auth/messages.ts, como el resto del módulo.
 */
export default function LegalPage() {
  const t = MESSAGES.legal;

  return (
    <main className="mx-auto w-full max-w-xl px-4 py-12 md:py-20">
      <div className="mb-8 flex items-center gap-2.5">
        <span
          className="grid h-7 w-7 place-items-center rounded-md bg-accent text-xs font-bold text-accent-ink"
          aria-hidden="true"
        >
          O
        </span>
        <span className="text-base font-semibold tracking-tight text-ink">{MESSAGES.marca}</span>
      </div>

      <h1 className="text-xl font-semibold tracking-tight text-ink">{t.titulo}</h1>
      <p className="mt-2 text-sm leading-5 text-ink-2">{t.descripcion}</p>

      {[t.terminos, t.privacidad].map((seccion) => (
        <section key={seccion.id} id={seccion.id} className="mt-10 scroll-mt-8">
          <h2 className="text-sm font-medium text-ink">{seccion.titulo}</h2>
          {seccion.parrafos.map((parrafo) => (
            <p key={parrafo} className="mt-3 text-sm leading-6 text-ink-2">
              {parrafo}
            </p>
          ))}
        </section>
      ))}

      <p className="mt-12 text-xs text-muted">
        <Link href="/login" className="underline underline-offset-4 hover:text-ink">
          {t.volver}
        </Link>
      </p>
    </main>
  );
}
