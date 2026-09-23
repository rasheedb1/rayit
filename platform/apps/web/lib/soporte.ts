import type { Env } from "@/lib/auth/config";

/**
 * El correo de contacto del producto (datos personales, soporte), desde
 * SUPPORT_EMAIL. Antes estaba escrito a mano en los textos de /legal, y
 * era un correo personal: ni se puede enseñar a un cliente que paga ni
 * cambia por despliegue sin tocar código.
 *
 * Sin la variable (o con algo que no parece un correo) devuelve null y
 * la página lo dice en vez de inventar una dirección: un correo de
 * contacto que no existe es peor que ninguno. Ver platform/.env.example.
 */
export function correoDeSoporte(env: Env = process.env): string | null {
  const valor = env.SUPPORT_EMAIL?.trim() ?? "";
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(valor) ? valor : null;
}
