"use server";

import { revalidatePath } from "next/cache";
import { isUuid } from "@mc/db";
import { ChannelCapError, disconnectChannelAccount, getChannelLimits, updateChannelAccountCaps } from "@mc/db/queries/canales";
import { withWorkspace } from "@/lib/db";
import { formatterFor } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { MESSAGES } from "./messages";

export interface LimitesState {
  errors?: { dailyCap?: string; weeklyCap?: string };
  message?: string;
  notice?: string;
}

/** Vacío = sin límite propio (rige el máximo de la cuenta); si no, un entero. El máximo lo comprueba @mc/db. */
function parseCap(raw: FormDataEntryValue | null): number | null | "invalid" {
  const v = String(raw ?? "").trim();
  if (v === "") return null;
  if (!/^\d{1,6}$/.test(v)) return "invalid";
  return Number(v);
}

/**
 * Guarda los límites de una cuenta, nunca por encima de su máximo (el
 * menor entre la política del espacio y lo que aguanta el proveedor). El
 * máximo se lee en el servidor (outreach_channel_account_limits, 0040):
 * del formulario solo llegan el id y los dos números.
 */
export async function guardarLimites(_prev: LimitesState, formData: FormData): Promise<LimitesState> {
  const accountId = String(formData.get("accountId") ?? "");
  if (!isUuid(accountId)) return { message: MESSAGES.caps.notFound };
  const dailyCap = parseCap(formData.get("dailyCap"));
  const weeklyCap = parseCap(formData.get("weeklyCap"));
  const f = formatterFor(await getCurrentWorkspace());
  if (dailyCap === "invalid" || weeklyCap === "invalid") {
    const limits = await withWorkspace((tx) => getChannelLimits(tx, accountId));
    if (!limits) return { message: MESSAGES.caps.notFound };
    return {
      errors: {
        ...(dailyCap === "invalid" ? { dailyCap: MESSAGES.caps.invalid(f.int(limits.maxDaily)) } : {}),
        ...(weeklyCap === "invalid" ? { weeklyCap: MESSAGES.caps.invalid(f.int(limits.maxWeekly)) } : {}),
      },
    };
  }
  try {
    const ok = await withWorkspace((tx) => updateChannelAccountCaps(tx, accountId, { dailyCap, weeklyCap }));
    if (!ok) return { message: MESSAGES.caps.notFound };
  } catch (err) {
    if (err instanceof ChannelCapError) {
      const text = err.problem === "daily_above_weekly" ? MESSAGES.caps.dailyAboveWeekly(f.int(err.max)) : MESSAGES.caps.invalid(f.int(err.max));
      return { errors: { [err.field]: text } };
    }
    throw err;
  }
  revalidatePath("/ventas/canales");
  return { notice: MESSAGES.caps.saved };
}

/**
 * Desconectar es de la persona: la fila queda 'disconnected' y pendiente
 * de soltar (0040). El worker (sales.channels_release, cada cinco
 * minutos) revoca el permiso de Google o borra la cuenta y sus avisos en
 * Unipile, que deja de cobrarla.
 */
export async function desconectar(formData: FormData): Promise<void> {
  const accountId = String(formData.get("accountId") ?? "");
  if (!isUuid(accountId)) return;
  await withWorkspace((tx) => disconnectChannelAccount(tx, accountId));
  revalidatePath("/ventas/canales");
}
