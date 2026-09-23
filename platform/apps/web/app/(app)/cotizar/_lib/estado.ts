import type { PillKind } from "@/components/ui/pill";
import { nombreEstadoCotizacion } from "../messages";

/**
 * La pastilla de una cotización. El color nunca es el único indicador:
 * el texto ya dice el estado.
 *
 *   aceptada → good · vista → warn (hay algo que hacer)
 *   rechazada o vencida → bad · borrador y enviada → neutral
 */
export function pillDeCotizacion(status: string): { kind: PillKind; text: string } {
  const text = nombreEstadoCotizacion(status);
  switch (status) {
    case "accepted":
      return { kind: "good", text };
    case "viewed":
      return { kind: "warn", text };
    case "rejected":
    case "expired":
      return { kind: "bad", text };
    default:
      return { kind: "neutral", text };
  }
}
