import type { Metadata } from "next";
import Link from "next/link";
import { Marca } from "@/components/marca";
import { MESSAGES } from "@/lib/auth/messages";
import { correoDeSoporte } from "@/lib/soporte";

export const metadata: Metadata = { title: MESSAGES.legal.meta };

/**
 * La página a la que apunta el pie de /login. Vive FUERA del grupo
 * (app) y es pública: quien todavía no ha entrado tiene que poder leer
 * qué pasa con su correo ANTES de escribirlo, y una página dentro de
 * (app) lo mandaría a /login, que es de donde viene.
 *
 * Pendiente de redacción (CIM-9): dice que lo está, arriba y a la
 * vista. El texto vive en lib/auth/messages.ts y el correo de contacto
 * en SUPPORT_EMAIL.
 */
export default function LegalPage() {
  const t = MESSAGES.legal;
  const contacto = correoDeSoporte();

  return (
    <main className="mx-auto w-full max-w-xl px-4 py-12 md:py-20">
      <Marca />

      <h1 className="text-xl font-semibold tracking-tight text-ink">{t.titulo}</h1>
      <p className="mt-2 text-sm leading-5 text-ink-2">{t.descripcion}</p>
      <p className="mt-4 rounded-md border border-border bg-surface-2 px-3 py-2 text-xs leading-5 text-ink-2">{t.pendiente}</p>

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

      <section id="contacto" className="mt-10 scroll-mt-8">
        <h2 className="text-sm font-medium text-ink">{t.contacto.titulo}</h2>
        <p className="mt-3 text-sm leading-6 text-ink-2">
          {contacto ? (
            <>
              {t.contacto.conCorreo}{" "}
              <a href={`mailto:${contacto}`} className="break-all text-ink underline underline-offset-2">
                {contacto}
              </a>
              .
            </>
          ) : (
            t.contacto.sinCorreo
          )}
        </p>
      </section>

      <p className="mt-12 text-xs text-muted">
        <Link href="/login" className="underline underline-offset-4 hover:text-ink">
          {t.volver}
        </Link>
      </p>
    </main>
  );
}
