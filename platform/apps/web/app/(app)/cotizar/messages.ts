/**
 * TODO el texto de interfaz de Cotizar, incluidas sus páginas públicas.
 *
 * Un solo archivo por módulo: traducir el producto (o corregir una
 * palabra) no puede ser buscar por el árbol. Las funciones de aquí
 * componen frases a partir de números YA formateados por
 * lib/format.ts — nunca formatean ellas, porque la moneda, el locale y
 * la zona salen del workspace.
 *
 * Los nombres de los entregables y de los modificadores también viven
 * aquí: packages/core trabaja con ids ('derechos_uso_30d'), sin idioma.
 */

export const MESSAGES = {
  modulo: "Cotizar",

  /** Las tres pantallas del módulo, para moverse entre ellas. */
  navegacion: {
    tarifario: "Tarifario",
    mediaKit: "Media kit",
    cotizaciones: "Cotizaciones",
  },

  tarifario: {
    eyebrow: "Cotizar",
    title: "Cuánto cobrar, con los números que lo sostienen",
    description:
      "El rango sale de tus views medianas por red y del CPM de referencia de tu nicho. No es un precio: es dónde empieza y dónde termina la conversación con la marca.",
    guardar: "Guardar tarifario",
    recalcular: "Recalcular con mis métricas",
    tabla: "Entregables del tarifario, con su rango sugerido",
    columnas: {
      entregable: "Entregable",
      views: "Views por pieza",
      cpm: "CPM de referencia",
      rango: "Rango sugerido",
      estado: "Origen",
    },
    editado: "Editado a mano",
    sugerido: "Sugerido",
    viewsManuales: "Views a mano",
    viewsBaseline: "Mediana propia",
    pocaMuestra: "Muestra corta",
    vacio: {
      title: "Todavía no hay con qué calcular",
      description:
        "El tarifario necesita dos cosas: tus views medianas por red (salen solas cuando hay métricas) y el CPM de referencia de tu nicho y tu país.",
      accion: "Ver conexiones",
    },
    sinTarifario: {
      title: "Tu tarifario todavía no está guardado",
      description: "Revisa los rangos propuestos, ajústalos si hace falta y guárdalos: la cotización y el media kit los usan.",
    },
    modificadores: {
      title: "Condiciones que suben el precio",
      description: "Se suman sobre la base y se aplican de una vez, así que el orden en que las marques no cambia el total.",
    },
    comoSeCalcula: "Cómo se calcula",
    cerrar: "Cerrar",
  },

  /** Nombre de cada entregable del tarifario. El id es el que guarda la base. */
  entregables: {
    tiktok: "TikTok dedicado",
    reel: "Reel de Instagram",
    historias: "Historias (3)",
    youtube: "Video en YouTube",
    facebook: "Video en Facebook",
  } as Record<string, string>,

  /** Nombre de cada modificador. Los ids y sus porcentajes están en @mc/core. */
  modificadores: {
    derechos_uso_30d: "Derechos de uso · 30 días",
    exclusividad_30d: "Exclusividad de categoría · 30 días",
    uso_en_pauta_90d: "Uso en pauta pagada · 90 días",
    entrega_express: "Entrega exprés (menos de 7 días)",
  } as Record<string, string>,

  fuentesCpm: {
    manual: "estimación de mercado",
    deals: "negocios cerrados en On Cue",
    "informe-externo": "informe del sector",
  } as Record<string, string>,

  mediaKit: {
    eyebrow: "Cotizar · Media kit",
    title: "Tus números, congelados y compartibles",
    description:
      "Un media kit es una foto fija: lo que la marca ve hoy es lo que verá dentro de tres meses, aunque tus métricas cambien. Se comparte por enlace, con contraseña y vencimiento si hace falta.",
    generar: "Generar media kit",
    tabla: "Media kits generados, con su enlace y sus visitas",
    columnas: { creado: "Generado", enlace: "Enlace", visitas: "Visitas", estado: "Estado" },
    publico: "Público",
    privado: "Despublicado",
    conPassword: "Con contraseña",
    vence: "Vence",
    vencido: "Vencido",
    copiar: "Copiar enlace",
    copiado: "Copiado",
    abrir: "Abrir",
    despublicar: "Despublicar",
    publicar: "Publicar",
    vacio: {
      title: "Todavía no has generado ningún media kit",
      description: "Se genera con las cifras de hoy y no vuelve a cambiar. Puedes generar otro cuando tus números crezcan.",
    },
    opciones: {
      title: "Cómo se comparte",
      password: "Contraseña (opcional)",
      passwordAyuda: "Quien abra el enlace tendrá que escribirla. Se guarda cifrada, nunca en claro.",
      expira: "Vence el (opcional)",
      expiraAyuda: "Después de esa fecha el enlace deja de abrir. Las cifras siguen guardadas.",
    },
  },

  cotizaciones: {
    eyebrow: "Cotizar · Cotizaciones",
    title: "Lo que propusiste, y en qué quedó",
    description:
      "Una cotización se crea desde un negocio, se congela al enviarla y se acepta desde su enlace. Al aceptarse, el negocio pasa a «Ganado» y nace la campaña.",
    nueva: "Nueva cotización",
    tabla: "Cotizaciones, con su estado y su total",
    columnas: { numero: "Número", marca: "Marca", total: "Total", estado: "Estado", enviada: "Enviada" },
    vacio: {
      title: "Todavía no has cotizado nada",
      description: "La primera sale de un negocio del embudo: sus entregables salen de tu tarifario y sus totales, de la misma función que la factura.",
      accion: "Crear la primera",
    },
    estados: {
      draft: "Borrador",
      sent: "Enviada",
      viewed: "Vista por la marca",
      accepted: "Aceptada",
      rejected: "Rechazada",
      expired: "Vencida",
    } as Record<string, string>,
    sinEnviar: "Sin enviar",
  },

  nueva: {
    eyebrow: "Cotizar",
    title: "Nueva cotización",
    description: "Elige el negocio, arma los entregables desde tu tarifario y acuerda lo que se va a reportar antes de enviarla.",
    negocio: "Negocio",
    negocioAyuda: "La marca sale del negocio. Enviar la cotización lo pasa a «Propuesta enviada».",
    sinNegocio: "Elige el negocio que estás cotizando",
    entregables: "Entregables",
    agregar: "Agregar entregable",
    quitar: "Quitar",
    descripcion: "Descripción",
    descripcionVacia: "Qué entregas (Reel, TikTok dedicado…)",
    cantidad: "Cantidad",
    precio: "Precio por unidad",
    descuento: "Descuento",
    impuesto: "Impuesto %",
    impuestoAplicado: (pct: string) => `Impuesto (${pct} %)`,
    impuestoAyuda: "Se calcula sobre el subtotal ya con descuento, igual que en la factura.",
    validez: "Válida hasta",
    validezAyuda: "Después de esa fecha el enlace deja de aceptar.",
    acordado: "Lo acordado antes de publicar",
    acordadoAyuda:
      "Es lo que hace defendible el reporte final: qué se mide, en qué cortes, qué derechos se ceden y cuándo se paga. Va en la cotización, no en la campaña.",
    metricas: "Métricas a reportar",
    cortes: "Cortes del reporte",
    derechos: "Derechos de uso (días)",
    exclusividad: "Exclusividad (días)",
    exclusividadAmbito: "Ámbito de la exclusividad",
    pago: "Plazo de pago (días)",
    ventana: "Ventana de la campaña",
    ventanaAyuda: "Cuándo se publica. Al aceptar la cotización, la campaña nace con estas fechas.",
    desde: "Desde",
    hasta: "Hasta",
    guardar: "Guardar borrador",
    cancelar: "Cancelar",
    total: "Total de la cotización",
    subtotal: "Subtotal",
    neto: "Base gravable",
  },

  detalle: {
    eyebrow: "Cotizar",
    enviar: "Enviar y copiar enlace",
    copiar: "Copiar enlace",
    copiado: "Copiado",
    abrir: "Ver como la marca",
    aceptar: "Marcar aceptada",
    rechazar: "Marcar rechazada",
    crearCampana: "Crear la campaña",
    campanaPendiente: "Campaña: pendiente de Campañas",
    campanaPendienteAyuda:
      "La cotización está aceptada y el negocio, ganado. La campaña la crea el módulo Campañas con la ventana acordada.",
    campanaCreada: "Campaña creada",
    verCampana: "Ver la campaña",
    entregables: "Entregables",
    acordado: "Lo acordado",
    enlace: "Enlace para la marca",
    enlaceAyuda: "En el MVP no hay correo: se copia y se pega donde ya estás hablando con la marca.",
    visitas: (n: number) => (n === 1 ? "1 visita" : `${n} visitas`),
    sinVisitas: "Todavía sin abrir",
    metricas: "Métricas a reportar",
    cortes: "Cortes",
    derechos: "Derechos de uso",
    exclusividad: "Exclusividad",
    pago: "Plazo de pago",
    ventana: "Ventana de la campaña",
    dias: (n: number) => (n === 1 ? "1 día" : `${n} días`),
    /** Un corte del reporte: hasta 48 h en horas, de ahí en días («7 días», «30 días»). */
    horas: (n: number) => (n < 48 || n % 24 !== 0 ? `${n} h` : n === 24 ? "1 día" : `${n / 24} días`),
    sinAcordar: "Sin acordar",
    noAplica: "No aplica",
  },

  /** Las métricas que se pueden acordar. El valor es lo que se guarda. */
  metricas: {
    views: "Views",
    reach: "Alcance",
    interactions: "Interacciones",
    saves: "Guardados",
    shares: "Compartidos",
    link_clicks: "Clics al enlace",
    code_redemptions: "Canjes del código",
  } as Record<string, string>,

  publico: {
    kit: {
      title: "Media kit",
      seguidores: "Seguidores",
      viewsMedianas: "Views medianas",
      engagement: "Interacción por view",
      topPosts: "Lo que mejor funciona",
      audiencia: "Audiencia",
      tarifas: "Tarifas",
      tarifasAyuda: "Rangos de referencia. El precio final se acuerda en la cotización.",
      congelado: (fecha: string) => `Cifras congeladas el ${fecha}`,
      vsMediana: "× su mediana",
      password: {
        title: "Este media kit pide contraseña",
        description: "Quien te compartió el enlace también te dio la contraseña.",
        label: "Contraseña",
        enviar: "Entrar",
        error: "Esa contraseña no es.",
      },
      noExiste: {
        title: "Este enlace ya no existe",
        description: "Puede haberse despublicado. Pídele uno nuevo a quien te lo compartió.",
      },
      vencido: {
        title: "Este enlace venció",
        description: "Pídele uno nuevo a quien te lo compartió.",
      },
    },
    cotizacion: {
      title: "Cotización",
      para: "Para",
      de: "De",
      entregables: "Entregables",
      cantidad: "Cant.",
      precio: "Precio",
      subtotal: "Subtotal",
      descuento: "Descuento",
      impuesto: "Impuesto",
      total: "Total",
      acordado: "Lo que se acuerda",
      valida: (fecha: string) => `Válida hasta el ${fecha}`,
      aceptar: "Aceptar cotización",
      aceptando: "Aceptando…",
      aceptada: (fecha: string) => `Aceptada el ${fecha}`,
      rechazada: "Esta cotización fue rechazada.",
      vencida: "Esta cotización venció. Pide una nueva a quien te la envió.",
      graciasTitle: "Listo: cotización aceptada",
      graciasDescription: "Quien te la envió ya lo sabe y va a preparar la campaña con las fechas acordadas.",
      noExiste: {
        title: "Este enlace ya no existe",
        description: "Puede haberse retirado. Pídele uno nuevo a quien te lo compartió.",
      },
      error: "No pudimos registrar la aceptación. Vuelve a intentarlo en un momento.",
      pie: "Documento generado con On Cue",
    },
  },

  /**
   * El «Cómo se calcula», paso a paso. Recibe cifras YA formateadas
   * (lib/format.ts, con la moneda y el locale del workspace) y las
   * envuelve en palabras: aquí no se formatea nada.
   */
  explicacion: {
    views: (views: string, muestra?: string, corte?: string) =>
      muestra && corte
        ? `Tus views medianas: ${views} (últimos ${muestra} videos, medidos a las ${corte})`
        : `Tus views por pieza: ${views} (escritas a mano)`,
    viewsPocaMuestra: (muestra: string) => `Con solo ${muestra} videos la mediana todavía se mueve mucho: tómala como un punto de partida.`,
    cpm: (low: string, high: string, nicho: string, pais: string, fuente: string) =>
      `CPM de referencia de ${nicho} en ${pais}: ${low} – ${high} (${fuente})`,
    base: (low: string, high: string) => `Views ÷ 1.000 × CPM = ${low} – ${high}`,
    cantidad: (cantidad: string, low: string, high: string) => `× ${cantidad} piezas = ${low} – ${high}`,
    modificador: (nombre: string, pct: string, low: string, high: string) => `${nombre} (${pct}): + ${low} – ${high}`,
    descuento: (pct: string, low: string, high: string) => `Descuento del paquete (${pct}): − ${low} – ${high}`,
    total: (low: string, high: string) => `Rango sugerido: ${low} – ${high}`,
    editado: (low: string, high: string) => `Tú lo dejaste en ${low} – ${high}`,
  },

  error: {
    eyebrow: "Cotizar",
    title: "No pudimos leer tu tarifario",
    description:
      "La base de datos no respondió a tiempo o rechazó la conexión. Tus datos no cambiaron; vuelve a intentarlo y, si sigue igual, avísanos.",
    retry: "Reintentar",
    reference: "Referencia",
  },

  loading: {
    label: "Cargando el tarifario",
    section: "Entregables",
  },
} as const;

/** El nombre de un entregable, o su id si es uno nuevo. */
export function nombreEntregable(id: string): string {
  return MESSAGES.entregables[id] ?? id;
}

/** El nombre de un modificador, o su id si es uno nuevo. */
export function nombreModificador(id: string): string {
  return MESSAGES.modificadores[id] ?? id;
}

export function nombreMetrica(id: string): string {
  return MESSAGES.metricas[id] ?? id;
}

export function nombreEstadoCotizacion(status: string): string {
  return MESSAGES.cotizaciones.estados[status] ?? status;
}
