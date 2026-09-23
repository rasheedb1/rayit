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
  /**
   * La bandeja de recordatorios (FIN-4). El texto del correo NO está
   * aquí: lo redacta @mc/core y lo guarda el job, para que la pantalla
   * no escriba dos veces lo mismo. Aquí solo está el marco.
   */
  bandeja: {
    titulo: "Recordatorios por enviar",
    descripcion:
      "El cobro se redacta solo cada día, con el tono que toca según los días de mora. Cópialo, mándalo desde tu correo y márcalo como enviado. Todavía no se envía solo: eso llega cuando la plataforma tenga correo saliente.",
    vacioTitulo: "No hay recordatorios por enviar",
    vacioDescripcion:
      "Aparecen solos: una semana antes del vencimiento, el día que vence y a los 7, 21 y 45 días de mora. Si no hay ninguno, ninguna factura llegó todavía a uno de esos días.",
    asunto: "Asunto",
    redactadoEl: "Redactado el",
    primeros: "Los primeros",
    copiar: "Copiar",
    copiado: "Copiado",
    copiadoAviso: "Asunto y cuerpo copiados",
    copiarFalló: "No se pudo copiar: selecciónalo y cópialo a mano",
    marcar: "Marcar como enviado",
    enviadoEl: "Marcado como enviado el",
    verFactura: "Ver la factura",
    enLaFactura: "Recordatorios de esta factura",
    sinRecordatorios:
      "Esta factura no tiene recordatorios todavía: se escriben solos desde una semana antes del vencimiento.",
  },

  /** Las seis vistas del módulo. Son enlaces: cada una tiene su URL. */
  tabs: {
    label: "Vistas de Finanzas",
    cobros: "Cobro",
    facturas: "Facturas",
    gastos: "Gastos",
    flujo: "Flujo",
    ingresos: "Ingresos",
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
      /** El rótulo de la bandeja de FIN-4, que va entre los KPI y la tabla. */
      bandeja: "Recordatorios por enviar",
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
  /** La sección «Pagos» del detalle de una factura (FIN-2). */
  pagos: {
    title: "Pagos",
    /** Sin cobros: una frase, no una tabla vacía ni un cero. */
    empty: "Todavía no hay cobros registrados en esta factura.",
    emptyPayable: "Cuando entre el dinero, regístralo aquí y la factura se actualiza sola.",
    columns: { date: "Fecha", amount: "Monto", method: "Método", reference: "Referencia" },
    noReference: "Sin referencia",
    /** `payment.method` es nullable: un cobro de antes puede no traerlo. */
    noMethod: "Sin método",
    /** El apartado de impuestos, en la lista y en la cabecera. */
    reserved: "Apartado para impuestos",
    reservedWith: (pct: string) => `Apartado para impuestos (${pct} %)`,
    /** El espacio no tiene porcentaje configurado: se dice, no se pone un cero. */
    noReserve: "Este espacio todavía no aparta un porcentaje para impuestos.",
    /** Lo que se aparta de este cobro, bajo su monto en la lista. */
    reservedOf: (monto: string, pct: string) => `${monto} apartados (${pct} %)`,
    form: {
      title: "Registrar pago",
      amount: "Monto del pago",
      amountHelp: (saldo: string) => `Pendiente por cobrar: ${saldo}. Un abono menor también vale.`,
      date: "Fecha del cobro",
      dateHelp: "El día en que entró el dinero. No puede ser en el futuro.",
      method: "Método",
      methodPlaceholder: "Elige cómo entró el pago",
      reference: "Referencia",
      referenceHelp: "Opcional: lo que dice el extracto del banco.",
      notes: "Notas",
      notesHelp: "Opcional. Para ti.",
      submit: "Registrar pago",
      ok: "Pago registrado.",
    },
    /** Por qué no se puede cobrar, según el estado persistido de la factura. */
    notPayable: {
      draft: "Esta factura todavía es un borrador: márcala enviada para poder registrar cobros.",
      paid: "Esta factura ya está cobrada por completo.",
      void: "Esta factura está anulada y no admite cobros.",
    },
    /**
     * Anular un cobro no existe en el MVP: obliga a decidir qué pasa con
     * su apartado de impuestos y a dejar rastro de la anulación. Se dice
     * en vez de esconderlo.
     */
    noVoid: "Un cobro registrado no se puede anular todavía. Si te equivocaste, avísanos.",
  },
  /** Los avisos que Finanzas deja escritos en `notification` (ver _lib/textos.ts). */
  avisos: {
    pagoTitulo: (invoiceNumber: string) => `Pago recibido · ${invoiceNumber}`,
    pagoPagada: (companyName: string, monto: string) => `${companyName} pagó ${monto}. La factura queda cobrada por completo.`,
    pagoParcial: (companyName: string, monto: string, saldo: string) =>
      `${companyName} abonó ${monto}. Quedan ${saldo} por cobrar.`,
  },
  /**
   * Por qué el panel de acciones no ofrece nada, por estado. Una frase
   * por estado y no «Una factura {estado} no admite…»: con FIN-2 el
   * estado `partial` es alcanzable y esa plantilla decía «Una factura
   * pago parcial no admite…», que no se lee.
   */
  estadoSinAcciones: {
    draft: "Marca la factura como enviada para poder cobrarla.",
    sent: "Esta factura está enviada y esperando el cobro.",
    partial: "Esta factura ya tiene cobros registrados: cambia de estado sola al terminar de cobrarse.",
    overdue: "Esta factura está vencida: registra el cobro cuando entre el dinero.",
    paid: "Esta factura ya está cobrada por completo y no admite más cambios.",
    void: "Esta factura está anulada y no admite más cambios.",
  },
  /**
   * Los errores de dominio de @mc/core llegan con su `messageEs` ya en
   * español, pero con las cifras y las fechas en crudo: el paquete no
   * tiene formateador. Los tres que llevan un dato se reescriben aquí
   * con el del espacio; el resto se muestra tal cual.
   */
  errores: {
    pago: "No se pudo registrar el pago.",
    facturaIda: "Esta factura ya no existe en tu espacio.",
    conflicto: (antes: string, ahora: string) =>
      `Esta factura cambió mientras registrabas el pago: llevaba ${antes} cobrado y ahora lleva ${ahora}. ` +
      "Recarga la página y comprueba antes de volver a registrarlo.",
    excede: (saldo: string) =>
      `El pago no puede pasar de lo que queda por cobrar (${saldo}). ` +
      "Si la marca pagó de más, regístralo por lo que debía y avísanos.",
    futuro: (dia: string, hoy: string) => `Un cobro no se puede fechar en el futuro: ${dia} es posterior a hoy (${hoy}).`,
  },
  /** FIN-6 · /finanzas/flujo. */
  flujo: {
    eyebrow: "Finanzas",
    title: "Qué entra y qué sale las próximas ocho semanas",
    description:
      "Las facturas por cobrar caen en la semana en que vencen; los negocios ganados que todavía no tienen factura, a los días de plazo del espacio. De ahí se restan el ritmo de gastos recurrentes y lo que hay que apartar para impuestos.",
    volver: "Ver las facturas",
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
    /**
     * Los ingresos de plataformas (FIN-7): entran como «otros ingresos»
     * y SIEMPRE dicen que son un estimado. Una cifra proyectada que se
     * presenta igual que una factura firmada es una promesa que nadie
     * hizo.
     */
    otrosIngresos: {
      fila: "Ingresos de plataformas (estimado)",
      columna: "Otros ingresos",
      base: (meses: number) => `estimado por promedio de los últimos ${meses} meses`,
      baseParcial: (promediados: number) =>
        `estimado por promedio de ${promediados} ${promediados === 1 ? "mes" : "meses"}: es lo que llevas cargado`,
      sinDatos:
        "Todavía no hay meses cerrados con ingresos de plataformas, así que no entran al flujo: no se inventa una cifra.",
      cargar: "Cargar ingresos de plataformas",
    },
    tabla: {
      seccion: "Semana a semana",
      caption: "Flujo de caja proyectado, semana a semana",
      semana: "Semana",
      cobros: "Cobros",
      otros: "Otros ingresos",
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
} as const;
