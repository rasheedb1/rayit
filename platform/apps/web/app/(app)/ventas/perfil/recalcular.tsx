"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmInline } from "@/components/ui/confirm-inline";
import { recalcularPerfil } from "./actions";
import { MESSAGES } from "./messages";

/**
 * «Recalcular»: vuelve a leer los datos, arma el perfil y escribe la
 * narrativa. Si el creador editó la narrativa, recalcular la reemplaza,
 * así que se pregunta en el sitio (ConfirmInline del kit) antes de
 * hacerlo; si no, es un botón. El resultado se anuncia en una región
 * role=status.
 */
export function Recalcular({ primera = false, editada = false }: { primera?: boolean; editada?: boolean }) {
  const t = MESSAGES.recalcular;
  const [pendiente, empezar] = useTransition();
  const [mensaje, setMensaje] = useState<{ ok: boolean; texto: string } | null>(null);

  async function correr() {
    setMensaje(null);
    const r = await recalcularPerfil();
    setMensaje({ ok: r.ok, texto: r.message });
  }

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
        <Button
          variant={primera ? "primary" : "secondary"}
          loading={pendiente}
          onClick={() => empezar(correr)}
        >
          {pendiente ? t.calculando : primera ? t.primero : t.boton}
        </Button>
      )}
      <p role="status" className={`text-xs ${mensaje?.ok === false ? "text-bad" : "text-fg-3"}`}>
        {mensaje?.texto}
      </p>
    </div>
  );
}
