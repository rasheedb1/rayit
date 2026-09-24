"use server";

import { revalidatePath } from "next/cache";
import { isUuid } from "@mc/db";
import { ChannelCapError, disconnectChannelAccount, updateChannelAccountCaps } from "@mc/db/queries/canales";
import { withWorkspace } from "@/lib/db";
import { formatterFor } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { MESSAGES } from "./messages";

export interface LimitesState {
  errors?: { dailyCap?: string; weeklyCap?: string };
  message?: string;
  notice?: string;
}

/** Vacío = sin límite propio (manda la política); si no, un entero. El techo lo comprueba @mc/db. */
function parseCap(raw: FormDataEntryValue | null): number | null | "invalid" {
  const v = String(raw ?? "").trim();
  if (v === "") return null;
  if (!/^\d{1,6}$/.test(v)) return "invalid";
  return Number(v);
}

/** Guarda los límites de una cuenta, nunca por encima del techo del canal. */
export async function guardarLimites(_prev: LimitesState, formData: FormData): Promise<LimitesState> {
  const accountId = String(formData.get("accountId") ?? "");
  if (!isUuid(accountId)) return { message: MESSAGES.caps.notFound };
  const dailyCap = parseCap(formData.get("dailyCap"));
  const weeklyCap = parseCap(formData.get("weeklyCap"));
  // El techo ya formateado con el locale del espacio, como lo pintó la pantalla.
  const maxDaily = String(formData.get("maxDaily") ?? "");
  const maxWeekly = String(formData.get("maxWeekly") ?? "");
  if (dailyCap === "invalid" || weeklyCap === "invalid") {
    return {
      errors: {
        ...(dailyCap === "invalid" ? { dailyCap: MESSAGES.caps.invalid(maxDaily) } : {}),
        ...(weeklyCap === "invalid" ? { weeklyCap: MESSAGES.caps.invalid(maxWeekly) } : {}),
      },
    };
  }
  try {
    const ok = await withWorkspace((tx) => updateChannelAccountCaps(tx, accountId, { dailyCap, weeklyCap }));
    if (!ok) return { message: MESSAGES.caps.notFound };
  } catch (err) {
    if (err instanceof ChannelCapError) {
      const f = formatterFor(await getCurrentWorkspace());
      return { errors: { [err.field]: MESSAGES.caps.invalid(f.int(err.max)) } };
    }
    throw err;
  }
  revalidatePath("/ventas/canales");
  return { notice: MESSAGES.caps.saved };
}

/** Desconectar es de la persona: la fila queda 'disconnected' y el token lo borra el keepalive. */
export async function desconectar(formData: FormData): Promise<void> {
  const accountId = String(formData.get("accountId") ?? "");
  if (!isUuid(accountId)) return;
  await withWorkspace((tx) => disconnectChannelAccount(tx, accountId));
  revalidatePath("/ventas/canales");
}
