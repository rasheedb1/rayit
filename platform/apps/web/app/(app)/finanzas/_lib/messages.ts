import { formatDaysRelative } from "@/lib/format";

/**
 * Todos los textos de interfaz del módulo Finanzas que no son de un
 * formulario: las dos pantallas (cuentas por cobrar y el archivo de
 * facturas), sus estados vacíos, el error y la carga del segmento.
 *
 * La regla del repositorio es un `messages.ts` por módulo: traducir
 * Finanzas es traducir este archivo, y @mc/db no tiene frases.
 *
 * Voz: le hablamos a una creadora que factura su trabajo. «Marca» y no
 * «cliente», «cobrar» y no «recaudar», y una ausencia se explica con
 * una frase —«Sin campaña»— y nunca con un guion mudo ni con un cero.
 */
export const MESSAGES = {
  /**
   * El nombre y el título de la frontera de error. Lo demás —las causas,
   * la pista de despliegue, Reintentar y Volver al plan— es el de la
   * aplicación ((app)/_lib/messages.ts): la ronda 3 tenía aquí «la base
   * no respondió», que era falso con un workspace que no existe.
   */
  error: {
    eyebrow: "Finanzas",
    title: "No pudimos leer tus facturas",
  },

  /** Las dos vistas del módulo. Son enlaces: cada una tiene su URL. */
  tabs: {
    label: "Vistas de Finanzas",
    cobros: "Cuentas por cobrar",
    facturas: "Facturas",
  },

  /** FIN-3 · /finanzas: la pantalla de cobro. */
  cobros: {
    metaTitle: "Cuentas por cobrar",
    eyebrow: "Finanzas",
    title: "Quién te debe, cuándo entra la plata y cuánto apartar",
    description:
      "Lo que hay que cobrar primero va arriba: lo vencido, después lo que vence esta semana. Los días de mora y lo que queda pendiente salen de la vista receivables, no de una cuenta hecha en la pantalla.",
    section: "Cuentas por cobrar",
    caption: "Facturas por cobrar con la marca, la campaña, lo pendiente, el vencimiento y su estado de mora",
    meta: (n: number) => `${n} ${n === 1 ? "factura" : "facturas"}`,
    newInvoice: "Nueva factura",

    columns: {
      company: "Marca",
      campaign: "Campaña",
      outstanding: "Por cobrar",
      dueOn: "Vence",
      status: "Estado",
      action: "Acción",
    },
    /** Lo facturado, cuando no coincide con lo que queda por cobrar. */
    ofTotal: (total: string) => `de ${total}`,
    /** Lo que se lee en «Por cobrar» de una factura ya cobrada: no un cero. */
    nothingDue: "Nada pendiente",
    noCampaign: "Sin campaña",
    seeInvoice: "Ver factura",
    /** Solo si un workspace llega al tope de filas de la pantalla. */
    truncated: (n: number) => `Se muestran las ${n} más urgentes.`,
    truncatedLink: "Ver el archivo completo de facturas",

    /** El texto de la pastilla. El color lo decide _lib/estado.ts. */
    pill: {
      overdue: (daysOverdue: number) => `Vencida ${formatDaysRelative(-daysOverdue)}`,
      dueSoon: (daysOverdue: number) => `Vence ${formatDaysRelative(-daysOverdue)}`,
      onTime: "Al día",
      paid: "Cobrada",
      /** Se antepone cuando ya hay un abono. */
      partial: "Pago parcial · ",
    },

    filters: {
      label: "Filtrar por estado de cobro",
      search: "Buscar",
      searchHelp: "Marca o número de factura.",
      searchPlaceholder: "Hogar Lindo · FV-2026-007",
      shortSearch: (min: number) => `Desde el ${min}.º carácter. Con menos, la lista no se filtra.`,
    },

    kpis: {
      /** El nombre de la región que agrupa las cuatro cifras. */
      label: "Resumen de cobro",
      outstanding: "Por cobrar",
      /** Un cero de verdad («no te deben nada») dicho con palabras. */
      outstandingZero: "Ninguna factura por cobrar",
      outstandingNote: (n: number) => `${n} ${n === 1 ? "factura" : "facturas"}`,
      overdue: "Vencido",
      overdueZero: "Ninguna vencida",
      overdueNote: (n: number, dias: number) =>
        `${n} ${n === 1 ? "factura" : "facturas"} · ${dias} ${dias === 1 ? "día" : "días"}`,
      collected: (year: number) => `Cobrado en ${year}`,
      collectedVs: (year: number) => `vs. mismo período ${year}`,
      collectedNoBase: (year: number) => `Sin cobros en ${year} para comparar`,
      collectedZero: (year: number) => `Sin cobros en ${year} todavía`,
      taxReserved: "Apartado para impuestos",
      taxRate: (pct: string) => `${pct} % de cada cobro`,
      taxNone: "Sin reservas todavía",
    },

    loading: {
      label: "Cargando las cuentas por cobrar",
      /** Los mismos cuatro rótulos de la pantalla, para que el esqueleto no cambie de tamaño al llegar los datos. */
      kpis: ["Por cobrar", "Vencido", "Cobrado este año", "Apartado para impuestos"],
    },

    empty: {
      title: "Todavía no hay facturas por cobrar",
      description:
        "Una campaña cerrada crea su factura con su fecha esperada de cobro. También puedes escribir una a mano: queda en borrador hasta que la marques como enviada.",
      action: "Crear una factura",
    },
    emptyFiltered: {
      title: (label: string) => `No hay facturas en «${label}»`,
      description: "Es una buena noticia. Mira el resto de lo que está por cobrar.",
      action: "Ver todo lo que está por cobrar",
    },
    emptySearch: {
      title: (q: string) => `Ninguna factura coincide con «${q}»`,
      description: "Se busca por el nombre de la marca o por el número de la factura.",
      action: "Quitar la búsqueda",
    },
  },

  /** FIN-1 · /finanzas/facturas: el archivo completo. */
  facturas: {
    metaTitle: "Facturas",
    eyebrow: "Finanzas",
    title: "Todo lo que has facturado",
    description:
      "El archivo completo, con los borradores que todavía no has enviado y las anuladas. Lo que hay que cobrar hoy está en Cuentas por cobrar.",
    section: "Facturas",
    meta: (n: number) => `${n} ${n === 1 ? "factura" : "facturas"}`,
    caption: "Facturas emitidas a marcas, con su estado de cobro",
    filtersLabel: "Filtrar facturas",
    newInvoice: "Nueva factura",
    back: "Volver a facturas",
    loading: {
      label: "Cargando las facturas",
    },
    empty: {
      title: "Todavía no hay facturas",
      description:
        "La primera puede salir de una campaña del seed o escribirse a mano. Queda en borrador hasta que la marques como enviada.",
      action: "Crear tu primera factura",
    },
    emptyFiltered: {
      title: (label: string) => `No hay facturas en «${label}»`,
      description: "Prueba con otro filtro o crea una factura nueva.",
      action: "Ver todas",
    },
  },
} as const;
