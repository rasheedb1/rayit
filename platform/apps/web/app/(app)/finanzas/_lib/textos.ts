import type { TextosFinanzas } from "@mc/db/queries/finanzas";
import { formatMoney } from "@/lib/format";
import { MESSAGES } from "./messages";

/**
 * Las frases que @mc/db guarda en tablas de otros módulos: hoy, el aviso
 * al creador cuando entra un cobro (`notification`). El paquete de base
 * no tiene idioma —lo dice su TextosFinanzas—, así que las compone aquí
 * la web con su messages.ts y las pasa a `recordPayment`.
 *
 * Es una función y no una constante como TEXTOS_COTIZAR porque el locale
 * del workspace sí está a mano en este camino: la Server Action ya
 * espera a `getCurrentWorkspace()` para formatear, y una cifra escrita
 * con el separador de otro país en el aviso se vería mal justo donde no
 * hay forma de recomponerla. La moneda y el monto exactos quedan además
 * en la propia factura, a la que el aviso enlaza.
 */
export function textosFinanzas(locale: string): TextosFinanzas {
  const money = (amount: string, currency: string) => formatMoney(amount, currency, { mode: "full", locale });
  return {
    avisoPagoRecibido: ({ invoiceNumber, companyName, amount, currency, status, outstanding }) => ({
      title: MESSAGES.avisos.pagoTitulo(invoiceNumber),
      body:
        status === "paid"
          ? MESSAGES.avisos.pagoPagada(companyName, money(amount, currency))
          : MESSAGES.avisos.pagoParcial(companyName, money(amount, currency), money(outstanding, currency)),
    }),
  };
}
