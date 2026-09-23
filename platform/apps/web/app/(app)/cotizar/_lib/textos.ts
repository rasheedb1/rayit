import type { TextosCotizar } from "@mc/db/queries/cotizar";
import { formatMoney } from "@/lib/format";
import { MESSAGES } from "../messages";

/**
 * Las frases que @mc/db guarda en tablas de otros módulos (la historia
 * del negocio, el aviso al creador), compuestas con messages.ts. El
 * paquete de base no tiene idioma: recibe esto en sendQuote,
 * acceptQuote, acceptQuoteAndCreateCampaign y completePublicAcceptance, y
 * guarda junto a cada frase su código y sus parámetros.
 */
export const TEXTOS_COTIZAR: TextosCotizar = {
  actividadEnviada: ({ quoteNumber }) => MESSAGES.actividad.enviada(quoteNumber),
  actividadAceptada: ({ quoteNumber, signerName, signerEmail, via }) =>
    via === "panel"
      ? MESSAGES.actividad.aceptadaPanel(quoteNumber)
      : MESSAGES.actividad.aceptadaEnlace(quoteNumber, signerName ? MESSAGES.actividad.firma(signerName, signerEmail) : null),
  // Sin el locale del workspace a mano: formatMoney usa el de por
  // defecto. La cifra y la moneda exactas quedan además en metadata.
  actividadMonto: ({ quoteNumber, amountFrom, currencyFrom, amountTo, currencyTo }) =>
    MESSAGES.actividad.monto(
      quoteNumber,
      amountFrom ? formatMoney(amountFrom, currencyFrom, { mode: "full" }) : null,
      formatMoney(amountTo, currencyTo, { mode: "full" }),
    ),
  avisoAceptada: ({ companyName, quoteNumber, signerName, signerEmail, campaignName }) => {
    const firma = signerName ? MESSAGES.actividad.firma(signerName, signerEmail) : null;
    return {
      title: MESSAGES.actividad.avisoTitulo(companyName, quoteNumber),
      body: campaignName ? MESSAGES.actividad.avisoConCampana(firma, campaignName) : MESSAGES.actividad.avisoSinCampana(firma),
    };
  },
};
