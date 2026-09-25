"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { NARRATIVE_MAX_CHARS, writeNarrative } from "@mc/core/outreach/narrativa";
import {
  claimPerfilRecalc, computePerfil, getPrimaryCreator, llmBudgetExhausted, PerfilComercialError, recordProfileLlmCalls,
  releasePerfilRecalc, saveNarrativeEdit, savePerfilComercial,
} from "@mc/db/queries/perfil-comercial";
import { formatterFor, type Formatter } from "@/lib/format";
import { narrativeModelFromEnv } from "@/lib/llm/narrativa";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../_lib/db";
import { formatClaim } from "./cifras";
import { MESSAGES } from "./messages";
import { puedeEditarElPerfil } from "./permiso";
import { describirProblemas } from "./problemas";

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
 *   1. tomar la marca de «recalculando» (claimPerfilRecalc), leer las
 *      filas y armar el perfil (una transacción). Con la marca, dos
 *      «Recalcular» a la vez no llaman los dos al modelo ni se pasan del
 *      tope diario por una llamada cada uno: el segundo dice que ya hay
 *      uno en curso. La marca anota la narrativa que había;
 *   2. escribir la narrativa: claude-sonnet-5 si hay llave y presupuesto,
 *      la plantilla si no (red, SIN transacción abierta: una transacción
 *      que espera a una API retiene una conexión del pooler). Cada
 *      llamada se registra en outbound_llm_call apenas responde (su
 *      propia transacción), y el tope se vuelve a consultar antes de
 *      cada intento: si la acción se corta después, lo pagado ya está en
 *      la bitácora y el tope lo ve;
 *   3. guardar y soltar la marca (otra transacción). Si mientras tanto
 *      alguien guardó una edición de la narrativa, no se pisa
 *      (stale_edit): la confirmación de «Recalcular» se pidió antes.
 *   Si algo falla después del paso 1, la marca se suelta igual; si la
 *   función la corta Vercel, vence sola (PERFIL_RECALCULO_TTL_S).
 *
 * El tiempo: dos intentos de a lo sumo 25 s cada uno (lib/llm/narrativa.ts,
 * sin reintentos del SDK) caben en el maxDuration de 60 s de la página.
 */

const RUTA = "/ventas/perfil";
const t = MESSAGES;

export type ResultadoAccion = { ok: true; message: string } | { ok: false; message: string; detalles: string[] };

async function formateador(): Promise<Formatter> {
  return formatterFor(await getCurrentWorkspace());
}

export async function recalcularPerfil(): Promise<ResultadoAccion> {
  if (!(await puedeEditarElPerfil())) return { ok: false, message: t.sinPermiso, detalles: [] };
  let marca: { creatorId: string; token: string } | null = null;
  try {
    const leido = await withWorkspace(async (tx) => {
      const creador = await getPrimaryCreator(tx);
      if (!creador) return null;
      const claim = await claimPerfilRecalc(tx, creador.id);
      return { creatorId: creador.id, claim, perfil: await computePerfil(tx, creador.id) };
    });
    if (!leido) return { ok: false, message: t.narrativa.errores.creator_not_found, detalles: [] };
    marca = { creatorId: leido.creatorId, token: leido.claim.token };

    const f = await formateador();
    const narrativa = await writeNarrative(leido.perfil, {
      model: narrativeModelFromEnv(),
      formatClaim: (c) => formatClaim(c, f),
      locale: f.locale,
      // Antes de cada intento: el primero pudo haber llevado el gasto del día al tope.
      budgetExhausted: () => withWorkspace((tx) => llmBudgetExhausted(tx)),
      // Apenas responde, antes de verificarla: lo pagado queda en la bitácora aunque la acción se corte.
      onCall: (uso) => withWorkspace((tx) => recordProfileLlmCalls(tx, [uso])),
    });
    const token = marca.token;
    await withWorkspace((tx) =>
      savePerfilComercial(tx, leido.perfil, narrativa, { expectedWrittenAt: leido.claim.narrativeWrittenAt, recalcToken: token }),
    );
    // Guardar la soltó en la misma transacción.
    marca = null;
  } catch (error) {
    if (error instanceof PerfilComercialError && error.code === "recalc_in_progress") {
      return { ok: false, message: t.recalcular.enCurso, detalles: [] };
    }
    if (error instanceof PerfilComercialError && error.code === "stale_edit") {
      return { ok: false, message: t.recalcular.edicionNueva, detalles: [] };
    }
    console.error("[ventas/perfil] recalcular", error);
    return { ok: false, message: t.recalcular.error, detalles: [] };
  } finally {
    const suelta = marca;
    if (suelta) {
      await withWorkspace((tx) => releasePerfilRecalc(tx, suelta.creatorId, suelta.token)).catch((e: unknown) =>
        console.error("[ventas/perfil] soltar la marca de recalcular", e),
      );
    }
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
        return { ok: false, message: t.narrativa.errores.titulo, detalles: describirProblemas(error.issues, f.int(NARRATIVE_MAX_CHARS)) };
      }
      return { ok: false, message: t.narrativa.errores[error.code], detalles: [] };
    }
    console.error("[ventas/perfil] guardar narrativa", error);
    return { ok: false, message: t.narrativa.errores.generico, detalles: [] };
  }
}
