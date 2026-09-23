import type { Env } from "./config";

/**
 * La comprobación anti-bots de /login: Cloudflare Turnstile.
 *
 * Por qué hace falta. El enlace mágico sale de un endpoint público de
 * Supabase (/auth/v1/otp) y la anon key viaja al navegador por diseño,
 * así que cualquiera puede pedir enlaces sin pasar por esta aplicación.
 * El cupo de correos es POR PROYECTO, no por persona: un script basta
 * para agotarlo y que nadie pueda entrar a On Cue. Un límite por IP en
 * la app no lo para (el script no pasa por ella). Lo único que lo para
 * es que Supabase exija un token de CAPTCHA en cada petición:
 * Authentication → Attack Protection → Enable Captcha protection, con
 * Turnstile y su CLAVE SECRETA (que vive en el panel de Supabase, no
 * aquí). La aplicación solo pone el widget y manda el token con
 * `signInWithOtp({ options: { captchaToken } })`.
 *
 * La CLAVE DE SITIO (TURNSTILE_SITE_KEY) no es un secreto: la ve el
 * navegador. Se lee en el servidor y /login se la pasa al formulario
 * como prop, así que no hace falta un NEXT_PUBLIC_ ni tocar
 * next.config.ts.
 *
 * Sin la clave, el formulario funciona igual (sin widget) y:
 *   - fuera de producción, /login lo dice en una línea discreta;
 *   - en producción, el log del servidor lo dice una vez por proceso.
 * Si Supabase exige CAPTCHA y aquí falta la clave, cada envío falla con
 * «captcha verification process failed» y /login lo dice con su texto
 * (MESSAGES.login.errores.captcha). El orden para activarlo está en
 * apps/web/README.md, «Autenticación» → «El límite del correo».
 */
export interface Captcha {
  /** La clave pública del widget, o null si esta copia no tiene CAPTCHA. */
  siteKey: string | null;
}

/** Las claves de Turnstile son alfanuméricas con guiones (p. ej. `0x4AAAAAAA…`). */
const CLAVE_RE = /^[0-9A-Za-z_-]{10,100}$/;

let avisado = false;

export function claveDeCaptcha(env: Env = process.env, avisar: (mensaje: string) => void = console.warn): Captcha {
  const valor = env.TURNSTILE_SITE_KEY?.trim() ?? "";
  if (CLAVE_RE.test(valor)) return { siteKey: valor };
  if (env.NODE_ENV === "production" && !avisado) {
    avisado = true;
    avisar(
      "[auth] /login sin CAPTCHA: falta TURNSTILE_SITE_KEY. Cualquiera puede agotar el cupo de correos del proyecto de Supabase " +
        "pidiendo enlaces. Ver apps/web/README.md, «El límite del correo» (historia CIM-10).",
    );
  }
  return { siteKey: null };
}

/** ¿El error de Supabase es el de la comprobación anti-bots? */
export function esErrorDeCaptcha(error: { message?: string; code?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "captcha_failed" || /captcha/i.test(error.message ?? "");
}
