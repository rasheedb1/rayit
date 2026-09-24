/**
 * Textos de los jobs de Ventas que salen del worker hacia una persona:
 * hoy, las alertas diarias del outreach (VEN-15), en la campana y en el
 * correo de resumen. En el idioma del workspace (workspace.locale), como
 * el pie del correo del outreach (footerTextsFor de @mc/core): inglés si
 * el locale es inglés, si no español.
 *
 * notification.title_es y body_es guardan la frase ya en ese idioma, como
 * hace Cotizar (packages/db/src/queries/cotizar/cotizacion.ts,
 * TextosCotizar): la columna es de 0009, cuando todo era español; quien
 * quiera otra frase la recompone con notification.kind.
 *
 * Las `{n}` se rellenan con cifras ya formateadas con Intl en el locale
 * del workspace.
 */
import type { OutreachAlertKind } from '@mc/core/outreach/deliverability';

/**
 * Adónde lleva cada alerta. Todas a /ventas/politica, que trae el bloque
 * «Salud de hoy» (outbound_health y los últimos rebotes) y el
 * presupuesto; account_down, a /ventas/canales cuando VEN-9 integre esa
 * pantalla: se cambia AQUÍ (CANALES_URL) y en nada más.
 */
export const SALUD_URL = '/ventas/politica#salud';
export const PRESUPUESTO_URL = '/ventas/politica#presupuesto';
/** Hasta que /ventas/canales (VEN-9) esté integrada, la salud; después, '/ventas/canales'. */
export const CANALES_URL = SALUD_URL;

export const ALERTAS_URL: Record<OutreachAlertKind, string> = {
  bounce_rate: SALUD_URL,
  no_sends: SALUD_URL,
  queue_stuck: SALUD_URL,
  account_down: CANALES_URL,
  llm_budget: PRESUPUESTO_URL,
};

export interface AlertTexts {
  alerts: Record<OutreachAlertKind, { title: string; body: string }>;
  email: {
    subject: string;
    subjectOne: string;
    intro: string;
    /** El enlace de cada alerta, debajo de su texto. */
    link: string;
    outro: string;
  };
}

export const ALERT_TEXTS_ES: AlertTexts = {
  alerts: {
    bounce_rate: {
      title: 'Rebotan demasiados correos: {rate}',
      body: '{bounces} de {attempts} correos enviados en las últimas 24 horas rebotaron porque la dirección no existe. Revisa las direcciones antes de seguir: Gmail castiga a quien rebota mucho.',
    },
    no_sends: {
      title: 'El outreach no envió nada ayer',
      body: 'Había {dueToSend} mensajes por salir y no salió ninguno en 24 horas. Revisa los canales y la cola.',
    },
    queue_stuck: {
      title: 'Hay mensajes atascados en la cola',
      body: '{stuck} mensajes llevan más de cinco minutos enviándose. Si sigue así, revisa el canal.',
    },
    account_down: {
      title: 'Una cuenta de envío necesita atención',
      body: '{accountsDown} cuentas de canal están caídas o piden reconectar. Mientras tanto no sale nada por ellas.',
    },
    llm_budget: {
      title: 'Se agotó el presupuesto diario de redacción',
      body: 'Se gastaron {spentToday} de {dailyCap} hoy. Los mensajes nuevos esperan a mañana; lo aprobado sigue saliendo.',
    },
  },
  email: {
    subject: 'On Cue · {n} alertas del outreach de {workspace}',
    subjectOne: 'On Cue · Una alerta del outreach de {workspace}',
    intro: 'Esto es lo que vimos en el outreach de {workspace}:',
    link: 'Revísalo: {url}',
    outro: 'Te escribimos porque eres dueño de este espacio en On Cue.',
  },
};

export const ALERT_TEXTS_EN: AlertTexts = {
  alerts: {
    bounce_rate: {
      title: 'Too many emails are bouncing: {rate}',
      body: "{bounces} of {attempts} emails sent in the last 24 hours bounced because the address doesn't exist. Check the addresses before sending more: Gmail penalizes senders who bounce a lot.",
    },
    no_sends: {
      title: 'Outreach sent nothing yesterday',
      body: '{dueToSend} messages were due and none went out in 24 hours. Check your channels and the queue.',
    },
    queue_stuck: {
      title: 'Messages are stuck in the queue',
      body: '{stuck} messages have been sending for more than five minutes. If it keeps up, check the channel.',
    },
    account_down: {
      title: 'A sending account needs attention',
      body: '{accountsDown} channel accounts are down or need to reconnect. Nothing goes out through them until then.',
    },
    llm_budget: {
      title: 'The daily writing budget is used up',
      body: '{spentToday} of {dailyCap} spent today. New messages wait until tomorrow; approved ones keep going out.',
    },
  },
  email: {
    subject: 'On Cue · {n} outreach alerts for {workspace}',
    subjectOne: 'On Cue · One outreach alert for {workspace}',
    intro: "Here's what we saw in {workspace}'s outreach:",
    link: 'Review it: {url}',
    outro: "You're receiving this because you own this workspace on On Cue.",
  },
};

/** Los textos para un locale BCP 47 ('es-CO', 'en-US'…): inglés si el locale es inglés, si no español. */
export function alertTextsFor(locale: string): AlertTexts {
  return /^en\b/i.test(locale) ? ALERT_TEXTS_EN : ALERT_TEXTS_ES;
}
