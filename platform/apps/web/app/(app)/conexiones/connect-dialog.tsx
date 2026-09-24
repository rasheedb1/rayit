"use client";

import { useId, useRef } from "react";
import { Button } from "@/components/ui/button";

export type ConnectDialogProps = {
  /** «TikTok», «Instagram»… */
  label: string;
  /** El texto de consentimiento tal cual se guarda en evidence.textShown. */
  text: string;
  policyVersion: string;
  /** POST a /conexiones/oauth/<proveedor>/start. */
  action: string;
  variant?: "primary" | "secondary" | "danger";
  size?: "sm" | "md";
  /** Texto del botón; por defecto «Conectar {label}». */
  actionLabel?: string;
  ariaLabel?: string;
  /** Título del diálogo; por defecto «Conectar {label}». Reautorizar no es conectar. */
  title?: string;
};

/**
 * Diálogo de consentimiento: texto, versión de la política y casilla
 * obligatoria. Aceptar envía un formulario POST (no un enlace) para que
 * el inicio del flujo lleve evidencia. <dialog> nativo: foco atrapado y
 * Escape cierran solos.
 *
 * CON-4 le añadió `variant="danger"` y `title`: el mismo diálogo y la
 * MISMA ruta `start` sirven para «Reautorizar» una cuenta cuyo permiso
 * caducó, porque el callback reactiva la fila por su clave natural en
 * vez de crear otra. Lo único que cambia es lo que se lee y el tono.
 * Ya no tiene estado deshabilitado (cierre CON-C): una red sin sus
 * variables no monta el diálogo y la pantalla lo dice con una frase.
 */
export function ConnectDialog({ label, text, policyVersion, action, variant = "primary", size = "md", actionLabel, ariaLabel, title }: ConnectDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  const encabezado = title ?? `Conectar ${label}`;
  return (
    <>
      <Button variant={variant} size={size} onClick={() => ref.current?.showModal()} aria-label={ariaLabel}>
        {actionLabel ?? `Conectar ${label}`}
      </Button>
      <dialog
        ref={ref}
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-md border border-border bg-surface p-0 text-ink shadow-lg backdrop:bg-black/40"
      >
        <form method="post" action={action} className="flex flex-col gap-4 p-6">
          <h2 id={titleId} className="text-base font-semibold">
            {encabezado}
          </h2>
          <p id={descId} className="text-sm leading-6 text-ink-2">
            {text}
          </p>
          <p className="text-xs text-muted">Política de tratamiento de datos, versión {policyVersion}.</p>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="acepto" required className="mt-1 h-4 w-4 accent-[var(--accent)]" />
            <span>Acepto que On Cue lea las métricas de mi cuenta de {label} con estos fines.</span>
          </label>
          <input type="hidden" name="policy_version" value={policyVersion} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => ref.current?.close()}>
              Cancelar
            </Button>
            <Button type="submit" variant="primary">
              Continuar a {label}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
