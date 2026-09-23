"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  createPlatformPayout,
  importPlatformPayouts,
  listPayoutPlatforms,
  type ConflictingPayout,
  type PlatformPayoutInput,
} from "@mc/db/queries/finanzas";
import { withWorkspace } from "@/lib/db";
import { DECIMAL_RE, firstErrors, formField } from "@/lib/forms";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import {
  analizar,
  revisar,
  ErrorCsv,
  MAX_BYTES,
  MAX_FILAS,
  ultimoDiaDelMes,
  type Codificacion,
  type FormatoIngresos,
  type Problema,
} from "./_lib/csv";
import { MESSAGES } from "./_lib/messages";

/**
 * Las dos escrituras de FIN-7. Las dos son dinero, así que las dos
 * pasan por la bitácora en cuanto ACC-2 exista, y por el permiso en
 * cuanto exista ACC-1.
 *
 * El CSV entra por el CUERPO de la Server Action y no por un route
 * handler como el lote de Resumen (RES-6): aquel son 5 MB de métricas y
 * este son doce filas. El techo de aquí, 256 KB, está por debajo del
 * 1 MB por defecto de Next, así que no hace falta subirle el límite a
 * TODAS las acciones de la aplicación para atender esta.
 */

// ---------------------------------------------------------------------
// Importar un CSV
// ---------------------------------------------------------------------

export interface ImportarState {
  /** Error general: el archivo no se pudo ni empezar a leer. */
  message?: string;
  ok?: boolean;
  resultado?: {
    formato: FormatoIngresos;
    escritos: number;
    repetidos: number;
    agrupadas: number;
    monedaSupuesta: boolean;
    moneda: string;
    codificacion: Codificacion;
    problemas: Problema[];
    conflictos: ConflictingPayout[];
  };
}

/** El texto de un `ErrorCsv`, que solo trae un código. */
function frasePara(err: ErrorCsv): string {
  const t = MESSAGES.importar.archivo;
  switch (err.codigo) {
    case "vacio":
      return t.vacio;
    case "sinEncabezados":
      return t.sinEncabezados;
    case "sinFilas":
      return t.sinFilas;
    case "demasiadasFilas":
      return t.demasiadasFilas(err.datos.filas ?? 0, err.datos.max ?? MAX_FILAS);
  }
}

export async function importarCsv(_prev: ImportarState, formData: FormData): Promise<ImportarState> {
  // TODO(ACC-1): requirePermission('finanzas.ingresos.crear') como PRIMERA línea.
  const t = MESSAGES.importar.archivo;
  const archivo = formData.get("archivo");
  if (!(archivo instanceof File) || archivo.size === 0) return { message: t.sinArchivo };
  // El tipo que manda el navegador no es de fiar (Windows manda
  // application/vnd.ms-excel para un .csv), así que manda la extensión.
  if (!/\.csv$/i.test(archivo.name)) return { message: t.noEsCsv };
  if (archivo.size > MAX_BYTES) return { message: t.demasiadoGrande(MAX_BYTES) };

  const { currency } = await getCurrentWorkspace();

  let leido: ReturnType<typeof analizar>;
  try {
    leido = analizar(await archivo.arrayBuffer());
  } catch (err) {
    if (err instanceof ErrorCsv) return { message: frasePara(err) };
    console.error("[finanzas/ingresos] no se pudo leer el CSV", err);
    return { message: MESSAGES.generico };
  }
  if (leido.deteccion.formato === null) return { message: t.formatoDesconocido };

  // Las redes salen del catálogo, no de una lista escrita a mano: si
  // mañana entra una quinta, el lector la acepta sin tocar nada.
  const plataformas = await withWorkspace(async (tx) => (await listPayoutPlatforms(tx)).map((p) => p.id));
  const revision = revisar(leido.tabla, leido.deteccion, { currency, plataformas });

  if (revision.listas.length === 0) {
    return {
      message: revision.filasLeidas === 0 ? t.sinFilas : t.nadaQueEscribir,
      resultado: {
        formato: leido.deteccion.formato,
        escritos: 0,
        repetidos: 0,
        agrupadas: revision.filasAgrupadas,
        monedaSupuesta: revision.monedaSupuesta,
        moneda: currency,
        codificacion: leido.codificacion,
        problemas: revision.problemas,
        conflictos: [],
      },
    };
  }

  let escrito;
  try {
    // TODO(ACC-2): audit('finanzas.platform_payout.import', { after: revision.listas }).
    escrito = await withWorkspace((tx) => importPlatformPayouts(tx, revision.listas));
  } catch (err) {
    console.error("[finanzas/ingresos] no se pudo escribir el lote", err);
    return { message: err instanceof Error ? err.message : MESSAGES.generico };
  }

  revalidatePath("/finanzas/ingresos");
  revalidatePath("/finanzas");
  return {
    ok: true,
    resultado: {
      formato: leido.deteccion.formato,
      escritos: escrito.inserted,
      repetidos: escrito.duplicated,
      agrupadas: revision.filasAgrupadas,
      monedaSupuesta: revision.monedaSupuesta,
      moneda: currency,
      codificacion: leido.codificacion,
      problemas: revision.problemas,
      conflictos: escrito.conflicting,
    },
  };
}

// ---------------------------------------------------------------------
// Agregar a mano
// ---------------------------------------------------------------------

const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const e = MESSAGES.nuevo.errores;

const nuevoIngresoSchema = z
  .object({
    platformId: z.string().min(1, e.plataforma),
    mes: z.string().regex(MES_RE, e.mes).or(z.literal("")),
    periodStart: z.string().regex(ISO_DATE_RE, e.inicio).or(z.literal("")),
    periodEnd: z.string().regex(ISO_DATE_RE, e.fin).or(z.literal("")),
    amount: z.string().regex(DECIMAL_RE, e.monto),
  })
  .refine((v) => v.mes !== "" || (v.periodStart !== "" && v.periodEnd !== ""), {
    path: ["mes"],
    message: e.mes,
  })
  .refine((v) => v.mes !== "" || v.periodEnd >= v.periodStart, {
    path: ["periodEnd"],
    message: e.finAntesDeInicio,
  })
  .refine((v) => !/^0+(\.0{1,2})?$/.test(v.amount), { path: ["amount"], message: e.montoCero });

export interface NuevoIngresoState {
  errors?: Record<string, string>;
  message?: string;
  ok?: boolean;
  /** Lo que se guardó, para decirlo con su nombre. */
  guardado?: { red: string; periodo: string };
  duplicado?: { red: string; periodo: string };
  conflicto?: { red: string; periodo: string; guardado: string };
}

export async function crearIngreso(_prev: NuevoIngresoState, formData: FormData): Promise<NuevoIngresoState> {
  // TODO(ACC-1): requirePermission('finanzas.ingresos.crear') como PRIMERA línea.
  const parsed = nuevoIngresoSchema.safeParse({
    platformId: formField(formData, "platformId"),
    mes: formField(formData, "mes"),
    periodStart: formField(formData, "periodStart"),
    periodEnd: formField(formData, "periodEnd"),
    amount: formField(formData, "amount"),
  });
  if (!parsed.success) return { errors: firstErrors(parsed.error.issues) };
  const v = parsed.data;

  // El mes se expande al periodo entero; el periodo propio se respeta.
  const periodo = v.mes
    ? {
        periodStart: `${v.mes}-01`,
        periodEnd: `${v.mes}-${String(ultimoDiaDelMes(+v.mes.slice(0, 4), +v.mes.slice(5, 7))).padStart(2, "0")}`,
      }
    : { periodStart: v.periodStart, periodEnd: v.periodEnd };

  const { currency } = await getCurrentWorkspace();
  const entrada: PlatformPayoutInput = {
    platformId: v.platformId,
    creatorId: null,
    ...periodo,
    amount: v.amount,
    currency,
    source: "manual",
  };

  let r;
  try {
    // TODO(ACC-2): audit('finanzas.platform_payout.create', { after: entrada }).
    r = await withWorkspace((tx) => createPlatformPayout(tx, entrada));
  } catch (err) {
    console.error("[finanzas/ingresos] no se pudo guardar el ingreso", err);
    return { message: err instanceof Error ? err.message : MESSAGES.generico };
  }

  const red = r.payout?.platformName ?? v.platformId;
  const periodoTexto = periodo.periodStart.slice(0, 7);
  if (r.conflicting) {
    return { conflicto: { red, periodo: periodoTexto, guardado: r.conflicting.existingAmount } };
  }
  revalidatePath("/finanzas/ingresos");
  revalidatePath("/finanzas");
  if (r.duplicated) return { ok: true, duplicado: { red, periodo: periodoTexto } };
  return { ok: true, guardado: { red, periodo: periodoTexto } };
}
