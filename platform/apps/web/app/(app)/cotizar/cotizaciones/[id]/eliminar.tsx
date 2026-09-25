"use client";

import { eliminarBorrador } from "../../actions";
import { MESSAGES } from "../../messages";
import { ConfirmInline } from "@/components/ui/confirm-inline";

/**
 * «Eliminar borrador», con confirmación en línea: borrar no se deshace.
 * Solo existe para borradores; una enviada es un documento que la marca
 * ya tiene y se rechaza o vence, no se borra.
 */
export function EliminarBorrador({ id, numero }: { id: string; numero: string }) {
  const t = MESSAGES.detalle;
  return (
    <ConfirmInline
      action={eliminarBorrador.bind(null, id)}
      label={t.eliminar}
      variant="danger"
      question={t.confirmar.eliminar.pregunta(numero)}
      consequence={t.confirmar.eliminar.consecuencia}
      confirmLabel={t.confirmar.eliminar.boton}
      cancelLabel={t.confirmar.cancelar}
    />
  );
}
