/**
 * El correo de la plataforma hacia sus usuarios (no el outreach, que sale
 * del Gmail de cada creador): hoy, el resumen diario de alertas de VEN-15.
 *
 * SMTP_URL dice a qué servidor (Mailpit en local: smtp://localhost:1025,
 * con su bandeja en http://localhost:8025) y MAIL_FROM quién firma. Sin
 * SMTP_URL, o en producción sin MAIL_FROM, no hay correo: el job lo dice
 * en el registro y deja las alertas sin marcar como enviadas, para
 * mandarlas cuando se configure.
 */
import nodemailer from 'nodemailer';

export interface MailMessage {
  /** Uno o varios destinatarios: el resumen de alertas va en un solo correo a todos los dueños. */
  to: string | readonly string[];
  subject: string;
  text: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/**
 * Quién firma si no hay MAIL_FROM, SOLO fuera de producción (Mailpit lo
 * acepta todo). En producción un remitente de un dominio .invalid rebota
 * o va a spam: sin MAIL_FROM no hay cartero (missingMailConfig).
 */
export const MAIL_FROM_DEFAULT = 'On Cue <no-responder@oncue.invalid>';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Lo que falta para poder enviar, o null si está todo: SMTP_URL siempre;
 * MAIL_FROM en producción (NODE_ENV=production).
 */
export function missingMailConfig(env: Env): 'SMTP_URL' | 'MAIL_FROM' | null {
  if (!env['SMTP_URL']?.trim()) return 'SMTP_URL';
  if (env['NODE_ENV'] === 'production' && !env['MAIL_FROM']?.trim()) return 'MAIL_FROM';
  return null;
}

/** El cartero SMTP de SMTP_URL, o null si falta algo (missingMailConfig). */
export function smtpMailerFromEnv(env: Env): Mailer | null {
  if (missingMailConfig(env)) return null;
  const url = env['SMTP_URL']!.trim();
  const from = env['MAIL_FROM']?.trim() || MAIL_FROM_DEFAULT;
  const transport = nodemailer.createTransport(url);
  return {
    async send(msg) {
      await transport.sendMail({ from, to: typeof msg.to === 'string' ? msg.to : [...msg.to], subject: msg.subject, text: msg.text });
    },
  };
}
