/**
 * El correo de la plataforma hacia sus usuarios (no el outreach, que sale
 * del Gmail de cada creador): hoy, el resumen diario de alertas de VEN-15.
 *
 * SMTP_URL dice a qué servidor (Mailpit en local: smtp://localhost:1025,
 * con su bandeja en http://localhost:8025) y MAIL_FROM quién firma. Sin
 * SMTP_URL no hay correo: el job lo dice y deja las alertas sin marcar
 * como enviadas, para mandarlas cuando se configure.
 */
import nodemailer from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

export const MAIL_FROM_DEFAULT = 'On Cue <no-responder@oncue.invalid>';

/** El cartero SMTP de SMTP_URL, o null si no está configurado. */
export function smtpMailerFromEnv(env: Readonly<Record<string, string | undefined>>): Mailer | null {
  const url = env['SMTP_URL']?.trim();
  if (!url) return null;
  const from = env['MAIL_FROM']?.trim() || MAIL_FROM_DEFAULT;
  const transport = nodemailer.createTransport(url);
  return {
    async send(msg) {
      await transport.sendMail({ from, to: msg.to, subject: msg.subject, text: msg.text });
    },
  };
}
