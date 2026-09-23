import type { Metadata } from "next";
import Link from "next/link";
import { Marca } from "@/components/marca";
import { esTipoDeCorreo } from "@/lib/auth/entrada";
import { MESSAGES } from "@/lib/auth/messages";
import { destinoSeguro } from "@/lib/auth/rutas";
import { confirmarEntrada } from "./acciones";
import { BotonEntrar } from "./boton";

export const metadata: Metadata = {
  title: MESSAGES.confirmar.meta,
  // Una URL con un token de un solo uso no pinta nada en un buscador.
  robots: { index: false, follow: false },
};

type Props = { searchParams: Promise<{ token_hash?: string; type?: string; next?: string }> };

/**
 * La parada de un clic entre el correo y la sesión (ronda 4).
 *
 * Cargar esta página NO canjea nada: solo pinta un botón. El canje va
 * por POST en `confirmarEntrada` (./acciones.ts), porque los escáneres
 * de enlaces del correo corporativo abren con un GET todo lo que llega
 * y gastaban el token de un solo uso antes que la persona. Llega aquí
 * directamente con la plantilla del README, o reenviada desde
 * /auth/callback si la plantilla todavía apunta allí.
 *
 * Misma forma que /login —marca arriba, una sola decisión— porque es su
 * segunda mitad. Es pública (lib/auth/rutas.ts, prefijo /auth).
 */
export default async function ConfirmarPage({ searchParams }: Props) {
  const { token_hash: tokenHash, type: tipo, next } = await searchParams;
  const t = MESSAGES.confirmar;
  const valido = Boolean(tokenHash) && esTipoDeCorreo(tipo);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-4 py-12">
      <Marca />

      <h1 className="text-xl font-semibold tracking-tight text-ink">{t.titulo}</h1>

      {valido ? (
        <>
          <p className="mt-2 mb-8 text-sm leading-5 text-ink-2">{t.descripcion}</p>
          <form action={confirmarEntrada}>
            <input type="hidden" name="token_hash" value={tokenHash} />
            <input type="hidden" name="type" value={tipo} />
            <input type="hidden" name="next" value={destinoSeguro(next)} />
            <BotonEntrar />
          </form>
        </>
      ) : (
        <>
          <p role="alert" className="mt-4 mb-8 rounded-md border border-bad/40 bg-bad-wash px-3 py-2 text-sm text-bad">
            {t.invalido}
          </p>
          <Link href="/login" className="text-sm font-medium text-ink underline underline-offset-4">
            {t.pedirOtro}
          </Link>
        </>
      )}
    </main>
  );
}
