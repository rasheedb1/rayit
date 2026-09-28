/**
 * Textos de la actividad y las métricas del outreach (VEN-16): la
 * pantalla /ventas/actividad (la cola y el historial), el widget de uso
 * por canal de /ventas/canales, y el embudo por paso y la vista de flujo
 * de /ventas/cadencias/[id]. Un solo sitio para traducirlos.
 *
 * La base guarda CÓDIGOS (el estado del toque, su held_reason o su
 * blocked_reason, el bloqueo de un reintento, el tope que manda): aquí se
 * convierten en frases. El motivo de una retención y el de un fallo del
 * proveedor son los mismos que dicen la ficha y los avisos
 * (holdReasonText y failureReason de @mc/core/outreach/messages), en el
 * idioma de ESTE archivo (IDIOMA_MENSAJES), no en el locale del espacio:
 * así una fila nunca mezcla dos idiomas. Lo demás vive aquí.
 *
 * Solo tipos de @mc/db: este archivo lo importan componentes de cliente.
 */
import type {
  CancelSkipCode, ChannelProvider, OutboundChannel, RetrySkipCode, SequenceHealthLevel, TouchStatus, UsageLevel, UsageOffReason,
} from "@mc/db/queries/actividad";

/**
 * El idioma de estos textos. Sus reglas de plural son las del idioma en
 * que están escritos: al traducir el archivo, cambia esto y cada frase
 * trae las formas que su idioma pida (one, few, many…).
 */
export const IDIOMA_MENSAJES = "es";
const reglasPlural = new Intl.PluralRules(IDIOMA_MENSAJES);

/**
 * Las formas de una frase con cifra: las categorías de Intl.PluralRules
 * del idioma (one, few, many, other…) y, aparte, «=0» para decir el cero
 * con otras palabras («Ningún mensaje…» en vez de «0 mensajes…»), como el
 * caso exacto =0 de ICU MessageFormat.
 */
type Formas = Partial<Record<Intl.LDMLPluralRule | "=0", string>> & { other: string };
/** Una frase con cifra: `n` llega ya formateado y reemplaza «{n}»; la forma la elige `count`. */
const plural =
  (formas: Formas) =>
  (n: string, count: number): string =>
    ((count === 0 ? formas["=0"] : undefined) ?? formas[reglasPlural.select(count)] ?? formas.other).replaceAll("{n}", n);

/**
 * Los códigos de blocked_reason que se dicen aquí (los de la cadencia y la
 * web). Los fallos del proveedor usan FAILURE_REASON_TEXTS de @mc/core.
 */
export type MotivoCode =
  | "replied" | "not_now" | "opted_out" | "opted_out_in_flight" | "outreach_disabled" | "sequence_archived" | "completed"
  | "bounced" | "email_invalid" | "no_address" | "invalid_address" | "no_contact" | "company_cap" | "canceled_by_user"
  | "sent_confirmed_by_user" | "paused" | "cooldown";

export const MESSAGES = {
  metaTitle: "Actividad",
  header: {
    eyebrow: "Ventas",
    title: "Actividad",
    description:
      "Lo que sale solo, lo que espera a una persona y lo que falló en tus cadencias. Reintenta lo fallido, cancela lo que ya no quieres enviar y revisa lo que salió.",
  },
  loading: { label: "Cargando la actividad" },
  error: { eyebrow: "Ventas · Actividad", title: "No pudimos cargar la actividad" },

  pestanas: {
    label: "Qué ver",
    cola: "Cola",
    historial: "Historial",
    colaAyuda: "Programados, retenidos, borradores y fallidos",
    historialAyuda: "Enviados, cancelados y saltados",
    /** «Cola · 12»: la cifra llega formateada. */
    conCifra: (vista: string, n: string) => `${vista} · ${n}`,
  },

  filtros: {
    label: "Filtrar la actividad",
    cadencia: "Cadencia",
    todasCadencias: "Todas las cadencias",
    tipo: "Tipo de paso",
    todosTipos: "Todos los tipos",
    contacto: "Contacto",
    contactoPlaceholder: "Nombre, correo o marca",
    aplicar: "Filtrar",
    limpiar: "Quitar filtros",
  },

  /** El nombre de cada estado de outbound_touch (0046), para la pastilla. */
  estados: {
    draft: "Borrador",
    scheduled: "Programado",
    processing: "Enviando",
    held: "Retenido",
    sent: "Enviado",
    failed: "Falló",
    skipped: "Saltado",
    canceled: "Cancelado",
  } satisfies Record<TouchStatus, string>,

  fila: {
    lista: (vista: string) => `Mensajes · ${vista}`,
    paso: (n: string, tipo: string) => `Paso ${n} · ${tipo}`,
    /** El título de un toque suelto (sin paso) que no lleva asunto: el canal, porque el contexto ya dice «Sin cadencia». */
    suelto: (canal: string) => `Mensaje por ${canal}`,
    sinContacto: "Sin contacto",
    sinCadencia: "Sin cadencia",
    sinAsunto: "Sin asunto",
    /** Un borrador de cadencia que todavía no se redacta: el título es su paso y esto va al lado, en neutro. */
    porRedactar: "por redactar",
    desde: (cuenta: string) => `Desde ${cuenta}`,
    intentos: plural({ one: "{n} intento", other: "{n} intentos" }),
    reintento: (cuando: string) => `Reintento ${cuando}`,
    /** Solo en lo programado: el despachador lo reclama a esa hora. */
    toca: (cuando: string) => `Sale ${cuando}`,
    /**
     * Lo retenido espera a una persona: el despachador no lo reclama. La
     * hora que dejó el generador es la prevista, no una promesa.
     */
    previsto: (cuando: string) => `Previsto para ${cuando} si lo apruebas`,
    /** Un borrador tampoco sale solo: lo completa y lo programa una persona. */
    borrador: "Sale cuando lo programes",
    borradorPrevisto: (cuando: string) => `Previsto para ${cuando}; sale cuando lo programes`,
    /**
     * Lo que tendría que salir pero la cola no reclama (el envío apagado, el
     * canal sin cuenta o fuera de la política): en vez de «Sale …», por qué
     * espera. La frase entera y su enlace van debajo (espera).
     */
    enEspera: (motivo: string) => `En espera · ${motivo}`,
    esperaPrevisto: (cuando: string) => `Estaba previsto para ${cuando}`,
    /** El botón de lo que espera a una persona: lleva a la cadencia de la ficha, donde está «Aprobar y enviar». */
    revisar: "Revisar y aprobar",
    /** Lo que se está enviando, al lado de la pastilla «Enviando»: solo desde cuándo. */
    desdeCorto: (cuando: string) => `Desde ${cuando}`,
    sinHora: "Sin hora todavía",
    salio: (cuando: string) => `Salió ${cuando}`,
    /**
     * Lo que ya no va a salir (o se está enviando): el verbo de su estado y
     * cuándo cambió. Es la frase larga (title y detalle): en la fila, al
     * lado de la pastilla que ya dice el verbo, va solo la fecha.
     */
    cambio: {
      failed: (cuando: string) => `Falló ${cuando}`,
      canceled: (cuando: string) => `Se canceló ${cuando}`,
      skipped: (cuando: string) => `Se saltó ${cuando}`,
      processing: (cuando: string) => `Enviándose desde ${cuando}`,
      sent: (cuando: string) => `Salió ${cuando}`,
    } satisfies Partial<Record<TouchStatus, (cuando: string) => string>>,
    cambioGenerico: (cuando: string) => `Cambió ${cuando}`,
    abierto: "Abierto",
    respondido: "Respondió",
    motivo: "Motivo",
    verFicha: "Ver la ficha de la empresa",
    /** El detalle del motivo, que se despliega en la fila (con teclado, con el dedo o con el ratón). */
    detalle: {
      codigo: (codigo: string) => `código: ${codigo}`,
    },
  },

  /**
   * Por qué terminó sin salir (blocked_reason de un cancelado o un
   * saltado), y las marcas de un enviado. Los fallos del proveedor usan
   * failureReason de @mc/core; un código que no está aquí ni allí se
   * dice de forma genérica (motivoTexto).
   */
  motivos: {
    replied: "respondió y la cadencia se detuvo",
    not_now: "dijo «ahora no» y la cadencia espera",
    opted_out: "pidió no recibir más mensajes",
    opted_out_in_flight: "salió justo cuando pidió la baja",
    outreach_disabled: "el envío del espacio está apagado",
    sequence_archived: "la cadencia está archivada",
    completed: "la cadencia ya había terminado",
    bounced: "la dirección rebotó",
    email_invalid: "el correo de la ficha rebotó antes",
    no_address: "la persona no tiene dirección en ese canal",
    invalid_address: "la dirección de la ficha no es válida",
    no_contact: "la ficha ya no existe",
    company_cap: "la marca ya recibió todos los mensajes que permite tu política",
    canceled_by_user: "lo cancelaste desde la actividad",
    sent_confirmed_by_user: "confirmaste a mano que salió",
    paused: "la cadencia está en pausa",
    cooldown: "la cadencia está en espera",
  } satisfies Record<MotivoCode, string>,
  motivoGenerico: "no salió",

  seleccion: {
    todas: "Seleccionar todo lo cancelable",
    /** Con más de una página, la casilla solo marca las filas que se ven: lo dice. */
    pagina: "Seleccionar lo cancelable de esta página",
    /** Debajo, cuántos hay en la cola con estos filtros, para que nadie crea que canceló «todo». */
    /**
     * `enPagina` y `total` llegan formateados; la forma la elige `count`
     * (lo cancelable de la página, lo que marca la casilla). El total es lo CANCELABLE de la cola con
     * estos filtros (getQueueFacets.cancelable): lo que se está enviando no
     * cuenta, porque no se puede cancelar.
     */
    soloPagina: (enPagina: string, count: number, total: string) =>
      plural({
        one: "Solo el mensaje de esta página; con estos filtros hay {total} que se pueden cancelar.",
        other: "Solo los {n} mensajes de esta página; con estos filtros hay {total} que se pueden cancelar.",
      })(enPagina, count).replaceAll("{total}", total),
    /** Una casilla: qué mensaje y a quién («Seleccionar «Paso 3 · Mensaje en LinkedIn» a Sofía Cárdenas»), para distinguir las de una misma persona. */
    una: (quien: string, que: string) => `Seleccionar «${que}» a ${quien}`,
    n: plural({ one: "{n} seleccionado", other: "{n} seleccionados" }),
    cancelar: "Cancelar seleccionados",
    pregunta: plural({ one: "¿Cancelar {n} mensaje?", other: "¿Cancelar {n} mensajes?" }),
    consecuencia:
      "No saldrán. Lo fallido queda descartado. Si la cadencia se queda sin nada pendiente, se da por terminada. No se puede deshacer.",
    confirmar: "Sí, cancelar",
    volver: "No, volver",
    enviando: "Enviándose ahora: no se puede cancelar",
  },

  reintentar: {
    titulo: "Reintentar lo fallido",
    ayuda:
      "Vuelven a la cola y salen en la próxima pasada, dentro de tu horario de envío. Solo cuenta lo que puede salir: lo que rebotó, quedó a medias o ya no tiene sentido enviar no se reintenta.",
    /** La misma ayuda con el envío del espacio apagado: vuelven a la cola, pero no salen. */
    ayudaApagado:
      "Vuelven a la cola, pero no salen mientras el envío del espacio esté apagado. Solo cuenta lo que puede salir: lo que rebotó, quedó a medias o ya no tiene sentido enviar no se reintenta.",
    boton: (tipo: string, n: string) => `${tipo} · ${n}`,
    /** Es en masa: pregunta antes, como «Cancelar seleccionados». */
    pregunta: (tipo: string, n: string, count: number) =>
      plural({ one: "¿Volver a enviar {n} mensaje de {tipo}?", other: "¿Volver a enviar {n} mensajes de {tipo}?" })(n, count).replaceAll(
        "{tipo}",
        tipo,
      ),
    consecuencia: "Vuelven a la cola y salen en la próxima pasada del envío, dentro de tu horario.",
    consecuenciaApagado: "Vuelven a la cola, pero no salen mientras el envío del espacio esté apagado.",
    confirmar: "Sí, reintentar",
    volver: "No, volver",
    uno: "Reintentar",
    /** En vez del botón, en un fallido que no se puede reintentar. */
    bloqueo: (motivo: string) => `No se reintenta: ${motivo}.`,
    /** Un fallo de la cuenta con el canal sin ninguna cuenta conectada. */
    reconectar: "Reconecta la cuenta del canal para reintentarlo.",
    irACanales: "Ir a canales",
  },

  resultado: {
    reintentados: plural({ one: "{n} mensaje volvió a la cola.", other: "{n} mensajes volvieron a la cola." }),
    cancelados: plural({ one: "{n} mensaje cancelado.", other: "{n} mensajes cancelados." }),
    saltados: plural({ one: "{n} no se movió:", other: "{n} no se movieron:" }),
    ninguno: "Nada cambió.",
    generico: "No pudimos hacerlo. Vuelve a intentarlo en un momento.",
    sinPermiso: "Tu rol en este espacio no puede reintentar ni cancelar mensajes. Pídeselo a quien administra el espacio.",
    /** Por qué un fallido no volvió (o no se ofrece): el motivo del resumen y el de la fila. */
    reintento: {
      not_found: "ya no existe",
      not_failed: "ya no estaba fallido",
      not_retryable: "rebotó o pudo haber salido",
      too_many_attempts: "ya gastó todos sus intentos",
      enrollment_closed: "la persona respondió, se dio de baja o rebotó",
      sequence_archived: "la cadencia está archivada",
      superseded: "ya salió un paso posterior",
      opted_out: "la persona pidió la baja",
      email_invalid: "el correo de la ficha rebotó",
      account_down: "la cuenta del canal no está conectada",
      already_queued: "ese paso ya tiene otro mensaje en la cola",
      blocked: "la base no lo deja volver (una baja o un rebote)",
    } satisfies Record<RetrySkipCode, string>,
    cancelacion: {
      not_found: "ya no existe",
      not_cancelable: "ya salió o se está enviando",
    } satisfies Record<CancelSkipCode, string>,
    conMotivo: (n: string, motivo: string) => `${n} · ${motivo}`,
  },

  /**
   * Por qué un mensaje por salir no sale (getQueueBlockers de @mc/db y el
   * estado de su cadencia): el aviso de arriba y lo que dice cada fila que
   * espera. `corto` va al lado de la pastilla; `texto`, debajo, con su
   * enlace, solo cuando el motivo es de esa fila (su canal, su cadencia).
   * El envío apagado es de todo el espacio: la fila dice solo el corto y
   * el aviso de arriba lleva a encenderlo, una vez.
   */
  espera: {
    aviso: "El envío está apagado: nada de la cola sale hasta que lo enciendas.",
    avisoEnlace: "Ir a la política de envío",
    disabled: { corto: "envío apagado" },
    /** La cadencia en pausa (o todavía en borrador): el despachador lo aplaza cada día. */
    sequencePaused: {
      corto: "cadencia en pausa",
      texto: "La cadencia está en pausa: no sale nada de ella hasta que la reanudes.",
      enlace: "Ir a la cadencia",
    },
    /** Esta persona, en pausa dentro de la cadencia. */
    enrollmentPaused: {
      corto: "en pausa para esta persona",
      texto: "La cadencia está en pausa para esta persona: no le sale nada mientras siga así.",
      enlace: "Ver su cadencia en la ficha",
    },
    /** Dijo «ahora no»: la cadencia espera antes de volver a escribirle. */
    enrollmentCooldown: {
      corto: "dijo «ahora no»",
      texto: "Dijo «ahora no»: la cadencia espera antes de volver a escribirle, y este mensaje no sale mientras tanto.",
      enlace: "Ver su cadencia en la ficha",
    },
    noAccount: {
      corto: (canal: string) => `sin cuenta de ${canal}`,
      texto: (canal: string) => `No hay ninguna cuenta de ${canal} conectada: sale en cuanto conectes una.`,
      enlace: "Ir a canales",
    },
    notAllowed: {
      corto: (canal: string) => `${canal} no está permitido`,
      texto: (canal: string) => `Tu política de envío no deja usar ${canal}: no sale hasta que lo permitas.`,
      enlace: "Ir a la política de envío",
    },
  },

  vacio: {
    cola: {
      titulo: "La cola está vacía",
      descripcion: "Cuando enroles a alguien en una cadencia activa, sus mensajes aparecerán aquí antes de salir.",
      accion: "Ir a las cadencias",
    },
    historial: {
      titulo: "Todavía no sale nada",
      descripcion: "Aquí verás cada mensaje enviado, cancelado o saltado, del más reciente al más viejo.",
    },
    filtrado: {
      titulo: "Nada con estos filtros",
      descripcion: "Prueba con otra cadencia, otro tipo de paso u otro contacto.",
    },
    pagina: {
      titulo: "No hay más mensajes",
      descripcion: "Esta página se quedó vacía: lo que había se movió mientras tanto.",
    },
  },

  /** Las páginas, debajo de la lista. El historial va de lo último a lo primero; la cola, por la hora a la que sale. */
  paginas: {
    label: "Páginas",
    historial: { anterior: "Más recientes", siguiente: "Más antiguos" },
    cola: { anterior: "Anteriores", siguiente: "Siguientes" },
    principio: "Volver al principio",
  },

  /** El widget de uso por canal (en /ventas/canales). */
  uso: {
    titulo: "Uso de hoy",
    descripcion:
      "Cuánto salió hoy por cada cuenta. Al llegar al límite duro, lo demás espera al siguiente día hábil; el límite blando avisa antes.",
    canales: { email: "Correo", linkedin: "LinkedIn", instagram_dm: "Instagram", whatsapp: "WhatsApp" } satisfies Record<OutboundChannel, string>,
    niveles: {
      ok: "Con margen",
      near: "Cerca del límite",
      full: "Límite alcanzado",
      off: "Sin envío",
    } satisfies Record<UsageLevel, string>,
    cifra: (usado: string, duro: string) => `${usado} de ${duro}`,
    blando: (n: string) => `Límite blando ${n}`,
    duro: (n: string) => `Límite duro ${n}`,
    calentando: (hoy: string, tope: string) => `Calentando: hoy hasta ${hoy}, luego sube hasta ${tope}`,
    semana: (usado: string, tope: string) => `Semana ${usado} de ${tope}`,
    proveedor: (n: string, proveedor: string) => `${proveedor} permite hasta ${n} al día`,
    /**
     * Quién pone el techo del proveedor: el servicio con el que se conectó
     * la cuenta. Unipile es un puente: el techo lo pone la red (LinkedIn,
     * Instagram), así que para él manda el nombre del canal (plataformas).
     */
    proveedores: { gmail_oauth: "Gmail", unipile: null } satisfies Record<ChannelProvider, string | null>,
    plataformas: { email: "Tu proveedor de correo", linkedin: "LinkedIn", instagram_dm: "Instagram", whatsapp: "WhatsApp" } satisfies Record<OutboundChannel, string>,
    /** Cuando el límite duro de hoy no es el diario de la cuenta, qué tope manda. */
    manda: {
      week: () => "Manda el tope semanal de la cuenta: hoy solo sale lo que le queda a la semana",
      workspace: (usado: string, tope: string) => `Manda el tope de correos del espacio: ${usado} de ${tope} hoy entre todas las cuentas`,
    },
    medidor: (cuenta: string, usado: string, duro: string, nivel: string) => `${cuenta}: ${usado} de ${duro} hoy, ${nivel}`,
    historia: "Últimos 14 días",
    /** La punta derecha del eje de los 14 días. */
    hoy: "Hoy",
    vacio: "Conecta una cuenta para ver su uso.",
    /**
     * Por qué una cuenta está «Sin envío», con adónde ir a arreglarlo. El
     * enlace de la cuenta caída lo pone usoVista: lleva a la fila de SU
     * canal en /ventas/canales (canalHref), donde está el botón de verdad.
     */
    sinEnvio: {
      account: { texto: "La cuenta no está conectada: no sale nada por ella hasta que la reconectes.", enlace: "Reconectar" },
      disabled: { texto: "El envío del espacio está apagado: no sale nada hasta que lo enciendas.", enlace: "Ir a la política de envío" },
    } satisfies Record<UsageOffReason, { texto: string; enlace: string }>,
    politicaHref: "/ventas/politica",
    cargando: "Cargando el uso de hoy",
    error: "No pudimos cargar el uso de hoy. El resto de la página sigue funcionando.",
  },

  /** El embudo por paso y la vista de flujo (en /ventas/cadencias/[id]). */
  embudo: {
    titulo: "Resultados por paso",
    descripcion: "Enviados, abiertos, respondidos y positivos de cada paso. Abiertos y respondidos cuentan solo lo que salió.",
    vacio: {
      titulo: "Todavía no sale nada de esta cadencia",
      descripcion: "Cuando salgan los primeros mensajes, aquí verás cuántos se abren, cuántos responden y cuántos dicen que sí.",
    },
    sinPasos: "La cadencia no tiene pasos.",
    salud: {
      inactive: "Inactiva",
      failing: "Fallando",
      attention: "Pide atención",
      healthy: "Sana",
    } satisfies Record<SequenceHealthLevel, string>,
    saludAyuda: {
      inactive: "No está activa: no sale nada nuevo.",
      failing: "Falla al menos uno de cada cinco envíos de la última semana. Revisa la cola.",
      attention: "Hay mensajes fallidos o retenidos esperando a una persona.",
      healthy: "Sale lo que tiene que salir.",
    } satisfies Record<SequenceHealthLevel, string>,
    verCola: "Ver en la actividad",
    /** La columna del semáforo en la lista de /ventas/cadencias. */
    columnaSalud: "Salud",
    kpis: {
      enviados: "Enviados",
      enviadosNota: (n: string) => `${n} en los últimos 7 días`,
      respuesta: "Respuesta",
      respuestaNota: (n: string, de: string) => `${n} de ${de} enviados`,
      positivos: "Positivos",
      positivosNota: (pct: string) => `«Me interesa»: ${pct} de lo enviado`,
      fallidos: "Fallidos",
      fallidosNota: (n: string) => `${n} en los últimos 7 días`,
      sinDato: "—",
      sinDatoNota: "Sin envíos todavía",
    },
    cargando: "Cargando los resultados de la cadencia",
    error: "No pudimos cargar los resultados de esta cadencia. Lo demás de la cadencia sigue funcionando.",
  },

  flujo: {
    titulo: "Flujo de la cadencia",
    descripcion:
      "Cada paso con lo que pasó en él. Pasa el cursor, toca o enfoca una cifra para ver qué cuenta; Escape la cierra. Con el teclado, Tab va de paso en paso y las flechas recorren sus cifras.",
    paso: (n: string, dia: string, tipo: string) => `Paso ${n} · Día ${dia} · ${tipo}`,
    cifras: {
      sent: "enviados",
      opened: "abiertos",
      replied: "respondidos",
      positive: "positivos",
      pending: "en cola",
      failed: "fallidos",
      stopped: "detenidos",
    },
    /** Lo que explica cada cifra: el tooltip. `n` llega formateado; la forma la elige `count`. */
    explica: {
      sent: plural({
        "=0": "Ningún mensaje de este paso ha salido todavía.",
        one: "Un mensaje de este paso salió.",
        other: "{n} mensajes de este paso salieron.",
      }),
      opened: plural({
        "=0": "Ninguno de los enviados se ha abierto. Solo el correo avisa de la apertura, y no siempre.",
        one: "Uno de los enviados se abrió. Solo el correo avisa de la apertura, y no siempre.",
        other: "{n} de los enviados se abrieron. Solo el correo avisa de la apertura, y no siempre.",
      }),
      openedNoTracked: "Este canal no avisa cuando se abre un mensaje.",
      replied: plural({
        "=0": "Ninguno de los enviados ha recibido respuesta (sin contar los «fuera de oficina»).",
        one: "Uno de los enviados recibió respuesta (sin contar los «fuera de oficina»).",
        other: "{n} de los enviados recibieron respuesta (sin contar los «fuera de oficina»).",
      }),
      positive: plural({
        "=0": "Ninguna respuesta de este paso dice «me interesa» todavía.",
        one: "Una de las respuestas de este paso dice «me interesa».",
        other: "{n} de las respuestas de este paso dicen «me interesa».",
      }),
      pending: plural({
        "=0": "No queda nada de este paso en la cola.",
        one: "Un mensaje de este paso sigue en la cola (programado, retenido, en borrador o enviándose): todavía puede salir.",
        other: "{n} mensajes de este paso siguen en la cola (programados, retenidos, en borrador o enviándose): todavía pueden salir.",
      }),
      failed: plural({
        "=0": "Ningún envío de este paso ha fallado.",
        one: "Un mensaje de este paso falló. Puedes reintentarlo desde la actividad.",
        other: "{n} mensajes de este paso fallaron. Puedes reintentarlos desde la actividad.",
      }),
      /** Ninguno de los fallidos se puede reintentar: la actividad no ofrece «Reintentar» (rebote, cuenta caída…). */
      failedNinguno: plural({
        one: "Un mensaje de este paso falló y no se puede reintentar: rebotó, la cuenta del canal está caída o ya no tiene sentido enviarlo.",
        other: "{n} mensajes de este paso fallaron y no se pueden reintentar: rebotaron, la cuenta del canal está caída o ya no tiene sentido enviarlos.",
      }),
      /** Solo algunos se pueden reintentar. `m` y `mCount`: cuántos sí. */
      failedAlgunos: (n: string, count: number, m: string, mCount: number) =>
        `${plural({ one: "Un mensaje de este paso falló", other: "{n} mensajes de este paso fallaron" })(n, count)}; ${plural({
          one: "uno se puede reintentar desde la actividad.",
          other: "{n} se pueden reintentar desde la actividad.",
        })(m, mCount)}`,
      stopped: plural({
        "=0": "Nada de este paso se canceló ni se saltó.",
        one: "Un mensaje de este paso no salió ni va a salir: se canceló o se saltó (la persona respondió, se dio de baja, no tenía dirección o lo cancelaste tú desde la actividad).",
        other: "{n} mensajes de este paso no salieron ni van a salir: se cancelaron o se saltaron (la persona respondió, se dio de baja, no tenía dirección o los cancelaste tú desde la actividad).",
      }),
    },
    tasa: (pct: string) => `${pct} de lo enviado`,
    /** Las barras de cada paso: cuánto de lo enviado en el primero llega hasta aquí (la caída de paso a paso). */
    barras: {
      titulo: "Sobre lo enviado en el paso 1",
      sent: "Enviados",
      opened: "Abiertos",
      replied: "Respondidos",
      label: (que: string, pct: string) => `${que}: ${pct} de lo enviado en el paso 1`,
    },
    /** Debajo de las cifras, con fallidos que sí se pueden reintentar: a la cola de la actividad, con este tipo de paso. */
    reintentar: plural({ one: "Reintentar el fallido en la actividad", other: "Reintentar los {n} fallidos en la actividad" }),
  },

  /** El aviso de una pieza montada en otra pantalla que no pudo cargar (su frontera propia). */
  widget: {
    reintentar: "Volver a intentar",
  },
} as const;

/** La frase de un código de blocked_reason de la cadencia o la web, o undefined si no es uno de esos. */
export function motivoTexto(code: string): string | undefined {
  return Object.hasOwn(MESSAGES.motivos, code) ? MESSAGES.motivos[code as MotivoCode] : undefined;
}
