/**
 * Todos los textos de interfaz del módulo Resumen, en un solo archivo.
 *
 * Por qué aquí y no repartidos por las pantallas: el producto está
 * pensado para salir de Colombia, y traducirlo no puede ser buscar
 * comillas por el árbol. Las cifras y las fechas NO viven aquí: las
 * formatea `lib/format.ts` con el locale, la moneda y la zona del
 * workspace.
 *
 * Las palabras son las que el creador ya conoce de TikTok Studio y de
 * Instagram Insights —Seguidores, Visualizaciones, Alcance,
 * Guardados—, no las nuestras.
 */
export const MESSAGES = {
  page: {
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
      note: (redes: number) => (redes === 1 ? "1 red" : `${redes} redes`),
    },
    views: {
      label: (dias: number) => `Visualizaciones en ${dias} días`,
      note: "De tus cuentas, no solo de lo publicado en el periodo",
    },
    nonFollowerReach: {
      label: "Alcance en no seguidores",
      note: (posts: number) => (posts === 1 ? "1 video publicado" : `${posts} videos publicados`),
    },
    savesPer1k: {
      label: "Guardados por 1 000 visualizaciones",
      note: "La señal que más pesa en el alcance",
    },
    /** Para las sumas del periodo. */
    deltaLabel: (dias: number) => `vs. los ${dias} días anteriores`,
    /** Para los valores de un instante, como los seguidores. */
    deltaLabelPunto: (dias: number) => `vs. hace ${dias} días`,
    sinComparacion: "Sin periodo anterior con qué comparar",
    sinDato: "—",
  },
  graficos: {
    seguidores: {
      title: "Seguidores por red",
      subtitle: (dias: number) => `Un punto por día · ${dias} días`,
      aria: "Seguidores por red, un punto por día",
      labelsHeader: "Fecha",
      nota: "La curva arranca el día en que todas las redes del filtro ya tienen lecturas.",
    },
    views: {
      title: "Visualizaciones por red",
      /** El subtítulo dice cuánto cubre cada barra, que cambia con el periodo (1, 2 o 7 días). */
      subtitle: (paso: number, bloques: number) =>
        paso === 1 ? `Por día · ${bloques} días`
        : paso === 7 ? `Por semana · ${bloques} semanas`
        : `Cada dos días · ${bloques} barras`,
      aria: "Visualizaciones por red y periodo",
      labelsHeaderBloque: "Desde el",
      labelsHeaderDia: "Día",
      nota: (paso: number) =>
        paso === 1
          ? undefined
          : `Cada barra son ${paso === 7 ? "siete" : "dos"} días contados hacia atrás desde el último día cerrado.`,
    },
    error: "No se pudieron cargar las series",
  },
  frescura: {
    title: "Hasta cuándo llegan los datos",
    sinLecturas: "Sin lecturas todavía",
    fuente: {
      api: "API",
      csv_import: "CSV importado",
      manual: "A mano",
      aggregator: "Agregador",
    } as Record<string, string>,
    tokenPorVencer: "Permiso por vencer",
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
    periodoSinDatos: {
      title: "No hay datos en este periodo",
      description: "Prueba con un periodo más largo o quita el filtro por red.",
      accion: "Ver 90 días",
    },
  },
  error: {
    eyebrow: "Resumen",
    title: "No pudimos leer tus métricas",
    description:
      "La base de datos no respondió a tiempo o rechazó la conexión. Tus datos no cambiaron; vuelve a intentarlo y, si sigue igual, avísanos.",
    retry: "Reintentar",
    /** Solo aparece cuando Next entrega un identificador del error (producción). */
    reference: "Referencia",
  },
  loading: {
    label: "Cargando tu resumen",
    kpis: ["Seguidores en total", "Visualizaciones", "Alcance en no seguidores", "Guardados por 1 000"],
    graficos: ["Seguidores por red", "Visualizaciones por red"],
  },

  /** Los cuatro pasos de la importación por CSV (RES-2). */
  importar: {
    eyebrow: "Resumen · Importar",
    title: "Sube la exportación de tu plataforma",
    description:
      "Mientras las plataformas aprueban el acceso automático, tus cifras pueden entrar desde el CSV que ya sabes exportar. Se leen en tu navegador, las revisas y solo entonces se guardan.",
    volver: "Volver al resumen",
    pasos: ["Subir", "Formato", "Revisar", "Importar"],
    subir: {
      title: "Elige el archivo",
      suelta: "Arrastra aquí tu CSV o",
      elegir: "elige un archivo",
      formatos: "Reconocemos las exportaciones de:",
      cualquiera: "Si tu archivo no es ninguno de estos, también sirve: en el paso siguiente dices qué columna es cada cosa.",
      leyendo: "Leyendo el archivo…",
      demasiadoGrande: (mb: number) => `El archivo pesa más de ${mb} MB. Divídelo por fechas y sube una parte.`,
      noEsCsv: "Ese archivo no parece un CSV. Si lo exportaste en Excel, guárdalo como CSV y vuelve a subirlo.",
    },
    formato: {
      title: "Qué es cada columna",
      detectado: (nombre: string) => `Parece una exportación de ${nombre}.`,
      noDetectado: "No reconocimos el formato, así que elige la red y revisa el mapeo.",
      red: "Red",
      cuenta: "¿A qué cuenta pertenece?",
      cuentaNueva: "Crear una cuenta importada por CSV",
      cuentaNuevaHandle: "Nombre de usuario de la cuenta",
      cuentaNuevaAyuda: "Sin la arroba. Es como la vas a ver en Resumen y en Conexiones.",
      columnas: "Columnas",
      sinAsignar: "Sin asignar",
      obligatorio: "Obligatorio",
      faltan: (campos: string) => `Falta decir qué columna es: ${campos}.`,
      idDelEnlace: "Sin columna de id, se saca del enlace.",
      muestra: "Primera fila del archivo",
    },
    revisar: {
      title: "Esto es lo que se va a guardar",
      resumen: (listas: number, total: number) => `${listas} de ${total} filas listas`,
      errores: (n: number) => (n === 1 ? "1 fila no se puede importar" : `${n} filas no se pueden importar`),
      avisos: (n: number) => (n === 1 ? "1 aviso" : `${n} avisos`),
      duplicadas: (n: number) => (n === 1 ? "1 fila repetida en el archivo" : `${n} filas repetidas en el archivo`),
      ninguna: "Ninguna fila se puede importar. Revisa el mapeo del paso anterior.",
      columnas: { fila: "Fila", video: "Video", publicado: "Publicado", views: "Views", estado: "Estado" },
      estado: { lista: "Lista", error: "No entra", aviso: "Con aviso" },
      verTodo: "Ver todos los problemas",
    },
    acciones: { atras: "Atrás", siguiente: "Siguiente", importar: "Importar", importando: "Importando…", otro: "Importar otro archivo" },
    hecho: {
      title: "Listo",
      resumen: (videos: number, lecturas: number) =>
        `${videos} ${videos === 1 ? "video" : "videos"}, ${lecturas} ${lecturas === 1 ? "lectura" : "lecturas"}.`,
      nuevos: (n: number) => `${n} ${n === 1 ? "video nuevo" : "videos nuevos"}`,
      conocidos: (n: number) => `${n} ya ${n === 1 ? "estaba" : "estaban"}: se les añadió una lectura`,
      ver: "Ver el resumen",
    },
    error: {
      generico: "No se pudo importar. Vuelve a intentarlo y, si sigue igual, avísanos.",
      sinCuenta: "Elige la cuenta a la que pertenece el archivo.",
      sinFilas: "No hay ninguna fila que se pueda importar.",
    },
  },
} as const;
