"use server";

import { isAuthConfigured } from "@/lib/auth/config";
import { MESSAGES } from "@/lib/auth/messages";
import { origenDeLaPeticion } from "@/lib/auth/origen";
import { destinoSeguro } from "@/lib/auth/rutas";
import { createServerSupabase } from "@/lib/auth/supabase";

/**
 * Lo único que hace /login: pedirle a Supabase que mande un enlace al
 * correo. No crea sesión, no toca la base y no dice si ese correo
 * existía —eso último a propósito: un formulario que responde distinto
 * a un correo registrado que a uno que no es un enumerador de usuarios.
 */
export interface EstadoLogin {
  /** "inicio" pide el correo; "enviado" muestra «revisa tu correo». */
  estado: "inicio" | "enviado";
  email: string;
  error?: string;
  /** Solo tras pulsar «Reenviar», para confirmarlo sin cambiar de pantalla. */
  reenviado?: boolean;
}

export const ESTADO_INICIAL: EstadoLogin = { estado: "inicio", email: "" };

/** Un correo con forma de correo. La verdad la dice el enlace que llega, no esto. */
const CORREO_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function enviarEnlace(_prev: EstadoLogin, formData: FormData): Promise<EstadoLogin> {
  const accion = String(formData.get("accion") ?? "enviar");
  const email = String(formData.get("email") ?? "").trim();
  const next = String(formData.get("next") ?? "");

  // «Usar otro correo» no manda nada: vuelve al formulario vacío.
  if (accion === "cambiar") return { estado: "inicio", email: "" };

  if (!isAuthConfigured()) {
    return { estado: "inicio", email, error: MESSAGES.login.sinConfigurar.titulo };
  }
  if (email.length > 254 || !CORREO_RE.test(email)) {
    return { estado: "inicio", email, error: MESSAGES.login.errores.correoInvalido };
  }

  const destino = destinoSeguro(next);
  const origen = await origenDeLaPeticion();
  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${origen}/auth/callback?next=${encodeURIComponent(destino)}`,
      // Entrar y registrarse son lo mismo: quien no existe se crea al
      // abrir el enlace, y su espacio lo crea /auth/callback.
      shouldCreateUser: true,
    },
  });

  if (error) {
    // El correo integrado de Supabase tiene un límite bajo por hora
    // (ver apps/web/README.md): 429 es el caso que la gente ve de
    // verdad, y merece su propio texto en vez del genérico.
    const limite = error.status === 429 || /rate limit|too many/i.test(error.message);
    return {
      estado: "inicio",
      email,
      error: limite ? MESSAGES.login.errores.limite : MESSAGES.login.errores.generico,
    };
  }

  return { estado: "enviado", email, reenviado: accion === "reenviar" };
}
