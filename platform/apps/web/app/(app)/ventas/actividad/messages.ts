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
 * (holdReasonText y failureReason de @mc/core/outreach/messages, en el
 * idioma del espacio); lo demás vive aquí.
 *
 * Solo tipos de @mc/db: este archivo lo importan componentes de cliente.
 */
import type {
  CancelSkipCode, OutboundChannel, RetrySkipCode, SequenceHealthLevel, TouchStatus, UsageLevel, UsageLimitedBy, UsageOffReason,
} from "@mc/db/queries/actividad";

/**
 * El idioma de estos textos. Sus reglas de plural son las del idioma en
 * que están escritos: al traducir el archivo, cambia esto y cada frase
 * trae las formas que su idioma pida (one, few, many…).
 */
export const IDIOMA_MENSAJES = "es";
const reglasPlural = new Intl.PluralRules(IDIOMA_MENSAJES);

type Formas = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
/** Una frase con cifra: `n` llega ya formateado y reemplaza «{n}»; la forma la elige Intl.PluralRules con `count`. */
const plural =
  (formas: Formas) =>
  (n: string, count: number): string =>
    (formas[reglasPlural.select(count)] ?? formas.other).replaceAll("{n}", n);

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

  /** El nombre de cada estado de outbound_touch (0037), para la pastilla. */
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
    desde: (cuenta: string) => `Desde ${cuenta}`,
    intentos: plural({ one: "{n} intento", other: "{n} intentos" }),
    reintento: (cuando: string) => `Reintento ${cuando}`,
    toca: (cuando: string) => `Sale ${cuando}`,
    sinHora: "Sin hora todavía",
    salio: (cuando: string) => `Salió ${cuando}`,
    /** Lo que ya no va a salir (o se está enviando): el verbo de su estado y cuándo cambió. */
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
      abrir: "Ver el detalle",
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
    una: (quien: string) => `Seleccionar el mensaje a ${quien}`,
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
    boton: (tipo: string, n: string) => `${tipo} · ${n}`,
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
    proveedor: (n: string, proveedor: string) => `${proveedor} permite hasta ${n} al día`,
    /** Cuando el límite duro de hoy no es el diario de la cuenta, qué tope manda. */
    manda: {
      week: (usado: string, tope: string) => `Manda el tope semanal de la cuenta: ${usado} de ${tope} esta semana`,
      workspace: (usado: string, tope: string) => `Manda el tope de correos del espacio: ${usado} de ${tope} hoy entre todas las cuentas`,
    } satisfies Record<Exclude<UsageLimitedBy, "day">, (usado: string, tope: string) => string>,
    medidor: (cuenta: string, usado: string, duro: string, nivel: string) => `${cuenta}: ${usado} de ${duro} hoy, ${nivel}`,
    historia: "Últimos 14 días",
    vacio: "Conecta una cuenta para ver su uso.",
    /** Por qué una cuenta está «Sin envío», con adónde ir a arreglarlo. */
    sinEnvio: {
      account: { texto: "La cuenta no está conectada: no sale nada por ella hasta que la reconectes.", enlace: "Reconectar", href: "/ventas/canales" },
      disabled: { texto: "El envío del espacio está apagado: no sale nada hasta que lo enciendas.", enlace: "Ir a la política de envío", href: "/ventas/politica" },
    } satisfies Record<UsageOffReason, { texto: string; enlace: string; href: string }>,
    cargando: "Cargando el uso de hoy",
    error: "No pudimos cargar el uso de hoy. El resto de la página sigue funcionando.",
  },

  /** El embudo por paso y la vista de flujo (en /ventas/cadencias/[id]). */
  embudo: {
    titulo: "Resultados por paso",
    descripcion: "Enviados, abiertos, respondidos y positivos de cada paso. Abiertos y respondidos cuentan solo lo que salió.",
    grafico: "Embudo por paso",
    series: { sent: "Enviados", opened: "Abiertos", replied: "Respondidos", positive: "Positivos" },
    eje: (n: string) => `Paso ${n}`,
    columnaPaso: "Paso",
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
    descripcion: "Cada paso con lo que pasó en él. Pasa el cursor, toca o enfoca una cifra para ver qué cuenta; Escape la cierra.",
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
    /** Lo que explica cada cifra: el tooltip. */
    explica: {
      sent: (n: string) => `${n}: mensajes de este paso que salieron.`,
      opened: (n: string) => `${n}: de los enviados, los que se abrieron. Solo el correo avisa de la apertura, y no siempre.`,
      openedNoTracked: "Este canal no avisa cuando se abre un mensaje.",
      replied: (n: string) => `${n}: de los enviados, los que recibieron respuesta (sin contar los «fuera de oficina»).`,
      positive: (n: string) => `${n}: de los enviados, los que recibieron una respuesta clasificada como «me interesa».`,
      pending: (n: string) => `${n}: programados, retenidos, borradores o enviándose. Todavía pueden salir.`,
      failed: (n: string) => `${n}: el envío falló. Puedes reintentarlos desde la actividad.`,
      stopped: (n: string) => `${n}: cancelados o saltados (la persona respondió, se dio de baja o no tenía dirección).`,
    },
    tasa: (pct: string) => `${pct} de lo enviado`,
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
