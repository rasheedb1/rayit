import { MESSAGES } from "@/lib/auth/messages";

/**
 * La marca de las pantallas sin marco: /login, /auth/confirm y /legal.
 * Antes el cuadrito con la «O» y el nombre estaban copiados en cada una.
 *
 * El marco de la aplicación (components/shell.tsx, carpeta de Nicolás)
 * tiene su propia `Brand`, más pequeña y con enlace a la portada; no se
 * ha tocado. Pasarla a este componente es una línea, pendiente de su
 * visto bueno (ver la nota de CIM-3 en content/backlog.ts).
 */
export function Marca() {
  return (
    <div className="mb-8 flex items-center gap-2.5">
      <span
        className="grid h-7 w-7 place-items-center rounded-md bg-accent text-xs font-bold text-accent-ink"
        aria-hidden="true"
      >
        {MESSAGES.marca.charAt(0)}
      </span>
      <span className="text-base font-semibold tracking-tight text-ink">{MESSAGES.marca}</span>
    </div>
  );
}
