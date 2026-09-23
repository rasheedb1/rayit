"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  POLICY_LIMITS, POSTAL_ADDRESS_MAX, PolicyNeedsAddressError, saveOutboundPolicy,
} from "@mc/db/queries/entregabilidad";
import { disableOutreach, enableOutreach } from "@mc/db/queries/outreach";
import { withWorkspace } from "../_lib/db";
import { MESSAGES } from "./messages";

/**
 * Las acciones de /ventas/politica. El workspace lo fija withWorkspace;
 * aquí no llega ni sale ningún id. El interruptor va por las funciones
 * de 0037 (enable_outreach / disable_outreach), que además cancelan la
 * cola al apagar.
 */

const t = MESSAGES;

function entero(campo: keyof typeof POLICY_LIMITS) {
  const { min, max } = POLICY_LIMITS[campo];
  return z
    .string()
    .trim()
    .regex(/^\d{1,5}$/, t.entero)
    .transform(Number)
    .refine((n) => n >= min && n <= max, t.rango(String(min), String(max)));
}

const politicaSchema = z.object({
  maxTouchesPerCompany: entero("maxTouchesPerCompany"),
  minDaysBetweenTouches: entero("minDaysBetweenTouches"),
  maxEmailsPerDay: entero("maxEmailsPerDay"),
  cooldownDaysAfterNo: entero("cooldownDaysAfterNo"),
  warmupDays: entero("warmupDays"),
  requireHumanReview: z.enum(["si", "no"]).transform((v) => v === "si"),
  claimsMustBeSourced: z.enum(["si", "no"]).transform((v) => v === "si"),
  postalAddress: z.string().trim().max(POSTAL_ADDRESS_MAX, t.direccionLarga(String(POSTAL_ADDRESS_MAX))),
});

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
  const parsed = politicaSchema.safeParse({
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
