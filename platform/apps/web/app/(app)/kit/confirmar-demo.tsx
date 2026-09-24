"use client";

import { useState } from "react";
import { ConfirmarAccion } from "@/components/ui/confirmar-accion";
import { Variant } from "./section";

/**
 * ConfirmarAccion en la galería (VEN-15 r4, nacida en Cotizar). La
 * acción aquí no llama a ningún servidor: cambia un estado local, para
 * ver el segundo paso y la vuelta al primero.
 */
export function ConfirmarDemo() {
  const [encendido, setEncendido] = useState(false);
  return (
    <>
      <Variant label="Peligrosa: rechazar una cotización">
        <ConfirmarAccion
          action={async () => {}}
          label="Marcar rechazada"
          variant="danger"
          pregunta="¿Rechazar COT-2026-003?"
          consecuencia="La cotización queda rechazada y no se puede aceptar después."
          confirmar="Sí, rechazar"
          cancelar="Cancelar"
          anchoAbierta="w-full sm:w-80"
        />
      </Variant>
      <Variant label="Dos acciones en el mismo sitio, con una key por estado">
        {encendido ? (
          <ConfirmarAccion
            key="apagar"
            action={async () => setEncendido(false)}
            label="Apagar el envío"
            variant="danger"
            pregunta="¿Apagar el envío?"
            consecuencia="Lo que está en cola se cancela."
            confirmar="Sí, apagar"
            cancelar="Cancelar"
            anchoAbierta="w-full sm:w-80"
          />
        ) : (
          <ConfirmarAccion
            key="encender"
            action={async () => setEncendido(true)}
            label="Encender el envío"
            variant="primary"
            pregunta="¿Encender el envío?"
            consecuencia="Desde ahora, lo que apruebes sale solo, en tu nombre y dentro de tus límites. Un texto largo se parte en varias líneas sin empujar el botón fuera de la tarjeta."
            confirmar="Sí, encender"
            cancelar="Cancelar"
            anchoAbierta="w-full sm:w-80"
          />
        )}
      </Variant>
    </>
  );
}
