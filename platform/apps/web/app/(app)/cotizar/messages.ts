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

/**
 * El idioma en que están escritos estos textos. El MVP es solo español
 * (decisión escrita en README.md); cuando llegue un segundo idioma,
 * será otro objeto con la misma forma que MESSAGES y esta constante
 * dejará de ser única.
 */
export const IDIOMA_MENSAJES = "es";

/**
 * El `lang` de un documento que abre la marca (media kit, cotización).
 * Las cifras siguen el locale del workspace, pero los textos están en
 * IDIOMA_MENSAJES: declarar `en-US` sobre frases en español haría que
 * un lector de pantalla las pronunciara en inglés. Si el locale es del
 * mismo idioma («es-MX»), se conserva la región.
 */
export function idiomaDocumento(locale: string | null | undefined): string {
  const idioma = (locale ?? "").split("-")[0]?.toLowerCase();
  return idioma === IDIOMA_MENSAJES && locale ? locale : IDIOMA_MENSAJES;
}

export const MESSAGES = {
  modulo: "Cotizar",

  /**
   * Los títulos de pestaña (metadata.title) de cada pantalla, y los de
   * las dos páginas que abre la marca. El layout raíz les pone « · On Cue».
   */
  meta: {
    tarifario: "Cotizar",
    mediaKits: "Media kit",
    mediaKitVistaPrevia: "Vista previa del media kit",
    cotizaciones: "Cotizaciones",
    nueva: "Nueva cotización",
    cotizacion: "Cotización",
    editar: "Editar cotización",
    vistaPrevia: "Vista previa de la cotización",
    /** La pestaña de la marca: el número y quién la manda, como el asunto de una factura. */
    cotizacionPublica: (numero: string, creador: string) => (creador ? `${numero} · ${creador}` : numero),
    cotizacionPublicaSinDatos: "Cotización",
    /** Solo con el kit abierto: detrás de una contraseña no se dice de quién es. */
    kitPublico: (creador: string) => (creador ? `Media kit · ${creador}` : "Media kit"),
    kitPublicoSinDatos: "Media kit",
  },

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
      "El rango sale de tus visualizaciones medianas por red y del CPM de referencia de tu nicho. No es un precio: es dónde empieza y dónde termina la conversación con la marca.",
    guardar: "Guardar tarifario",
    guardado: "Guardado",
    recalcular: "Volver a la fórmula",
    editar: "Editar",
    listo: "Listo",
    tabla: "Entregables del tarifario, con su rango sugerido",
    columnas: {
      entregable: "Entregable",
      views: "Visualizaciones por pieza",
      cpm: "CPM de referencia",
      rango: "Rango sugerido",
      estado: "Origen",
    },
    piezas: (n: string) => `${n} piezas`,
    rangoBajo: "bajo",
    rangoAlto: "alto",
    cpmBajo: "CPM bajo",
    cpmAlto: "CPM alto",
    editado: "Editado a mano",
    sugerido: "Sugerido",
    cpmPropio: "CPM propio",
    cpmReferencia: (low: string, high: string) => `Referencia del nicho: ${low} – ${high}`,
    /** En la columna del rango, cuando el CPM propio está al revés (el error va junto a sus campos). */
    cpmRevisar: "Corrige el CPM para ver el rango.",
    viewsManuales: "Visualizaciones a mano",
    viewsBaseline: "Mediana propia",
    viewsPocoFiables: "Mediana con poca muestra",
    /** Placeholder del campo de views vacío. Recibe la cifra ya formateada. */
    viewsEjemplo: (views: string) => `p. ej. ${views}`,
    /** Lo que falta en una fila que todavía no tiene rango. */
    motivos: {
      sin_views: "Escribe las visualizaciones de una pieza para ver el rango.",
      views_poco_fiables: (muestra: string, mediana: string) =>
        `Tu mediana sale de solo ${muestra} videos (${mediana}). Confírmala o escribe la tuya.`,
      sin_cpm: (red: string, pais: string) => `No hay CPM de referencia para ${red} en ${pais}. Escribe el tuyo.`,
      /** Hay referencia para el país, pero en otra moneda que la del workspace: no se convierte. */
      sin_cpm_moneda: (moneda: string, red: string) => `No hay CPM de referencia en ${moneda} para ${red}. Escribe el tuyo.`,
      cpm_invertido: "El CPM bajo no puede ser mayor que el alto.",
    },
    /** Por qué un rango escrito a mano no vale (validarRangoPrecio de @mc/core). */
    rangoErrores: {
      vacio: "Escribe los dos extremos del rango.",
      no_numero: "El rango tiene que ser un número.",
      invertido: "El precio bajo no puede ser mayor que el alto.",
      cero: "El precio alto tiene que ser mayor que cero.",
    } as Record<string, string>,
    rangoRevisar: "Hay rangos o CPM que no valen. Corrígelos (van marcados en la tabla) y vuelve a guardar.",
    vacio: {
      title: "Todavía no hay con qué calcular",
      description:
        "El tarifario necesita dos cosas: tus visualizaciones medianas por red (salen solas cuando hay métricas) y el CPM de referencia de tu nicho y tu país.",
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
    /** Título del desglose que se abre bajo la fila. */
    desgloseDe: (nombre: string) => `Cómo se calcula · ${nombre}`,
  },

  paquetes: {
    title: "Paquetes",
    description:
      "Varios entregables juntos con un descuento. El rango es la suma de sus piezas sueltas menos el descuento, y se guarda en el tarifario como un entregable más.",
    agregar: "Agregar paquete",
    quitar: "Quitar paquete",
    descuento: "Descuento del paquete (%)",
    descuentoError: "El descuento es un porcentaje entre 0 y 100.",
    cantidad: (nombre: string) => `Cantidad de ${nombre} en el paquete`,
    incluye: "Incluye",
    vacio: "Marca al menos un entregable con rango para armar el paquete.",
    sinPrecios: "Primero hace falta el rango de algún entregable.",
    /** «Paquete: 1 TikTok dedicado + 3 Historias (3)». Recibe las partes ya compuestas. */
    nombre: (partes: readonly string[]) => `Paquete: ${partes.join(" + ")}`,
    parte: (cantidad: string, nombre: string) => `${cantidad} × ${nombre}`,
    etiqueta: (n: number) => `Paquete ${n}`,
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
    creador: "tu CPM",
  } as Record<string, string>,

  mediaKit: {
    eyebrow: "Cotizar · Media kit",
    title: "Tus números, congelados y compartibles",
    description:
      "Un media kit es una foto fija: lo que la marca ve hoy es lo que verá dentro de tres meses, aunque tus métricas cambien. Se comparte por enlace, con contraseña y vencimiento si hace falta.",
    generar: "Generar media kit",
    generado: "Media kit generado. Cópialo desde la lista.",
    tabla: "Media kits generados, con su enlace y sus visitas",
    columnas: { creado: "Generado", enlace: "Enlace", visitas: "Visitas", estado: "Estado", acciones: "Acciones" },
    publico: "Público",
    privado: "Despublicado",
    conPassword: "Con contraseña",
    vence: "Vence",
    vencido: "Vencido",
    copiar: "Copiar enlace",
    copiado: "Copiado",
    abrir: "Vista previa",
    despublicar: "Despublicar",
    publicar: "Publicar",
    /**
     * El bloqueo por contraseñas fallidas (migración 0030): el del enlace
     * entero deja fuera a todos; el de un origen, solo a quien falló.
     */
    bloqueado: "Bloqueado",
    bloqueadoHasta: (hora: string) => `Nadie puede entrar hasta las ${hora}: demasiadas contraseñas fallidas.`,
    origenesBloqueados: (n: number) =>
      n === 1
        ? "1 visitante bloqueado 15 minutos por contraseñas fallidas."
        : `${n} visitantes bloqueados 15 minutos por contraseñas fallidas.`,
    desbloquear: "Desbloquear",
    desbloquearAria: "Desbloquear este media kit: borra la cuenta de contraseñas fallidas",
    /**
     * El aviso al creador cuando el techo POR ENLACE deja un media kit
     * bloqueado para todos, marca incluida (0030, pulido r6). Sin él se
     * enteraba cuando la marca se quejaba.
     */
    avisosBloqueo: {
      title: "Media kits bloqueados",
      titulo: (fechaKit: string) => `Tu media kit del ${fechaKit} quedó bloqueado`,
      hasta: (hora: string) =>
        `Hubo demasiadas contraseñas fallidas en una hora y nadie puede entrar hasta las ${hora}, tampoco la marca.`,
      yaAbierto: "Hubo demasiadas contraseñas fallidas en una hora. El bloqueo ya pasó y se puede entrar otra vez.",
      consejo: "Si no fue la marca, genera otro enlace: el nuevo no lo tiene quien lo está intentando.",
      entendido: "Entendido",
      /**
       * Lo que queda guardado en la notificación. Sin horas ni cifras: se
       * escribe desde el enlace público, sin la zona del creador a mano, y
       * esta pantalla lo recompone con el kit y su bloqueo de hoy.
       */
      guardado: {
        title: "Un media kit quedó bloqueado por contraseñas fallidas",
        body: "Nadie puede entrar durante 15 minutos, tampoco la marca. Desbloquéalo desde Cotizar › Media kit.",
      },
    },
    vacio: {
      title: "Todavía no has generado ningún media kit",
      description: "Se genera con las cifras de hoy y no vuelve a cambiar. Puedes generar otro cuando tus números crezcan.",
    },
    opciones: {
      title: "Cómo se comparte",
      password: "Contraseña (opcional)",
      passwordAyuda:
        "Mínimo 8 signos. Quien abra el enlace tendrá que escribirla. Se guarda como huella (no se puede leer ni recuperar); si la olvidas, genera otro enlace.",
      placeholder: "Sin contraseña",
      mostrar: "Mostrar",
      ocultar: "Ocultar",
      mostrarAria: "Mostrar la contraseña",
      ocultarAria: "Ocultar la contraseña",
      expira: "Vence el (opcional)",
      expiraAyuda: "El enlace deja de abrir al terminar ese día, en tu zona horaria. Las cifras siguen guardadas.",
    },
    vistaPrevia: {
      eyebrow: "Cotizar · Media kit · Vista previa",
      aviso: "Vista previa: así lo ve la marca. Abrirla aquí no cuenta como visita.",
      volver: "Volver a los media kits",
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
      /** 'expired' porque la reemplazó otra versión del mismo negocio (0033), no por su fecha. */
      superseded: "Sin efecto",
    } as Record<string, string>,
    sinEnviar: "Sin enviar",
  },

  nueva: {
    eyebrow: "Cotizar",
    title: "Nueva cotización",
    description: "Elige el negocio, arma los entregables desde tu tarifario y acuerda lo que se va a reportar antes de enviarla.",
    editarTitle: "Editar borrador",
    editarDescription: "Mientras no la envíes, la cotización se corrige aquí sin gastar otro número.",
    sinNegocios: {
      title: "No hay negocios abiertos para cotizar",
      description: "Una cotización nace de un negocio del embudo que todavía no está ganado ni perdido.",
      accion: "Ir a Ventas",
    },
    negocio: "Negocio",
    negocioAyuda: "La marca sale del negocio. Enviar la cotización lo pasa a «Propuesta enviada».",
    /**
     * El negocio elegido ya tiene una cotización que la marca puede
     * aceptar: enviar esta la deja sin efecto (0033). Se dice al elegirlo,
     * no después de enviar (pulido r7).
     */
    negocioConViva: (numeros: readonly string[]) =>
      numeros.length === 1
        ? `Este negocio ya tiene ${numeros[0]} enviada. Cuando envíes esta, ${numeros[0]} dejará de poder aceptarse.`
        : `Este negocio ya tiene ${numeros.join(", ")} enviadas. Cuando envíes esta, dejarán de poder aceptarse.`,
    sinNegocio: "Elige el negocio que estás cotizando",
    entregables: "Entregables",
    // Sin tarifario guardado, el selector solo ofrece «Otro entregable»:
    // se dice por qué y se lleva adonde se guarda.
    sinTarifario: {
      texto: "Todavía no guardaste tu tarifario: guárdalo en Cotizar y aquí podrás elegir cada entregable con su precio.",
      accion: "Ir al tarifario",
    },
    entregable: "Entregable",
    otro: "Otro entregable",
    agregar: "Agregar entregable",
    quitar: "Quitar",
    descripcion: "Descripción",
    descripcionVacia: "Qué entregas (Reel, TikTok dedicado…)",
    cantidad: "Cantidad",
    precio: "Precio por unidad",
    rangoTarifario: (low: string, high: string) => `Tarifario: ${low} – ${high}`,
    fueraDeRango: "Fuera del rango",
    descuento: "Descuento",
    impuesto: "Impuesto %",
    impuestoAplicado: (pct: string) => `Impuesto (${pct})`,
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
    exclusividadEjemplo: "Ej.: bebidas calientes",
    pago: "Plazo de pago (días)",
    ventana: "Ventana de la campaña",
    ventanaAyuda: "Cuándo se publica. Al aceptar la cotización, la campaña nace con estas fechas.",
    desde: "Desde",
    hasta: "Hasta",
    mediaKit: "Media kit que la acompaña",
    mediaKitAyuda: "La marca lo abre desde el pie de la cotización. Solo salen los públicos y sin vencer.",
    sinMediaKit: "Sin media kit",
    /** Una opción del selector: «Generado el 20 sep · 3:15 p. m. · con contraseña». La hora separa dos del mismo día. */
    mediaKitOpcion: (fecha: string, hora: string, conPassword: boolean) =>
      `Generado el ${fecha} · ${hora}${conPassword ? " · con contraseña" : ""}`,
    /** El media kit elegido pide contraseña, y esa contraseña no se puede recuperar. */
    mediaKitConPassword:
      "Este media kit tiene contraseña: tendrás que dársela a la marca. Si no la recuerdas, elige otro o genera uno sin contraseña.",
    /** Debajo del precio de una línea del tarifario: las condiciones que ese precio ya cobra. */
    incluye: (condiciones: readonly string[]) => `El precio del tarifario incluye: ${condiciones.join(", ")}.`,
    sinKitsAyuda: "No hay media kits públicos sin vencer. Genera uno en Media kit si quieres que acompañe la cotización.",
    guardar: "Guardar borrador",
    guardarCambios: "Guardar cambios",
    cancelar: "Cancelar",
    total: "Total de la cotización",
    subtotal: "Subtotal",
    neto: "Base gravable",
  },

  detalle: {
    eyebrow: "Cotizar",
    enviar: "Enviar y copiar enlace",
    enviando: "Enviando…",
    enviadaCopiado: "Enviada · enlace copiado",
    enviadaSinCopiar: "Enviada. Copia el enlace desde aquí:",
    copiar: "Copiar enlace",
    copiado: "Copiado",
    verVistaPrevia: "Vista previa",
    editar: "Editar",
    eliminar: "Eliminar borrador",
    aceptar: "Marcar aceptada",
    rechazar: "Marcar rechazada",
    crearCampana: "Crear la campaña",
    campanaPendiente: "Campaña: pendiente de Campañas",
    campanaPendienteAyuda:
      "La cotización está aceptada y el negocio, ganado. La campaña la crea el módulo Campañas con la ventana acordada.",
    campanaSinFechas:
      "La cotización se aceptó sin la ventana de la campaña. Di cuándo se publica y Campañas la crea con esas fechas.",
    ventanaDesde: "Desde",
    ventanaHasta: "Hasta",
    /**
     * Las acciones que no se deshacen piden un segundo paso en la misma
     * tarjeta, como las de Stripe Quotes: qué va a pasar y un botón que
     * lo dice.
     */
    confirmar: {
      cancelar: "Cancelar",
      aceptar: {
        pregunta: (numero: string) => `¿Marcar ${numero} como aceptada?`,
        consecuencia:
          "El negocio pasará a «Ganado» y se creará la campaña con la ventana acordada. No se puede deshacer.",
        consecuenciaSinVentana:
          "El negocio pasará a «Ganado». Como no hay ventana acordada, después te pediremos las fechas para crear la campaña. No se puede deshacer.",
        boton: "Sí, marcar aceptada",
      },
      rechazar: {
        pregunta: (numero: string) => `¿Rechazar ${numero}?`,
        consecuencia: "La marca ya no podrá aceptarla desde el enlace. No se puede deshacer.",
        boton: "Sí, rechazar",
      },
      /**
       * Enviar un borrador cuyo negocio ya tiene otra versión viva: la
       * deja sin efecto (0033) y eso no se deshace, así que pide el mismo
       * segundo paso que aceptar y rechazar (pulido r7).
       */
      enviar: {
        pregunta: (numero: string) => `¿Enviar ${numero}?`,
        consecuencia: (numeros: readonly string[]) =>
          numeros.length === 1
            ? `${numeros[0]} dejará de poder aceptarse, también si la marca la tiene abierta ahora. No se puede deshacer.`
            : `${numeros.join(", ")} dejarán de poder aceptarse, también si la marca las tiene abiertas ahora. No se puede deshacer.`,
        boton: "Sí, enviar y copiar enlace",
      },
      eliminar: {
        pregunta: (numero: string) => `¿Eliminar el borrador ${numero}?`,
        consecuencia: "Se borra con sus entregables. No se puede deshacer.",
        boton: "Sí, eliminar",
      },
    },
    /** Encima del botón de rechazar, para separarlo de «aceptar». */
    otraRespuesta: "¿La marca dijo que no?",
    campanaCreada: "Campaña creada",
    verCampana: "Ver la campaña",
    entregables: "Entregables",
    acordado: "Lo acordado",
    historia: "Historia",
    enlace: "Enlace para la marca",
    enlaceAyuda: "Copia el enlace y pégalo donde ya hablas con la marca.",
    /**
     * Una cotización que ya no se puede aceptar: su enlace sigue abriendo
     * (la marca lee por qué), pero no se ofrece copiarlo (pulido r7).
     */
    enlaceMuerto: {
      /** Solo se manda a la sucesora si su enlace sirve: viva, o aceptada (la marca ve lo que firmó). */
      sinEfecto: (numero: string, estadoSucesora: string | null) =>
        estadoSucesora === "rejected" || estadoSucesora === "expired"
          ? `Este enlace ya no acepta, y el de ${numero}, que la reemplazó, tampoco. Si la marca quiere retomarla, crea otra versión.`
          : `Este enlace ya no acepta: comparte el de ${numero}.`,
      rechazada: "Este enlace ya no acepta: la cotización está rechazada. Si la marca quiere retomarla, crea otra versión.",
      vencida: "Este enlace ya no acepta: pasó su fecha de validez. Si la marca quiere retomarla, crea otra versión.",
    },
    visitas: (n: number) => (n === 1 ? "1 visita" : `${n} visitas`),
    sinVisitas: "Todavía sin abrir",
    totalLinea: "Total",
    /** Debajo de la descripción de una línea: «2 × COP 1.200.000». Recibe cifras ya formateadas. */
    cantidadPorPrecio: (cantidad: string, precio: string) => `${cantidad} × ${precio}`,
    aceptadaPor: (nombre: string, correo: string | null) => (correo ? `${nombre} · ${correo}` : nombre),
    /** Las fechas del ciclo, en el orden en que pasan. */
    fechas: {
      creada: "Creada",
      enviada: "Enviada",
      vista: "Vista por la marca",
      aceptada: "Aceptada",
      rechazada: "Rechazada",
      vencida: "Vencida",
      sinEfecto: "Sin efecto",
    },
    /**
     * Una versión nueva del mismo negocio deja sin efecto las que
     * siguieran vivas (0033): un negocio, una cotización que la marca
     * puede aceptar. Reciben números COT-AAAA-NNN ya compuestos.
     */
    dejaSinEfecto: (numeros: readonly string[]) =>
      numeros.length === 1
        ? `${numeros[0]} queda sin efecto: la marca ya no puede aceptarla. Vale esta.`
        : `${numeros.join(", ")} quedan sin efecto: la marca ya no puede aceptarlas. Vale esta.`,
    /**
     * Depende de cómo esté HOY la versión que la reemplazó: decir «es la
     * que la marca puede aceptar» de una ya aceptada era falso (pulido r7).
     */
    quedoSinEfecto: (numero: string, estadoSucesora: string | null) =>
      estadoSucesora === "accepted"
        ? `Quedó sin efecto: la reemplazó ${numero}, que la marca ya aceptó.`
        : estadoSucesora === "rejected"
          ? `Quedó sin efecto: la reemplazó ${numero}, que después se rechazó.`
          : estadoSucesora === "expired"
            ? `Quedó sin efecto: la reemplazó ${numero}, que tampoco sigue vigente.`
            : `Quedó sin efecto: la reemplazó ${numero}, que es la que la marca puede aceptar.`,
    /**
     * En un borrador cuyo negocio tiene otra versión viva: lo que pasará
     * al enviarlo, antes de enviarlo (0033, pulido r7).
     */
    alEnviarQuedaSinEfecto: (numeros: readonly string[]) =>
      numeros.length === 1
        ? `Al enviarla, ${numeros[0]} deja de poder aceptarse: la marca que tenga ese enlace abierto ya no podrá aceptarla.`
        : `Al enviarla, ${numeros.join(", ")} dejan de poder aceptarse: la marca que tenga esos enlaces abiertos ya no podrá aceptarlas.`,
    verVersion: (numero: string) => `Ver ${numero}`,
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
    vistaPrevia: {
      eyebrow: (numero: string) => `Cotizar · ${numero} · Vista previa`,
      aviso: "Vista previa: así la ve la marca. Abrirla aquí no cuenta como visita ni la marca como vista.",
      avisoBorrador: "Vista previa del borrador: así la verá la marca cuando la envíes.",
      volver: "Volver a la cotización",
    },
  },

  /**
   * Los errores que una acción del panel puede enseñar. La URL lleva el
   * CÓDIGO (?error=QuoteNotEditable), nunca el texto: así nadie puede
   * fabricar un enlace que muestre una alerta inventada, y un error de
   * Postgres en inglés no llega a la pantalla.
   */
  errores: {
    QuoteNotFound: "Esa cotización no existe en este espacio de trabajo.",
    QuoteNotEditable: "Una cotización enviada ya no se edita. Si hace falta cambiarla, crea otra.",
    QuoteNotDraft: "Solo un borrador se puede eliminar.",
    QuoteTransitionError: "La cotización ya no está en un estado que permita esa acción. Recarga para ver cómo quedó.",
    QuoteSinItems: "Una cotización necesita al menos un entregable.",
    QuoteNotAccepted: "Solo una cotización aceptada crea campaña.",
    FechasDeCampanaFaltan: "Falta la ventana de la campaña. Di cuándo empieza y cuándo termina para crearla.",
    FinAntesDeInicio: "El fin de la campaña no puede ser anterior al inicio.",
    InvalidDatesError: "Las fechas de la campaña no son válidas: revisa el inicio y el fin.",
    QuoteNotAcceptedError: "Solo una cotización aceptada crea campaña.",
    ValidezVencida: "La fecha «Válida hasta» ya pasó: la marca abriría una cotización vencida. Cámbiala en el borrador y vuelve a enviar.",
    RangoInvertido: "Un rango del tarifario está al revés: el precio bajo es mayor que el alto.",
    RangoVacio: "Un rango del tarifario tiene un extremo vacío.",
    RangoEnCero: "Un rango del tarifario tiene el precio alto en cero.",
    RangoNoNumero: "Un rango del tarifario no es un número.",
    MediaKitNotFound: "Ese media kit no existe en este espacio de trabajo.",
    CreatorNotFound: "No encontramos tu perfil de creador.",
    DealNotFound: "Ese negocio no existe en este espacio de trabajo.",
    CompanyNotFound: "Elige la marca a la que le cotizas.",
    TasaInvalida: "El impuesto es un porcentaje entre 0 y 100.",
    TarifarioVacio: "Todavía no hay ningún entregable que se pueda calcular.",
    DescuentoMayorQueSubtotal: "El descuento no puede ser mayor que el subtotal.",
    DealAlreadyAccepted:
      "Este negocio ya se ganó con otra cotización aceptada. Aceptar o enviar otra versión duplicaría la campaña y el ingreso: si lo acordado cambió, rechaza esta y ajusta la campaña.",
    OtraVersionEnCurso: "Otra versión de esta cotización está en uso ahora mismo (la marca la está abriendo o aceptando). Recarga y vuelve a intentarlo.",
    formularioIlegible: "No pudimos leer el formulario. Recarga la página e inténtalo otra vez.",
    tarifarioIlegible: "No pudimos leer los cambios del tarifario. Recarga la página e inténtalo otra vez.",
    generico: "No se pudo completar la acción. Vuelve a intentarlo; si sigue igual, avísanos.",
  } as Record<string, string>,

  /** Los mensajes de validación de los formularios del panel. */
  validacion: {
    negocio: "Elige el negocio que estás cotizando.",
    entregables: "Agrega al menos un entregable.",
    descripcion: "Cada entregable necesita una descripción.",
    cantidad: "La cantidad va de 1 a 999.",
    precio: "El precio tiene que ser un número.",
    descuento: "El descuento tiene que ser un número.",
    impuesto: "El impuesto es un porcentaje entre 0 y 100.",
    fecha: "Elige una fecha válida.",
    fechaObligatoria: "Elige la fecha.",
    finAntesDeInicio: "El fin de la campaña no puede ser anterior al inicio.",
    passwordCorta: "La contraseña necesita al menos 8 signos.",
  },

  /**
   * Las frases que Cotizar deja en tablas de otros módulos: la historia
   * del negocio (Ventas la enseña tal cual) y el aviso al creador. Las
   * compone _lib/textos.ts; la base guarda además el código y los
   * parámetros.
   */
  actividad: {
    enviada: (numero: string) => `Cotización ${numero} enviada`,
    aceptadaPanel: (numero: string) => `Cotización ${numero} marcada como aceptada`,
    aceptadaEnlace: (numero: string, firma: string | null) =>
      firma ? `Cotización ${numero} aceptada por ${firma} desde el enlace` : `Cotización ${numero} aceptada desde el enlace`,
    firma: (nombre: string, correo: string | null) => (correo ? `${nombre} <${correo}>` : nombre),
    /** Los montos llegan ya formateados; son sin impuesto, como el pipeline. */
    monto: (numero: string, antes: string | null, ahora: string) =>
      antes
        ? `El monto del negocio pasó de ${antes} a ${ahora}, sin impuesto, como en la cotización ${numero}`
        : `El monto del negocio quedó en ${ahora}, sin impuesto, como en la cotización ${numero}`,
    avisoTitulo: (marca: string, numero: string) => `${marca} aceptó la cotización ${numero}`,
    avisoConCampana: (firma: string | null, campana: string) =>
      `${firma ? `Aceptada por ${firma}. ` : ""}La campaña «${campana}» ya está planeada.`,
    avisoSinCampana: (firma: string | null) =>
      `${firma ? `Aceptada por ${firma}. ` : ""}La campaña quedó pendiente: termínala desde la cotización.`,
  },

  /** Los avisos de «la marca aceptó» en la lista de cotizaciones. */
  avisos: {
    title: "Aceptadas desde el enlace",
    aceptada: (marca: string, numero: string) => `${marca} aceptó ${numero}`,
    firmo: (nombre: string) => `Firmó ${nombre}`,
    campana: (nombre: string) => `Campaña «${nombre}» planeada`,
    campanaPendiente: "Campaña pendiente: termínala desde la cotización",
    ver: "Ver cotización",
    entendido: "Entendido",
  },

  /** Las métricas que se pueden acordar. El valor es lo que se guarda. */
  metricas: {
    views: "Visualizaciones",
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
      redes: "Redes",
      seguidores: "Seguidores",
      viewsMedianas: "Visualizaciones medianas",
      /** La cifra grande de la cabecera: la mediana de la red que más rinde, con su red al lado. */
      viewsMedianasMejorRed: "Visualizaciones medianas · mejor red",
      /** Nombre accesible de la cabecera de cifras. */
      cifras: "Cifras principales",
      engagement: "Interacción por visualización",
      topPosts: "Lo que mejor funciona",
      audiencia: "Audiencia",
      audienciaDe: (dimension: string, red: string) => `${dimension} · ${red}`,
      dimensiones: { age: "Edad", gender: "Género", country: "País" } as Record<string, string>,
      generos: { F: "Mujeres", M: "Hombres", U: "Sin dato" } as Record<string, string>,
      otros: "Otros",
      tarifas: "Tarifas",
      tarifasAyuda: "Rangos de referencia. El precio final se acuerda en la cotización.",
      /** Debajo de las tarifas: las condiciones que los rangos ya cobran. Recibe los nombres de messages.modificadores. */
      tarifasIncluyen: (condiciones: readonly string[]) => `Estos rangos ya incluyen: ${condiciones.join(", ")}.`,
      congelado: (fecha: string) => `Cifras congeladas el ${fecha}`,
      vsMediana: (multiplo: string) => `${multiplo} su mediana`,
      password: {
        title: "Este media kit pide contraseña",
        description: "Quien te compartió el enlace también te dio la contraseña.",
        label: "Contraseña",
        enviar: "Entrar",
        mostrar: "Mostrar",
        ocultar: "Ocultar",
        mostrarAria: "Mostrar la contraseña",
        ocultarAria: "Ocultar la contraseña",
        error: "Esa contraseña no es.",
        errorQuedan: (n: number) => (n === 1 ? "Esa contraseña no es. Te queda 1 intento." : `Esa contraseña no es. Te quedan ${n} intentos.`),
        bloqueado: (hora: string) => `Demasiados intentos. Podrás volver a probar a las ${hora}.`,
        demasiados: "Demasiados intentos seguidos. Espera un minuto y vuelve a probar.",
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
      impuestoConTasa: (pct: string) => `Impuesto (${pct})`,
      total: "Total",
      acordado: "Lo que se acuerda",
      valida: (fecha: string) => `Válida hasta el ${fecha}`,
      aceptar: "Aceptar cotización",
      aceptando: "Aceptando…",
      aceptada: (fecha: string) => `Aceptada el ${fecha}`,
      aceptadaPor: (nombre: string, fecha: string) => `Aceptada por ${nombre} el ${fecha}`,
      /**
       * 'rejected' la escribe el creador: al marcarla rechazada desde el
       * panel o al perder el negocio (0031). La marca no la rechazó: se le
       * dice que la conversación se cerró y cómo retomarla.
       */
      rechazada: "Quien te envió esta cotización la cerró. Si quieres retomarla, escríbele.",
      vencida: "Esta cotización venció. Pide una nueva a quien te la envió.",
      /** Una versión que otra más reciente del mismo acuerdo dejó sin efecto (0033). */
      sinEfecto: "Esta versión quedó sin efecto: quien te la envió mandó una más reciente, o ya se aceptó otra para este mismo acuerdo. Usa el último enlace que te compartió.",
      yaAceptada: "Esta cotización ya estaba aceptada: no hace falta hacer nada más.",
      firma: {
        title: "Para aceptarla, deja tu nombre",
        description: "Queda registrado quién la aceptó y cuándo, como en una propuesta firmada.",
        nombre: "Tu nombre",
        correo: "Tu correo",
        terminos: "Leí la cotización y acepto sus términos",
        errores: {
          nombre: "Escribe tu nombre.",
          correo: "Escribe un correo válido.",
          terminos: "Marca la casilla para aceptar los términos.",
        },
      },
      /** La respuesta a la propia firma: solo la ve quien acaba de aceptar. */
      graciasTitle: "Listo: cotización aceptada",
      graciasDescription: "Quedó registrada a tu nombre. Le avisamos a quien te la envió.",
      /**
       * El estado leído al abrir el enlace de una ya aceptada: lo puede
       * ver otra persona del equipo de la marca, así que va en tercera
       * persona (pulido r7). Recibe la fecha ya formateada.
       */
      aceptadaTitle: "Cotización aceptada",
      aceptadaLeida: (nombre: string | null, fecha: string) =>
        nombre
          ? `Aceptada por ${nombre} el ${fecha}. Quien te la envió ya lo sabe.`
          : `Aceptada el ${fecha}. Quien te la envió ya lo sabe.`,
      error: "No pudimos registrar la aceptación. Vuelve a intentarlo en un momento.",
      pie: "Documento generado con On Cue",
    },
    // Sin esqueleto de carga a propósito: un loading.tsx en (public)
    // mandaba el 200 antes de saber si el enlace existe (no-existe.test.tsx).
    noExiste: {
      title: "Este enlace no existe",
      description: "Puede haberse retirado o estar mal copiado. Pídele uno nuevo a quien te lo compartió.",
    },
    error: {
      title: "No pudimos abrir este documento",
      description: "Algo falló de nuestro lado, no del enlace. Vuelve a intentarlo en un momento.",
      retry: "Reintentar",
      reference: "Referencia",
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
        ? `Tus visualizaciones medianas: ${views} (últimos ${muestra} videos, medidos a las ${corte})`
        : `Tus visualizaciones por pieza: ${views} (escritas a mano)`,
    viewsPocaMuestra: (muestra: string) => `Con solo ${muestra} videos la mediana todavía se mueve mucho: tómala como un punto de partida.`,
    cpm: (low: string, high: string, nicho: string, pais: string, fuente: string) =>
      `CPM de referencia de ${nicho} en ${pais}: ${low} – ${high} (${fuente})`,
    cpmPropio: (low: string, high: string) => `Tu CPM: ${low} – ${high} (lo escribiste tú)`,
    base: (low: string, high: string) => `Visualizaciones ÷ 1.000 × CPM = ${low} – ${high}`,
    cantidad: (cantidad: string, low: string, high: string) => `× ${cantidad} piezas = ${low} – ${high}`,
    modificador: (nombre: string, pct: string, low: string, high: string) => `${nombre} (${pct}): + ${low} – ${high}`,
    descuento: (pct: string, low: string, high: string) => `Descuento del paquete (${pct}): − ${low} – ${high}`,
    componente: (cantidad: string, nombre: string, low: string, high: string) => `${cantidad} × ${nombre}: ${low} – ${high}`,
    subtotal: (low: string, high: string) => `Piezas sueltas: ${low} – ${high}`,
    /** Recibe el rango EXACTO; el redondeado es el del paso siguiente («Rango sugerido»). */
    redondeo: (low: string, high: string) => `Sin redondear: ${low} – ${high}. Se propone a tres cifras, como se negocia un precio.`,
    total: (low: string, high: string) => `Rango sugerido: ${low} – ${high}`,
    editado: (low: string, high: string) => `Tú lo dejaste en ${low} – ${high}`,
  },

  /**
   * El nombre y el título de la frontera de error. Lo demás —las causas,
   * la pista de despliegue, Reintentar y Volver al plan— es el de la
   * aplicación ((app)/_lib/messages.ts), igual que en Finanzas.
   */
  error: {
    eyebrow: "Cotizar",
    title: "No pudimos leer tu tarifario",
  },

  loading: {
    label: "Cargando el tarifario",
    section: "Entregables",
    /** Los esqueletos de cada lista y del formulario (pulido r4: ya no heredan el del tarifario). */
    cotizaciones: "Cargando las cotizaciones",
    mediaKits: "Cargando los media kits",
    nueva: "Cargando la nueva cotización",
    /** El detalle y la edición, detrás de su <Suspense> (pulido r5). */
    cotizacion: "Cargando la cotización",
    editar: "Cargando el borrador",
  },

  /**
   * El 404 de una cotización o un media kit que no existe (o es de otro
   * espacio de trabajo). Sin esto caía en el genérico de (app), que
   * manda al plan y no a la lista de donde venía.
   */
  noEncontrado: {
    cotizacion: {
      eyebrow: "Cotizar · Cotizaciones",
      title: "Esa cotización no está en tu espacio",
      description: "Puede que la hayas eliminado siendo un borrador, que el enlace esté mal copiado o que sea de otro espacio de trabajo.",
      accion: "Volver a Cotizaciones",
    },
    mediaKit: {
      eyebrow: "Cotizar · Media kit",
      title: "Ese media kit no está en tu espacio",
      description: "Puede que el enlace esté mal copiado o que sea de otro espacio de trabajo.",
      accion: "Volver a los media kits",
    },
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

/** El texto de un código de error de una acción; si el código no es conocido, el genérico. */
export function mensajeDeError(code: string | undefined | null): string | null {
  if (!code) return null;
  return Object.hasOwn(MESSAGES.errores, code) ? MESSAGES.errores[code]! : MESSAGES.errores.generico!;
}
