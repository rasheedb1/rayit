"use server";

import { z } from "zod";
import { listKnownPosts } from "@mc/db/queries/resumen";
import { withWorkspace } from "@/lib/db";
import { UUID_RE } from "@/lib/forms";
import { MAX_FILAS, MAX_ID } from "./_lib/csv";

/**
 * La única server action de la importación: una LECTURA pequeña (unos
 * cientos de ids) que cabe de sobra en el 1 MB por defecto de Next.
 *
 * La escritura ya no es una server action: va por el route handler de
 * `lote/route.ts`, con su propio techo de 5 MB (RES-6). Así el límite de
 * cuerpo de TODAS las server actions de la app vuelve al de Next.
 */

const esquemaConocidos = z.object({
  connectionId: z.string().regex(UUID_RE),
  ids: z.array(z.string().min(1).max(MAX_ID)).max(MAX_FILAS),
});

export type ResultadoConocidos =
  | { ok: true; conocidos: { id: string; ultimaLectura: string | null }[] }
  | { ok: false };

/**
 * Solo lectura: de estos identificadores, cuáles YA existen en la
 * cuenta de destino y cuándo se leyeron por última vez. La usa el paso 3
 * para avisar ANTES de escribir si un video recibe una lectura nueva o
 * si ya tiene una de esa fecha o posterior (y esta no se guardará). Si
 * falla, la previsualización sigue siendo válida, solo pierde ese aviso,
 * así que devuelve `{ ok: false }` y no lanza.
 *
 * El workspace lo fija el cliente de base: un connectionId de otro
 * workspace no existe para RLS y la respuesta sale vacía.
 */
export async function buscarPostsConocidos(entrada: unknown): Promise<ResultadoConocidos> {
  const parsed = esquemaConocidos.safeParse(entrada);
  if (!parsed.success) return { ok: false };
  try {
    const posts = await withWorkspace((tx) => listKnownPosts(tx, parsed.data.connectionId, parsed.data.ids));
    return { ok: true, conocidos: posts.map((p) => ({ id: p.externalPostId, ultimaLectura: p.lastCapturedAt })) };
  } catch (err) {
    console.error("[resumen/importar] no se pudo mirar qué videos ya estaban", err);
    return { ok: false };
  }
}
