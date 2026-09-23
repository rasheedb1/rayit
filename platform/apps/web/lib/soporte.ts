import type { Env } from "@/lib/auth/config";

/**
 * El correo de contacto del producto (datos personales, soporte), desde
 * SUPPORT_EMAIL. Antes estaba escrito a mano en los textos de /legal, y
 * era un correo personal: ni se puede enseñar a un cliente que paga ni
 * cambia por despliegue sin tocar código.
 *
 * Sin la variable (o con algo que no parece un correo) devuelve null y
 * quien lo pinta lo dice en vez de inventar una dirección: un correo de
 * contacto que no existe es peor que ninguno. Ver platform/.env.example.
 *
 * Lo usan tres sitios, y en los tres la salida sin correo es distinta
 * pero nunca «escríbenos» a secas: /legal dice que se publicará, /login
 * con una cuenta bloqueada ofrece entrar con otro correo, y el selector
 * de espacio dice el tope sin prometer un contacto que no puede dar.
 *
 * En producción, que falte se dice en voz alta en el log (una vez por
 * proceso), con el mismo criterio que DATABASE_URL en from-env.ts: es
 * el único contacto que ve una persona con la cuenta bloqueada.
 */
const CORREO_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;

let avisado = false;

export function correoDeSoporte(env: Env = process.env, avisar: (mensaje: string) => void = console.error): string | null {
  const valor = env.SUPPORT_EMAIL?.trim() ?? "";
  if (CORREO_RE.test(valor)) return valor;
  if (env.NODE_ENV === "production" && !avisado) {
    avisado = true;
    avisar(
      "[soporte] SUPPORT_EMAIL no está fijado (o no es un correo) en producción: /legal, /login y el selector de espacio " +
        'no pueden dar ningún contacto. make vercel.run ARGS="env add SUPPORT_EMAIL production"',
    );
  }
  return null;
}

/** El `mailto:` del correo de soporte, o null si no hay correo que dar. */
export function enlaceDeSoporte(env: Env = process.env, avisar?: (mensaje: string) => void): string | null {
  const correo = correoDeSoporte(env, avisar);
  return correo ? `mailto:${correo}` : null;
}
