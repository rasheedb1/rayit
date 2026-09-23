"use server";

import { claveDeCaptcha, esErrorDeCaptcha } from "@/lib/auth/captcha";
import { isAuthConfigured } from "@/lib/auth/config";
import { MESSAGES } from "@/lib/auth/messages";
import { OrigenNoConfiguradoError, origenDeLaPeticion } from "@/lib/auth/origen";
import { marcarPedido } from "@/lib/auth/pedido";
import { destinoSeguro } from "@/lib/auth/rutas";
import { createServerSupabase } from "@/lib/auth/supabase";

/**
 * Lo único que hace /login: pedirle a Supabase que mande un enlace al
 * correo. No crea sesión, no toca la base y no dice si ese correo
 * existía —eso último a propósito: un formulario que responde distinto
 * a un correo registrado que a uno que no es un enumerador de usuarios.
 *
 * OJO: este archivo lleva "use server", así que Next convierte TODOS
 * sus exports en tiempo de ejecución en referencias de servidor y exige
 * que sean funciones async. Una constante exportada aquí —el estado
 * inicial del formulario vivía en esta línea— revienta el primer envío
 * con «A "use server" file can only export async functions, found
 * object» y deja la pantalla de entrada en un 500. Las interfaces sí
 * pueden salir: TypeScript las borra al compilar y no existen en tiempo
 * de ejecución. El estado inicial vive en app/login/formulario.tsx, que
 * es quien lo usa. Lo vigila app/login/acciones.test.ts.
 *
 * CAPTCHA (CIM-10): con TURNSTILE_SITE_KEY fijada, el formulario manda
 * `captchaToken` y aquí se pasa a Supabase, que es quien lo verifica
 * (lib/auth/captcha.ts explica por qué no basta con un límite en la
 * app). Sin token no se llama a Supabase: sería un correo menos del cupo
 * para nada.
 *
 * Y al salir bien deja la cookie `mc.enlace` (lib/auth/pedido.ts): este
 * navegador pidió un enlace para este correo. /auth/confirm la usa para
 * no dejar entrar sin aviso con un enlace que pidió otra persona.
 */
export interface EstadoLogin {
  /** "inicio" pide el correo; "enviado" muestra «revisa tu correo». */
  estado: "inicio" | "enviado";
  email: string;
  error?: string;
  /** Solo tras pulsar «Reenviar», para confirmarlo sin cambiar de pantalla. */
  reenviado?: boolean;
  /**
   * Cuándo salió el último enlace (ms desde epoch, reloj del servidor).
   * El formulario lo usa como llave de la cuenta atrás de «Reenviar»:
   * cambia con cada enlace que sale y NO cambia cuando reenviar falla,
   * así que un error no reinicia el minuto de espera.
   */
  enviadoEn?: number;
}

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

  // Si falla REENVIAR, la persona se queda en «Revisa tu correo», con
  // su correo y el error debajo: el primer enlace sigue en camino y
  // devolverla al formulario vacío parecía un reinicio (ronda 4).
  const fallo = (texto: string): EstadoLogin => {
    if (accion === "reenviar") {
      const previo = Number(formData.get("enviadoEn"));
      return { estado: "enviado", email, error: texto, ...(Number.isFinite(previo) && previo > 0 ? { enviadoEn: previo } : {}) };
    }
    return { estado: "inicio", email, error: texto };
  };

  const captchaToken = String(formData.get("captchaToken") ?? "").trim();
  if (claveDeCaptcha().siteKey && !captchaToken) return fallo(MESSAGES.login.errores.captcha);

  const destino = destinoSeguro(next);
  let origen: string;
  try {
    origen = await origenDeLaPeticion();
  } catch (err) {
    // Producción sin APP_URL: el enlace no puede salir hacia un origen
    // que diga una cabecera del cliente (lib/auth/origen.ts). Es un
    // fallo de configuración, no de la persona: al log, con el motivo.
    if (!(err instanceof OrigenNoConfiguradoError)) throw err;
    console.error(`[auth] ${err.message}`);
    return fallo(MESSAGES.login.errores.generico);
  }
  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${origen}/auth/callback?next=${encodeURIComponent(destino)}`,
      // Entrar y registrarse son lo mismo: quien no existe se crea al
      // abrir el enlace, y su espacio lo crea /auth/callback.
      shouldCreateUser: true,
      ...(captchaToken ? { captchaToken } : {}),
    },
  });

  if (error) {
    // El correo integrado de Supabase tiene un límite bajo por hora
    // (ver apps/web/README.md), y además no deja pedir otro enlace para
    // el mismo correo antes de 60 s: los dos responden 429, que es el
    // caso que la gente ve de verdad y merece su propio texto.
    const limite = error.status === 429 || /rate limit|too many/i.test(error.message);
    if (limite) return fallo(MESSAGES.login.errores.limite);
    return fallo(esErrorDeCaptcha(error) ? MESSAGES.login.errores.captcha : MESSAGES.login.errores.generico);
  }

  await marcarPedido(email);
  return { estado: "enviado", email, reenviado: accion === "reenviar", enviadoEn: Date.now() };
}
