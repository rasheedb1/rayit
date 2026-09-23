/**
 * Todos los textos de interfaz de la entrada a la aplicación: /login,
 * /auth/callback, /cuenta y el selector de espacio. Un solo sitio por
 * módulo, para que traducirlos —o corregir el tono— no sea buscar por
 * el árbol.
 *
 * Nada aquí depende de Colombia: los nombres, las cifras y las fechas
 * salen del workspace (moneda, zona, locale) y se formatean con Intl en
 * lib/format.ts.
 */
import { MAX_NOMBRE } from "./reglas";

export const MESSAGES = {
  marca: "On Cue",

  login: {
    /** El <title> de la pestaña. */
    meta: "Entrar",
    titulo: "Entra a On Cue",
    descripcion: "Te mandamos un enlace al correo. Sin contraseñas.",
    correo: "Correo",
    correoPlaceholder: "tu@correo.com",
    enviar: "Enviarme un enlace",
    enviando: "Enviando…",
    /**
     * El pie legal, como enlaces y no como una frase suelta: es lo que
     * un cliente que paga espera ver antes de dejar su correo, y es lo
     * que hacen las dos referencias de esta pantalla (Vercel y Linear).
     * Mientras no haya un texto legal redactado por alguien que sepa,
     * los dos apuntan a /legal, que es pública, dice lo que hoy es
     * cierto y no inventa cláusulas.
     */
    legal: {
      prefijo: "Al entrar aceptas los",
      terminos: { texto: "términos", href: "/legal#terminos" },
      union: "y la",
      privacidad: { texto: "política de privacidad", href: "/legal#privacidad" },
      sufijo: ".",
    },
    enviado: {
      titulo: "Revisa tu correo",
      descripcion: "Te mandamos un enlace para entrar. Se abre una sola vez y caduca en una hora.",
      spam: "Si no llega en un par de minutos, mira en correo no deseado.",
      reenviar: "Reenviar el enlace",
      /**
       * Supabase no deja pedir otro enlace para el mismo correo hasta
       * pasados 60 s; el botón espera ese minuto a la vista, como en
       * Linear y Vercel, en vez de dejar pulsar y devolver un error.
       */
      reenviarEn: (segundos: number) => `Reenviar en ${segundos} s`,
      reenviado: "Enlace reenviado.",
      cambiar: "Usar otro correo",
    },
    errores: {
      correoInvalido: "Escribe un correo válido.",
      // Supabase rechazó el enlace porque la comprobación anti-bots
      // (Turnstile) faltó, caducó o no pasó.
      captcha: "No pudimos comprobar que no eres un robot. Espera a que aparezca la marca de verificación y vuelve a intentarlo.",
      limite: "Ya mandamos varios enlaces a ese correo. Espera unos minutos y vuelve a intentarlo.",
      generico: "No pudimos mandar el enlace. Vuelve a intentarlo y, si sigue igual, avísanos.",
    },
    sinConfigurar: {
      titulo: "Falta configurar la autenticación",
      descripcion:
        "Esta copia de On Cue no tiene las llaves de Supabase, así que no puede mandar enlaces de acceso. Mientras tanto muestra los datos de demostración.",
      comando: "make db.unlock",
      comandoAyuda: "Corre esto en platform/ y vuelve a arrancar la aplicación.",
      variables: "Variables que faltan:",
      seguir: "Ver la demostración",
    },
    /**
     * La comprobación anti-bots (Cloudflare Turnstile) sin llave: solo se
     * enseña fuera de producción, para quien desarrolla. En producción lo
     * dice el log del servidor; a quien entra no le sirve de nada saberlo.
     */
    captchaSinConfigurar: "Sin comprobación anti-bots: falta TURNSTILE_SITE_KEY (ver platform/.env.example).",
    captchaEtiqueta: "Comprobación anti-bots",
  },

  callback: {
    errores: {
      // Los textos de la URL (?error=) los pone /auth/callback; /login
      // los muestra tal cual, sin exponer nada del proveedor.
      enlace: "Ese enlace ya no sirve. Pide uno nuevo.",
      // El enlace se abrió en un navegador distinto del que lo pidió
      // (otro dispositivo, o el navegador interno de la app de correo).
      otroNavegador:
        "Abre el enlace en el mismo navegador donde lo pediste, o pide uno nuevo desde aquí y ábrelo en este.",
      cancelado: "Se canceló la entrada.",
      sesion: "No pudimos abrir tu sesión. Vuelve a intentarlo.",
      // Otra cuenta con el mismo correo: un buzón reasignado, o un
      // correo que se cambió en el proveedor. No se entra, y no se dice
      // de quién es la otra cuenta.
      identidad: "Ese correo ya está ligado a otra cuenta de On Cue.",
    },
    /**
     * Lo que sigue a `identidad`, según haya o no SUPPORT_EMAIL. Sin
     * correo de soporte no se dice «escríbenos»: se da una salida que
     * funciona ahí mismo, que es el campo de abajo.
     */
    identidadSalida: {
      conCorreo: "Escríbenos a",
      conCorreoSufijo: "y lo resolvemos.",
      sinCorreo: "Entra con otro correo aquí abajo.",
    },
  },

  /**
   * /auth/confirm: la parada de un clic entre el correo y la sesión. El
   * enlace del correo NO abre la sesión al cargarse, porque los
   * escáneres de enlaces del correo corporativo (Outlook Safe Links,
   * Mimecast) lo abren antes que la persona y lo gastaban.
   */
  confirmar: {
    meta: "Confirmar la entrada",
    titulo: "Entra a On Cue",
    descripcion: "Pulsa el botón para terminar de entrar. El enlace sirve una sola vez.",
    boton: "Entrar a On Cue",
    entrando: "Entrando…",
    invalido: "Este enlace está incompleto. Pide uno nuevo.",
    pedirOtro: "Pedir otro enlace",
  },

  /**
   * /auth/comprobar: la parada que sigue a /auth/confirm cuando el enlace
   * NO se pidió en este navegador. Quien abre el enlace que otra persona
   * pidió para SU correo entraría en la cuenta de esa persona sin
   * notarlo (y todo lo que registrara acabaría allí): antes de seguir,
   * se le dice con qué correo entró.
   */
  comprobar: {
    meta: "Comprueba tu cuenta",
    titulo: "Entraste como",
    descripcion:
      "Este enlace no se pidió desde este navegador. Si ese no es tu correo, cierra la sesión y pide tu propio enlace.",
    seguir: "Sí, soy yo",
    salir: "No soy yo, cerrar sesión",
  },

  cuenta: {
    meta: "Tu cuenta",
    titulo: "Tu cuenta",
    descripcion: "Cómo te ve el equipo y a qué correo llegan los enlaces de acceso.",
    nombre: "Nombre",
    nombreAyuda: "Lo deducimos de tu correo la primera vez. Cámbialo cuando quieras.",
    correo: "Correo",
    correoAyuda: "Es tu forma de entrar. Cambiarlo todavía no se puede desde aquí.",
    guardar: "Guardar",
    guardando: "Guardando…",
    guardado: "Guardado.",
    errores: {
      nombreVacio: "Escribe tu nombre.",
      nombreLargo: `El nombre no puede pasar de ${MAX_NOMBRE} caracteres.`,
      generico: "No pudimos guardar el cambio. Vuelve a intentarlo.",
    },
    sesion: "Sesión",
    actual: "Actual",
    volver: "Volver a Resumen",
    cerrarSesion: "Cerrar sesión",
    espacios: "Tus espacios",
    // Etiquetas neutras: se le muestran a cualquier persona, y el rol
    // describe un permiso, no a quien lo tiene.
    rol: {
      owner: "Propietario/a",
      admin: "Administrador/a",
      member: "Miembro",
      viewer: "Solo lectura",
      client: "Cliente",
    },
    renombrar: {
      accion: "Renombrar",
      etiqueta: (espacio: string) => `Nuevo nombre para ${espacio}`,
      guardar: "Guardar",
      guardando: "Guardando…",
      cancelar: "Cancelar",
      guardado: "Nombre del espacio guardado.",
      ayuda:
        "Quien administra un espacio puede renombrarlo. Si tu ficha de creador lleva el mismo nombre que el espacio, cambia con él.",
      errores: {
        nombreVacio: "Escribe un nombre para el espacio.",
        nombreLargo: `El nombre no puede pasar de ${MAX_NOMBRE} caracteres.`,
        sinPermiso: "Solo quien administra el espacio puede cambiarle el nombre.",
        generico: "No pudimos cambiar el nombre. Vuelve a intentarlo.",
      },
    },
    demo: {
      titulo: "Estás viendo la demostración",
      descripcion: "No hay sesión iniciada: la aplicación sirve el espacio de ejemplo del seed.",
      entrar: "Entrar con mi correo",
    },
  },

  /**
   * El error.tsx de /login. La puerta del producto no puede caer en la
   * pantalla genérica de Next, en inglés y sin marca: es justo donde se
   * decide si alguien entra o no. Misma forma que el de Finanzas.
   */
  loginError: {
    eyebrow: "Entrar",
    titulo: "No pudimos abrir la pantalla de acceso",
    descripcion:
      "Algo falló antes de poder pedirte el correo. No se mandó ningún enlace; vuelve a intentarlo y, si sigue igual, avísanos.",
    reintentar: "Reintentar",
    referencia: "Referencia",
  },

  /**
   * El error.tsx de la raíz: cubre /auth/callback y cualquier ruta
   * futura que viva fuera del grupo (app), que no hereda el límite de
   * error del marco.
   */
  errorRaiz: {
    eyebrow: "On Cue",
    titulo: "Algo se rompió",
    descripcion: "No pudimos cargar esta página. Vuelve a intentarlo y, si sigue igual, avísanos.",
    reintentar: "Reintentar",
    referencia: "Referencia",
    inicio: "Ir a Resumen",
  },

  /**
   * El nombre y el título de la frontera de /cuenta. Lo demás es el de la
   * aplicación ((app)/_lib/frontera.tsx), igual que en Finanzas.
   */
  cuentaError: {
    eyebrow: "Cuenta",
    title: "No pudimos leer tu cuenta",
  },

  selector: {
    etiqueta: "Cambiar de espacio",
    /**
     * El nombre accesible del disparador. Empieza por el nombre VISIBLE
     * del espacio (WCAG 2.5.3): quien usa un lector de pantalla oye en
     * qué espacio está, y quien usa control por voz puede decir lo que
     * ve.
     */
    disparador: (espacio: string) => `${espacio} · Cambiar de espacio`,
    espacios: "Tus espacios",
    crear: "Crear espacio",
    crearNombre: "Nombre del espacio",
    crearBoton: "Crear",
    creando: "Creando…",
    cancelar: "Cancelar",
    cuenta: "Tu cuenta",
    /** Con qué correo se entró, bajo «Tu cuenta»: sin él, quien entra en una cuenta ajena no lo nota. */
    sesionComo: (correo: string) => `Sesión de ${correo}`,
    cerrarSesion: "Cerrar sesión",
    errores: {
      sinMembresia: "Ese espacio ya no es tuyo.",
      // Lo que ve la persona. El motivo técnico (la clave de firma que
      // falta en el servidor) va al log, desde lib/auth/acciones.ts. No
      // promete que reintentar lo arregle: lo que falta es del servidor.
      sinFirma: "No pudimos guardar tu elección de espacio. Seguirás viendo el que tenías.",
      creadoSinRecordar: "El espacio se creó, pero no pudimos abrirlo. Elígelo en la lista.",
      nombreVacio: "Escribe un nombre.",
      limite: (tope: number) => `Ya eres propietario/a de ${tope} espacios, el máximo por persona.`,
      /** Tras `limite`, con el enlace a SUPPORT_EMAIL. Sin correo de soporte no se pinta. */
      limiteContacto: "Si necesitas más, escríbenos a",
      crear: "No pudimos crear el espacio. Vuelve a intentarlo.",
      generico: "No pudimos cambiar de espacio. Vuelve a intentarlo.",
    },
  },

  espacio: {
    /** Cuando el correo no da ningún nombre legible. */
    sinNombre: "Mi espacio",
  },

  /**
   * La página pública a la que apunta el pie de /login.
   *
   * PENDIENTE DE REDACCIÓN (historia CIM-9 en content/backlog.ts, con
   * dueño y fecha: antes del primer cliente que pague). Esto no son
   * unos términos: es lo que hoy es cierto, dicho sin prometer lo que
   * todavía no está escrito. Lo que NO puede decir es que usar On Cue
   * «no obliga a nada»: eso es una cláusula, y mala.
   *
   * El correo de contacto no se escribe aquí: sale de SUPPORT_EMAIL
   * (lib/soporte.ts), porque cambia por despliegue y no es texto.
   */
  legal: {
    meta: "Términos y privacidad",
    titulo: "Términos y privacidad",
    descripcion: "On Cue está en construcción. Esto es lo que hoy es cierto sobre tus datos.",
    pendiente:
      "Los términos de servicio y la política de privacidad completos están en redacción y se publicarán en esta página antes de que abramos On Cue a clientes de pago.",
    terminos: {
      id: "terminos",
      titulo: "Términos",
      parrafos: [
        "On Cue es software en desarrollo y puede cambiar mientras lo construimos.",
        "Los datos que subas o conectes son tuyos.",
      ],
    },
    privacidad: {
      id: "privacidad",
      titulo: "Privacidad",
      parrafos: [
        "Guardamos tu correo para identificarte y para mandarte el enlace de acceso. No hay contraseñas que guardar y no vendemos ni cedemos esa dirección.",
        "Si conectas una cuenta de TikTok, Instagram, Facebook o YouTube, guardamos sus credenciales cifradas y las métricas que esa plataforma nos deja leer, para enseñártelas a ti y a nadie más.",
      ],
    },
    contacto: {
      titulo: "Contacto",
      conCorreo: "Para pedir una copia de tus datos, su borrado o cualquier aclaración, escribe a",
      sinCorreo: "El correo de contacto se publicará aquí junto con los términos.",
    },
    volver: "Volver a entrar",
  },
} as const;
