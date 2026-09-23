import type { PillKind } from "@/components/ui/pill";
import { MESSAGES, nombreEstadoCotizacion } from "../messages";

/**
 * El estado que se ENSEÑA: 'superseded' para una vencida que dejó sin
 * efecto otra versión del mismo negocio (0033), que no venció por su
 * fecha y no se tiene que leer como «Vencida».
 */
export function estadoVisible(q: { status: string; supersededById?: string | null }): string {
  return q.status === "expired" && q.supersededById ? "superseded" : q.status;
}

/**
 * La pastilla de una cotización. El color nunca es el único indicador:
 * el texto ya dice el estado.
 *
 *   aceptada → good · vista → warn (hay algo que hacer)
 *   rechazada o vencida → bad · sin efecto, borrador y enviada → neutral
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

/**
 * true cuando la cotización ya se cerró (aceptada, rechazada o vencida)
 * y «Válida hasta» no dice nada: Stripe Quotes quita la validez en cuanto
 * la cotización se acepta. La usan el detalle del panel y el documento
 * que ve la marca.
 */
export function validezYaNoAplica(status: string): boolean {
  return status === "accepted" || status === "rejected" || status === "expired";
}

/**
 * Qué hacer con el enlace de una cotización ya enviada, según su estado
 * de hoy (pulido r7):
 *
 *   enviada, vista o aceptada → se ofrece copiarlo (la aceptada, para que
 *     la marca vuelva a ver lo que firmó)
 *   rechazada o vencida → ya no acepta: no se ofrece copiarlo, y la ayuda
 *     dice qué compartir en su lugar
 *   sin efecto → el enlace de la versión que la reemplazó, si ese sirve
 *
 * El enlace muerto sigue abriendo (la marca lee por qué ya no vale): lo
 * que no hace la pantalla es invitar a mandarlo.
 */
export function enlaceDeCotizacion(q: {
  status: string;
  supersededByNumber?: string | null;
  supersededByStatus?: string | null;
}): { copiable: boolean; ayuda: string } {
  const t = MESSAGES.detalle;
  if (q.status !== "rejected" && q.status !== "expired") return { copiable: true, ayuda: t.enlaceAyuda };
  if (q.status === "expired" && q.supersededByNumber) {
    return { copiable: false, ayuda: t.enlaceMuerto.sinEfecto(q.supersededByNumber, q.supersededByStatus ?? null) };
  }
  return { copiable: false, ayuda: q.status === "rejected" ? t.enlaceMuerto.rechazada : t.enlaceMuerto.vencida };
}
