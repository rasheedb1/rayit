/**
 * Los textos del módulo Conexiones en un solo sitio, como Ventas y
 * Finanzas: corregir una frase o traducirla no es buscar por el árbol.
 * Nacieron por separado en CON-4 (la pantalla) y en ACC-8 (el aviso al
 * titular y «Conectada por …»); el cierre de CON-B los juntó aquí.
 *
 * Las funciones reciben cifras y fechas YA formateadas por lib/format.ts
 * (formatterFor del workspace): aquí no se formatea nada.
 *
 * Lo que NO está aquí: el texto de consentimiento (`_lib/consent.ts`,
 * porque se guarda tal cual en `data_consent.evidence` y cambia con la
 * versión de la política), los mensajes de error del flujo OAuth
 * (`_lib/oauth-handlers.ts`, porque viajan como código en la URL) y el
 * paso manual de TikTok, que es `metric_requirement.message_es` de la
 * base (0011): copiarlo aquí sería una segunda fuente de verdad.
 */
export const MESSAGES = {
  /** ACC-6: con alcance por marca o por campaña no se ve ninguna cuenta: una cuenta es de un creador, no de una marca. */
  alcance: {
    title: "Las cuentas conectadas no están en tu alcance",
    description:
      "Tu acceso está acotado a algunas marcas o campañas, y una cuenta conectada es de un creador, no de una marca ni de una campaña.",
  },

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
    /** Una red sin sus variables no ofrece botón (cierre CON-C): la frase dice qué falta, en lugar del botón. */
    sinConfigurar: (red: string, falta: string) => `${red} todavía no se puede conectar desde aquí: faltan ${falta}.`,
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
      seRenuevaSola: "Se renueva sola",
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
    /** CON-8: en YouTube, autorizar desbloquea la analítica (retención, demografía), no las cifras, que ya salen por @. */
    autorizarAnalitica: "Autorizar analítica",
    autorizarAnaliticaAria: (cuenta: string) => `Autorizar analítica de ${cuenta}`,
    delta: (texto: string) => `${texto} en 7 días`,
    /**
     * CON-5: de cuántas publicaciones tenemos lecturas nosotros, aparte
     * de lo que la red dice que tiene la cuenta. «En seguimiento» y no
     * «con métricas»: entre que el recolector las descubre y las mide
     * pasan horas, y prometer una medida que aún no existe es peor que
     * no decir nada.
     */
    enSeguimiento: (n: string) => `${n} en seguimiento`,
    publicacionesHasta: "publicaciones hasta el",
    /** Hay lectura de publicaciones pero ninguna de la cuenta (una red que no dice cuántas tiene). */
    sinCifrasDeCuenta: "Todavía sin cifras de la cuenta",
    /** ACC-8: debajo del @, solo cuando la conectó un tercero. La fecha ya viene formateada. */
    conectadaPor: (p: { who: string; when: string }) => `Conectada por ${p.who} el ${p.when}`,
    /** Quien conectó ya no es miembro y la evidencia no guardó correo: nunca un guion mudo. */
    alguienDelEquipo: "alguien del equipo",
    /**
     * CON-3 → CON-4: el token de acceso venció pero el de renovación
     * sigue vigente. No hay nada que pedirle al dueño: oauth.refresh lo
     * renueva solo. Si la fila llega a verse así es que el worker no ha
     * pasado (lo renueva 30 minutos ANTES de que venza), así que la
     * frase no promete una hora: dice de quién depende.
     */
    seRenuevaSola: "El worker de renovación la renueva sin pedirte nada cuando corra; hasta entonces se ven las cifras de la última lectura. Si no quieres esperar, reautorízala.",
    /**
     * CON-7: qué dato falta de la cuenta. El porqué NO está aquí: es
     * metric_requirement.message_es, que viene con el hueco (metric_gap).
     */
    falta: (grupo: string) => `Falta ${grupo}`,
    faltaDesde: (fecha: string) => `desde el ${fecha}`,
    comoArreglarlo: "Cómo arreglarlo",
    /** Los grupos de metric_requirement.metric_group que una persona entiende. */
    grupos: {
      demografia_de_cuenta: "la audiencia de la cuenta",
      retencion_y_audiencia: "la retención y la audiencia de los videos",
      alcance_y_retencion: "el alcance y la retención de los videos",
      visitas_al_perfil: "las visitas al perfil",
      clics_de_contacto: "los clics de contacto",
    } as Record<string, string>,
    grupoDesconocido: "un grupo de cifras",
    /** Pie de la tabla: los huecos los detecta un job (collect.demographics), no esta pantalla. */
    huecosCadaManana: "Qué dato le falta a cada cuenta, y por qué, lo revisa el worker cada mañana al leer la audiencia.",
    /** El rol ve las cuentas pero no puede conectarlas ni quitarlas. */
    /** La celda de acciones de quien solo ve: una frase, no una celda vacía. */
    sinAcciones: "Sin acciones para tu rol",
    soloLectura: "Tu rol puede ver las cuentas, pero no agregarlas, actualizarlas ni quitarlas.",
    /**
     * Cuando la cuenta pide reautorizar y esta versión no puede: la
     * bandera oauth_connect está apagada (es lo que hay hoy en
     * producción) o esa red todavía no tiene app de OAuth (YouTube y
     * Facebook, CON-8). Es una instrucción, no un callejón sin salida.
     */
    sinReautorizar: "Esta versión no puede reautorizarla desde aquí. Sus cifras se quedan en la última lectura y su historial se conserva.",
    /** Una cuenta que no se relee desde aquí (portafolio, CSV, proveedor) y cuya última lectura falló. */
    sinRelectura: "Esta cuenta no se vuelve a leer desde aquí: la lee el worker en su próxima pasada.",
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

  /** ACC-8: el aviso que recibe el titular cuando un tercero conecta su cuenta. */
  ownerNotice: {
    /** notification.title_es del kind connection_added. */
    title: "Una cuenta se conectó en tu nombre",
    /** notification.body_es: quién (nombre o correo), qué cuenta, en qué red y cuándo (fecha ya formateada). */
    body: (p: { who: string; handle: string; network: string; when: string }): string =>
      `${p.who} conectó la cuenta @${p.handle} de ${p.network} el ${p.when} en tu nombre. Puedes quitarla cuando quieras desde Cuentas.`,
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

/** El nombre de una persona para una frase: su nombre y, si no lo puso, su correo. */
export function displayNameOf(p: { name: string | null; email: string | null }): string | null {
  return p.name?.trim() || p.email || null;
}
