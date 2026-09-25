"use client";

import { useState } from "react";
import { ConfirmInline } from "@/components/ui/confirm-inline";

/**
 * Dos acciones que se alternan en el mismo sitio (encender y apagar el
 * envío de Ventas), cada una con su `key`: al cambiar de estado, la
 * pregunta abierta no se hereda de la otra (VEN-15 r4). La acción aquí no
 * llama a ningún servidor: cambia un estado local.
 */
export function ConfirmToggleDemo() {
  const [encendido, setEncendido] = useState(false);
  return encendido ? (
    <ConfirmInline
      key="apagar"
      action={async () => setEncendido(false)}
      label="Apagar el envío"
      variant="danger"
      question="¿Apagar el envío?"
      consequence="Lo que está en cola se cancela."
      confirmLabel="Sí, apagar"
      cancelLabel="Cancelar"
      openWidth="w-full sm:w-80"
    />
  ) : (
    <ConfirmInline
      key="encender"
      action={async () => setEncendido(true)}
      label="Encender el envío"
      variant="primary"
      question="¿Encender el envío?"
      consequence="Desde ahora, lo que apruebes sale solo, en tu nombre y dentro de tus límites. Un texto largo se parte en varias líneas sin empujar el botón fuera de la tarjeta."
      confirmLabel="Sí, encender"
      cancelLabel="Cancelar"
      openWidth="w-full sm:w-80"
    />
  );
}
