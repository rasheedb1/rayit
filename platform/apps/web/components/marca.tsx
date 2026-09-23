import Link from "next/link";
import { MESSAGES } from "@/lib/auth/messages";

/**
 * La marca de On Cue, en un solo sitio.
 *
 *   <Marca />          las pantallas sin marco (/login, /auth/confirm,
 *                      /auth/comprobar y /legal): el cuadrito con la
 *                      inicial y el nombre, encima del título.
 *   <Marca enMarco />  la barra lateral y la cabecera móvil del marco
 *                      (components/shell.tsx): más pequeña y con enlace a
 *                      la portada.
 *
 * Antes el marco tenía su propia `Brand` y estas pantallas otra copia:
 * dos marcas que podían desalinearse (la del marco decía «M» y
 * «MultiCampaign» cuando estas ya decían On Cue). El cambio en
 * shell.tsx, carpeta de Nicolás, es una línea y va a su visto bueno en
 * el PR de integración.
 */
export function Marca({ enMarco = false }: { enMarco?: boolean }) {
  const inicial = MESSAGES.marca.charAt(0);
  if (enMarco) {
    return (
      <Link href="/" className="inline-flex items-center gap-2.5 rounded-sm">
        <span
          className="grid h-6 w-6 place-items-center rounded-md bg-accent text-[11px] font-bold text-accent-ink"
          aria-hidden="true"
        >
          {inicial}
        </span>
        <span className="text-sm font-semibold tracking-tight">{MESSAGES.marca}</span>
      </Link>
    );
  }
  return (
    <div className="mb-8 flex items-center gap-2.5">
      <span
        className="grid h-7 w-7 place-items-center rounded-md bg-accent text-xs font-bold text-accent-ink"
        aria-hidden="true"
      >
        {inicial}
      </span>
      <span className="text-base font-semibold tracking-tight text-ink">{MESSAGES.marca}</span>
    </div>
  );
}
