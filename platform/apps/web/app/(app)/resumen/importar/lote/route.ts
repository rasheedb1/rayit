import { recibirLote } from "../_lib/lote";

/**
 * POST /resumen/importar/lote: la escritura de la importación por CSV,
 * con su propio techo de cuerpo (RES-6). Todo lo que hace está en
 * `_lib/lote.ts`; aquí solo se monta la ruta.
 *
 * No puede ser `importar/route.ts`: ese segmento ya tiene su page.tsx, y
 * Next no deja una página y una ruta en la misma URL.
 */
export function POST(req: Request): Promise<Response> {
  return recibirLote(req);
}
