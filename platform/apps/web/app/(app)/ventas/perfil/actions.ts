"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { NARRATIVE_MAX_CHARS, writeNarrative, type NarrativeIssue } from "@mc/core/outreach/narrativa";
import {
  computePerfil, getPrimaryCreator, llmBudgetExhausted, PerfilComercialError, recordProfileLlmCalls, saveNarrativeEdit,
  savePerfilComercial,
} from "@mc/db/queries/perfil-comercial";
import { formatterFor, type Formatter } from "@/lib/format";
import { narrativeModelFromEnv } from "@/lib/llm/narrativa";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../_lib/db";
import { formatClaim } from "./cifras";
import { MESSAGES } from "./messages";

/**
 * Las acciones de /ventas/perfil (VEN-11). El workspace lo fija
 * withWorkspace; aquí no llega ni sale ningún id: el creador es el
 * principal del workspace, el mismo que usa Cotizar.
 *
 * Recalcular son tres pasos y dos transacciones, a propósito:
 *   1. leer las filas y armar el perfil (una transacción);
 *   2. escribir la narrativa: claude-sonnet-5 si hay llave y presupuesto,
 *      la plantilla si no (red, SIN transacción abierta: una transacción
 *      que espera a una API retiene una conexión del pooler);
 *   3. registrar cada llamada al modelo y guardar (otra transacción cada
 *      una: la bitácora de lo que ya se pagó no depende de que el
 *      guardado salga bien).
 */

const RUTA = "/ventas/perfil";
const t = MESSAGES;

export type ResultadoAccion = { ok: true; message: string } | { ok: false; message: string; detalles: string[] };

/** Lo que el verificador encontró, dicho para el creador. */
function problemas(issues: readonly NarrativeIssue[], f: Formatter): string[] {
  const e = t.narrativa.errores;
  const vistos = new Set<string>();
  const out: string[] = [];
  for (const i of issues) {
    const texto =
      i.code === "unknown_claim" ? e.unknown_claim(i.id)
        : i.code === "malformed_marker" ? e.malformed_marker(i.text)
          : i.code === "bare_number" ? e.bare_number(i.text)
            : i.code === "placeholder" ? e.placeholder(i.text)
              : i.code === "too_long" ? e.too_long(f.int(i.max))
                : e[i.code];
    if (!vistos.has(texto)) {
      vistos.add(texto);
      out.push(texto);
    }
  }
  return out;
}

async function formateador(): Promise<Formatter> {
  return formatterFor(await getCurrentWorkspace());
}

export async function recalcularPerfil(): Promise<ResultadoAccion> {
  try {
    const leido = await withWorkspace(async (tx) => {
      const creador = await getPrimaryCreator(tx);
      if (!creador) return null;
      return { perfil: await computePerfil(tx, creador.id), sinPresupuesto: await llmBudgetExhausted(tx) };
    });
    if (!leido) return { ok: false, message: t.narrativa.errores.creator_not_found, detalles: [] };

    const f = await formateador();
    const narrativa = await writeNarrative(leido.perfil, {
      model: narrativeModelFromEnv(),
      formatClaim: (c) => formatClaim(c, f),
      budgetExhausted: leido.sinPresupuesto,
    });
    if (narrativa.calls.length) await withWorkspace((tx) => recordProfileLlmCalls(tx, narrativa.calls));
    await withWorkspace((tx) => savePerfilComercial(tx, leido.perfil, narrativa));
  } catch (error) {
    console.error("[ventas/perfil] recalcular", error);
    return { ok: false, message: t.recalcular.error, detalles: [] };
  }
  revalidatePath(RUTA);
  return { ok: true, message: t.recalcular.listo };
}

const EdicionSchema = z.object({
  // El verificador dice «demasiado larga» con la cifra; esto solo corta lo absurdo antes de leerlo.
  texto: z.string().max(NARRATIVE_MAX_CHARS * 4),
  escritaEl: z.iso.datetime(),
});

export async function guardarNarrativa(texto: string, escritaEl: string): Promise<ResultadoAccion> {
  const f = await formateador();
  const entrada = EdicionSchema.safeParse({ texto, escritaEl });
  if (!entrada.success) return { ok: false, message: t.narrativa.errores.titulo, detalles: [t.narrativa.errores.too_long(f.int(NARRATIVE_MAX_CHARS))] };
  try {
    await withWorkspace(async (tx) => {
      const creador = await getPrimaryCreator(tx);
      if (!creador) throw new PerfilComercialError("creator_not_found", "sin creador");
      return saveNarrativeEdit(tx, creador.id, entrada.data.texto, entrada.data.escritaEl);
    });
    revalidatePath(RUTA);
    return { ok: true, message: t.narrativa.guardada };
  } catch (error) {
    if (error instanceof PerfilComercialError) {
      if (error.code === "invalid_narrative") {
        return { ok: false, message: t.narrativa.errores.titulo, detalles: problemas(error.issues, f) };
      }
      return { ok: false, message: t.narrativa.errores[error.code], detalles: [] };
    }
    console.error("[ventas/perfil] guardar narrativa", error);
    return { ok: false, message: t.narrativa.errores.generico, detalles: [] };
  }
}
