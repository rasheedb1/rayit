"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  FINANCE_PLAZO_MAX,
  FINANCE_TEXT_MAX,
  parseFinanceSettings,
  PCT_RE,
  type FinanceSettings,
} from "@mc/core";
import { updateFinanceSettings } from "@mc/db/queries/finanzas";
import { firstErrors, formField, type ActionState } from "@/lib/forms";
import { requirePermission } from "@/lib/permisos";
import { withWorkspace } from "../_lib/db";
import { MESSAGES } from "../_lib/messages";

const t = MESSAGES.configuracion;

/** Un porcentaje como lo escribe una persona: 0 a 100, con coma o punto y hasta dos decimales. */
const MONEDA_RE = /^[A-Za-z]{3}$/;
/** Un correo, con el criterio flojo que basta para un campo opcional: hay un @ y algo a cada lado. */
const CORREO_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const pct = z.string().trim().regex(PCT_RE, t.errores.pct);
/** Un texto opcional: "" es una ausencia, no una cadena vacía guardada. */
const texto = z.string().trim().max(FINANCE_TEXT_MAX, t.errores.texto(FINANCE_TEXT_MAX));

/**
 * Lo estricto, aquí. `parseFinanceSettings` de core es tolerante a
 * propósito —leer una configuración rara no puede tumbar /finanzas—,
 * así que el único camino que ESCRIBE es el que valida con rangos,
 * topes y un mensaje por campo. Es la misma división que ya usan Ventas
 * y Cotizar.
 */
const esquema = z.object({
  ivaPct: pct,
  retencionPct: pct,
  reservaPct: pct,
  plazoDias: z
    .string()
    .trim()
    .regex(/^\d{1,3}$/, t.errores.plazo)
    .refine((v) => Number(v) <= FINANCE_PLAZO_MAX, t.errores.plazo),
  currency: z.string().trim().regex(MONEDA_RE, t.errores.moneda),
  razonSocial: texto,
  identificacion: texto,
  direccion: texto,
  regimen: texto,
  correoFacturacion: texto.refine((v) => v === "" || CORREO_RE.test(v), t.errores.correo),
  banco: texto,
  cuenta: texto,
  enlacePago: texto.refine((v) => v === "" || /^https:\/\/\S+$/.test(v), t.errores.enlace),
});

/** "" → null. Una ausencia se guarda como ausencia; el kit la pinta con una frase. */
function oNulo(v: string): string | null {
  return v === "" ? null : v;
}

export interface ConfiguracionState extends ActionState {
  /**
   * Facturas vivas que quedaron en otra moneda después de guardar. La
   * pantalla lo dice: cambiar la moneda no convierte nada (FIN-8 §0.3 F).
   */
  facturasEnOtraMoneda?: number;
  /** La moneda que quedó, para el mensaje de éxito. */
  moneda?: string;
  /**
   * La que había antes. El aviso nombra ESTA, porque es la moneda en la
   * que están las facturas que nadie convirtió. Sin JavaScript la
   * pantalla se repinta con la moneda nueva ya en sus props, así que
   * tomarla de ahí decía la equivocada.
   */
  monedaAnterior?: string;
}

/**
 * Guarda la configuración financiera del workspace.
 *
 * El permiso es la PRIMERA línea, antes de validar y antes de abrir
 * ninguna transacción (ACC-1). Que la pantalla no ofrezca el formulario
 * a quien no puede es cortesía del render; la que decide es esta línea.
 * `SinPermisoError` cae en la frontera del segmento, como en las otras
 * doce acciones de mis módulos: ACC-5 esconde antes lo que no se abre.
 */
export async function guardarConfiguracion(
  _prev: ConfiguracionState,
  formData: FormData,
): Promise<ConfiguracionState> {
  await requirePermission("finanzas.ajustes.configurar");

  const parsed = esquema.safeParse({
    ivaPct: formField(formData, "ivaPct"),
    retencionPct: formField(formData, "retencionPct"),
    reservaPct: formField(formData, "reservaPct"),
    plazoDias: formField(formData, "plazoDias"),
    currency: formField(formData, "currency"),
    razonSocial: formField(formData, "razonSocial"),
    identificacion: formField(formData, "identificacion"),
    direccion: formField(formData, "direccion"),
    regimen: formField(formData, "regimen"),
    correoFacturacion: formField(formData, "correoFacturacion"),
    banco: formField(formData, "banco"),
    cuenta: formField(formData, "cuenta"),
    enlacePago: formField(formData, "enlacePago"),
  });
  if (!parsed.success) return { errors: firstErrors(parsed.error.issues) };
  const v = parsed.data;

  // El bloque pasa por parseFinanceSettings antes de guardarse: así la
  // normalización (la coma a punto, el recorte, el tope) es LA MISMA que
  // usa la lectura, y no hay dos ideas de qué es un 19,5 válido.
  // La bitácora la escribe updateFinanceSettings con audit(), dentro de
  // su transacción (ACC-2).
  const settings: FinanceSettings = parseFinanceSettings({
    iva_pct: v.ivaPct,
    retencion_pct: v.retencionPct,
    reserva_pct: v.reservaPct,
    plazo_dias: v.plazoDias,
    razon_social: oNulo(v.razonSocial),
    identificacion: oNulo(v.identificacion),
    direccion: oNulo(v.direccion),
    regimen: oNulo(v.regimen),
    correo_facturacion: oNulo(v.correoFacturacion),
    banco: oNulo(v.banco),
    cuenta: oNulo(v.cuenta),
    enlace_pago: oNulo(v.enlacePago),
  });

  let guardado;
  try {
    guardado = await withWorkspace((tx) => updateFinanceSettings(tx, { settings, currency: v.currency }));
  } catch (err) {
    // La causa se registra en el servidor; al usuario, una frase. El
    // mensaje de un error de la base puede traer SQL o el nombre de una
    // migración («falta la política… corre make db.migrate»).
    console.error("[finanzas] no se pudo guardar la configuración", err);
    return { message: t.errores.general };
  }

  // La configuración cambia los defaults de «factura nueva» y la
  // cabecera del detalle, así que se revalida el segmento entero.
  revalidatePath("/finanzas", "layout");
  return {
    ok: true,
    moneda: guardado.currency,
    monedaAnterior: guardado.previousCurrency,
    facturasEnOtraMoneda: guardado.invoicesInOtherCurrency,
  };
}
