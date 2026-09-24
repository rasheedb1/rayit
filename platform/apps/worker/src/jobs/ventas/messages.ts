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
 * presupuesto. account_down lleva a la lista de cuentas caídas de esa
 * misma pantalla (#cuentas: cuál es, qué dijo el proveedor y qué hacer),
 * y a /ventas/canales cuando VEN-9 integre esa pantalla, donde se
 * reconecta: se cambia AQUÍ (CANALES_URL) y en nada más.
 */
export const SALUD_URL = '/ventas/politica#salud';
export const PRESUPUESTO_URL = '/ventas/politica#presupuesto';
/** Hasta que /ventas/canales (VEN-9) esté integrada, las cuentas caídas de la política; después, '/ventas/canales'. */
export const CANALES_URL = '/ventas/politica#cuentas';

export const ALERTAS_URL: Record<OutreachAlertKind, string> = {
  bounce_rate: SALUD_URL,
  no_sends: SALUD_URL,
  queue_stuck: SALUD_URL,
  account_down: CANALES_URL,
  llm_budget: PRESUPUESTO_URL,
};

/**
 * Una frase que cambia con una cifra («1 mensaje lleva…», «3 mensajes
 * llevan…»). La forma la elige Intl.PluralRules del locale del workspace
 * con la cifra CRUDA de `by` (una de las de la alerta); las `{…}` se
 * rellenan después con las cifras ya formateadas. Las categorías que no
 * sean 'one' (few, many… en otros idiomas) usan `other`.
 */
export interface Plural {
  by: string;
  one: string;
  other: string;
}

/** Un texto fijo o uno con plural. */
export type Plantilla = string | Plural;

export interface AlertTexts {
  alerts: Record<OutreachAlertKind, { title: Plantilla; body: Plantilla }>;
  /**
   * Cómo se nombra una cuenta caída en {accounts}: «LinkedIn: Laura ·
   * Cocina fácil». Si no se sabe cuáles son (una salud de fixture), el
   * número: una o varias.
   */
  accounts: {
    channel: Record<'email' | 'linkedin' | 'instagram_dm' | 'whatsapp', string>;
    /** Sin nombres: «una cuenta de canal» / «{n} cuentas de canal», por accountsDown. */
    unnamed: Plural;
  };
  email: {
    /** Por `n`, el número de alertas del resumen. */
    subject: Plural;
    intro: string;
    /** El enlace de cada alerta, debajo de su texto. */
    link: string;
    /** Sin APP_URL no hay enlaces: dónde verlo, en una línea. */
    whereToSee: string;
    outro: string;
  };
}

export const ALERT_TEXTS_ES: AlertTexts = {
  alerts: {
    bounce_rate: {
      title: 'Rebotan demasiados correos: {rate}',
      body: {
        by: 'bounces',
        one: '{bounces} de {attempts} correos enviados en las últimas 24 horas rebotó porque la dirección no existe. Revisa las direcciones antes de seguir: Gmail castiga a quien rebota mucho.',
        other:
          '{bounces} de {attempts} correos enviados en las últimas 24 horas rebotaron porque la dirección no existe. Revisa las direcciones antes de seguir: Gmail castiga a quien rebota mucho.',
      },
    },
    no_sends: {
      title: 'El outreach no envió nada ayer',
      body: {
        by: 'dueToSend',
        one: 'Había {dueToSend} mensaje por salir y no salió en 24 horas. Revisa los canales y la cola.',
        other: 'Había {dueToSend} mensajes por salir y no salió ninguno en 24 horas. Revisa los canales y la cola.',
      },
    },
    queue_stuck: {
      title: { by: 'stuck', one: 'Hay un mensaje atascado en la cola', other: 'Hay mensajes atascados en la cola' },
      body: {
        by: 'stuck',
        one: '{stuck} mensaje lleva más de cinco minutos enviándose. Si sigue así, revisa el canal.',
        other: '{stuck} mensajes llevan más de cinco minutos enviándose. Si sigue así, revisa el canal.',
      },
    },
    account_down: {
      title: {
        by: 'accountsDown',
        one: 'Una cuenta de envío necesita atención',
        other: 'Hay cuentas de envío que necesitan atención',
      },
      body: {
        by: 'accountsDown',
        one: 'No sale nada por {accounts} hasta que se reconecte: lo de ese canal espera en la cola. En tu política de envío ves qué dijo el proveedor y qué hacer.',
        other:
          'No sale nada por {accounts} hasta que se reconecten: lo de esos canales espera en la cola. En tu política de envío ves qué dijo cada proveedor y qué hacer.',
      },
    },
    llm_budget: {
      title: 'Se agotó el presupuesto diario de redacción',
      body: 'Se gastaron {spentToday} de {dailyCap} hoy. Los mensajes nuevos esperan a mañana; lo aprobado sigue saliendo.',
    },
  },
  accounts: {
    channel: { email: 'Gmail', linkedin: 'LinkedIn', instagram_dm: 'Instagram', whatsapp: 'WhatsApp' },
    unnamed: { by: 'accountsDown', one: 'una cuenta de canal', other: '{accountsDown} cuentas de canal' },
  },
  email: {
    subject: {
      by: 'n',
      one: 'On Cue · Una alerta del outreach de {workspace}',
      other: 'On Cue · {n} alertas del outreach de {workspace}',
    },
    intro: 'Esto es lo que vimos en el outreach de {workspace}:',
    link: 'Revísalo: {url}',
    whereToSee: 'Lo ves en On Cue, en Ventas → Política de envío.',
    outro: 'Te escribimos una vez al día porque eres dueño de este espacio en On Cue. Lo que aparezca más tarde está en la campana y va en el resumen de mañana.',
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
      body: {
        by: 'dueToSend',
        one: "{dueToSend} message was due and it didn't go out in 24 hours. Check your channels and the queue.",
        other: '{dueToSend} messages were due and none went out in 24 hours. Check your channels and the queue.',
      },
    },
    queue_stuck: {
      title: { by: 'stuck', one: 'A message is stuck in the queue', other: 'Messages are stuck in the queue' },
      body: {
        by: 'stuck',
        one: '{stuck} message has been sending for more than five minutes. If it keeps up, check the channel.',
        other: '{stuck} messages have been sending for more than five minutes. If it keeps up, check the channel.',
      },
    },
    account_down: {
      title: { by: 'accountsDown', one: 'A sending account needs attention', other: 'Some sending accounts need attention' },
      body: {
        by: 'accountsDown',
        one: 'Nothing goes out through {accounts} until it reconnects: messages for that channel wait in the queue. Your sending policy shows what the provider said and what to do.',
        other:
          'Nothing goes out through {accounts} until they reconnect: messages for those channels wait in the queue. Your sending policy shows what each provider said and what to do.',
      },
    },
    llm_budget: {
      title: 'The daily writing budget is used up',
      body: '{spentToday} of {dailyCap} spent today. New messages wait until tomorrow; approved ones keep going out.',
    },
  },
  accounts: {
    channel: { email: 'Gmail', linkedin: 'LinkedIn', instagram_dm: 'Instagram', whatsapp: 'WhatsApp' },
    unnamed: { by: 'accountsDown', one: 'one channel account', other: '{accountsDown} channel accounts' },
  },
  email: {
    subject: {
      by: 'n',
      one: 'On Cue · One outreach alert for {workspace}',
      other: 'On Cue · {n} outreach alerts for {workspace}',
    },
    intro: "Here's what we saw in {workspace}'s outreach:",
    link: 'Review it: {url}',
    whereToSee: 'You can see it in On Cue, under Sales → Sending policy.',
    outro: "We write once a day because you own this workspace on On Cue. Anything that shows up later is in the bell and goes in tomorrow's summary.",
  },
};

/**
 * Rellena una plantilla: elige la forma con Intl.PluralRules(locale) y la
 * cifra cruda de `crudos[by]`, y cambia cada `{clave}` por su valor ya
 * formateado. Una `{clave}` sin valor se queda como está (y una prueba lo
 * atrapa: ningún texto guardado lleva «{»).
 */
export function fillTemplate(
  plantilla: Plantilla,
  valores: Readonly<Record<string, string>>,
  crudos: Readonly<Record<string, number>>,
  locale: string,
): string {
  const texto =
    typeof plantilla === 'string'
      ? plantilla
      : new Intl.PluralRules(locale).select(crudos[plantilla.by] ?? 0) === 'one'
        ? plantilla.one
        : plantilla.other;
  return texto.replace(/\{(\w+)\}/g, (_, k: string) => valores[k] ?? `{${k}}`);
}

/** Los textos para un locale BCP 47 ('es-CO', 'en-US'…): inglés si el locale es inglés, si no español. */
export function alertTextsFor(locale: string): AlertTexts {
  return /^en\b/i.test(locale) ? ALERT_TEXTS_EN : ALERT_TEXTS_ES;
}
