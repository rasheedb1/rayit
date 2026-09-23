"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { MESSAGES } from "@/lib/auth/messages";

/** El único botón de /auth/confirm, con su estado mientras se canjea el enlace. */
export function BotonEntrar() {
  const { pending } = useFormStatus();
  const t = MESSAGES.confirmar;
  return (
    <Button type="submit" variant="primary" loading={pending} className="w-full">
      {pending ? t.entrando : t.boton}
    </Button>
  );
}
