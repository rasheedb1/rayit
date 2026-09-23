import type { CsvImportErrorCode } from "@mc/db/queries/resumen";
import type { ErrorCsvCodigo, ProblemaCodigo, ProblemaFechaExportacion } from "./importar/_lib/csv";
import type { Campo, FormatoId } from "./importar/_lib/formatos";

/**
 * Todos los textos de interfaz del módulo Resumen, en un solo archivo.
 *
 * Por qué aquí y no repartidos por las pantallas: el producto está
 * pensado para salir de Colombia, y traducirlo no puede ser buscar
 * comillas por el árbol. Las cifras y las fechas NO se formatean aquí:
 * las formatea `lib/format.ts` con el locale, la moneda y la zona del
 * workspace, y llegan ya como texto. Por eso los contadores reciben DOS
 * argumentos: el número, para elegir singular o plural, y su texto ya
 * formateado («1.234», no «1234»).
 *
 * Las palabras son las que el creador ya conoce de TikTok Studio y de
 * Instagram Insights —Seguidores, Visualizaciones, Alcance,
 * Guardados—, no las nuestras.
 */

/** «1 video» · «1.234 videos». `n` decide el número gramatical; `txt` es `n` ya formateado. */
const contar = (n: number, txt: string, uno: string, varios: string) => (n === 1 ? `1 ${uno}` : `${txt} ${varios}`);

export const MESSAGES = {
  page: {
    /** El título de la pestaña del navegador. */
    metaTitle: "Resumen",
    eyebrow: "Resumen",
    title: "Todas tus redes en una sola lectura",
    description:
      "Seguidores, visualizaciones, alcance en no seguidores y guardados, por red y en el tiempo. Cada cifra se compara con el periodo anterior y dice hasta qué día llegan sus datos.",
    plan: "Plan de construcción",
    importar: "Importar un CSV",
  },
  filtros: {
    periodo: "Periodo",
    red: "Red",
    todasLasRedes: "Todas",
    dias: (n: number) => `${n} días`,
  },
  kpis: {
    followers: {
      label: "Seguidores en total",
      /** Se usa cuando el filtro deja una sola red. */
      labelRed: (red: string) => `Seguidores en ${red}`,
      /** Sin serie de cuenta —solo CSV— no hay seguidores que contar. */
      sinCuenta: "Llegan al conectar la cuenta: un CSV trae métricas por video",
    },
    views: {
      label: (dias: number) => `Visualizaciones en ${dias} días`,
      /**
       * Cuando la serie de cuenta aún no cerró el último día del reloj:
       * la suma termina antes, y se dice hasta cuándo. `fecha` ya formateada.
       */
      hastaCuenta: (fecha: string) => `Hasta el ${fecha}, el último día que cerró la cuenta`,
      /** Con serie de cuenta: cuenta otra cosa que las dos tarjetas de al lado. */
      note: "De tus cuentas, no solo de lo publicado en el periodo",
      /** Sin serie de cuenta: la suma de lo publicado, y hay que decirlo. */
      noteContenido: (n: number, txt: string) =>
        `De ${contar(n, txt, "video publicado", "videos publicados")} en el periodo, con su última lectura`,
    },
    nonFollowerReach: {
      label: "Alcance en no seguidores",
    },
    savesPer1k: {
      label: "Guardados por 1 000 visualizaciones",
    },
    /**
     * La base de los dos KPIs de contenido: sobre cuántos videos se
     * calculó la razón y con qué lectura. «Vida completa» porque se usa
     * la última lectura de cada video en los dos periodos, no un corte
     * de edad.
     */
    base: (n: number, txt: string) => `Sobre ${contar(n, txt, "video", "videos")}, en su vida completa`,
    /** Para las sumas del periodo. */
    deltaLabel: (dias: number) => `vs. los ${dias} días anteriores`,
    /** Para los valores de un instante, como los seguidores. */
    deltaLabelPunto: (dias: number) => `vs. hace ${dias} días`,
    sinComparacion: "Sin periodo anterior con qué comparar",
    /** El delta de un KPI que ya es un porcentaje: diferencia en puntos. `txt` = «+2,1». */
    puntos: (txt: string) => `${txt} puntos`,
    /**
     * Cuentas que suman en la cifra pero no en la comparación ni en la
     * línea: empezaron a medirse dentro del tramo comparado.
     */
    nuevas: (n: number, txt: string) =>
      n === 1 ? "1 cuenta nueva no entra en la comparación" : `${txt} cuentas nuevas no entran en la comparación`,
    sinDato: "—",
  },
  graficos: {
    seguidores: {
      title: "Seguidores por red",
      subtitle: (dias: number) => `Un punto por día · ${dias} días`,
      aria: "Seguidores por red, un punto por día",
      labelsHeader: "Fecha",
      nota: "El eje arranca en cero, así que la curva enseña el tamaño y no solo el movimiento.",
      /** Solo con todas las redes: con una sola, no hay otras con las que desalinearse. */
      notaRedes: "Una red que empezó a medirse dentro del periodo aparece en cero hasta su primera lectura.",
      sinCuenta: {
        title: "Los seguidores llegan al conectar la cuenta",
        description:
          "Tus CSV traen métricas por video; los seguidores y las visualizaciones diarias llegan al conectar la cuenta.",
        accion: "Conectar una cuenta",
      },
    },
    views: {
      title: "Visualizaciones por red",
      /** El subtítulo dice cuánto cubre cada barra, que cambia con el periodo. */
      subtitle: (paso: number, bloques: number) =>
        paso === 1 ? `Por día · ${bloques} días` : `Cada ${paso} días · ${bloques} barras`,
      aria: "Visualizaciones por red y periodo",
      /** Con bloques, cada etiqueta ES el rango: «26–30/8». */
      labelsHeaderBloque: "Días",
      labelsHeaderDia: "Día",
      nota: (paso: number) =>
        paso === 1 ? undefined : `Cada barra son ${paso} días contados hacia atrás desde el último día cerrado; juntas cubren el periodo entero.`,
      /** Sin serie de cuenta, las barras son otra cosa y se dice. */
      notaContenido:
        "Sin cuenta conectada: cada barra suma las visualizaciones de lo publicado en esos días, con su última lectura.",
    },
  },
  /**
   * Los días del módulo son días cerrados en UTC (la convención del
   * repositorio: `account_metric_snapshot.day` es el día de la plataforma
   * y no se puede pasar a otra zona). Se dice junto a cada «datos hasta
   * el…»: en Bogotá, a las 21:30 del 22, «hasta el 22» se leía como
   * «incluye hoy».
   */
  zona: {
    /** Va como `source` de DataAsOf: «datos hasta el 22 sep · día cerrado en UTC». */
    asOf: "día cerrado en UTC",
    /** Una sola vez, bajo el título del aviso de frescura. */
    frescura: "Cada fecha es un día cerrado en UTC.",
  },
  frescura: {
    title: "Hasta cuándo llegan los datos",
    sinLecturas: "Sin lecturas todavía",
    fuente: {
      api: "API",
      csv: "CSV importado",
    },
    tokenPorVencer: "Permiso por vencer",
    /** Cuando la conexión no está sana: lo primero que hay que ver. */
    estado: {
      expired: "Permiso vencido",
      revoked: "Acceso revocado",
      error: "Con error",
      needs_reauth: "Hay que volver a conectarla",
      disabled: "Pausada",
    } as Record<string, string>,
    estadoDesconocido: "Con problemas",
    /** Cuando sus datos van por detrás del último día cerrado del resto. */
    atrasada: (n: number, txt: string) => (n === 1 ? "1 día por detrás" : `${txt} días por detrás`),
    revisar: "Revisar conexiones",
  },
  vacio: {
    sinConexiones: {
      title: "Todavía no hay ninguna cuenta conectada",
      description:
        "Resumen se llena con lo que traen tus cuentas. Conecta una red para que el recolector empiece, o sube un CSV exportado de TikTok Studio, Instagram Insights o YouTube Studio mientras llegan las aprobaciones.",
      conectar: "Conectar una cuenta",
      importar: "Importar un CSV",
    },
    sinDatos: {
      title: "Las cuentas están conectadas, pero aún no hay lecturas",
      description:
        "El recolector cierra el día anterior de madrugada; la primera sincronización puede tardar unas horas. Si no quieres esperar, importa el CSV de tu exportación.",
      importar: "Importar un CSV",
    },
    /**
     * Cuando la tarjeta de un gráfico se queda sin datos, la salida
     * depende de dónde esté el filtro: ofrecer «Ver 90 días» a quien ya
     * está en 90 días es un callejón sin salida.
     */
    periodoSinDatos: {
      title: "No hay datos en este periodo",
      masLargo: {
        description: "Prueba con un periodo más largo: quizá las lecturas empiezan antes de esta ventana.",
        accion: "Ver 90 días",
      },
      quitarRed: {
        description: "Esta red todavía no tiene lecturas en los últimos 90 días. Mira todas juntas para ver lo que sí hay.",
        accion: "Quitar el filtro de red",
      },
      sinSalida: {
        description:
          "No hay ninguna lectura en los últimos 90 días. En cuanto el recolector cierre un día, o importes un CSV, aparece aquí.",
      },
    },
  },
  /**
   * El nombre y el título de la frontera de error. Lo demás —las causas,
   * la pista de despliegue, Reintentar y Volver al plan— es el de la
   * aplicación ((app)/_lib/messages.ts), igual que en Finanzas.
   */
  error: {
    eyebrow: "Resumen",
    title: "No pudimos leer tus métricas",
  },
  loading: {
    label: "Cargando tu resumen",
    kpis: ["Seguidores en total", "Visualizaciones", "Alcance en no seguidores", "Guardados por 1 000"],
    graficos: ["Seguidores por red", "Visualizaciones por red"],
    frescura: "Cargando hasta cuándo llegan los datos",
  },

  /** Los cuatro pasos de la importación por CSV (RES-2). */
  importar: {
    /** El título de la pestaña del navegador. */
    metaTitle: "Importar un CSV",
    eyebrow: "Resumen · Importar",
    title: "Sube la exportación de tu plataforma",
    description:
      "Mientras las plataformas aprueban el acceso automático, tus cifras pueden entrar desde el CSV que ya sabes exportar. Se leen en tu navegador, las revisas y solo entonces se guardan.",
    volver: "Volver al resumen",
    pasos: ["Subir", "Formato", "Revisar", "Importar"],
    /** Lo que anuncia un lector de pantalla al cambiar de paso. */
    pasoActual: (n: number, total: number, nombre: string) => `Paso ${n} de ${total}: ${nombre}`,
    subir: {
      title: "Elige el archivo",
      suelta: "Arrastra aquí tu CSV o",
      elegir: "elige un archivo",
      formatos: "Reconocemos las exportaciones de:",
      cualquiera: "Si tu archivo no es ninguno de estos, también sirve: en el paso siguiente dices qué columna es cada cosa.",
      demasiadoGrande: (mb: string) => `El archivo pesa más de ${mb} MB. Divídelo por fechas y sube una parte.`,
      noEsCsv: "Ese archivo no parece un CSV. Si lo exportaste en Excel, guárdalo como CSV y vuelve a subirlo.",
    },
    /** Por qué un archivo no se puede ni empezar a revisar (ErrorCsv). */
    errorArchivo: {
      vacio: () => "El archivo está vacío.",
      sinEncabezados: () => "No se encontró la fila de encabezados.",
      sinFilas: () => "El archivo tiene encabezados pero ninguna fila.",
      demasiadasFilas: (filas: string, max: string) => `El archivo tiene ${filas} filas y el máximo son ${max}. Divídelo por fechas.`,
    } satisfies Record<ErrorCsvCodigo, (...args: string[]) => string>,
    /** Las exportaciones que reconocemos: su nombre y de dónde se descargan. */
    formatos: {
      instagram_meta: { nombre: "Instagram Insights", donde: "Meta Business Suite → Estadísticas → Contenido → Exportar" },
      tiktok_studio: { nombre: "TikTok Studio", donde: "TikTok Studio → Analíticas → Contenido → Descargar datos" },
      youtube_studio: {
        nombre: "YouTube Studio",
        donde: "YouTube Studio → Analíticas → Modo avanzado → Exportar (Table data.csv)",
      },
    } satisfies Record<FormatoId, { nombre: string; donde: string }>,
    /** Los campos que sabemos escribir, como se los nombra en el paso 2. */
    campos: {
      externalPostId: { label: "Identificador del video", ayuda: "El id de la plataforma. Si no viene, se saca del enlace." },
      publishedAt: { label: "Fecha de publicación" },
      title: { label: "Título o descripción" },
      url: { label: "Enlace" },
      mediaType: { label: "Tipo de publicación" },
      durationS: { label: "Duración (segundos)" },
      views: { label: "Visualizaciones" },
      reach: { label: "Alcance (cuentas alcanzadas)" },
      likes: { label: "Me gusta" },
      comments: { label: "Comentarios" },
      shares: { label: "Veces compartido" },
      saves: { label: "Guardados" },
      followsFromPost: { label: "Seguidores ganados" },
      reachNonFollowers: { label: "Alcance en no seguidores" },
    } satisfies Record<Campo, { label: string; ayuda?: string }>,
    formato: {
      title: "Qué es cada columna",
      detectado: (nombre: string) => `Parece una exportación de ${nombre}.`,
      noDetectado: "No reconocimos el formato: elige la red a la que pertenece y revisa el mapeo.",
      /** Sin formato reconocido, la red no se da por supuesta: se elige. */
      faltaRed: "Elige la red del archivo antes de seguir.",
      red: "Red",
      cuenta: "¿A qué cuenta pertenece?",
      /** Una opción del selector de cuenta: «@laura · 17 videos». */
      cuentaOpcion: (nombre: string, posts: number, postsTxt: string) =>
        posts > 0 ? `@${nombre} · ${contar(posts, postsTxt, "video", "videos")}` : `@${nombre}`,
      cuentaNueva: "Crear una cuenta importada por CSV",
      cuentaNuevaHandle: "Nombre de usuario de la cuenta",
      cuentaNuevaAyuda: "Sin la arroba. Es como la vas a ver en Resumen y en Conexiones.",
      cuentaNuevaEjemplo: "tu.cuenta",
      columnas: "Columnas",
      sinAsignar: "Sin asignar",
      obligatorio: "Obligatorio",
      faltan: (campos: string) => `Falta decir qué columna es: ${campos}.`,
      idDelEnlace: "Sin columna de id, se saca del enlace.",
      muestra: "Primera fila del archivo",
      celdaVacia: "—",
      /** El orden día/mes de las fechas numéricas, decidido para el archivo entero. */
      fechas: {
        label: "Orden de las fechas",
        dm: "Día/Mes",
        md: "Mes/Día",
        ambiguo:
          "Ninguna fecha del archivo tiene un número mayor que 12, así que sirven en los dos órdenes. Di cuál usa tu exportación.",
        /** Cuando el formato reconocido escribe siempre en el mismo orden. */
        ambiguoFormato: (formato: string, orden: string) =>
          `Ninguna fecha del archivo tiene un número mayor que 12. ${formato} las escribe en orden ${orden}, así que proponemos ese; cámbialo si tu archivo usa otro.`,
        nombreOrden: { dm: "día/mes", md: "mes/día" },
        deducido: {
          dm: "Las fechas van en orden día/mes: lo demuestra el propio archivo.",
          md: "Las fechas van en orden mes/día: lo demuestra el propio archivo.",
        },
        ejemplo: (crudo: string, leida: string) => `«${crudo}» se lee como ${leida}.`,
      },
      /**
       * CUÁNDO se exportó el archivo: es el momento de la lectura. Con el
       * de la importación, un archivo viejo haría parecer más viejos los
       * videos y más nuevas las cifras.
       */
      fechaExportacion: {
        label: "Fecha de la exportación",
        ayuda: "El día en que descargaste el archivo de la plataforma. Las cifras son las de ese día.",
        origen: {
          columna: (columna: string) => `Propuesta a partir de la columna «${columna}» del archivo.`,
          nombreArchivo: "Propuesta a partir del nombre del archivo.",
          hoy: "Si lo descargaste otro día, cámbiala.",
        },
        problema: {
          ilegible: "Escribe una fecha completa.",
          futura: "No puede ser posterior a hoy.",
          anteriorAPublicacion: "No puede ser anterior al video más reciente del archivo.",
        } satisfies Record<ProblemaFechaExportacion, string>,
      },
    },
    /**
     * Lo que puede estar mal en una fila. `csv.ts` devuelve el código y
     * la celda cruda; la frase se arma aquí.
     */
    validacion: {
      sinId: () => "Sin identificador: ni columna de id ni enlace del que sacarlo.",
      sinFecha: () => "Sin fecha de publicación.",
      fechaIlegible: (p: { valor?: string }) => `No se entiende la fecha «${p.valor ?? ""}».`,
      fechaFutura: () => "La fecha de publicación está en el futuro.",
      fechaLejana: (p: { valor?: string }) =>
        `«${p.valor ?? ""}» queda más de seis meses antes que el resto del archivo: comprueba el orden día/mes del paso 2.`,
      idDemasiadoLargo: () => "El identificador es demasiado largo para ser el de un video.",
      fueraDeRango: (p: { valor?: string; campo?: string }) =>
        `«${p.valor ?? ""}» es demasiado grande para ${(p.campo ?? "").toLowerCase()}: se importa sin ese dato.`,
      enlaceInvalido: (p: { valor?: string }) =>
        `«${p.valor ?? ""}» no es un enlace web (http o https): se importa sin enlace.`,
      noEsNumero: (p: { valor?: string; campo?: string }) =>
        `«${p.valor ?? ""}» no es un número en ${(p.campo ?? "").toLowerCase()}: se importa sin ese dato.`,
      negativo: (p: { campo?: string }) => `${p.campo ?? ""} no puede ser negativo: se importa sin ese dato.`,
      noSeguidoresMayor: () => "El alcance en no seguidores supera el alcance total: se importa sin ese dato.",
      repetidaEnArchivo: () => "Repetida en este mismo archivo: se queda la primera.",
      yaImportado: () => "Este video ya está: se añade una lectura nueva, no se reemplaza nada.",
      casiVacia: () => "Sin visualizaciones ni alcance: la lectura entra casi vacía.",
    } satisfies Record<ProblemaCodigo, (p: { valor?: string; campo?: string }) => string>,
    revisar: {
      title: "Esto es lo que se va a guardar",
      resumen: (listas: string, total: string) => `${listas} de ${total} filas listas`,
      errores: (n: number, txt: string) =>
        n === 1 ? "1 fila no se puede importar" : `${txt} filas no se pueden importar`,
      avisos: (n: number, txt: string) => contar(n, txt, "aviso", "avisos"),
      duplicadas: (n: number, txt: string) =>
        n === 1 ? "1 fila repetida en el archivo" : `${txt} filas repetidas en el archivo`,
      /** Leídas en el orden elegido las fechas se reparten en meses; en el otro, en días. */
      ordenDudoso: (elegido: string, otro: string) =>
        `Leídas en orden ${elegido}, las fechas de este archivo quedan a meses de distancia; en orden ${otro} caben en pocos días. Si tu exportación usa ${otro}, vuelve al paso 2 y cámbialo.`,
      /** La fila «Total» de YouTube Studio: no es un error, es la suma de las demás. */
      totales: (n: number, txt: string) =>
        n === 1 ? "1 fila de totales ignorada" : `${txt} filas de totales ignoradas`,
      ninguna: "Ninguna fila se puede importar. Revisa el mapeo del paso anterior.",
      /** Contra los videos que YA están en la cuenta de destino, no contra el propio archivo. */
      yaEstaban: (n: number, txt: string) =>
        n === 1 ? "1 ya estaba: se le añade una lectura" : `${txt} ya estaban: se les añade una lectura`,
      columnas: { fila: "Fila", estado: "Estado", video: "Video", publicado: "Publicado", views: "Visualizaciones" },
      estado: { lista: "Lista", error: "No entra", aviso: "Con aviso" },
      sinDato: "—",
    },
    acciones: { atras: "Atrás", siguiente: "Siguiente", importar: "Importar", importando: "Importando…", otro: "Importar otro archivo" },
    hecho: {
      title: "Listo",
      resumen: (videos: number, videosTxt: string, lecturas: number, lecturasTxt: string) =>
        `${contar(videos, videosTxt, "video", "videos")}, ${contar(lecturas, lecturasTxt, "lectura", "lecturas")}.`,
      nuevos: (n: number, txt: string) => contar(n, txt, "video nuevo", "videos nuevos"),
      conocidos: (n: number, txt: string) =>
        n === 1 ? "1 ya estaba: se le añadió una lectura" : `${txt} ya estaban: se les añadió una lectura`,
      /** Lecturas que no se escribieron porque el video ya tenía una igual de reciente o más. */
      antiguas: (n: number, txt: string) =>
        n === 1
          ? "1 lectura era más antigua que la que ya había: no se guardó, para no mover las cifras hacia atrás"
          : `${txt} lecturas eran más antiguas que las que ya había: no se guardaron, para no mover las cifras hacia atrás`,
      /** La fecha con la que quedaron las lecturas. */
      fecha: (fecha: string) => `Con fecha de exportación ${fecha}.`,
      ver: "Ver el resumen",
    },
    error: {
      generico: "No se pudo importar. Vuelve a intentarlo y, si sigue igual, avísanos.",
      sinCuenta: "Elige la cuenta a la que pertenece el archivo.",
      sinFilas: "No hay ninguna fila que se pueda importar.",
      sinMapeo: "Falta decir qué columna es la fecha de publicación o el identificador. Vuelve al paso 2.",
      /** La fecha de exportación que llegó al servidor no vale (un POST a mano, o el día cambió). */
      fechaExportacion: "La fecha de la exportación no vale: tiene que ser de hoy o anterior, y no anterior a ningún video del archivo. Revísala en el paso 2.",
      /** Lo que pesa de más ni siquiera llega al servidor: se dice antes de intentarlo. */
      demasiadoGrande: (mb: string) => `El archivo pasa de ${mb} MB y no se puede enviar. Divídelo por fechas.`,
      /** Los rechazos de @mc/db, que llegan como código. */
      base: {
        invalid_connection: "La cuenta elegida no es válida. Vuelve a elegirla en el paso 2.",
        connection_not_found: "Esa cuenta ya no existe en este espacio de trabajo. Elige otra en el paso 2.",
        no_creator: "Este espacio de trabajo aún no tiene un perfil de creador al que colgar la cuenta.",
        empty_batch: "No hay ninguna fila que se pueda importar.",
        duplicate_ids: "El archivo trae el mismo video más de una vez. Deja una sola fila por video.",
        empty_handle: "Escribe el nombre de usuario de la cuenta nueva.",
        invalid_captured_at:
          "La fecha de la exportación no vale: tiene que ser de hoy o anterior, y no anterior a ningún video del archivo. Revísala en el paso 2.",
      } satisfies Record<CsvImportErrorCode, string>,
    },
    /** La frontera de error del propio asistente: aquí no hay métricas que leer. */
    errorPagina: {
      eyebrow: "Resumen · Importar",
      title: "El asistente de importación se quedó a medias",
      description:
        "No se escribió nada: tus métricas están como estaban. Vuelve a empezar desde el archivo y, si sigue igual, avísanos.",
      retry: "Empezar otra vez",
      reference: "Referencia",
    },
    loading: {
      label: "Cargando el asistente de importación",
    },
  },
} as const;
