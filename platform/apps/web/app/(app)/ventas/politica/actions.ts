"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  isPolicyForbidden, POLICY_LIMITS, POSTAL_ADDRESS_MAX, PolicyForbiddenError, PolicyNeedsAddressError, readSendReadiness,
  saveOutboundPolicy,
} from "@mc/db/queries/entregabilidad";
import { disableOutreach, enableOutreach } from "@mc/db/queries/outreach";
import { formatterFor } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../_lib/db";
import { MESSAGES } from "./messages";
import { puedeCambiarLaPolitica } from "./permiso";

/**
 * Las acciones de /ventas/politica. El workspace lo fija withWorkspace;
 * aquí no llega ni sale ningún id. El interruptor va por las funciones
 * de 0037 (enable_outreach / disable_outreach), que además cancelan la
 * cola al apagar.
 *
 * Las tres piden ser 'owner' o 'admin' del workspace (0038 §7): la base
 * lo exige igual, pero así el rechazo se explica en vez de ser un error.
 */

const t = MESSAGES;

type Campo = keyof typeof POLICY_LIMITS;

/** Un entero dentro de POLICY_LIMITS; el error de rango, con las cifras ya formateadas en el locale del workspace. */
function entero(campo: Campo, rango: (c: Campo) => string) {
  const { min, max } = POLICY_LIMITS[campo];
  return z
    .string()
    .trim()
    .regex(/^\d{1,5}$/, t.entero)
    .transform(Number)
    .refine((n) => n >= min && n <= max, rango(campo));
}

function politicaSchema(rango: (c: Campo) => string, direccionLarga: string) {
  return z.object({
    maxTouchesPerCompany: entero("maxTouchesPerCompany", rango),
    minDaysBetweenTouches: entero("minDaysBetweenTouches", rango),
    maxEmailsPerDay: entero("maxEmailsPerDay", rango),
    cooldownDaysAfterNo: entero("cooldownDaysAfterNo", rango),
    warmupDays: entero("warmupDays", rango),
    requireHumanReview: z.enum(["si", "no"]).transform((v) => v === "si"),
    claimsMustBeSourced: z.enum(["si", "no"]).transform((v) => v === "si"),
    postalAddress: z.string().trim().max(POSTAL_ADDRESS_MAX, direccionLarga),
  });
}

export interface GuardarPoliticaState {
  errors?: Record<string, string>;
  message?: string;
  ok?: boolean;
}

function primeros(issues: { path: PropertyKey[]; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const k = String(i.path[0] ?? "form");
    if (!(k in out)) out[k] = i.message;
  }
  return out;
}

export async function guardarPolitica(_prev: GuardarPoliticaState, form: FormData): Promise<GuardarPoliticaState> {
  if (!(await puedeCambiarLaPolitica())) return { message: t.sinPermiso };
  const campo = (k: string) => String(form.get(k) ?? "");
  // Las cifras del error, como las de la ayuda de la pantalla: «Entre 1 y 2.000.» en es-CO.
  const f = formatterFor(await getCurrentWorkspace());
  const rango = (c: Campo) => t.rango(f.int(POLICY_LIMITS[c].min), f.int(POLICY_LIMITS[c].max));
  const parsed = politicaSchema(rango, t.direccionLarga(f.int(POSTAL_ADDRESS_MAX))).safeParse({
    maxTouchesPerCompany: campo("maxTouchesPerCompany"),
    minDaysBetweenTouches: campo("minDaysBetweenTouches"),
    maxEmailsPerDay: campo("maxEmailsPerDay"),
    cooldownDaysAfterNo: campo("cooldownDaysAfterNo"),
    warmupDays: campo("warmupDays"),
    requireHumanReview: campo("requireHumanReview"),
    claimsMustBeSourced: campo("claimsMustBeSourced"),
    postalAddress: campo("postalAddress"),
  });
  if (!parsed.success) return { errors: primeros(parsed.error.issues) };
  const v = parsed.data;
  try {
    await withWorkspace((tx) => saveOutboundPolicy(tx, { ...v, postalAddress: v.postalAddress || null }));
  } catch (err) {
    if (err instanceof PolicyNeedsAddressError) return { errors: { postalAddress: t.necesitaDireccion } };
    if (err instanceof PolicyForbiddenError) return { message: t.sinPermiso };
    console.error("[ventas/politica] no se pudo guardar", err);
    return { message: t.errorGuardar };
  }
  revalidatePath("/ventas/politica");
  return { ok: true };
}

export type InterruptorResultado = { ok: true } | { ok: false; message: string };

/**
 * Encender es lo que empieza a escribir a marcas en nombre del creador:
 * pide el rol, una cuenta de envío conectada y la dirección postal (esta
 * última la exige también la base).
 */
export async function encenderEnvio(): Promise<InterruptorResultado> {
  if (!(await puedeCambiarLaPolitica())) return { ok: false, message: t.interruptor.sinPermiso };
  try {
    const listo = await withWorkspace(async (tx) => {
      if ((await readSendReadiness(tx)).connectedAccounts === 0) return false;
      await enableOutreach(tx);
      return true;
    });
    if (!listo) return { ok: false, message: t.interruptor.sinCanal };
  } catch (err) {
    const e = err as { code?: string };
    if (isPolicyForbidden(err)) return { ok: false, message: t.interruptor.sinPermiso };
    if (e.code !== "23514") console.error("[ventas/politica] no se pudo encender", err);
    return { ok: false, message: e.code === "23514" ? t.interruptor.sinDireccion : t.interruptor.errorEncender };
  }
  revalidatePath("/ventas/politica");
  return { ok: true };
}

export async function apagarEnvio(): Promise<InterruptorResultado> {
  if (!(await puedeCambiarLaPolitica())) return { ok: false, message: t.interruptor.sinPermiso };
  try {
    await withWorkspace((tx) => disableOutreach(tx, t.interruptor.motivoManual));
  } catch (err) {
    if (isPolicyForbidden(err)) return { ok: false, message: t.interruptor.sinPermiso };
    console.error("[ventas/politica] no se pudo apagar", err);
    return { ok: false, message: t.interruptor.errorApagar };
  }
  revalidatePath("/ventas/politica");
  return { ok: true };
}
