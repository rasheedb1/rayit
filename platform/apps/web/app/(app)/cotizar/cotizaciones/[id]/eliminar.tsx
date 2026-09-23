"use client";

import { Button } from "@/components/ui/button";
import { eliminarBorrador } from "../../actions";
import { MESSAGES } from "../../messages";

/**
 * «Eliminar borrador», con confirmación: borrar no se deshace. Solo
 * existe para borradores; una enviada es un documento que la marca ya
 * tiene y se rechaza o vence, no se borra.
 */
export function EliminarBorrador({ id }: { id: string }) {
  const t = MESSAGES.detalle;
  return (
    <form
      action={eliminarBorrador.bind(null, id)}
      onSubmit={(e) => {
        if (!window.confirm(t.eliminarConfirmar)) e.preventDefault();
      }}
    >
      <Button type="submit" variant="danger">
        {t.eliminar}
      </Button>
    </form>
  );
}
