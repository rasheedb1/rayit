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
