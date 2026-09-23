import type { ReactNode, Ref } from "react";

/** Un estado de la página de baja: título, una frase y, si hace falta, una acción. */
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
    <div ref={ref} tabIndex={-1} role="status" className="outline-none">
      <h1 className={`text-2xl font-semibold tracking-tight ${tono === "good" ? "text-good" : "text-ink"}`}>{title}</h1>
      <p className="mt-3 text-base leading-relaxed text-ink-2">{body}</p>
      {accion && <div className="mt-6">{accion}</div>}
    </div>
  );
}
