"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  POLICY_LIMITS, POSTAL_ADDRESS_MAX, PolicyNeedsAddressError, saveOutboundPolicy,
} from "@mc/db/queries/entregabilidad";
import { disableOutreach, enableOutreach } from "@mc/db/queries/outreach";
import { formatterFor } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../_lib/db";
import { MESSAGES } from "./messages";

/**
 * Las acciones de /ventas/politica. El workspace lo fija withWorkspace;
 * aquí no llega ni sale ningún id. El interruptor va por las funciones
 * de 0037 (enable_outreach / disable_outreach), que además cancelan la
 * cola al apagar.
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

/** 'HH:MM' de 00:00 a 23:59. */
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

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
    // (VEN-10 r5) La ventana laboral: 'HH:MM', y el fin después del inicio (el CHECK de 0051 §1).
    sendWindowStart: z.string().regex(HORA, t.campos.sendWindow.invalida),
    sendWindowEnd: z.string().regex(HORA, t.campos.sendWindow.invalida),
  }).refine((v) => v.sendWindowEnd > v.sendWindowStart, { path: ["sendWindowEnd"], message: t.campos.sendWindow.error });
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
    sendWindowStart: campo("sendWindowStart"),
    sendWindowEnd: campo("sendWindowEnd"),
  });
  if (!parsed.success) return { errors: primeros(parsed.error.issues) };
  const v = parsed.data;
  try {
    await withWorkspace((tx) => saveOutboundPolicy(tx, { ...v, postalAddress: v.postalAddress || null }));
  } catch (err) {
    if (err instanceof PolicyNeedsAddressError) return { errors: { postalAddress: t.necesitaDireccion } };
    console.error("[ventas/politica] no se pudo guardar", err);
    return { message: t.errorGuardar };
  }
  revalidatePath("/ventas/politica");
  return { ok: true };
}

export type InterruptorResultado = { ok: true } | { ok: false; message: string };

export async function encenderEnvio(): Promise<InterruptorResultado> {
  try {
    await withWorkspace((tx) => enableOutreach(tx));
  } catch (err) {
    const e = err as { code?: string };
    if (e.code !== "23514") console.error("[ventas/politica] no se pudo encender", err);
    return { ok: false, message: e.code === "23514" ? t.interruptor.sinDireccion : t.interruptor.errorEncender };
  }
  revalidatePath("/ventas/politica");
  return { ok: true };
}

export async function apagarEnvio(): Promise<InterruptorResultado> {
  try {
    await withWorkspace((tx) => disableOutreach(tx, t.interruptor.motivoManual));
  } catch (err) {
    console.error("[ventas/politica] no se pudo apagar", err);
    return { ok: false, message: t.interruptor.errorApagar };
  }
  revalidatePath("/ventas/politica");
  return { ok: true };
}
