"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ScopeError } from "@mc/db";
import {
  createPlatformPayout,
  getWorkspaceToday,
  importPlatformPayouts,
  listPayoutPlatforms,
  PlatformPayoutInputError,
  type ConflictingPayout,
  type PlatformPayoutInput,
} from "@mc/db/queries/finanzas";
import { requirePermission } from "@/lib/permisos";
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
 * Las dos escrituras de FIN-7. Las dos son dinero: las dos abren con
 * `requirePermission` (ACC-1) y las dos dejan su fila en `audit_log`,
 * que la pone `importPlatformPayouts` dentro de la misma transacción
 * (ACC-2).
 *
 * El permiso es `finanzas.pago.registrar` («Registrar pagos») y el de
 * lectura, `finanzas.flujo.ver`. No hay un `finanzas.ingreso.*` porque
 * el catálogo de permisos viaja en la semilla de la migración 0034, que
 * ya está en `main`, y `packages/db/test/accesos.test.ts` exige que esa
 * semilla sea, línea por línea, la salida del script de ACC-1: añadir
 * dos permisos obligaría a editar una migración aplicada. Está propuesto
 * en docs/propuestas/FIN-7.md §1 y marcado DECISIÓN PENDIENTE DE NICOLÁS.
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
  await requirePermission("finanzas.pago.registrar");
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

  // Las redes salen del catálogo y no de una lista escrita a mano: si
  // mañana entra una quinta, el lector la acepta sin tocar nada. El día
  // es el del ESPACIO (no el del servidor de base ni el de Node), que es
  // con el que se decide si un periodo ya cerró. Los dos, en la misma
  // transacción.
  const { plataformas, hoy } = await withWorkspace(async (tx) => ({
    plataformas: (await listPayoutPlatforms(tx)).map((p) => p.id),
    hoy: await getWorkspaceToday(tx),
  }));
  const revision = revisar(leido.tabla, leido.deteccion, { currency, plataformas, hoy });

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
    // La bitácora la pone importPlatformPayouts, dentro de la misma
    // transacción que el INSERT (ACC-2).
    escrito = await withWorkspace((tx) => importPlatformPayouts(tx, revision.listas));
  } catch (err) {
    console.error("[finanzas/ingresos] no se pudo escribir el lote", err);
    // Solo lo que la persona puede arreglar («Fila 2: «twitch» no es una
    // red conocida») sale a la pantalla. Un error de Postgres —un
    // «numeric field overflow», un 42P10 porque falta la migración— se
    // queda en el log: no le dice nada a nadie y enseña la forma de la
    // consulta.
    return { message: err instanceof PlatformPayoutInputError ? err.message : err instanceof ScopeError ? err.messageEs : MESSAGES.generico };
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
  await requirePermission("finanzas.pago.registrar");
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
  // El día del ESPACIO, de la base: un `new Date()` aquí sería el reloj
  // del servidor, y a las 02:00 UTC en Bogotá todavía es ayer. Un
  // periodo que no ha terminado no es un pago, es lo que va del mes:
  // contarlo hundiría el promedio de los tres meses.
  const hoy = await withWorkspace((tx) => getWorkspaceToday(tx));
  if (periodo.periodEnd > hoy) return { errors: { [v.mes ? "mes" : "periodEnd"]: e.futuro } };

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
    r = await withWorkspace((tx) => createPlatformPayout(tx, entrada));
  } catch (err) {
    console.error("[finanzas/ingresos] no se pudo guardar el ingreso", err);
    // Mismo criterio que el import: la frase de dominio sí, la de
    // Postgres no. Aquí además la validación de zod ya cubre casi todo,
    // así que lo que llegue suele ser cosa nuestra.
    return { message: err instanceof PlatformPayoutInputError ? err.message : err instanceof ScopeError ? err.messageEs : MESSAGES.generico };
  }

  // El NOMBRE de la red, no su id: «Instagram» y no «instagram». En el
  // choque lo trae la fila que ya estaba, que es de la que se habla.
  const red = r.payout?.platformName ?? r.conflicting?.platformName ?? v.platformId;
  const periodoTexto = periodo.periodStart.slice(0, 7);
  if (r.conflicting) {
    return { conflicto: { red, periodo: periodoTexto, guardado: r.conflicting.existingAmount } };
  }
  revalidatePath("/finanzas/ingresos");
  revalidatePath("/finanzas");
  if (r.duplicated) return { ok: true, duplicado: { red, periodo: periodoTexto } };
  return { ok: true, guardado: { red, periodo: periodoTexto } };
}
