/**
 * Los textos del módulo Conexiones en un solo sitio, como Ventas y
 * Finanzas: corregir una frase o traducirla no es buscar por el árbol.
 *
 * Lo que NO está aquí: el texto de consentimiento (`_lib/consent.ts`,
 * porque se guarda tal cual en `data_consent.evidence` y cambia con la
 * versión de la política), los mensajes de error del flujo OAuth
 * (`_lib/oauth-handlers.ts`, porque viajan como código en la URL) y el
 * paso manual de TikTok, que es `metric_requirement.message_es` de la
 * base (0011): copiarlo aquí sería una segunda fuente de verdad.
 */
export const MESSAGES = {
  meta: { title: "Cuentas" },

  error: {
    eyebrow: "Cuentas",
    title: "No pudimos leer tus cuentas",
  },

  loading: {
    label: "Cargando tus cuentas",
    seccion: "Cuentas",
  },

  cabecera: {
    eyebrow: "Cuentas",
    title: "Las cuentas que alimentan todo lo demás",
    /** Sin OAuth: el MVP agrega cuentas por @ y nada más. */
    descripcion:
      "Agrega una cuenta con su @ y On Cue leerá cada día lo que la plataforma publica de ella: seguidores, publicaciones y vistas. Sin contraseñas ni autorizaciones.",
    /** Con la bandera oauth_connect: conviven las dos formas. */
    descripcionConOauth:
      "Agrega una cuenta con su @ y On Cue leerá cada día lo que la plataforma publica de ella. Si la cuenta es tuya, autorizarla una vez desbloquea las cifras que la red solo entrega a su dueño.",
  },

  agregar: {
    titulo: "Agregar cuenta",
    red: "Red",
    handle: "Usuario o enlace del perfil",
    handleAyuda: "Por ejemplo @nicolasduartea o https://www.tiktok.com/@selvathegolden",
    handlePlaceholder: "@usuario",
    enviar: "Agregar cuenta",
    sinConfigurar: (falta: string) => `Sin configurar en este entorno: falta ${falta}.`,
    redSinConfigurar: (nombre: string) => `${nombre} (sin configurar)`,
  },

  conectar: {
    titulo: "Conectar una cuenta autorizada",
    descripcion:
      "Si la cuenta es tuya, autorizarla una vez deja que On Cue lea lo que la red solo entrega a su dueño: vistas, alcance y retención de cada video. Puedes revocar el permiso cuando quieras.",
    boton: (red: string) => `Conectar ${red}`,
    /** El botón deshabilitado dice qué falta, en vez de desaparecer. */
    sinConfigurar: (red: string, falta: string) => `${red} no está configurado en este entorno: faltan ${falta}.`,
    reautorizar: "Reautorizar",
    reautorizarAria: (cuenta: string) => `Reautorizar ${cuenta}`,
    reautorizarTitulo: (red: string) => `Reautorizar ${red}`,
    reautorizarTexto: (red: string) =>
      `El permiso de esta cuenta de ${red} caducó o fue revocado, así que dejamos de poder leer sus cifras. ` +
      `Autorízala otra vez y seguimos donde lo dejamos: la cuenta conserva su historial y sus campañas. ` +
      `No publicamos nada en tu nombre.`,
  },

  tabla: {
    titulo: "Cuentas",
    caption: "Cuentas del workspace con su acceso, su última lectura y su estado",
    cuenta: (n: number) => `${n} ${n === 1 ? "cuenta" : "cuentas"}`,
    columnas: {
      cuenta: "Cuenta",
      acceso: "Acceso",
      seguidores: "Seguidores",
      publicaciones: "Publicaciones",
      vistas: "Vistas",
      lectura: "Última lectura",
      estado: "Estado",
      acciones: "Acciones",
    },
    acceso: {
      porArroba: "Por @",
      porArrobaExplicacion: "Cifras públicas, leídas por su @.",
      autorizada: "Autorizada",
      autorizadaExplicacion: "Cifras leídas con el permiso de su dueño.",
      portafolioExplicacion: "Cifras leídas por el portafolio de empresa de su dueño.",
      csv: "Por CSV",
      csvExplicacion: "Cifras importadas de un archivo.",
      proveedor: "Por proveedor",
      proveedorExplicacion: "Cifras compradas a un proveedor de datos.",
    },
    estado: {
      activa: "Activa",
      vencePronto: "Vence pronto",
      vencida: "Vencida",
      necesitaReautorizar: "Necesita reautorizar",
      revocada: "Revocada",
      noSePudoLeer: "No se pudo leer",
      quitada: "Quitada",
    },
    frescura: {
      sinLectura: "Sin leer todavía",
      haceUnMomento: "hace menos de una hora",
      haceUnaHora: "hace una hora",
      haceUnDia: "hace un día",
    },
    sinDato: "Sin dato",
    sinCifrasPorArroba: "Sin cifras por @",
    autorizarCifras: "Autorizar cifras",
    autorizarCifrasAria: (cuenta: string) => `Autorizar cifras de ${cuenta}`,
    delta: (texto: string) => `${texto} en 7 días`,
    /**
     * Cuando la cuenta pide reautorizar y esta versión no puede: la
     * bandera oauth_connect está apagada (es lo que hay hoy en
     * producción) o esa red todavía no tiene app de OAuth (YouTube y
     * Facebook, CON-8). Es una instrucción, no un callejón sin salida.
     */
    sinReautorizar: "Para volver a leerla, quítala y agrégala por su @.",
    actualizar: "Actualizar",
    actualizarAria: (cuenta: string) => `Actualizar ${cuenta}`,
    quitar: "Quitar",
    quitarAria: (cuenta: string) => `Quitar ${cuenta}`,
    vacio: {
      titulo: "Todavía no hay cuentas",
      descripcion: "Agrega la primera con su @ en el formulario de arriba. Desde ese momento guardamos su historial diario.",
    },
  },

  pasosManuales: {
    titulo: "Un paso que solo puedes dar tú",
    etiqueta: "Paso manual",
    /** Lo que desbloquea; la instrucción es el message_es de la base. */
    paraQue: "Sin ese interruptor, TikTok responde a la API sin retención ni audiencia, por mucho que la cuenta esté autorizada.",
  },

  avisos: {
    agregadaConCifras: (cuenta: string, seguidores: string) =>
      `${cuenta} agregada. Seguidores hoy: ${seguidores}. Desde mañana se lee cada día.`,
    agregadaSinCifras: (cuenta: string, detalle: string) => `${cuenta} agregada. ${detalle}`,
    agregadaSinCifrasPorOmision: "Todavía no hay métricas públicas para esta red.",
    agregada: "Cuenta agregada.",
    actualizada: (cuenta: string) => `${cuenta} actualizada con los datos de hoy.`,
    actualizadaSinMetricas: (cuenta: string, detalle: string) => `${cuenta}: ${detalle}`,
    actualizadaSinMetricasPorOmision: "esta red no publica métricas por @.",
    actualizadaYaHoy: (cuenta: string) => `${cuenta}: la lectura de hoy ya está guardada; mañana se vuelve a leer.`,
    conectada: "Cuenta conectada.",
    sinConectar: "No se pudo conectar la cuenta.",
    desconectada: "Cuenta quitada. Su historial se conserva; ya no se leerá.",
  },

  acciones: {
    revisaFormulario: "Revisa el formulario.",
    eligeRed: "Elige TikTok, Instagram o YouTube.",
    escribeHandle: "Escribe el @ de la cuenta.",
    handleLargo: "Eso no parece un @.",
    declara: "Tienes que declarar que la cuenta es tuya o que la gestionas con permiso.",
    yaNoEsta: "Esa cuenta ya no está en la lista.",
    noSePudoQuitar: "No se pudo quitar la cuenta. Inténtalo de nuevo.",
  },
} as const;
