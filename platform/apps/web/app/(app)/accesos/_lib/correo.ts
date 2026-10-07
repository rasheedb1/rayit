import "server-only";
import nodemailer from "nodemailer";
import type { Env } from "@/lib/auth/config";

/**
 * El correo de una invitación de Equipo (ACC-4).
 *
 * Usa el mismo SMTP de la plataforma que las alertas del outreach
 * (SMTP_URL y MAIL_FROM, platform/.env.example §Correo). Tres
 * resultados, y la pantalla dice cuál fue sin inventar nada:
 *
 *   enviado         el servidor SMTP lo aceptó
 *   sin_configurar  no hay SMTP_URL (o, en producción, no hay MAIL_FROM):
 *                   no se intenta y la pantalla muestra el enlace para copiar
 *   fallo           se intentó y el servidor no contestó o lo rechazó:
 *                   igual, el enlace para copiar
 *
 * En los tres casos la invitación ya existe: el correo es una forma de
 * entregar el enlace, no una condición para invitar. El enlace viaja en
 * el cuerpo y en ningún otro sitio; no se registra.
 */
export type EnvioInvitacion = "enviado" | "sin_configurar" | "fallo";

export interface CorreoDeInvitacion {
  para: string;
  asunto: string;
  texto: string;
}

/** Lo que el cartero usa de un transporte de nodemailer: se inyecta en las pruebas. */
export interface TransporteDeCorreo {
  sendMail(mail: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

/** Quién firma si no hay MAIL_FROM, SOLO fuera de producción (Mailpit lo acepta todo). El mismo que el worker. */
const REMITENTE_DE_DESARROLLO = "On Cue <no-responder@oncue.invalid>";

/** Lo que tarda como mucho el SMTP antes de rendirse: la persona está esperando el formulario. */
const TECHO_MS = 8_000;

/** Lo más largo que entra en el correo del nombre de un espacio o de quien invita. */
export const NOMBRE_EN_CORREO_MAX = 60;

/**
 * Un nombre que puso alguien (el del espacio, el de quien invita), listo
 * para el asunto y el cuerpo de un correo que firma la plataforma: en
 * una sola línea (saltos, tabuladores y caracteres de control pasan a un
 * espacio) y recortado a NOMBRE_EN_CORREO_MAX con «…». Así un nombre
 * no puede traer un párrafo entero de texto engañoso, ni partir el
 * asunto en dos cabeceras.
 */
export function nombreParaCorreo(texto: string, max = NOMBRE_EN_CORREO_MAX): string {
  const limpio = texto.replace(/[\p{C}\s]+/gu, " ").trim();
  const letras = [...limpio];
  return letras.length <= max ? limpio : `${letras.slice(0, max - 1).join("").trimEnd()}…`;
}

/** El remitente, o null si no hay con qué enviar. */
export function remitente(env: Env = process.env): string | null {
  if (!env.SMTP_URL?.trim()) return null;
  const from = env.MAIL_FROM?.trim();
  if (from) return from;
  return env.NODE_ENV === "production" ? null : REMITENTE_DE_DESARROLLO;
}

function transporteDesde(url: string): TransporteDeCorreo {
  return nodemailer.createTransport({
    url,
    connectionTimeout: TECHO_MS,
    greetingTimeout: TECHO_MS,
    socketTimeout: TECHO_MS,
  } as Parameters<typeof nodemailer.createTransport>[0]);
}

/**
 * Envía la invitación si hay correo configurado. Nunca lanza: un SMTP
 * caído no deshace una invitación ya creada; se dice y se muestra el
 * enlace.
 */
export async function enviarInvitacion(
  correo: CorreoDeInvitacion,
  env: Env = process.env,
  crear: (url: string) => TransporteDeCorreo = transporteDesde,
): Promise<EnvioInvitacion> {
  const from = remitente(env);
  if (!from) return "sin_configurar";
  try {
    await crear(env.SMTP_URL!.trim()).sendMail({ from, to: correo.para, subject: correo.asunto, text: correo.texto });
    return "enviado";
  } catch (err) {
    // Sin el correo ni el enlace en el registro: solo que falló y por qué.
    console.error("[equipo] no se pudo enviar la invitación por correo:", err instanceof Error ? err.message : err);
    return "fallo";
  }
}
