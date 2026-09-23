import type { BrandCsvRejectReason, MissingInput, ReportSentVia } from "@mc/core";
import { REPORT_SENT_VIA_LABEL_ES } from "@mc/core";
import type { TextosReporte } from "@mc/db";

/**
 * Textos de interfaz del módulo Campañas que no viven en una pantalla
 * concreta. Empieza con «Lo que aportó la marca» (CAM-4); el reporte a la
 * marca (CAM-6) trae los de su sección, su documento y su página pública,
 * y las frases que enviar deja en otras tablas. Las pantallas
 * de CAM-1 conservan sus frases en el JSX hasta que las toque una
 * historia.
 */
export const MESSAGES = {
  aporte: {
    title: "Lo que aportó la marca",
    /** Cabeceras de la tabla por kind. */
    table: {
      caption: "Lo que la marca reportó de la campaña, por concepto",
      kind: "Concepto",
      value: "Cifra",
      asOf: "A qué fecha",
      /** «total» es el último reportado; «daily» es la suma de los días. */
      lastTotal: "último total",
      sum: "suma",
      /** Cuántas filas hay detrás de la cifra, cuando son más de una. */
      rows: (n: string) => `${n} filas`,
    },
    empty: {
      title: "La marca todavía no reportó nada",
      editable: "Registra canjes, pedidos, ingresos o registros con el formulario, o importa el CSV de ventas diarias. Es la entrada del resultado de la campaña.",
      locked: "Esta campaña ya no admite aportes de la marca.",
    },
    chart: {
      title: "Ventas diarias reportadas",
      series: "Ventas",
      labelsHeader: "Día",
      ariaLabel: "Ventas diarias que la marca reportó por CSV",
      source: "CSV de ventas de la marca",
    },
    /** Formulario «Registrar aporte». */
    form: {
      title: "Registrar aporte",
      open: "Registrar aporte",
      help: "Un total acumulado a la fecha, tal como lo reporta la marca. Si después manda otra cifra, la última manda.",
      kind: "Qué reporta",
      kindPlaceholder: "Elige el concepto",
      day: "A qué fecha",
      value: "Cifra",
      valueHelpCount: "Un número entero, sin decimales.",
      valueHelpMoney: "Con hasta dos decimales.",
      currency: "Moneda",
      notes: "Nota",
      notesHelp: "Opcional. Por ejemplo, «correo de la marca del lunes». No se comparte con nadie.",
      submit: "Guardar",
      cancel: "Cancelar",
      saved: "Aporte registrado.",
      savedAgain: "Ese aporte ya estaba registrado igual: no se duplicó.",
      currencyWarning: (currency: string, campaignCurrency: string) => `Se guardó en ${currency}; la campaña está en ${campaignCurrency}.`,
      error: "No se pudo registrar el aporte.",
    },
    /** Formulario «Importar CSV de ventas». */
    csv: {
      title: "Importar CSV de ventas",
      open: "Importar CSV de ventas",
      help: "Una fila por día con las columnas día y ventas; pedidos y canjes son opcionales. Fechas como 2026-09-02 o 02/09/2026, separador coma o punto y coma.",
      file: "Archivo CSV",
      submit: "Importar",
      importing: "Importando…",
      cancel: "Cancelar",
      window: (from: string, to: string) => `Solo entran días entre el ${from} y el ${to} (una semana antes del inicio y sesenta días después del fin).`,
      noDates: "La campaña no tiene fechas de inicio y fin: ponlas en «Editar datos» antes de importar.",
      error: "No se pudo importar el CSV.",
      tooBig: (kib: number) => `El archivo pasa de ${kib} KiB. Un CSV de ventas diarias es mucho más pequeño: revisa que sea el archivo correcto.`,
      tooManyRows: (max: number) => `El archivo trae más de ${max} filas. Es una fila por día: revisa que sea el archivo correcto.`,
      empty: "El archivo está vacío.",
      noHeader: "El archivo no tiene cabecera.",
      noRows: "El archivo no tiene filas debajo de la cabecera.",
      missingColumns: (which: string) => `Falta la columna ${which}. Las cabeceras válidas son día (o fecha) y ventas; pedidos y canjes son opcionales.`,
      missing: "Elige un archivo.",
      notCsv: "El archivo tiene que ser un CSV.",
      /** El resumen de una importación. */
      summary: {
        title: "Importación terminada",
        days: (n: number) => (n === 1 ? "1 día aceptado" : `${n} días aceptados`),
        inserted: (n: number) => (n === 1 ? "1 dato nuevo" : `${n} datos nuevos`),
        unchanged: (n: number) => (n === 1 ? "1 ya estaba igual" : `${n} ya estaban igual`),
        replaced: (n: number) => (n === 1 ? "1 corregido con la cifra del archivo" : `${n} corregidos con la cifra del archivo`),
        rejected: (n: number) => (n === 1 ? "1 fila rechazada" : `${n} filas rechazadas`),
        nothing: "Ninguna fila se pudo importar.",
        row: (line: number) => `Fila ${line}`,
        encoding: "El archivo venía en Windows-1252 (Excel) y se leyó igual.",
        another: "Importar otro archivo",
      },
      reason: {
        fecha_ilegible: "la fecha no se entiende",
        fuera_de_rango: "queda fuera del rango de la campaña",
        dia_repetido: "el día ya venía antes en el archivo",
        ventas_vacia: "no trae ventas",
        ventas_ilegible: "las ventas no son un número",
        ventas_negativa: "las ventas son negativas",
        pedidos_ilegible: "los pedidos no son un entero",
        canjes_ilegible: "los canjes no son un entero",
      } satisfies Record<BrandCsvRejectReason, string>,
    },
  },
  /** «Resultado» (CAM-5): los seis KPIs de campaign_result. */
  resultado: {
    title: "Resultado",
    kpi: {
      views: "Views",
      reach: "Alcance",
      clicks: "Clics al enlace",
      redemptions: "Canjes del código",
      followers: "Seguidores ganados por la marca",
      cpm: "CPM",
    },
    /** Lo que dice una cifra que no está. Nunca un cero ni un guion. */
    absent: {
      brand: "Sin datos de la marca",
      posts: "Sin posts medidos",
      clicks: "Sin datos de clics",
      amount: "Sin monto acordado",
      /** Una cifra vacía sin causa registrada (una fila antigua): no se inventa el porqué. */
      notComputed: "Sin calcular",
    },
    note: {
      vsMedian: (x: string) => `${x} tu mediana`,
      nonFollowers: (pct: string) => `${pct} no te seguía`,
      revenue: (money: string) => `${money} en ventas atribuidas`,
      rate: (x: string) => `${x} su ritmo previo`,
      /** CAM-3: con menos de dos semanas de línea base, el ritmo no se compara. */
      rateShort: "línea base corta: sin ritmo comparable",
      cpa: (money: string) => `CPA ${money}`,
      cpaAbsent: "CPA sin datos de la marca",
      cpaNoAmount: "CPA sin monto acordado",
      cpaNoRedemptions: "CPA sin canjes reportados",
      costPerFollower: (money: string) => `${money} por seguidor`,
    },
    cut: (label: string) => `a ${label}`,
    partialCut: (label: string) => `parcial, a ${label}; se recalcula solo hasta llegar a 30 días`,
    asOfSource: (cut: string) => `resultado calculado ${cut}`,
    noCut: "sin posts medidos",
    /** Qué conceptos salen del CSV aunque haya también un total por formulario. */
    fromCsv: (concepts: string) => `${concepts} salen del CSV de ventas; el total por formulario queda como respaldo.`,
    concepts: { redemptions: "Los canjes", revenue: "Los ingresos", both: "Los canjes y los ingresos" },
    otherCurrency: (currency: string, campaign: string) => `Los ingresos que reportó la marca están en ${currency}: no se atribuyen a un resultado en ${campaign}.`,
    missingTitle: "Falta",
    missing: {
      posts: "posts con lecturas: asocia los posts de la campaña o espera su primera lectura",
      amount: "el monto acordado: sin él no hay CPM ni CPA",
      baseline: "la línea base del creador en alguna red: conecta más videos",
      brand_followers: "los seguidores de la marca",
      brand_followers_baseline_short: "dos semanas de seguidores de la marca antes de publicar",
      brand_inputs: "lo que aportó la marca: canjes, ingresos o el CSV de ventas",
      brand_csv_sales: "el CSV de ventas diarias de la marca",
    } satisfies Record<MissingInput, string>,
    complete: "Resultado completo a 30 días: ya puedes marcar el reporte listo.",
    empty: {
      title: "Todavía no hay resultado",
      description: "Se calcula cada mañana para las campañas en curso, en medición o con reporte listo, desde los posts asociados y lo que aporta la marca.",
      planned: "Una campaña planeada todavía no tiene posts que medir. El resultado empieza cuando la campaña esté en curso.",
    },
    daily: "Se recalcula cada mañana.",
    frozen: "Una campaña cerrada conserva su resultado: ya no se recalcula.",
    recompute: "Recalcular",
    recomputeError: "No se pudo recalcular el resultado.",
    recomputeDenied: "Desde la ficha todavía no se puede recalcular: el resultado se actualiza cada mañana.",
  },
  meta: {
    /** La pestaña de la marca: la campaña y quién la manda, como el asunto de una factura. Nunca se indexa. */
    reportePublico: (campana: string, creador: string) => (creador ? `${campana} · ${creador}` : campana),
    reportePublicoSinDatos: "Reporte",
    vistaPrevia: (campana: string) => `Vista previa del reporte · ${campana}`,
  },

  reporte: {
    title: "Reporte a la marca",
    generar: "Generar reporte",
    regenerar: "Generar de nuevo",
    /** Bajo el botón: qué hace generar según lo que hay. */
    ayudaSinReporte: "Congela lo acordado, los posts con sus cortes, el resultado, la curva de la marca y lo que aportó. Nace en borrador: nadie lo ve hasta que lo marques enviado.",
    ayudaBorrador: "El borrador se reemplaza con las cifras de ahora. Su enlace no abre hasta que lo marques enviado.",
    ayudaEnviado: "El reporte enviado no cambia aunque lleguen lecturas nuevas. Generar de nuevo crea otra versión con otro enlace; el anterior sigue abriendo y avisa que hay una más reciente.",
    noDisponible: {
      planned: "El reporte llega cuando la campaña esté en curso: hasta entonces no hay nada que congelar.",
      cancelled: "Una campaña cancelada no se reporta.",
    },
    confirmarRegenerar: "¿Generar de nuevo? El borrador actual se reemplaza con las cifras de ahora.",
    confirmarNuevaVersion: "¿Generar otra versión? La enviada seguirá abriendo con el aviso de que hay una más reciente.",
    previsualizar: "Previsualizar",
    enlace: "Enlace para la marca",
    copiarEnlace: "Enlace",
    /** Sin APP_URL en producción el enlace absoluto no se inventa (lib/auth/origen.ts). */
    sinOrigen: "falta configurar el dominio público de la aplicación (APP_URL) para mostrar el enlace completo",
    enlaceBorrador: "Este enlace no abre hasta que marques el reporte como enviado.",
    marcarEnlace: "Enviado por enlace",
    marcarPdf: "Enviado como PDF",
    confirmarEnviado: (via: ReportSentVia) =>
      `¿Marcar el reporte como enviado ${REPORT_SENT_VIA_LABEL_ES[via]}? Desde ahora el enlace abre para la marca y las cifras quedan congeladas.`,
    estado: "Estado",
    generado: (fecha: string) => `Cifras congeladas el ${fecha}`,
    enviado: (via: ReportSentVia, fecha: string) => `Enviado ${REPORT_SENT_VIA_LABEL_ES[via]} el ${fecha}`,
    visto: (fecha: string) => `Abierto por la marca el ${fecha}`,
    sinAbrir: "La marca todavía no lo abre",
    visitas: (n: number) => (n === 1 ? "1 apertura" : `${n} aperturas`),
    versiones: "Versiones",
    version: (n: number) => `Versión ${n}`,
    versionReemplazada: "Reemplazada por una más reciente",
    versionVigente: "Vigente",
    descargarPdf: "Descargar PDF",
    descargarPdfAyuda: "Abre el diálogo de impresión: elige «Guardar como PDF».",
    /** El aviso de la vista previa, arriba del documento. */
    vistaPreviaBorrador: "Vista previa. Es un borrador: la marca no puede abrirlo todavía.",
    vistaPreviaEnviado: "Vista previa. Es lo que la marca ve en su enlace.",
    volver: "Volver a la campaña",
    errores: {
      generar: "No se pudo generar el reporte.",
      enviar: "No se pudo marcar el reporte como enviado.",
      reporte: "El reporte no es válido.",
      via: "Elige cómo lo enviaste: por enlace o como PDF.",
    },
  },

  /** La página que abre la marca (y la vista previa del creador). Solo lee el payload. */
  documento: {
    eyebrow: "Reporte de campaña",
    de: "De",
    para: "Para",
    fechas: (rango: string) => `Campaña del ${rango}`,
    sinFechas: "Campaña sin fechas acordadas",
    /** Arriba, antes que cualquier cifra: lo que se acordó antes de publicar. */
    acordado: "Acordado antes de publicar",
    acordadoDe: (numero: string) => `Cotización ${numero}`,
    sinCotizacion: "Los términos se acordaron fuera de On Cue: no hay cotización que citar.",
    resultado: "Resultado",
    resultadoCorte: (corte: string) => `Consolidado al corte de ${corte}`,
    resultadoCalculado: (fecha: string) => `calculado el ${fecha}`,
    sinResultado: "El resultado consolidado todavía no está: las cifras de cada post, abajo, sí.",
    faltantes: "Para completarlo falta:",
    kpi: {
      views: "Visualizaciones",
      reach: "Alcance",
      interactions: "Interacciones",
      saves: "Guardados",
      shares: "Compartidos",
      linkClicks: "Clics al enlace",
      reachNonFollowers: "Alcance fuera de seguidores",
      brandFollowersGained: "Seguidores ganados por la marca",
      codeRedemptions: "Canjes del código",
      attributedRevenue: "Ventas atribuidas",
      cpm: "CPM",
      costPerFollower: "Costo por seguidor",
      cpa: "Costo por canje",
      emv: "Valor mediático (EMV)",
    },
    sinDato: "Sin dato",
    posts: "Los posts",
    post: "Post",
    metrica: "Métrica",
    principal: "Principal",
    publicado: (fecha: string) => `Publicado el ${fecha}`,
    sinFechaPublicacion: "Sin fecha de publicación",
    corte: (corte: string) => `A ${corte}`,
    ultimaLectura: (fecha: string) => `Última lectura: ${fecha}`,
    sinLectura: "Todavía sin lectura en este corte",
    sinPosts: "El reporte se generó sin posts asociados.",
    metricaPost: {
      views: "Visualizaciones",
      reach: "Alcance",
      likes: "Me gusta",
      comments: "Comentarios",
      shares: "Compartidos",
      saves: "Guardados",
      totalInteractions: "Interacciones",
    },
    seguidores: "Seguidores de la marca",
    seguidoresDe: (handle: string) => `@${handle}`,
    seguidoresSerie: "Seguidores",
    seguidoresVentana: (rango: string) => `Campaña ${rango}`,
    seguidoresLineaBase: (fecha: string) => `Línea base desde el ${fecha}`,
    seguidoresAria: (handle: string) => `Seguidores de @${handle} por día, con la ventana de la campaña sombreada`,
    sinSeguidores: (handle: string | null) =>
      handle ? `Todavía no hay serie de seguidores de @${handle}: se toma del perfil público cada día.` : "La campaña no tiene una cuenta de la marca que medir.",
    seguidoresSinCuenta: "Sin cuenta de la marca",
    aportes: "Lo que aportó la marca",
    aporte: {
      code_redemptions: "Canjes del código",
      orders: "Pedidos",
      revenue: "Ingresos",
      signups: "Registros",
      csv_sales: "Ventas diarias (CSV)",
      postback: "Conversiones (postback)",
    } as Record<string, string>,
    aporteFuente: {
      brand_manual: "reportado por la marca",
      brand_csv: "CSV de la marca",
      integration: "integración",
      postback: "postback",
    } as Record<string, string>,
    aporteDia: (fecha: string) => `al ${fecha}`,
    sinAportes: "La marca no ha compartido canjes, pedidos ni ingresos.",
    seguimiento: "Seguimiento",
    codigo: "Código",
    enlaceRastreado: "Enlace",
    sinSeguimiento: "Esta campaña no usó código ni enlace rastreado.",
    congelado: (fecha: string) => `Cifras congeladas el ${fecha}`,
    /** El aviso de un enlace que otra versión enviada dejó atrás (0037 §1). */
    versionAntigua: "Hay una versión más reciente de este reporte. Quien te lo envió tiene el enlace nuevo; este sigue mostrando lo que decía cuando se envió.",
    pie: (creador: string) => (creador ? `Reporte preparado por ${creador} con On Cue` : "Reporte preparado con On Cue"),
  },

  publico: {
    noExiste: {
      title: "Este enlace no existe",
      description: "Puede haberse retirado o estar mal copiado. Pídele uno nuevo a quien te lo compartió.",
    },
  },
} as const;


/**
 * Las frases que marcar «enviado» deja en la historia de la empresa
 * (Ventas la enseña en la ficha) y en el aviso al creador. Se pasan a
 * @mc/db, que no tiene idioma.
 */
export const TEXTOS_REPORTE: TextosReporte = {
  actividadEnviado: ({ campaignName, via }) => `Reporte de «${campaignName}» enviado ${REPORT_SENT_VIA_LABEL_ES[via]}`,
  avisoEnviado: ({ companyName, campaignName, via }) => ({
    title: `Reporte enviado a ${companyName}`,
    body: `«${campaignName}», ${REPORT_SENT_VIA_LABEL_ES[via]}. Cuando la marca lo abra, la ficha lo dirá.`,
  }),
};
