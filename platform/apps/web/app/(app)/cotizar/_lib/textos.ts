import type { TextosCotizar } from "@mc/db/queries/cotizar";
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
  avisoAceptada: ({ companyName, quoteNumber, signerName, signerEmail, campaignName }) => {
    const firma = signerName ? MESSAGES.actividad.firma(signerName, signerEmail) : null;
    return {
      title: MESSAGES.actividad.avisoTitulo(companyName, quoteNumber),
      body: campaignName ? MESSAGES.actividad.avisoConCampana(firma, campaignName) : MESSAGES.actividad.avisoSinCampana(firma),
    };
  },
};
