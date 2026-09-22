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
export const MESSAGES = {
  marca: "On Cue",

  login: {
    titulo: "Entra a On Cue",
    descripcion: "Te mandamos un enlace al correo. Sin contraseñas.",
    correo: "Correo",
    correoPlaceholder: "tu@correo.com",
    enviar: "Enviarme un enlace",
    enviando: "Enviando…",
    legal: "Al entrar aceptas que guardemos tu correo para identificarte.",
    volver: "Volver al inicio",
    enviado: {
      titulo: "Revisa tu correo",
      descripcion: "Te mandamos un enlace para entrar. Se abre una sola vez y caduca en una hora.",
      spam: "Si no llega en un par de minutos, mira en correo no deseado.",
      reenviar: "Reenviar el enlace",
      reenviado: "Enlace reenviado.",
      cambiar: "Usar otro correo",
    },
    errores: {
      correoInvalido: "Escribe un correo válido.",
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
  },

  callback: {
    errores: {
      // Los textos de la URL (?error=) los pone /auth/callback; /login
      // los muestra tal cual, sin exponer nada del proveedor.
      enlace: "Ese enlace ya no sirve. Pide uno nuevo.",
      cancelado: "Se canceló la entrada.",
      sesion: "No pudimos abrir tu sesión. Vuelve a intentarlo.",
    },
  },

  cuenta: {
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
      nombreLargo: "El nombre no puede pasar de 80 caracteres.",
      generico: "No pudimos guardar el cambio. Vuelve a intentarlo.",
    },
    sesion: "Sesión",
    actual: "Actual",
    volver: "Volver a Resumen",
    cerrarSesion: "Cerrar sesión",
    espacios: "Tus espacios",
    rol: { owner: "Dueña", admin: "Administra", member: "Miembro", viewer: "Mira", client: "Cliente" },
    demo: {
      titulo: "Estás viendo la demostración",
      descripcion: "No hay sesión iniciada: la aplicación sirve el espacio de ejemplo del seed.",
      entrar: "Entrar con mi correo",
    },
  },

  /** El error.tsx del segmento /cuenta, con la misma forma que el de Finanzas. */
  cuentaError: {
    eyebrow: "Cuenta",
    title: "No pudimos leer tu cuenta",
    description:
      "La sesión o la base de datos no respondieron. No se cambió nada; vuelve a intentarlo y, si sigue igual, avísanos.",
    retry: "Reintentar",
    reference: "Referencia",
  },

  selector: {
    etiqueta: "Cambiar de espacio",
    espacios: "Tus espacios",
    crear: "Crear espacio",
    crearNombre: "Nombre del espacio",
    crearBoton: "Crear",
    creando: "Creando…",
    cuenta: "Tu cuenta",
    cerrarSesion: "Cerrar sesión",
    errores: {
      sinMembresia: "Ese espacio ya no es tuyo.",
      sinFirma: "No podemos recordar el espacio elegido en esta máquina: falta TOKEN_ENCRYPTION_KEY (make db.unlock).",
      nombreVacio: "Escribe un nombre.",
      generico: "No pudimos cambiar de espacio. Vuelve a intentarlo.",
    },
  },

  espacio: {
    /** Cuando el correo no da ningún nombre legible. */
    sinNombre: "Mi espacio",
  },
} as const;
