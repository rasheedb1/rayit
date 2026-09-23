"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CATEGORIA_GASTO_IDS, RECURRENCIA_IDS } from "@mc/core";
import { createExpense, updateExpense, ExpenseNotFound, InvalidExpenseError } from "@mc/db/queries/finanzas";
import { DECIMAL_RE, firstErrors, formField, UUID_RE, type ActionState } from "@/lib/forms";
import { withWorkspace } from "../_lib/db";
import { MESSAGES } from "../_lib/messages";

const T = MESSAGES.gastos;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Lo que llega del formulario «Nuevo gasto» y de «Corregir el gasto»:
 * los mismos campos y las mismas reglas, porque corregir es volver a
 * guardar. `gastoId` vacío = alta.
 *
 * Las categorías y las recurrencias salen de las tuplas de @mc/core, no
 * escritas a mano: una categoría nueva allí llega sola aquí, y `z.enum`
 * las acepta sin forzar el tipo (mismo patrón que PLATFORMS en Resumen).
 */
const gastoSchema = z
  .object({
    gastoId: z.union([z.string().regex(UUID_RE, "El gasto que intentas corregir no es válido."), z.literal("")]),
    category: z.enum(CATEGORIA_GASTO_IDS, { message: "Elige la categoría del gasto." }),
    vendor: z.string().trim().max(200, "El proveedor no puede pasar de 200 caracteres."),
    description: z.string().trim().max(500, "La descripción no puede pasar de 500 caracteres."),
    amount: z.string().regex(DECIMAL_RE, "Escribe el monto del gasto."),
    incurredOn: z.string().regex(ISO_DATE_RE, "Elige la fecha del gasto."),
    // Una casilla manda "on" o no manda nada. Comparar con "on" en vez de
    // exigirlo con zod deja la validación sin un solo mensaje en inglés.
    isRecurring: z.string(),
    recurrence: z.union([z.enum(RECURRENCIA_IDS), z.literal("")], { message: "Di cada cuánto se repite." }),
    deductible: z.string(),
    receiptUrl: z.string().trim().max(2000, "El enlace del recibo no puede pasar de 2000 caracteres."),
  })
  .refine((v) => v.amount !== "0" && v.amount !== "0.0" && v.amount !== "0.00", {
    path: ["amount"],
    message: "El monto tiene que ser mayor que cero.",
  })
  .refine((v) => v.isRecurring !== "on" || v.recurrence !== "", {
    path: ["recurrence"],
    message: "Di cada cuánto se repite.",
  });

/**
 * Registra un gasto o corrige uno que ya existe. No borra: quitar un
 * gasto del MVP es editarlo y decir en la descripción que fue un error
 * (decisión 7 de docs/propuestas/FIN-5.md).
 *
 * TODO(ACC-1): requirePermission('finanzas.gasto.registrar') como PRIMERA
 * línea. El catálogo de permisos (packages/core/src/permisos.ts, rama
 * nicolas/ACC-1-catalogo-permisos) todavía no está en main; ACC-1 no
 * distingue crear de editar en gastos, así que las dos usan esa clave.
 * TODO(ACC-2): la bitácora la deja hoy queries/finanzas.ts dentro de la
 * misma transacción de la escritura (audit() cuando ACC-2 entre).
 */
export async function guardarGasto(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = gastoSchema.safeParse({
    gastoId: formField(formData, "gastoId"),
    category: formField(formData, "category"),
    vendor: formField(formData, "vendor"),
    description: formField(formData, "description"),
    amount: formField(formData, "amount"),
    incurredOn: formField(formData, "incurredOn"),
    isRecurring: formField(formData, "isRecurring"),
    recurrence: formField(formData, "recurrence"),
    deductible: formField(formData, "deductible"),
    receiptUrl: formField(formData, "receiptUrl"),
  });
  if (!parsed.success) return { errors: firstErrors(parsed.error.issues) };
  const v = parsed.data;

  const input = {
    category: v.category,
    vendor: v.vendor || null,
    description: v.description || null,
    amount: v.amount,
    incurredOn: v.incurredOn,
    isRecurring: v.isRecurring === "on",
    // Si deja de ser recurrente, la recurrencia no se guarda: lo hace la consulta.
    recurrence: v.recurrence || null,
    receiptUrl: v.receiptUrl || null,
    deductible: v.deductible === "on",
  };

  const editando = v.gastoId !== "";
  try {
    await withWorkspace((tx) => (editando ? updateExpense(tx, v.gastoId, input) : createExpense(tx, input)));
  } catch (err) {
    // Un error de dominio sabe de qué campo es: se pinta en su campo, no
    // como una alerta suelta arriba del formulario.
    if (err instanceof InvalidExpenseError) {
      return err.field ? { errors: { [err.field]: err.messageEs } } : { message: err.messageEs };
    }
    if (err instanceof ExpenseNotFound) return { message: err.messageEs };
    return { message: err instanceof Error ? err.message : "No se pudo guardar el gasto." };
  }

  // El mes del gasto y la proyección cambian; las facturas no.
  revalidatePath("/finanzas/gastos");
  return { ok: true, message: editando ? T.form.editado : T.form.guardado };
}
