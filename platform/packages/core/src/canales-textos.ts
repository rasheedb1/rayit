/**
 * La salud de un canal de outreach, en frase (VEN-9).
 *
 * Una cuenta de LinkedIn, de Instagram o de Gmail puede caer por dos
 * caminos: el aviso de Unipile a la web (/api/webhooks/unipile) o el
 * keepalive del worker. El mismo evento tiene que decir lo mismo lo
 * detecte quien lo detecte, y quedar traducido en UN sitio: la web
 * (ventas/canales/messages.ts los reexporta) y el worker leen de aquí.
 *
 * Qué va a la base y qué no (ronda 5): en last_error de la cuenta solo
 * van CÓDIGOS (CHANNEL_ERROR_CODES de @mc/db, 'unipile_status:<X>'), y la
 * pantalla los traduce con estas frases en el momento de pintar, así un
 * espacio en otro idioma no hereda un español congelado en la base. Lo
 * único que se escribe con frase es el aviso de la campana (la tabla
 * notification guarda title_es y body_es): `down` y `back`.
 *
 * Nada de esto nombra un código crudo del proveedor: el código
 * (CREDENTIALS, STOPPED…) queda en api_call_log y en el registro del
 * servidor.
 */

/** El nombre de cada canal como lo lee la persona, para las frases. */
export const CHANNEL_HEALTH_NAME: Readonly<Record<string, string>> = {
  email: 'Gmail', linkedin: 'LinkedIn', instagram_dm: 'Instagram', whatsapp: 'WhatsApp',
};

export function channelHealthName(channel: string): string {
  return CHANNEL_HEALTH_NAME[channel] ?? channel;
}

export const CANALES_TEXTOS = {
  /**
   * Lo que dice Unipile de una sesión (el estado de su fuente). Termina
   * en punto y sin la llamada a la acción: la añade `down.body`.
   */
  unipileStatus: (status: string | null, channel: string): string => {
    switch (status) {
      case 'CREDENTIALS': return `${channel} cerró la sesión.`;
      case 'STOPPED': return 'La cuenta se detuvo.';
      case 'DELETED': return `La cuenta de ${channel} se borró.`;
      case 'DISCONNECTED': return 'La cuenta se desconectó.';
      default: return `${channel} dio un error con la sesión.`;
    }
  },
  /**
   * Unipile ya no tiene la cuenta (la borró quien la conectó, o caducó).
   * Nombra el canal, no a Unipile: la persona conectó «LinkedIn», no
   * conoce al intermediario.
   */
  unipileGone: (channel: string): string => `${channel} ya no reconoce esta cuenta.`,
  /** Google no acepta el refresh token: la persona quitó el acceso, o venció sin uso. */
  gmailRevoked: 'Google ya no acepta el permiso de este Gmail (lo quitaste o venció).',
  gmailNoSecret: 'No encontramos el permiso guardado de este Gmail.',
  /**
   * Un problema nuestro o pasajero: la cuenta no cambia de estado. Frase
   * fija: el detalle del proveedor (en inglés, tal cual lo manda) queda
   * en api_call_log.error_message y nunca llega al creador.
   */
  transient: 'No pudimos comprobar la cuenta hoy. Lo intentamos de nuevo mañana.',

  /** El aviso de la campana cuando la cuenta cae. */
  down: {
    title: (channel: string, name: string | null) => `Vuelve a conectar tu ${channel}${name ? ` (${name})` : ''}`,
    /** `what` es una de las frases de arriba. */
    body: (what: string) => `${what} Vuelve a conectar la cuenta desde Canales.`,
  },
  /** El aviso de la campana cuando la sesión vuelve sola (la persona resolvió el reto en LinkedIn). */
  back: {
    title: (channel: string, name: string | null) => `Tu ${channel}${name ? ` (${name})` : ''} volvió a conectarse`,
    body: 'On Cue ya puede volver a enviar por esta cuenta.',
  },
} as const;
