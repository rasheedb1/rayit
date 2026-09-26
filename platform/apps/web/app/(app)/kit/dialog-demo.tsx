"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";

/**
 * El diálogo modal con una pregunta que hay que contestar (el motivo de
 * pérdida del pipeline, «No aceptar esta marca» del radar). Aquí solo
 * cuenta cuántas veces se confirmó.
 */
export function DialogDemo({ long = false }: { long?: boolean }) {
  const [abierto, setAbierto] = useState(false);
  const [confirmadas, setConfirmadas] = useState(0);
  return (
    <div className="space-y-2">
      <Button variant="secondary" onClick={() => setAbierto(true)}>
        {long ? "No aceptar esta marca" : "Mover a Perdido"}
      </Button>
      {abierto && (
        <Dialog
          title={long ? "¿No aceptar Distribuidora de Alimentos y Bebidas del Pacífico S.A.S.?" : "Perder el negocio con Café Alma"}
          description={
            long
              ? "Entra a tu CRM como bloqueada y a «Marcas que no aceptas» de los briefs que elijas. El radar deja de enseñar sus señales cuando la excluyen todos los briefs activos."
              : "Elige por qué: el motivo alimenta la tasa de pérdida."
          }
          onClose={() => setAbierto(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setConfirmadas((n) => n + 1);
              setAbierto(false);
            }}
            className="space-y-4"
          >
            {long && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-ink">En el brief de</legend>
                <Checkbox label="Laura Méndez" defaultChecked />
                <Checkbox label="Beto · cocina y recetas de temporada para toda la familia" defaultChecked />
              </fieldset>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="danger">
                {long ? "No aceptarla" : "Perder el negocio"}
              </Button>
              <Button variant="ghost" onClick={() => setAbierto(false)}>
                Cancelar
              </Button>
            </div>
          </form>
        </Dialog>
      )}
      <p className="font-mono text-xs text-muted">confirmadas: {confirmadas}</p>
    </div>
  );
}

/** Casillas controladas y no controladas, con y sin ayuda. */
export function CheckboxDemo() {
  const [activo, setActivo] = useState(true);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Checkbox label="Aplicar el brief" help="Si lo apagas, el brief queda en pausa: la bandeja muestra todo." checked={activo} onChange={setActivo} />
      <Checkbox label="Reel de Instagram" defaultChecked />
      <Checkbox
        label="Divulgación obligatoria: no acepto contenido pagado sin la marca de publicidad de la red, en ningún formato ni plataforma"
        help="Una etiqueta larga parte línea sin mover la casilla."
      />
      <Checkbox label="Deshabilitada" disabled help="Sin permiso para cambiar el brief." />
    </div>
  );
}
