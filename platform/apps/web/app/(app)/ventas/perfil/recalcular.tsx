"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmInline } from "@/components/ui/confirm-inline";
import { EmptyState } from "@/components/ui/empty-state";
import { recalcularPerfil } from "./actions";
import { MESSAGES } from "./messages";

/**
 * Corre la acción y guarda lo que dijo, para anunciarlo en una región
 * role=status. Si la petición misma falla antes de que la acción responda
 * (Vercel la corta en el maxDuration, la red se cae, un despliegue nuevo
 * cambia el id de la acción), la promesa se rechaza: se atrapa aquí y se
 * dice en la misma región. Sin eso, el rechazo dentro de startTransition
 * sube hasta error.tsx y la pantalla entera se cambia por la frontera.
 */
function useRecalcular() {
  const [pendiente, empezar] = useTransition();
  const [mensaje, setMensaje] = useState<{ ok: boolean; texto: string } | null>(null);
  async function correr() {
    setMensaje(null);
    try {
      const r = await recalcularPerfil();
      setMensaje({ ok: r.ok, texto: r.message });
    } catch {
      setMensaje({ ok: false, texto: MESSAGES.recalcular.error });
    }
  }
  return { pendiente, mensaje, correr, empezar };
}

function Estado({ mensaje }: { mensaje: { ok: boolean; texto: string } | null }) {
  return (
    <p role="status" className={`text-xs ${mensaje?.ok === false ? "text-bad" : "text-fg-3"}`}>
      {mensaje?.texto}
    </p>
  );
}

/**
 * «Recalcular»: vuelve a leer los datos, arma el perfil y escribe la
 * narrativa. Si el creador editó la narrativa, recalcular la reemplaza,
 * así que se pregunta en el sitio (ConfirmInline del kit) antes de
 * hacerlo; si no, es un botón. La página solo lo pinta si quien mira
 * puede recalcular (puedeEditarElPerfil); la acción lo vuelve a mirar.
 */
export function Recalcular({ editada = false }: { editada?: boolean }) {
  const t = MESSAGES.recalcular;
  const { pendiente, mensaje, correr, empezar } = useRecalcular();
  return (
    <div className="flex flex-col items-start gap-2 md:items-end">
      {editada ? (
        <ConfirmInline
          action={correr}
          label={t.boton}
          question={t.confirmar}
          consequence={t.consecuencia}
          confirmLabel={t.confirmarSi}
          cancelLabel={t.confirmarNo}
          openWidth="w-full sm:w-80"
        />
      ) : (
        <Button variant="secondary" loading={pendiente} onClick={() => empezar(correr)}>
          {pendiente ? t.calculando : t.boton}
        </Button>
      )}
      <Estado mensaje={mensaje} />
    </div>
  );
}

/**
 * El perfil sin calcular: el EmptyState del kit con «Calcular mi perfil»
 * como su acción, dentro de la tarjeta (el patrón del kit). Mientras
 * calcula, el botón lo dice y un segundo clic no lanza otro cálculo.
 */
export function CalcularPrimero() {
  const t = MESSAGES;
  const { pendiente, mensaje, correr, empezar } = useRecalcular();
  return (
    <div className="space-y-2 text-center">
      <EmptyState
        title={t.vacio.title}
        description={t.vacio.description}
        action={{
          label: pendiente ? t.recalcular.calculando : t.recalcular.primero,
          onClick: () => {
            if (!pendiente) empezar(correr);
          },
        }}
      />
      <Estado mensaje={mensaje} />
    </div>
  );
}
