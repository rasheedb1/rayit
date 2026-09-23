"use client";

import { useActionState, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { renombrarEspacio, type EstadoRenombrar } from "@/lib/auth/acciones";
import { MESSAGES } from "@/lib/auth/messages";

const ESTADO: EstadoRenombrar = {};

/**
 * «Renombrar» en una fila de «Tus espacios». El espacio nace con un
 * nombre sacado del correo, y la historia pide que se pueda cambiar
 * después. Solo se pinta para owner y admin; aun así, quién puede lo
 * decide el servidor (lib/auth/acciones.ts, `renombrarEspacio`).
 *
 * En línea y no en un diálogo, como el renombrado de Notion y de
 * Vercel: el campo aparece donde estaba el nombre, con Guardar y
 * Cancelar, y Escape cancela.
 */
export function RenombrarEspacio({ id, nombre }: { id: string; nombre: string }) {
  const t = MESSAGES.cuenta.renombrar;
  const [editando, setEditando] = useState(false);
  const [estado, action, pendiente] = useActionState<EstadoRenombrar, FormData>(renombrarEspacio, ESTADO);

  // Guardado: se cierra el campo; la lista trae el nombre nuevo del servidor.
  useEffect(() => {
    if (estado.guardado) setEditando(false);
  }, [estado]);

  if (!editando) {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-sm text-ink">{nombre}</span>
        {estado.guardado && (
          <span role="status" className="sr-only">
            {t.guardado}
          </span>
        )}
        <Button size="sm" variant="ghost" onClick={() => setEditando(true)} aria-label={`${t.accion}: ${nombre}`}>
          {t.accion}
        </Button>
      </span>
    );
  }

  return (
    <form
      action={action}
      className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center"
      onKeyDown={(e) => {
        if (e.key === "Escape") setEditando(false);
      }}
    >
      <input type="hidden" name="workspaceId" value={id} />
      <Input
        name="nombre"
        defaultValue={nombre}
        aria-label={t.etiqueta(nombre)}
        invalid={Boolean(estado.error)}
        maxLength={80}
        required
        autoFocus
        className="min-w-0 flex-1"
      />
      <span className="flex shrink-0 items-center gap-2">
        <Button type="submit" size="sm" variant="primary" loading={pendiente}>
          {pendiente ? t.guardando : t.guardar}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditando(false)}>
          {t.cancelar}
        </Button>
      </span>
      {estado.error && (
        <p role="alert" className="text-xs text-bad sm:basis-full">
          {estado.error}
        </p>
      )}
    </form>
  );
}
