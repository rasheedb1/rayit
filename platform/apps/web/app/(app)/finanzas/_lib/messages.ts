import { formatDaysRelative } from "@/lib/format";

/**
 * Todos los textos de interfaz del módulo Finanzas que no son de un
 * formulario: las cuatro vistas (cuentas por cobrar, el archivo de
 * facturas, el flujo de caja y la configuración), sus estados vacíos, y
 * el error y la carga del segmento.
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
    flujo: "Flujo de caja",
    configuracion: "Configuración",
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
  /** FIN-6 · /finanzas/flujo. */
  flujo: {
    eyebrow: "Finanzas",
    title: "Qué entra y qué sale las próximas ocho semanas",
    description:
      "Las facturas por cobrar caen en la semana en que vencen; los negocios ganados que todavía no tienen factura, a los días de plazo del espacio. De ahí se restan el ritmo de gastos recurrentes y lo que hay que apartar para impuestos.",
    kpis: {
      proyectado: "Caja proyectada a 8 semanas",
      ajustada: "Semana más ajustada",
      sinAjustada: "Nada que proyectar todavía",
    },
    grafico: {
      title: "Flujo de caja proyectado",
      subtitle: "Ocho semanas · cobros esperados frente a gastos y apartado de impuestos",
      aria: "Flujo de caja proyectado por semana: cobros esperados frente a gastos e impuestos",
      cobros: "Cobros esperados",
      egresos: "Gastos e impuestos",
    },
    tabla: {
      seccion: "Semana a semana",
      caption: "Flujo de caja proyectado, semana a semana",
      semana: "Semana",
      cobros: "Cobros",
      gastos: "Gastos",
      impuestos: "Impuestos",
      neto: "Neto",
      acumulado: "Acumulado",
      sinCobros: "Sin cobros previstos",
      verDetalle: (n: number) => `${n} ${n === 1 ? "cobro" : "cobros"}`,
    },
    error: {
      eyebrow: "Finanzas",
      title: "No pudimos calcular tu flujo de caja",
    },
    loading: {
      label: "Calculando el flujo de caja",
      kpis: ["Caja proyectada a 8 semanas", "Semana más ajustada"],
    },
    vacio: {
      title: "Sin cobros ni gastos previstos",
      description:
        "El flujo de caja se arma con lo que ya está en el espacio: crea una factura o registra un gasto y esta pantalla empieza a proyectar.",
      accion: "Crear una factura",
    },
  },

  /** FIN-8 · /finanzas/configuracion */
  configuracion: {
    meta: "Configuración financiera",
    eyebrow: "Finanzas",
    titulo: "Con qué números nace cada factura",
    descripcion:
      "El IVA, la retención y el plazo con los que se prellena una factura nueva, cuánto apartas de cada cobro para impuestos, y los datos que la factura imprime. Cambiarlos afecta a lo que venga; lo ya emitido se queda como está.",
    volver: "Volver a facturas",
    enlaceDesdeLista: "Configuración",

    error: {
      eyebrow: "Finanzas",
      title: "No pudimos leer tu configuración",
    },
    cargando: "Cargando la configuración financiera",

    sinPermiso: {
      titulo: "Esta pantalla es de quien manda en el espacio",
      descripcion:
        "La configuración financiera la cambian el dueño del espacio y quien lo administre. Si necesitas ajustar el IVA, la retención o los datos de facturación, pídeselo a quien te invitó.",
      accion: "Volver a facturas",
    },

    porcentajes: {
      titulo: "Porcentajes y plazo",
      ayuda: "Son los valores con los que se prellena una factura nueva. En la factura se pueden cambiar una a una.",
      iva: "IVA %",
      ivaAyuda: "El general de tu país. Cero si no facturas IVA.",
      retencion: "Retención en la fuente %",
      retencionAyuda: "Lo que la marca te retiene al pagar. No se resta del total de la factura.",
      reserva: "Reserva de impuestos %",
      reservaAyuda: "Cuánto se aparta de cada cobro. Lo que ya se apartó conserva su porcentaje.",
      plazo: "Plazo de pago (días)",
      plazoAyuda: "Emisión + este plazo = vencimiento. Cero es pago contra entrega.",
    },

    moneda: {
      titulo: "Moneda",
      ayuda: "En la que se emite toda factura nueva y en la que se suman los KPI de Finanzas.",
      campo: "Moneda",
      campoAyuda: "Código ISO-4217 de tres letras: COP, MXN, USD.",
      /** El aviso de la decisión conservadora: se permite, pero se dice qué pasa. */
      aviso: (n: number, moneda: string) =>
        n === 1
          ? `Tienes 1 factura viva en ${moneda}. Cambiar la moneda no la convierte: se queda como está y los KPI la suman sin convertirla.`
          : `Tienes ${n} facturas vivas en ${moneda}. Cambiar la moneda no las convierte: se quedan como están y los KPI las suman sin convertirlas.`,
    },

    fiscales: {
      titulo: "Datos para la factura",
      ayuda: "Es la cabecera que imprime cada factura y lo que va en el correo de cobro.",
      razonSocial: "Razón social",
      razonSocialAyuda: "El nombre con el que facturas, tal como está registrado.",
      identificacion: "NIT o identificación",
      direccion: "Dirección",
      regimen: "Régimen",
      regimenAyuda: "Como lo escribes tú: «Responsable de IVA», «No responsable», «Régimen simple».",
      correo: "Correo de facturación",
      correoAyuda: "A dónde te escriben las marcas por temas de factura.",
      sinConfigurar: "Todavía no has escrito tus datos fiscales: la factura sale sin cabecera.",
    },

    pago: {
      titulo: "Cómo te pagan",
      ayuda: "Lo que la factura le dice a la marca para transferir. Con el banco y la cuenta, o con un enlace de pago.",
      banco: "Banco",
      cuenta: "Cuenta",
      cuentaAyuda: "Tipo y número, como se lo dictas a alguien: «Ahorros 123-456789-01».",
      enlace: "Enlace de pago",
      enlaceAyuda: "Opcional, si cobras por pasarela. Tiene que empezar por https://.",
    },

    guardar: "Guardar configuración",
    guardando: "Guardando…",
    guardado: "Configuración guardada.",
    guardadoConMoneda: (moneda: string) => `Configuración guardada. Toda factura nueva se emite en ${moneda}.`,

    errores: {
      pct: "Es un porcentaje entre 0 y 100, con hasta dos decimales.",
      plazo: "Es un número entero de días, entre 0 y 180.",
      moneda: "Escribe un código de tres letras: COP, MXN, USD.",
      texto: (max: number) => `No puede pasar de ${max} caracteres.`,
      correo: "Escribe un correo válido, o déjalo vacío.",
      enlace: "Tiene que ser una dirección https://.",
      general: "No pudimos guardar la configuración. Vuelve a intentarlo.",
    },
  },
} as const;
