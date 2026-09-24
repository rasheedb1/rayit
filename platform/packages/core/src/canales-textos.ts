/**
 * La salud de un canal de outreach, en frase (VEN-9).
 *
 * Una cuenta de LinkedIn, de Instagram o de Gmail puede caer por dos
 * caminos: el aviso de Unipile a la web (/api/webhooks/unipile) o el
 * keepalive diario del worker. El mismo evento tiene que decir lo mismo
 * lo detecte quien lo detecte, y quedar traducido en UN sitio: la web
 * (ventas/canales/messages.ts) y el worker (canales.keepalive.ts) leen
 * de aquí. Nada de esto nombra un código crudo del proveedor: el código
 * (CREDENTIALS, STOPPED…) queda en api_call_log y en el registro del
 * servidor.
 *
 * Es texto que queda escrito en la base (last_error de la cuenta y el
 * aviso de la campana), por eso vive en @mc/core, que no depende de
 * nadie, y no en una pantalla.
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
      case 'DELETED': return 'La cuenta se borró en el proveedor.';
      case 'DISCONNECTED': return 'La cuenta se desconectó.';
      default: return `${channel} dio un error con la sesión.`;
    }
  },
  /** Unipile ya no tiene la cuenta (la borró quien la conectó, o caducó). */
  unipileGone: 'Unipile ya no tiene esta cuenta.',
  /** Google no acepta el refresh token: la persona quitó el acceso, o venció sin uso. */
  gmailRevoked: 'Google ya no acepta el permiso de este Gmail (lo quitaste o venció).',
  gmailNoSecret: 'No encontramos el permiso guardado de este Gmail.',
  /** Un problema nuestro o pasajero: la cuenta no cambia de estado. */
  transient: (detail: string) => `No pudimos comprobar la cuenta hoy: ${detail} Lo intentamos de nuevo mañana.`,

  /** Lo que queda en last_error y en la campana cuando la cuenta cae. */
  down: {
    title: (channel: string, name: string | null) => `Vuelve a conectar tu ${channel}${name ? ` (${name})` : ''}`,
    /** `what` es una de las frases de arriba. */
    body: (what: string) => `${what} Vuelve a conectar la cuenta desde Canales.`,
  },
} as const;
