/**
 * Todos los textos de «Ingresos de plataformas» (FIN-7), en un solo
 * sitio, como en el resto de los módulos: el lector de CSV devuelve
 * CÓDIGOS y aquí están las frases, para que traducir o corregir no sea
 * buscar comillas por el árbol.
 *
 * La regla que manda en las frases de ausencia: **una ausencia se
 * explica con una frase, nunca con un guion mudo ni con un cero.** Un
 * mes sin pago no vale «0»: vale «ese mes no entró nada» o «todavía no
 * hay con qué estimarlo», según lo que de verdad sepamos.
 */
import { VENTANA_PROMEDIO_MESES } from "@mc/core";

export const MESSAGES = {
  eyebrow: "Finanzas · ingresos",
  title: "Lo que te pagan las plataformas",
  description:
    "AdSense, Creator Rewards de TikTok y bonos de Instagram, cargados por CSV o a mano. Entran al flujo de caja como otros ingresos, estimados con el promedio de los últimos meses.",

  error: {
    eyebrow: "Finanzas · ingresos",
    title: "No pudimos leer tus ingresos de plataformas",
  },
  loading: {
    label: "Cargando ingresos de plataformas",
    kpis: ["Cobrado este año", "Último mes cerrado", "Estimado mensual"],
    section: "Pagos por periodo",
  },

  kpis: {
    ytd: (anio: number) => `Recibido en ${anio}`,
    ytdNota: (pagos: number) => `${pagos} ${pagos === 1 ? "pago" : "pagos"} cargados`,
    ytdVacio: "Todavía no has cargado ningún pago de este año",
    ultimoMes: "Último mes cerrado",
    ultimoMesVacio: "Sin pagos cargados de ese mes",
    estimado: "Estimado mensual",
    estimadoNota: (meses: number, promediados: number) =>
      promediados === meses
        ? `Promedio de los últimos ${meses} meses`
        : `Promedio de ${promediados} ${promediados === 1 ? "mes" : "meses"}: es lo que llevas cargado`,
    estimadoVacio: `Todavía no hay meses cerrados con ingresos para promediar`,
  },

  /**
   * Lo que de aquí entra al flujo de caja (FIN-6). La cifra es la misma
   * —`proyeccionDePlataformas` de @mc/core—, y el texto de la fila vive
   * en el messages.ts del módulo (`MESSAGES.flujo.otrosIngresos`), para
   * que las dos pantallas la nombren igual.
   */
  flujo: {
    titulo: "Entrada al flujo de caja",
    base: `estimado por promedio de los últimos ${VENTANA_PROMEDIO_MESES} meses`,
    baseParcial: (promediados: number) =>
      `estimado por promedio de ${promediados} ${promediados === 1 ? "mes" : "meses"}: es lo que llevas cargado`,
    sinDatos:
      "Cuando cierres tu primer mes con un pago cargado, esta cifra entra al flujo de caja. Hasta entonces no se inventa una.",
    verFlujo: "Ver el flujo de caja",
    comoEntra:
      "En el flujo de caja se reparte por semana (× 12 ÷ 52) y no se le aparta impuesto: la reserva se calcula sobre los cobros a marcas.",
  },

  tabla: {
    caption: "Pagos de plataformas por periodo, del más reciente al más antiguo",
    columnas: { mes: "Mes", plataforma: "Red", monto: "Monto" },
    meta: (pagos: number) => `${pagos} ${pagos === 1 ? "pago" : "pagos"}`,
    sinCreador: "Sin creador asignado",
  },
  origen: { api: "Por API", csv_import: "Importado de CSV", manual: "A mano" } as const,

  vacio: {
    title: "Todavía no hay ingresos de plataformas",
    description:
      "Sube el CSV que descargaste de AdSense o de Creator Rewards, o escribe el pago a mano. Con un mes cerrado ya se puede estimar lo que entra cada mes.",
    accion: "Importar un CSV",
  },

  acciones: { importar: "Importar CSV", aMano: "Agregar a mano", volver: "Volver a ingresos" },

  importar: {
    eyebrow: "Finanzas · ingresos",
    title: "Importar un CSV de ingresos",
    description:
      "AdSense (mensual o diario), Creator Rewards de TikTok, o una lista genérica con plataforma, inicio, fin, monto y moneda. El archivo se lee y se escribe de una vez; subir dos veces el mismo no duplica nada.",
    campo: { label: "Archivo CSV", ayuda: "Hasta 256 KB y 1000 filas. Separador coma o punto y coma." },
    enviar: "Importar",
    enviando: "Importando…",

    formatos: {
      adsense: "AdSense",
      tiktok_rewards: "Creator Rewards de TikTok",
      generico: "lista genérica",
    } as const,

    /** Lo que se dice después de escribir. */
    resultado: {
      titulo: "Listo",
      reconocido: (formato: string) => `Se leyó como ${formato}.`,
      escritos: (n: number) => `${n} ${n === 1 ? "pago entró" : "pagos entraron"}.`,
      nadaNuevo: "Todo lo del archivo ya estaba cargado: no se escribió nada.",
      repetidos: (n: number) =>
        `${n} ${n === 1 ? "pago ya estaba" : "pagos ya estaban"} cargados con el mismo monto y no se duplicaron.`,
      agrupadas: (n: number) =>
        `${n} ${n === 1 ? "fila diaria se sumó" : "filas diarias se sumaron"} dentro de su mes: un pago de plataforma es de un periodo, no de un día.`,
      monedaSupuesta: (moneda: string) =>
        `El archivo no dice la moneda por ningún lado, así que se tomaron como ${moneda}, la de tu espacio. Si no era esa, bórralos y vuelve a subirlos con una columna «moneda».`,
      codificacion: (cual: string) =>
        cual === "windows-1252"
          ? "El archivo venía en Windows-1252 (guardado con Excel para Windows): se leyó sin romper las tildes."
          : "",
    },

    /** Lo que impide siquiera empezar a revisar el archivo. */
    archivo: {
      sinArchivo: "Elige el archivo CSV que descargaste.",
      vacio: "El archivo está vacío.",
      sinEncabezados: "La primera línea del archivo no tiene nombres de columna.",
      sinFilas: "El archivo solo tiene la línea de encabezados.",
      demasiadasFilas: (filas: number, max: number) =>
        `El archivo trae ${filas} filas y el máximo es ${max}. Una exportación de pagos no es tan larga: revisa que sea el archivo correcto.`,
      demasiadoGrande: (max: number) =>
        `El archivo pasa de ${Math.round(max / 1024)} KB. Un CSV de pagos de plataforma son unas pocas filas: revisa que sea el archivo correcto.`,
      noEsCsv: "Solo se pueden subir archivos .csv.",
      formatoDesconocido:
        "No reconocimos ninguna columna de periodo y monto. Hace falta una columna de mes o fecha y una de importe; o, para una lista genérica, las columnas «plataforma», «inicio», «fin», «monto» y «moneda».",
      nadaQueEscribir: "Ninguna fila del archivo se pudo cargar. Abajo está lo que pasó con cada una.",
    },

    /** Un problema de una fila. `fila` la pone la pantalla. */
    validacion: {
      sinPeriodo: () => "sin mes ni fecha",
      periodoIlegible: (valor?: string) =>
        `no entendimos el periodo «${valor ?? ""}». Se aceptan 2026-09, 09/2026, 2026-09-15 y «septiembre de 2026»`,
      periodoAlReves: (valor?: string) => `el periodo termina antes de empezar (${valor ?? ""})`,
      sinMonto: () => "sin importe",
      montoIlegible: (valor?: string) => `no entendimos el importe «${valor ?? ""}»`,
      montoNegativo: (valor?: string) =>
        `el importe es negativo (${valor ?? ""}). Un ajuste o una devolución no se carga aquí todavía`,
      montoCero: (valor?: string) => `${valor ?? "ese mes"} suma cero: no se carga, porque un mes sin ingreso no es un pago de cero`,
      periodoNoCerrado: (valor?: string) =>
        `${valor ?? "ese periodo"} todavía no ha terminado: es lo que va del mes, no el pago. Vuelve a subirlo cuando cierre`,
      monedaDistinta: (valor?: string) =>
        `está en ${valor ?? "otra moneda"} y tu espacio lleva otra. No se carga: convertir necesita una tasa con fecha, y eso todavía no está`,
      sinPlataforma: () => "sin red",
      plataformaDesconocida: (valor?: string) =>
        `«${valor ?? ""}» no es una red conocida. Se aceptan TikTok, Instagram, Facebook y YouTube (AdSense entra como YouTube)`,
      filaTotal: () => "es la fila de totales del archivo, no un pago: se descartó",
    } satisfies Record<string, (valor?: string) => string>,

    conflicto: {
      titulo: "Mismo periodo, otro monto",
      explicacion:
        "Estos pagos ya estaban cargados con un importe distinto. No se escribieron ni se pisaron: si el bueno es el nuevo, hay que borrar el viejo (todavía no se puede desde aquí).",
      fila: (red: string, periodo: string, guardado: string, archivo: string) =>
        `${red} · ${periodo}: guardado ${guardado}, el archivo dice ${archivo}`,
    },
  },

  nuevo: {
    eyebrow: "Finanzas · ingresos",
    title: "Agregar un ingreso a mano",
    description:
      "Para lo que no tiene exportación: un bono de Instagram, un pago que llegó por correo. Queda igual que uno importado y entra al mismo promedio.",
    campos: {
      plataforma: { label: "Red", ayuda: "AdSense va como YouTube." },
      mes: { label: "Mes del pago", ayuda: "El periodo se completa con el mes entero." },
      inicio: { label: "Inicio del periodo" },
      fin: { label: "Fin del periodo" },
      monto: { label: "Monto" },
    },
    periodoPropio: "Escribir el periodo exacto en vez del mes entero",
    enviar: "Guardar el ingreso",
    enviando: "Guardando…",
    errores: {
      plataforma: "Elige la red que pagó.",
      mes: "Elige el mes del pago.",
      inicio: "Elige el inicio del periodo.",
      fin: "Elige el fin del periodo.",
      finAntesDeInicio: "El fin del periodo no puede ser anterior a su inicio.",
      monto: "Escribe el monto, con hasta dos decimales.",
      montoCero: "El monto tiene que ser mayor que cero.",
      futuro: "El periodo todavía no ha terminado: carga el pago cuando cierre.",
    },
    yaEstaba: (red: string, periodo: string) => `Ese pago ya estaba cargado: ${red}, ${periodo}. No se duplicó.`,
    choca: (red: string, periodo: string, guardado: string) =>
      `Ya hay un pago de ${red} para ${periodo} por ${guardado}. No se guardó nada: si el bueno es el nuevo, hay que borrar el viejo (todavía no se puede desde aquí).`,
    guardado: (red: string, periodo: string) => `Guardado: ${red}, ${periodo}.`,
  },

  generico: "No se pudo guardar. Vuelve a intentarlo en un momento.",
} as const;
