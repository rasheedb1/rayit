/**
 * Textos de la actividad y las métricas del outreach (VEN-16): la
 * pantalla /ventas/actividad (la cola y el historial), el widget de uso
 * por canal de /ventas/canales, y el embudo por paso y la vista de flujo
 * de /ventas/cadencias/[id]. Un solo sitio para traducirlos.
 *
 * La base guarda CÓDIGOS (el estado del toque, su held_reason o su
 * blocked_reason, el motivo por el que un reintento se saltó): aquí se
 * convierten en frases. El motivo de una retención y el de un fallo del
 * proveedor son los mismos que dicen la ficha y los avisos
 * (holdReasonText y failureReason de @mc/core/outreach/messages, en el
 * idioma del espacio); lo demás vive aquí.
 */
import type { CancelSkipCode, RetrySkipCode, SequenceHealthLevel, TouchStatus, UsageLevel } from "@mc/db/queries/actividad";

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
    conteo: plural({ one: "{n} mensaje", other: "{n} mensajes" }),
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
    sinPaso: "Fuera de una cadencia",
    sinContacto: "Sin contacto",
    sinCadencia: "Sin cadencia",
    sinAsunto: "Sin asunto",
    desde: (cuenta: string) => `Desde ${cuenta}`,
    intentos: plural({ one: "{n} intento", other: "{n} intentos" }),
    reintento: (cuando: string) => `Reintento ${cuando}`,
    toca: (cuando: string) => `Sale ${cuando}`,
    sinHora: "Sin hora todavía",
    salio: (cuando: string) => `Salió ${cuando}`,
    cambio: (cuando: string) => `${cuando}`,
    abierto: "Abierto",
    respondido: "Respondió",
    motivo: "Motivo",
    verFicha: "Ver la ficha de la empresa",
    /** El título completo al pasar el cursor, con el código para soporte. */
    detalleMotivo: (frase: string, codigo: string) => `${frase} (código: ${codigo})`,
  },

  /**
   * Por qué terminó sin salir (blocked_reason de un cancelado o un
   * saltado), y las marcas de un enviado. Los fallos del proveedor usan
   * failureReason de @mc/core; un código que no está aquí ni allí se
   * dice de forma genérica.
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
  } as Record<string, string>,
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
    ayuda: "Vuelven a la cola y salen en la próxima pasada, dentro de tu horario de envío. Lo que rebotó o quedó a medias no se reintenta.",
    boton: (tipo: string, n: string) => `${tipo} · ${n}`,
    uno: "Reintentar",
    nada: "No hay nada que reintentar con estos filtros.",
    noReintentable: "No se reintenta: volvería a fallar o podría duplicarse",
  },

  resultado: {
    reintentados: plural({ one: "{n} mensaje volvió a la cola.", other: "{n} mensajes volvieron a la cola." }),
    cancelados: plural({ one: "{n} mensaje cancelado.", other: "{n} mensajes cancelados." }),
    saltados: plural({ one: "{n} no se movió:", other: "{n} no se movieron:" }),
    ninguno: "Nada cambió.",
    generico: "No pudimos hacerlo. Vuelve a intentarlo en un momento.",
    reintento: {
      not_found: "ya no existe",
      not_failed: "ya no estaba fallido",
      not_retryable: "rebotó o pudo haber salido",
      enrollment_closed: "la persona respondió, se dio de baja o rebotó",
      sequence_archived: "la cadencia está archivada",
      superseded: "ya salió un paso posterior",
      opted_out: "la persona pidió la baja",
      email_invalid: "el correo de la ficha rebotó",
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
  },
  masFilas: (n: string) => `Se muestran los primeros ${n}. Filtra por cadencia, tipo o contacto para ver el resto.`,

  /** El widget de uso por canal (en /ventas/canales). */
  uso: {
    titulo: "Uso de hoy",
    descripcion:
      "Cuánto salió hoy por cada cuenta. Al llegar al límite duro, lo demás espera al siguiente día hábil; el límite blando avisa antes.",
    canales: { email: "Correo", linkedin: "LinkedIn", instagram_dm: "Instagram", whatsapp: "WhatsApp" } as Record<string, string>,
    niveles: {
      ok: "Con margen",
      near: "Cerca del límite",
      full: "Límite alcanzado",
    } satisfies Record<UsageLevel, string>,
    cifra: (usado: string, duro: string) => `${usado} de ${duro}`,
    blando: (n: string) => `Límite blando ${n}`,
    duro: (n: string) => `Límite duro ${n}`,
    calentando: (hoy: string, tope: string) => `Calentando: hoy hasta ${hoy}, luego sube hasta ${tope}`,
    proveedor: (n: string, proveedor: string) => `${proveedor} permite hasta ${n} al día`,
    medidor: (cuenta: string, usado: string, duro: string, nivel: string) => `${cuenta}: ${usado} de ${duro} hoy, ${nivel}`,
    historia: "Últimos 14 días",
    historiaSerie: "Enviados",
    historiaLimite: "Límite duro",
    vacio: "Conecta una cuenta para ver su uso.",
    caida: "La cuenta no está conectada: no sale nada por ella hasta que la reconectes.",
  },

  /** El embudo por paso y la vista de flujo (en /ventas/cadencias/[id]). */
  embudo: {
    titulo: "Resultados por paso",
    descripcion: "Enviados, abiertos, respondidos y positivos de cada paso. Abiertos y respondidos cuentan solo lo que salió.",
    grafico: "Embudo por paso",
    series: { sent: "Enviados", opened: "Abiertos", replied: "Respondidos", positive: "Positivos" },
    eje: (n: string) => `Paso ${n}`,
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
      positivosNota: (n: string) => `${n} «me interesa»`,
      fallidos: "Fallidos",
      fallidosNota: (n: string) => `${n} en los últimos 7 días`,
      sinDato: "—",
      sinDatoNota: "Sin envíos todavía",
    },
  },

  flujo: {
    titulo: "Flujo de la cadencia",
    descripcion: "Cada paso con lo que pasó en él. Pasa el cursor o enfoca una cifra para ver qué cuenta.",
    paso: (n: string, dia: string, tipo: string) => `Paso ${n} · Día ${dia} · ${tipo}`,
    espera: plural({ one: "{n} día después", other: "{n} días después" }),
    mismoDia: "El mismo día",
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
} as const;
