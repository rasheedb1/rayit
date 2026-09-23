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
} as const;
