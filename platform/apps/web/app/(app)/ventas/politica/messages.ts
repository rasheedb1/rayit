/**
 * Textos de /ventas/politica (VEN-15): la política de envío del
 * outreach y la salud del día. Cada regla lleva una línea que dice qué
 * hace y por qué; referencia: la configuración de límites y
 * calentamiento de Lemlist e Instantly. Voz: una creadora que escribe a
 * marcas, no un equipo de ventas. Nada atado a un país: las cifras y las
 * fechas llegan formateadas con el locale del workspace.
 *
 * Los plurales (r4): la cifra llega formateada para pintarla y cruda para
 * elegir la forma con Intl.PluralRules del idioma de estos textos, nunca
 * con un «n === 1» a mano.
 */
// Solo el tipo: este archivo llega al cliente (interruptor.tsx) y @mc/db no.
import type { DisabledReasonCode } from "@mc/db/queries/entregabilidad";

const reglas = new Intl.PluralRules("es");
/** La forma de una frase según la cifra: «1 atascado», «3 atascados». */
function plural(n: number, one: string, other: string): string {
  return reglas.select(n) === "one" ? one : other;
}

export const MESSAGES = {
  metaTitle: "Política de envío",
  header: {
    eyebrow: "Ventas · política de envío",
    title: "Las reglas que respeta cada mensaje",
    description:
      "Cuánto se escribe, cada cuánto y con qué cuidado. Valen para el correo, LinkedIn e Instagram, y se revisan antes de cada envío.",
    back: "Volver a Ventas",
  },

  interruptor: {
    title: "Envío automático",
    on: "Encendido",
    off: "Apagado",
    onHelp: "Los mensajes aprobados salen solos, dentro de estos límites.",
    /**
     * Nunca se encendió y no falta nada (r5): la dirección está guardada y
     * hay una cuenta conectada, así que no se pide lo que ya está.
     */
    offHelpListo: "Todo listo: al encenderlo, lo aprobado sale solo dentro de estos límites.",
    /** Nunca se encendió y falta algo: el paso concreto lo dice la línea de abajo, sin repetirlo aquí (r4). */
    offHelpNuncaCorto: "Todavía no sale nada.",
    /** Se apagó, sin motivo guardado: lo que estaba en cola se canceló. */
    offHelp: "No sale nada. Lo que estaba en cola se canceló y vuelve a planificarse al encender.",
    offReason: (motivo: string, fecha: string) => `Apagado el ${fecha}: ${motivo}.`,
    /**
     * Los motivos que guarda outbound_policy.disabled_reason como código
     * (r4): la base no guarda frases. Uno que no está aquí (lo pone otro
     * proceso) se enseña con offReasonDetalle, como detalle.
     */
    motivos: { manual: "lo apagaste desde la política" } satisfies Record<DisabledReasonCode, string> as Readonly<
      Record<string, string>
    >,
    offReasonDetalle: (detalle: string, fecha: string) => `Apagado el ${fecha}. Motivo registrado: ${detalle}.`,
    encender: "Encender el envío",
    apagar: "Apagar el envío",
    confirmarApagar: "¿Apagar el envío?",
    consecuenciaApagar: "Lo que está en cola se cancela; tus secuencias quedan como están y vuelven a planificarse al encender.",
    siApagar: "Sí, apagar",
    cancelar: "Cancelar",
    sinDireccion: "Para encender el envío guarda primero tu dirección postal.",
    /** Sin ninguna cuenta de envío conectada, encender no enviaría nada. */
    sinCanal: "Para encender el envío conecta primero una cuenta de envío (Gmail, LinkedIn o Instagram).",
    /**
     * El enlace que va detrás de la línea de lo que falta: al campo de la
     * dirección (que además recibe el foco) o a /ventas/canales.
     */
    irADireccion: "Ir a la dirección postal",
    irACanales: "Conectar una cuenta",
    /** Quien no es dueño ni administra el espacio (0038 §7). */
    sinPermiso: "Solo quien es dueño o administra este espacio puede encender o apagar el envío.",
    confirmarEncender: "¿Encender el envío?",
    /** `n` es el número de mensajes aprobados para hoy, ya formateado; `cuantos`, el mismo sin formatear. */
    consecuenciaEncender: (n: string, cuantos: number) =>
      cuantos > 0
        ? `${plural(cuantos, `Hoy sale ${n} mensaje aprobado`, `Hoy salen ${n} mensajes aprobados`)}, dentro de tus límites, y desde ahí lo que apruebes sale solo, en tu nombre.`
        : "Hoy no hay mensajes aprobados en cola. Desde ahora, lo que apruebes sale solo, en tu nombre y dentro de tus límites.",
    siEncender: "Sí, encender",
    /** Lo que anuncia la región role=status después de encender o apagar (r5). */
    anuncioEncendido: "Envío encendido.",
    anuncioApagado: "Envío apagado.",
    errorEncender: "No se pudo encender. Revisa que la dirección postal esté guardada.",
    errorApagar: "No se pudo apagar. Inténtalo de nuevo.",
  },

  /** El formulario, para quien no es dueño ni administra el espacio (0038 §7). */
  sinPermiso: "Solo quien es dueño o administra este espacio puede cambiar estas reglas. Puedes verlas; para cambiarlas, pídeselo.",

  secciones: {
    ritmo: "Ritmo",
    cuidado: "Cuidado",
    cumplimiento: "Cumplimiento",
    calentamiento: "Calentamiento",
  },

  campos: {
    maxTouchesPerCompany: {
      label: "Mensajes por marca",
      /**
       * `dias` es la ventana en la que se cuentan (COMPANY_CAP_WINDOW_DAYS
       * de @mc/db) e `insistente` INSISTENT_TOUCHES_PER_COMPANY
       * (@mc/core/outreach/warmup), los dos ya formateados.
       */
      help: (dias: string, insistente: string) =>
        `Cuántas veces, como mucho, se le escribe a una marca en ${dias} días, sumando todas tus secuencias. Los de más no salen. Más de ${insistente} suele sentirse insistente.`,
    },
    minDaysBetweenTouches: {
      label: "Días entre mensajes",
      help: "El mínimo de días entre un mensaje y el siguiente a la misma marca, por cualquier canal. Si una secuencia los tiene más juntos, el siguiente espera.",
    },
    sendWindow: {
      label: "Horario de envío",
      /** `zona` es el nombre de la zona del workspace, en su idioma («hora estándar de Colombia»). */
      help: (zona: string) => `Los mensajes salen entre estas horas, en ${zona}, de lunes a viernes.`,
      desde: "Desde",
      hasta: "Hasta",
      error: "La hora de fin tiene que ser después de la de inicio.",
      invalida: "Elige una hora de la lista.",
    },
    maxEmailsPerDay: {
      label: "Correos al día",
      /** Las cifras de GMAIL_DAILY_GUIDANCE (@mc/core/outreach/warmup), ya formateadas. */
      help: (personalDesde: string, personalHasta: string, workspaceDesde: string, workspaceHasta: string) =>
        `El tope diario de tu Gmail. Una cuenta personal aguanta ${personalDesde} a ${personalHasta} sin llamar la atención; Workspace, ${workspaceDesde} a ${workspaceHasta}.`,
    },
    cooldownDaysAfterNo: {
      label: "Días de espera tras un «no»",
      help: "Si una marca dice que no, no se le vuelve a escribir hasta que pasen estos días.",
    },
    requireHumanReview: {
      label: "Revisión humana",
      help: "Cada mensaje de tus secuencias espera tu aprobación en la ficha de la empresa antes de salir. Recomendado hasta que confíes en lo que se redacta.",
    },
    stopCompanyOnReply: {
      label: "Una respuesta pausa a la marca",
      help: "Si alguien de una marca te responde, las cadencias con las demás personas de esa marca quedan en pausa para que no les sigan llegando mensajes mientras hablas.",
    },
    claimsMustBeSourced: {
      label: "Cifras con origen",
      help: "Toda cifra de un mensaje (vistas, resultados de campañas) tiene que salir de tus datos. Un mensaje con una cifra inventada no sale.",
    },
    warmupDays: {
      label: "Días de calentamiento",
      /** `inicio` es WARMUP_START_LIMIT ya formateado: la regla vive en @mc/core/outreach/warmup. */
      help: (inicio: string) =>
        `Una cuenta nueva empieza con ${inicio} correos al día y sube poco a poco hasta tu tope en este día. 0 es sin calentamiento.`,
    },
    postalAddress: {
      label: "Dirección postal",
      help: "Va al pie de cada correo junto al enlace de baja. La exigen las leyes de correo comercial (CAN-SPAM, RGPD y las leyes locales); sin ella no sale nada.",
      placeholder: "Calle, número, ciudad y país",
    },
  },

  si: "Sí",
  no: "No",
  /** Los rangos que acepta cada campo, ya con cifras formateadas. */
  rango: (min: string, max: string) => `Entre ${min} y ${max}.`,
  entero: "Escribe un número entero.",
  direccionLarga: (max: string) => `La dirección no puede pasar de ${max} caracteres.`,

  calentamiento: {
    title: "Cómo sube tu tope de correos",
    dia: (d: string) => `Día ${d}`,
    correos: (n: string) => `${n} al día`,
    sinCalentamiento: "Sin calentamiento: el tope vale desde el primer día.",
    /** El tope no pasa del inicio del calentamiento: no hay nada que subir. */
    topeBajo: (tope: string) => `Con un tope de ${tope} correos al día no hace falta calentar: vale desde el primer día.`,
    fueraDeRango: "Corrige el tope o los días de calentamiento para ver la curva.",
    caption: "Correos al día según el día desde que conectaste tu Gmail",
    /** El nombre de la línea del gráfico (tooltip). */
    serie: "Correos al día",
    /** Debajo del gráfico: qué es el eje horizontal. */
    ejeX: "Día desde que conectaste tu Gmail",
  },

  salud: {
    title: "Salud de hoy",
    description: "Las últimas 24 horas del envío. Si algo se sale de lo normal, lo verás aquí arriba y te avisamos por correo.",
    /**
     * Los avisos del día (las notification de outbound.alerts): hasta que
     * la web tenga una campana, este es el sitio donde se ven, también sin
     * correo configurado. La frase de cada uno ya viene en el idioma del
     * espacio desde el worker.
     */
    avisos: {
      title: "Avisos de hoy",
      severidad: { critical: "Urgente", warning: "Revisar", info: "Aviso", success: "Aviso" } as Record<
        "critical" | "warning" | "info" | "success",
        string
      >,
      /**
       * El enlace de cada aviso, con su destino: un lector de pantalla no
       * oye «Ver, Ver» con dos avisos. Un tipo que no está aquí usa `ver`.
       */
      verPor: {
        account_down: "Ver la cuenta",
        bounce_rate: "Ver los rebotes",
        bounces_unread: "Ver la lectura de rebotes",
        no_sends: "Ver la salud del envío",
        queue_stuck: "Ver la cola",
        llm_budget: "Ver el presupuesto",
      } as Readonly<Record<string, string>>,
      ver: "Ver el detalle",
      vacio: {
        title: "Nada que revisar hoy",
        description: "Cuando algo se salga de lo normal (rebotes, una cuenta caída, la cola parada) aparecerá aquí.",
      },
    },
    enviados: { label: "Correos enviados", note: "En las últimas 24 horas" },
    rebotes: {
      label: "Rebotes",
      /** «1 de 40 no existe», «2 de 40 no existen»; `n` es `duros` sin formatear. */
      note: (duros: string, enviados: string, n: number) =>
        plural(n, `${duros} de ${enviados} no existe`, `${duros} de ${enviados} no existen`),
      /**
       * Los bloqueos, que también suman a la tasa: el servidor de la marca
       * rechazó por reputación, spam o un límite de envío. `n` es
       * `bloqueados` sin formatear.
       */
      bloqueados: (bloqueados: string, n: number) =>
        plural(n, `${bloqueados} bloqueado por el servidor`, `${bloqueados} bloqueados por el servidor`),
      sinEnvios: "Sin envíos en las últimas 24 horas",
      /** La cifra grande con pocos envíos: «1 de 4» (duros y bloqueos). Los dos llegan formateados. */
      cuenta: (rebotes: string, enviados: string) => `${rebotes} de ${enviados}`,
      /**
       * Detrás de la nota, dónde está la tasa respecto del aviso
       * (bounceRateStatus de @mc/core): que un 25 % con cuatro envíos no
       * parezca ignorado. `minimo` y `umbral` llegan formateados.
       */
      umbral: {
        /** Sola, debajo de «1 de 4»: con pocos envíos la nota no repite la cuenta. */
        pocos: (minimo: string) => `Con menos de ${minimo} envíos no se avisa todavía`,
        sobre: (umbral: string) => `pasa del ${umbral}: te avisamos`,
        bajo: (umbral: string) => `por debajo del ${umbral} que dispara el aviso`,
      },
    },
    cola: {
      label: "Por salir",
      /** `n` es `atascados` sin formatear. */
      note: (atascados: string, n: number) => plural(n, `${atascados} atascado`, `${atascados} atascados`),
      noteSinAtascos: "Nada atascado",
    },
    cuentas: {
      label: "Cuentas caídas",
      /** Cuáles, ya en una lista con Intl («LinkedIn: Laura · Cocina fácil»). */
      note: (cuales: string) => cuales,
      noteBien: "Todas conectadas",
    },
    /** La lista de cuentas caídas, adonde lleva la alerta outreach_account_down. */
    caidas: {
      title: "Cuentas que necesitan atención",
      description: "Mientras una cuenta no se reconecte, no sale nada por ella.",
      estado: { needs_reconnect: "Pide reconectar", error: "Falla" } as Record<"needs_reconnect" | "error", string>,
      /** «Desde el 23 de septiembre». */
      desde: (fecha: string) => `Desde el ${fecha}`,
      sinDetalle: "No tenemos más detalle de lo que pasó.",
      /**
       * Qué pasó, en frase. En last_error solo van CÓDIGOS: los de
       * CHANNEL_ERROR_CODES de VEN-9 (@mc/db, rama rasheed/VEN-9-canales) y
       * 'unipile_status:<X>' para lo que Unipile dice de una sesión. Un
       * código que no está aquí (o una frase vieja) nunca se enseña crudo:
       * sale `sinDetalle`. Al integrar VEN-9, estas frases pasan a leerse
       * de CANALES_TEXTOS (@mc/core/canales-textos) y la pantalla de
       * canales; los códigos son los mismos.
       */
      motivos: {
        taken: "Esta cuenta ya está conectada en otro espacio.",
        missing_scopes: "Google no dio los permisos de envío: al conectar hay que aceptarlos todos.",
        cancelled: "La conexión se canceló antes de terminar.",
        wrong_provider: "La cuenta que se conectó no es de este canal.",
        releasing: "La cuenta se estaba desconectando: espera un minuto y vuelve a conectarla.",
        webhooks_missing: "Está conectada, pero no nos enteramos de sus respuestas.",
        provider_error: "El servicio no respondió al conectar. Suele ser pasajero.",
        exchange_failed: "Google no aceptó la autorización.",
        auth_failed: "La conexión no terminó: la contraseña o el código de verificación no pasaron.",
        duplicate: "Este perfil ya está conectado en este espacio con otra cuenta.",
        gmail_revoked: "Google ya no acepta el permiso de este Gmail (lo quitaste o venció).",
        gmail_no_secret: "No encontramos el permiso guardado de este Gmail.",
        transient: "No pudimos comprobar la cuenta hoy. Lo intentamos de nuevo mañana.",
      } as Readonly<Record<string, string>>,
      /** 'unipile_gone': el canal ya no reconoce la cuenta. */
      motivoSinCuenta: (canal: string) => `${canal} ya no reconoce esta cuenta.`,
      /** 'unipile_status:<X>': lo que dijo Unipile de la sesión, sin nombrar a Unipile. */
      motivoSesion: (estado: string, canal: string) => {
        switch (estado) {
          case "CREDENTIALS":
            return `${canal} cerró la sesión.`;
          case "STOPPED":
            return "La cuenta se detuvo.";
          case "DELETED":
            return `La cuenta de ${canal} se borró.`;
          case "DISCONNECTED":
            return "La cuenta se desconectó.";
          default:
            return `${canal} dio un error con la sesión.`;
        }
      },
      /**
       * El paso concreto, en una frase, en vez de un enlace a una página
       * que no resuelve nada: la pantalla de canales (VEN-9), donde se
       * reconecta, todavía no está integrada. Cuando llegue, la alerta y
       * esta lista enlazan allí (CANALES_URL del worker). Solo se enseña
       * si hay cómo darlo: con el botón o con SUPPORT_EMAIL (r5).
       */
      paso: {
        email: "Para volver a enviar hay que conectar otra vez este Gmail y aceptar los permisos de envío.",
        otro: "Para volver a enviar hay que conectar otra vez esta cuenta con tu sesión del proveedor.",
      },
      /**
       * Qué pasa mientras tanto, y a quién escribir. Sin frases de una
       * función futura: con SUPPORT_EMAIL, a quién; sin él, solo que no se
       * pierde nada. Cuando la pantalla de canales (VEN-9) esté, cada
       * cuenta lleva su botón `reconectar` y esta línea sobra.
       */
      donde: (soporte: string | null) =>
        soporte
          ? `Escríbenos a ${soporte} y la reconectamos contigo. Lo de esta cuenta espera en la cola; no se pierde nada.`
          : "Lo de esta cuenta espera en la cola; no se pierde nada.",
      /** El botón de cada cuenta cuando hay una pantalla donde reconectarla. */
      reconectar: "Reconectar",
      /** El nombre accesible del botón: con varias cuentas, cuál. */
      reconectarCuenta: (cuenta: string) => `Reconectar ${cuenta}`,
    },
    canal: { email: "Gmail", linkedin: "LinkedIn", instagram_dm: "Instagram", whatsapp: "WhatsApp" } as Record<
      "email" | "linkedin" | "instagram_dm" | "whatsapp",
      string
    >,
    sinDato: "—",
    rebotesTitle: "Últimos rebotes",
    rebotesCaption: "Los últimos avisos de rebote leídos de tu Gmail",
    columnas: { direccion: "Dirección", tipo: "Tipo", motivo: "Lo que dijo el servidor", fecha: "Cuándo" },
    tipos: { hard: "No existe", soft: "Pasajero", blocked: "Bloqueado" },
    sinDireccion: "Sin dirección en el aviso",
    sinRebotes: {
      title: "Ningún rebote",
      description: "Cuando un correo no llegue, aquí verás a qué dirección y por qué.",
    },
    /**
     * Cuando nadie está leyendo los rebotes de un Gmail conectado
     * (readSendReadiness.bouncesReading, por el cursor de cada cuenta, r5):
     * que «Ningún rebote» no se lea como «todo bien». 'never' mientras el
     * job no lea los buzones (hasta integrar VEN-9, o si faltan las llaves);
     * 'stale' si el job se paró.
     */
    lectura: {
      never: {
        title: "Todavía no leemos los rebotes de tu Gmail",
        description:
          "La lectura automática de los avisos de rebote se conecta junto con los canales de envío. Hasta entonces, los que lleguen a tu buzón no se cuentan aquí ni en la cifra de rebotes: revísalos allí.",
      },
      stale: {
        title: "La lectura de rebotes está parada",
        /** `fecha` es la última lectura, con fecha y hora en la zona del espacio. */
        description: (fecha: string) =>
          `La última vez que leímos los rebotes de tu Gmail fue el ${fecha}. Los que llegaron después no se cuentan aquí ni en la cifra de rebotes: revísalos en tu buzón.`,
      },
    },
  },

  fijo: {
    optout: {
      label: "Enlace de baja",
      body: "Siempre. Cada correo lleva un enlace para dejar de recibir mensajes y la cabecera de baja de un clic que piden Gmail y Yahoo. No se puede apagar.",
    },
    llm: {
      label: "Presupuesto diario de redacción",
      body: (monto: string) => `${monto} al día para redactar y revisar mensajes. Lo fija On Cue; si se agota, lo nuevo espera a mañana.`,
    },
  },

  guardar: "Guardar la política",
  guardado: "Política guardada.",
  errorGuardar: "No se pudo guardar. Inténtalo de nuevo.",
  necesitaDireccion: "Con el envío encendido la dirección postal es obligatoria. Apágalo primero si quieres quitarla.",
  actualizada: (fecha: string) => `Actualizada el ${fecha}`,
  nuncaGuardada: "Todavía con los valores por defecto",

  error: {
    eyebrow: "Ventas · política de envío",
    title: "No pudimos leer tu política de envío",
  },
  loading: {
    label: "Cargando la política de envío",
  },
} as const;
