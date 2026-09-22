"use client";

import { Button, type ButtonVariant } from "@/components/ui/button";

/**
 * Botón de cambio de estado con confirmación. Recibe la Server Action
 * ya ligada (bind) desde la página: las acciones sí cruzan la frontera
 * servidor → cliente, a diferencia de cualquier otra función.
 */
export function TransitionButton({
  action,
  label,
  confirmText,
  variant = "secondary",
}: {
  action: () => Promise<void>;
  label: string;
  confirmText: string;
  variant?: ButtonVariant;
}) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(confirmText)) e.preventDefault();
      }}
    >
      <Button type="submit" variant={variant} className="w-full">
        {label}
      </Button>
    </form>
  );
}
