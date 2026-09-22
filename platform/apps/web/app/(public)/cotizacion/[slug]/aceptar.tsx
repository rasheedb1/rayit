"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { MESSAGES } from "@/app/(app)/cotizar/messages";
import { aceptarCotizacionPublica, type AceptarResultado } from "../../actions";

/**
 * «Aceptar cotización».
 *
 * Un solo botón, sin diálogo de confirmación pero sin vuelta atrás
 * silenciosa: al aceptar, la página cambia a un mensaje que dice qué
 * acaba de pasar y qué sigue. Es el patrón de la página alojada de
 * Stripe: una acción, visible, y una confirmación en el mismo sitio.
 */
export function AceptarCotizacion({ slug }: { slug: string }) {
  const t = MESSAGES.publico.cotizacion;
  const [estado, setEstado] = useState<AceptarResultado | null>(null);
  const [pending, startTransition] = useTransition();

  if (estado === "ok") {
    return (
      <div role="status" className="rounded-md border border-good/30 bg-good-wash px-4 py-3">
        <p className="text-sm font-medium text-good">{t.graciasTitle}</p>
        <p className="mt-1 text-sm text-ink-2">{t.graciasDescription}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Button
        variant="primary"
        loading={pending}
        onClick={() =>
          startTransition(async () => {
            setEstado(await aceptarCotizacionPublica(slug));
          })
        }
      >
        {pending ? t.aceptando : t.aceptar}
      </Button>
      {estado !== null && (
        <p role="alert" className="text-sm text-bad">
          {estado === "no_existe" ? t.noExiste.description : estado === "no_aceptable" ? t.vencida : t.error}
        </p>
      )}
    </div>
  );
}
