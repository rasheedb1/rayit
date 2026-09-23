"use client";

import { eliminarBorrador } from "../../actions";
import { MESSAGES } from "../../messages";
import { ConfirmarAccion } from "../../_ui/confirmar-accion";

/**
 * «Eliminar borrador», con confirmación en línea: borrar no se deshace.
 * Solo existe para borradores; una enviada es un documento que la marca
 * ya tiene y se rechaza o vence, no se borra.
 */
export function EliminarBorrador({ id, numero }: { id: string; numero: string }) {
  const t = MESSAGES.detalle;
  return (
    <ConfirmarAccion
      action={eliminarBorrador.bind(null, id)}
      label={t.eliminar}
      variant="danger"
      pregunta={t.confirmar.eliminar.pregunta(numero)}
      consecuencia={t.confirmar.eliminar.consecuencia}
      confirmar={t.confirmar.eliminar.boton}
      cancelar={t.confirmar.cancelar}
    />
  );
}
