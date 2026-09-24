/**
 * Lo que hacen las acciones de servidor de /ventas/canales (actions.ts),
 * como funciones con sus dependencias inyectadas: se prueban sin Next,
 * con pglite y con el rol que toque.
 *
 * Las tres empiezan por lo mismo: ¿puede quien pide gestionar los canales
 * de este espacio? (PUEDEN_GESTIONAR_CANALES, lib/auth/reglas.ts). La
 * pantalla ya no ofrece los botones a los demás roles, pero el servidor lo
 * vuelve a mirar siempre: un 'viewer' o un 'client' que mande el
 * formulario a mano recibe la frase de MESSAGES y la base no se toca.
 */
import { isUuid, type WorkspaceTx } from "@mc/db";
import { ChannelCapError, disconnectChannelAccount, getChannelLimits, updateChannelAccountCaps } from "@mc/db/queries/canales";
import type { Formatter } from "@/lib/format";
import type { VentasState } from "../../actions";
import { MESSAGES } from "../messages";

/** El estado del formulario de límites: el de todo Ventas (useVentasForm), con errores por campo dailyCap y weeklyCap. */
export type LimitesState = VentasState;

export interface AvisosState {
  message?: string;
  notice?: string;
}

export interface ActionDeps {
  canManage: () => Promise<boolean>;
  withWorkspace: <T>(fn: (tx: WorkspaceTx) => Promise<T>) => Promise<T>;
  /** El formateador del espacio (los máximos en los mensajes de error). */
  format: () => Promise<Formatter>;
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
 * del formulario solo llegan el id y los dos números. `saved`: si hay que
 * refrescar la pantalla.
 */
export async function saveCaps(deps: ActionDeps, formData: FormData): Promise<LimitesState & { saved?: boolean }> {
  if (!(await deps.canManage())) return { message: MESSAGES.detail.readOnly };
  const accountId = String(formData.get("accountId") ?? "");
  if (!isUuid(accountId)) return { message: MESSAGES.caps.notFound };
  const dailyCap = parseCap(formData.get("dailyCap"));
  const weeklyCap = parseCap(formData.get("weeklyCap"));
  const f = await deps.format();
  if (dailyCap === "invalid" || weeklyCap === "invalid") {
    const limits = await deps.withWorkspace((tx) => getChannelLimits(tx, accountId));
    if (!limits) return { message: MESSAGES.caps.notFound };
    return {
      errors: {
        ...(dailyCap === "invalid" ? { dailyCap: MESSAGES.caps.invalid(f.int(limits.maxDaily)) } : {}),
        ...(weeklyCap === "invalid" ? { weeklyCap: MESSAGES.caps.invalid(f.int(limits.maxWeekly)) } : {}),
      },
    };
  }
  try {
    const ok = await deps.withWorkspace((tx) => updateChannelAccountCaps(tx, accountId, { dailyCap, weeklyCap }));
    if (!ok) return { message: MESSAGES.caps.notFound };
  } catch (err) {
    if (err instanceof ChannelCapError) {
      const text = err.problem === "daily_above_weekly" ? MESSAGES.caps.dailyAboveWeekly(f.int(err.max)) : MESSAGES.caps.invalid(f.int(err.max));
      return { errors: { [err.field]: text } };
    }
    throw err;
  }
  return { notice: MESSAGES.caps.saved, saved: true };
}

/**
 * Desconectar: la fila queda 'disconnected' y pendiente de soltar (0040).
 * El worker (sales.channels_release, cada cinco minutos) revoca el permiso
 * de Google o borra la cuenta y sus avisos en Unipile. Devuelve la
 * confirmación con el nombre de la cuenta (de la base, no del formulario).
 */
export async function disconnect(deps: ActionDeps, formData: FormData): Promise<AvisosState & { changed?: boolean }> {
  if (!(await deps.canManage())) return { message: MESSAGES.detail.readOnly };
  const accountId = String(formData.get("accountId") ?? "");
  if (!isUuid(accountId)) return { message: MESSAGES.caps.notFound };
  const done = await deps.withWorkspace((tx) => disconnectChannelAccount(tx, accountId));
  if (!done) return { message: MESSAGES.actions.alreadyDisconnected, changed: true };
  return { notice: MESSAGES.actions.disconnected(done.name), changed: true };
}
