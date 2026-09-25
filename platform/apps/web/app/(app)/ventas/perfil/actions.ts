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
import { puedeEditarElPerfil } from "./permiso";

/**
 * Las acciones de /ventas/perfil (VEN-11). El workspace lo fija
 * withWorkspace; aquí no llega ni sale ningún id: el creador es el
 * principal del workspace, el mismo que usa Cotizar.
 *
 * Las dos acciones exigen el rol (puedeEditarElPerfil: owner, admin o
 * member) ANTES de tocar la base o el modelo: un 'viewer' o un 'client'
 * del espacio no reescribe la narrativa ni gasta contra el tope diario.
 *
 * Recalcular son tres pasos, a propósito sin una transacción que los
 * abarque:
 *   1. leer las filas y armar el perfil (una transacción);
 *   2. escribir la narrativa: claude-sonnet-5 si hay llave y presupuesto,
 *      la plantilla si no (red, SIN transacción abierta: una transacción
 *      que espera a una API retiene una conexión del pooler). Cada
 *      llamada se registra en outbound_llm_call apenas responde (su
 *      propia transacción), y el tope se vuelve a consultar antes de
 *      cada intento: si la acción se corta después, lo pagado ya está en
 *      la bitácora y el tope lo ve;
 *   3. guardar (otra transacción).
 *
 * El tiempo: dos intentos de a lo sumo 25 s cada uno (lib/llm/narrativa.ts,
 * sin reintentos del SDK) caben en el maxDuration de 60 s de la página.
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
            : i.code === "number_word" ? e.number_word(i.text)
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
  if (!(await puedeEditarElPerfil())) return { ok: false, message: t.sinPermiso, detalles: [] };
  try {
    const perfil = await withWorkspace(async (tx) => {
      const creador = await getPrimaryCreator(tx);
      return creador ? computePerfil(tx, creador.id) : null;
    });
    if (!perfil) return { ok: false, message: t.narrativa.errores.creator_not_found, detalles: [] };

    const f = await formateador();
    const narrativa = await writeNarrative(perfil, {
      model: narrativeModelFromEnv(),
      formatClaim: (c) => formatClaim(c, f),
      locale: f.locale,
      // Antes de cada intento: el primero pudo haber llevado el gasto del día al tope.
      budgetExhausted: () => withWorkspace((tx) => llmBudgetExhausted(tx)),
      // Apenas responde, antes de verificarla: lo pagado queda en la bitácora aunque la acción se corte.
      onCall: (uso) => withWorkspace((tx) => recordProfileLlmCalls(tx, [uso])),
    });
    await withWorkspace((tx) => savePerfilComercial(tx, perfil, narrativa));
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
  if (!(await puedeEditarElPerfil())) return { ok: false, message: t.sinPermiso, detalles: [] };
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
