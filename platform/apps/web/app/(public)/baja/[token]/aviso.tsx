import type { ReactNode, Ref } from "react";

/**
 * Un estado de la página de baja: título, una frase y, si hace falta, una
 * acción. Después del clic recibe el foco por programa (tabIndex=-1) para
 * que un lector de pantalla lo anuncie (role=status); el anillo global de
 * :focus-visible (globals.css, fuera de toda capa: gana a las utilidades)
 * le dibujaba un recuadro como si fuera un campo. `outline-none!` sí gana,
 * como en el título de cada paso de Importar.
 */
export function Aviso({
  title,
  body,
  tono = "neutral",
  accion,
  ref,
}: {
  title: string;
  body: string;
  tono?: "good" | "neutral";
  accion?: ReactNode;
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div ref={ref} tabIndex={-1} role="status" className="outline-none!">
      <h1 className={`text-2xl font-semibold tracking-tight ${tono === "good" ? "text-good" : "text-ink"}`}>{title}</h1>
      <p className="mt-3 text-base leading-relaxed text-ink-2">{body}</p>
      {accion && <div className="mt-6">{accion}</div>}
    </div>
  );
}
