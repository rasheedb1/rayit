"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { guardarNombre, type EstadoCuenta } from "@/lib/auth/acciones";
import { MESSAGES } from "@/lib/auth/messages";
import { MAX_NOMBRE } from "@/lib/auth/reglas";

const ESTADO: EstadoCuenta = {};

/** Nombre y correo. El correo se muestra y no se edita: es la llave de la sesión. */
export function FormularioCuenta({ nombre, correo }: { nombre: string; correo: string }) {
  const t = MESSAGES.cuenta;
  const [estado, action, pendiente] = useActionState<EstadoCuenta, FormData>(guardarNombre, ESTADO);

  return (
    <form action={action} className="flex max-w-md flex-col gap-5">
      <Field label={t.nombre} help={t.nombreAyuda} error={estado.error} required>
        <Input name="nombre" defaultValue={nombre} maxLength={MAX_NOMBRE} required autoComplete="name" />
      </Field>
      <Field label={t.correo} help={t.correoAyuda}>
        <Input name="correo" defaultValue={correo} disabled readOnly />
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" loading={pendiente}>
          {pendiente ? t.guardando : t.guardar}
        </Button>
        {estado.guardado && !estado.error && (
          <p role="status" className="text-sm text-good">
            {t.guardado}
          </p>
        )}
      </div>
    </form>
  );
}
