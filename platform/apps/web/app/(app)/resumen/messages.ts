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
    importar: "Importar un CSV",
  },
  filtros: {
    periodo: "Periodo",
    red: "Red",
    todasLasRedes: "Todas",
    dias: (n: number) => `${n} días`,
    /** Mientras llegan las cifras del filtro nuevo: las de pantalla aún son las del anterior. */
    actualizando: "Actualizando las cifras",
  },
  /**
   * La tarjeta de un KPI lleva solo la cifra, el delta y la sparkline
   * (Plausible: «nada que no sea el dato»). Lo que explica de dónde sale
   * la cifra va detrás del botón (i) de la tarjeta: son las frases de
   * `info`. En la tarjeta solo queda, cuando hace falta, UNA línea corta
   * que dice por qué no hay flecha.
   */
  kpis: {
    followers: {
      label: "Seguidores en total",
      /** Se usa cuando el filtro deja una sola red. */
      labelRed: (red: string) => `Seguidores en ${red}`,
      /** Sin serie de cuenta —solo CSV— no hay seguidores que contar. Va en la tarjeta: explica el «—». */
      sinCuenta: "Llegan al conectar la cuenta",
    },
    views: {
      label: (dias: number) => `Visualizaciones en ${dias} días`,
    },
    nonFollowerReach: {
      label: "Alcance en no seguidores",
    },
    savesPer1k: {
      label: "Guardados por 1 000 visualizaciones",
    },
    /** Lo que se lee al pulsar (i). Frases completas, en palabras de creador. */
    info: {
      /** La etiqueta del botón (i) para el lector de pantalla. */
      boton: (kpi: string) => `Qué cuenta «${kpi}»`,
      followersSinCuenta: "Los seguidores llegan al conectar la cuenta: un CSV trae métricas por video, no de la cuenta.",
      followers: "La suma de tus cuentas conectadas el último día con datos.",
      /** Con serie de cuenta: cuenta otra cosa que las dos tarjetas de al lado. */
      views: "Todas las visualizaciones de tus cuentas en esos días, no solo las de lo que publicaste en el periodo.",
      /** Sin serie de cuenta: la suma de lo publicado, y hay que decirlo. */
      viewsContenido: (n: number, txt: string) =>
        `La suma de ${contar(n, txt, "video publicado", "videos publicados")} en el periodo, cada uno con su última lectura. Al conectar la cuenta pasa a ser la de la cuenta entera.`,
      /**
       * Cuando la serie de cuenta aún no cerró el último día del reloj:
       * la suma termina antes, y se dice hasta cuándo. `fecha` ya formateada.
       */
      hastaCuenta: (fecha: string) => `Suma hasta el ${fecha}, el último día que tu cuenta ya cerró.`,
      /**
       * La base de los dos KPIs de contenido: sobre cuántos videos se
       * calculó la razón y con qué lectura. «Vida completa» porque se usa
       * la última lectura de cada video en los dos periodos, no un corte
       * de edad.
       */
      base: (n: number, txt: string) =>
        `Calculado sobre ${contar(n, txt, "video publicado", "videos publicados")} en el periodo, con todo lo que llevan acumulado.`,
      nonFollowerReach: "De las cuentas a las que llegaron tus videos, cuántas no te siguen.",
      savesPer1k: "Cuántas veces se guardan tus videos por cada mil visualizaciones.",
      /** Cuentas que suman en la cifra pero no en la comparación ni en la línea. */
      nuevas: (n: number, txt: string) =>
        n === 1
          ? "Una cuenta que conectaste dentro del periodo suma en la cifra, pero no en la comparación: no es crecimiento."
          : `${txt} cuentas que conectaste dentro del periodo suman en la cifra, pero no en la comparación: no es crecimiento.`,
    },
    /** Para las sumas del periodo. */
    deltaLabel: (dias: number) => `vs. los ${dias} días anteriores`,
    /** Para los valores de un instante, como los seguidores. */
    deltaLabelPunto: (dias: number) => `vs. hace ${dias} días`,
    sinComparacion: "Sin periodo anterior con qué comparar",
    /** Hay periodo anterior, pero alguno de los dos tiene menos de MIN_SAMPLE videos. */
    pocaMuestra: "Pocos videos para comparar",
    /** El delta de un KPI que ya es un porcentaje: diferencia en puntos. `txt` = «+2,1». */
    puntos: (txt: string) => `${txt} puntos`,
    sinDato: "—",
  },
  graficos: {
    seguidores: {
      title: "Seguidores por red",
      subtitle: (dias: number) => `Un punto por día · ${dias} días`,
      aria: "Seguidores por red, un punto por día",
      labelsHeader: "Fecha",
      /** Solo con varias redes a la vez: con una sola, no hay otras con las que desalinearse. */
      notaRedes: "Una red nueva aparece en cero hasta su primera lectura.",
      sinCuenta: {
        title: "Los seguidores llegan al conectar la cuenta",
        description:
          "Tus CSV traen métricas por video; los seguidores y las visualizaciones diarias llegan al conectar la cuenta.",
        accion: "Conectar una cuenta",
      },
    },
    views: {
      title: "Visualizaciones por semana",
      /** Doce semanas fijas: no cambian con el periodo, y el subtítulo lo dice. */
      subtitle: (semanas: number) => (semanas === 1 ? "Por semana · 1 semana" : `Por semana · ${semanas} semanas`),
      aria: "Visualizaciones por red y semana",
      /** Cada categoría ES la semana: «15–21/9». */
      labelsHeader: "Semana",
      /** Una línea: por qué el total no es la tarjeta de al lado. */
      nota: "No es la suma del periodo elegido: siempre enseña las últimas semanas.",
      /** Sin serie de cuenta, las barras son otra cosa y se dice. */
      notaContenido: "Sin cuenta conectada, cada barra suma lo que publicaste esa semana.",
    },
  },
  frescura: {
    title: "Hasta cuándo llegan los datos",
    /**
     * Los días del módulo son días cerrados en UTC (la convención del
     * repositorio: `account_metric_snapshot.day` es el día de la
     * plataforma y no se puede pasar a otra zona). Se dice UNA vez, aquí
     * y con palabras de creador, no junto a cada fecha.
     */
    diaCerrado: "Las cifras llegan hasta el final del día anterior.",
    sinLecturas: "Sin lecturas todavía",
    fuente: {
      api: "API",
    },
    /**
     * La fecha que el creador escribió en el paso 2, tal cual: «CSV
     * exportado el 12 sep». `fecha` ya formateada en la zona del workspace.
     */
    csvExportado: (fecha: string) => `CSV exportado el ${fecha}`,
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
    /**
     * El gráfico semanal no depende del periodo: «Ver 90 días» no le
     * cambia nada. Su única salida posible es quitar el filtro de red.
     */
    semanasSinDatos: {
      title: "No hay datos en estas semanas",
      quitarRed: {
        description: "Esta red todavía no tiene lecturas en las últimas semanas. Mira todas juntas para ver lo que sí hay.",
        accion: "Quitar el filtro de red",
      },
      sinSalida: {
        description: "No hay ninguna lectura en las últimas semanas. En cuanto el recolector cierre un día, o importes un CSV, aparece aquí.",
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
    graficos: ["Seguidores por red", "Visualizaciones por semana"],
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
    /** Se enseña en el paso 2 cuando el archivo no venía en UTF-8. */
    codificacion: {
      "windows-1252":
        "Este archivo venía guardado desde Excel para Windows (Windows-1252). Lo leímos así para conservar las tildes: revisa que los nombres de abajo se vean bien.",
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
      /**
       * El nombre escrito ya es el de una cuenta de esa red (OAuth o
       * importada): crear otra partiría sus videos en dos y Resumen los
       * contaría dos veces. Se propone la que existe.
       */
      cuentaExistente: (handle: string) => `Ya tienes @${handle} en esta red. Sus videos van a esa cuenta, no a una nueva.`,
      usarExistente: (handle: string) => `Importar en @${handle}`,
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
      sinNovedad: () => "Este video ya tiene una lectura de esta fecha o posterior: esta no se guardará.",
      casiVacia: () => "Sin visualizaciones ni alcance: la lectura entra casi vacía.",
    } satisfies Record<ProblemaCodigo, (p: { valor?: string; campo?: string }) => string>,
    revisar: {
      title: "Esto es lo que se va a guardar",
      /**
       * Cuántas filas van a escribir algo, de cuántas trae el archivo.
       * Si alguna ya tiene una lectura igual de reciente o más, no se
       * llaman «listas»: al subir el mismo archivo dos veces decía a la
       * vez «3 de 3 filas listas» y «3 no se guardarán».
       */
      resumen: (n: number, txt: string, total: string, haySinNovedad: boolean) =>
        !haySinNovedad
          ? `${txt} de ${total} filas listas`
          : n === 1
            ? `1 de ${total} filas trae algo nuevo`
            : `${txt} de ${total} filas traen algo nuevo`,
      /**
       * La pastilla corta de cada problema, bajo el título del video. La
       * frase completa (`validacion`) la lee el lector de pantalla y sale
       * al pasar el puntero; se enseña entera cuando cita la celda que lo
       * causó, que es lo que hay que buscar en el archivo.
       */
      etiqueta: {
        sinId: "Sin identificador",
        idDemasiadoLargo: "Id demasiado largo",
        sinFecha: "Sin fecha",
        fechaIlegible: "Fecha ilegible",
        fechaFutura: "Fecha futura",
        fechaLejana: "Fecha lejana",
        noEsNumero: "No es un número",
        fueraDeRango: "Cifra demasiado grande",
        negativo: "Cifra negativa",
        noSeguidoresMayor: "No seguidores > alcance",
        enlaceInvalido: "Enlace no válido",
        repetidaEnArchivo: "Repetida",
        yaImportado: "Ya estaba",
        sinNovedad: "Nada nuevo",
        casiVacia: "Casi vacía",
      } satisfies Record<ProblemaCodigo, string>,
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
      /** Las que ya tienen una lectura igual de reciente o más: la base no las guardará. */
      sinNovedad: (n: number, txt: string) =>
        n === 1
          ? "1 ya tiene una lectura de esta fecha o posterior: no se guardará"
          : `${txt} ya tienen una lectura de esta fecha o posterior: no se guardarán`,
      /** El <caption> de la tabla: dice qué es, sin repetir el título del paso. */
      caption: "Filas del archivo, con su estado y las cifras que se guardarán",
      columnas: {
        fila: "Fila",
        estado: "Estado",
        video: "Video",
        publicado: "Publicado",
        /** Una columna por cifra MAPEADA: se ve todo lo que se va a escribir, no solo las visualizaciones. */
        views: "Visualizaciones",
        reach: "Alcance",
        likes: "Me gusta",
        comments: "Comentarios",
        shares: "Compartidos",
        saves: "Guardados",
        followsFromPost: "Seguidores ganados",
        reachNonFollowers: "Alcance en no seguidores",
        durationS: "Duración (s)",
      },
      estado: { lista: "Lista", error: "No entra", aviso: "Con aviso" },
      sinDato: "—",
    },
    acciones: {
      atras: "Atrás",
      siguiente: "Siguiente",
      importar: "Importar",
      importando: "Importando…",
      otro: "Importar otro archivo",
      /** El botón del paso 3 cuando ninguna fila trae una lectura más reciente que la guardada. */
      nadaNuevo: "No hay nada nuevo que importar",
    },
    hecho: {
      title: "Listo",
      resumen: (videos: number, videosTxt: string, lecturas: number, lecturasTxt: string) =>
        `${contar(videos, videosTxt, "video", "videos")}, ${contar(lecturas, lecturasTxt, "lectura", "lecturas")}.`,
      nuevos: (n: number, txt: string) => contar(n, txt, "video nuevo", "videos nuevos"),
      /** Solo los conocidos que SÍ recibieron lectura: los demás los cuenta `antiguas`. */
      conocidos: (n: number, txt: string) =>
        n === 1 ? "1 ya estaba: se le añadió una lectura" : `${txt} ya estaban: se les añadió una lectura`,
      /**
       * Lecturas que no se escribieron porque el video ya tenía una igual
       * de reciente o más. «No traían nada más reciente» cubre la fecha
       * igual (reimportar el mismo archivo) y la anterior.
       */
      antiguas: (n: number, txt: string) =>
        n === 1
          ? "1 video no traía nada más reciente que lo que ya había: no se guardó"
          : `${txt} videos no traían nada más reciente que lo que ya había: no se guardaron`,
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
