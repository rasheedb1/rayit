/**
 * Textos de interfaz del módulo Finanzas que no viven en una pantalla
 * concreta: el estado de error y el de carga del segmento. Un solo
 * sitio por módulo para que traducirlos o corregirlos no sea buscar por
 * el árbol.
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
  loading: {
    label: "Cargando facturas",
    kpis: ["Por cobrar", "Vencido", "Cobrado este año", "Apartado para impuestos"],
    section: "Facturas",
  },
  /** La sección «Pagos» del detalle de una factura (FIN-2). */
  pagos: {
    title: "Pagos",
    /** Sin cobros: una frase, no una tabla vacía ni un cero. */
    empty: "Todavía no hay cobros registrados en esta factura.",
    emptyPayable: "Cuando entre el dinero, regístralo aquí y la factura se actualiza sola.",
    columns: { date: "Fecha", amount: "Monto", method: "Método", reference: "Referencia" },
    noReference: "Sin referencia",
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
  errores: {
    pago: "No se pudo registrar el pago.",
  },
} as const;
