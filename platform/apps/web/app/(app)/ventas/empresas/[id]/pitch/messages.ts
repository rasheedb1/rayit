import type { ClaimSource } from "@mc/core/outreach/claims";
import type { PreflightCode, RegenerateHint } from "@mc/core/outreach/preflight";
import type { TemplateVariable } from "@mc/core/outreach/render";

/**
 * Los textos del editor del pitch (VEN-6 dentro de VEN-12), en un solo
 * lugar. En la voz del producto: le hablamos a una creadora que le
 * escribe a una marca; «cifra» y «origen», nunca «claim» ni «toque».
 */
export const PITCH = {
  metaTitle: (company: string) => `Pitch para ${company} · Ventas`,
  eyebrow: "Ventas · Pitch",
  title: (company: string) => `Pitch para ${company}`,
  description:
    "Un correo con cifras que salen de tu perfil. Cada cifra lleva su origen: si una no lo tiene, el correo no se puede programar.",

  campos: {
    contacto: "Para",
    contactoPlaceholder: "Elige a quién le escribes",
    contactoHelp: "Solo las personas con correo que no pidieron la baja.",
    sinContactos: "Esta empresa no tiene contactos con correo. Agrega uno en la ficha para escribirle.",
    negocio: "Negocio",
    negocioNinguno: "Sin negocio",
    negocioHelp: "Si el negocio salió de una señal, sus cifras también se pueden citar.",
    asunto: "Asunto",
    asuntoHelp: "De 2 a 12 palabras, sin «Re:».",
    cuerpo: "Mensaje",
    cuerpoHelp:
      "Las cifras de tu perfil y las variables se ven como fichas. Cada cifra lleva su origen (pasa el cursor o tócala para verlo) y la marca solo ve el número; cada variable se rellena con los datos de la persona.",
  },

  /** Las fichas dentro del mensaje. */
  cuerpo: {
    cifra: (display: string, label: string, origen: string) => `${display}: ${label} (${origen})`,
    cifraDesconocida: (display: string) => `${display}: esta cifra no es de tu perfil`,
    variable: (label: string) => `${label}, se rellena al enviar`,
    /** Bajo el mensaje, al tocar o enfocar una ficha: en un teléfono no hay cursor que pase por encima. */
    detalle: (label: string) => `Ficha: ${label}.`,
    /** Bajo el mensaje, junto a las cifras subrayadas: cuáles no tienen origen o no coinciden con él. */
    cifrasSinOrigen: (list: string, n: number) =>
      n === 1
        ? `La cifra subrayada (${list}) no tiene un origen que coincida: insértala desde «Cifras de tu perfil» o quítala.`
        : `Las cifras subrayadas (${list}) no tienen un origen que coincida: insértalas desde «Cifras de tu perfil» o quítalas.`,
  },

  fichas: {
    variables: "Variables",
    variablesHelp: "Se rellenan con los datos de la persona, la empresa y tu perfil.",
    cifras: "Cifras de tu perfil",
    cifrasHelp: "Toca una para insertarla con su origen donde está el cursor.",
    sinCifras: "Todavía no hay cifras fiables en tu perfil: conecta tus redes o importa tus métricas para poder citarlas.",
    insertar: (label: string) => `Insertar ${label}`,
    buscar: "Buscar una cifra",
    buscarPlaceholder: "Mediana, TikTok, campaña…",
    sinResultados: "Ninguna cifra coincide con la búsqueda.",
    cuantas: (n: number) => (n === 1 ? "1 cifra" : `${n} cifras`),
    /** Los grupos, en el orden en que se enseñan. */
    grupos: {
      creator_baseline: "Medianas (visualizaciones e interacción)",
      campaign_brand: "Campañas con esta marca",
      signal: "Señal del negocio",
      creator_profile: "Audiencia",
      post_score: "Videos",
      media_kit: "Media kit",
      campaign_result: "Otras campañas",
      /** Los precios del tarifario vigente (Cotizar): citar el propio precio es normal. */
      quote: "Tus tarifas",
    },
  },

  ia: {
    titulo: "Redactar con IA",
    help: "La IA escribe a partir de tu perfil, la señal del negocio y lo que ya le enviaste a esta persona; cada cifra sale con su origen y una revisión automática le pone nota.",
    instrucciones: "Instrucciones (opcional)",
    instruccionesHelp: "El tono o qué destacar, con tus palabras. No cambia las reglas: ninguna cifra sin origen.",
    senal: (headline: string) => `Se apoya en la señal del negocio: ${headline}.`,
    sinSenal: "Sin señal en este negocio: se apoya en la marca y su sector.",
    redactar: "Redactar con IA",
    volverARedactar: "Otra versión",
    pistas: {
      shorter: "Más corto",
      more_specific: "Más específico",
      other_angle: "Otro ángulo",
      soften: "Suavizar",
      add_proof: "Añadir prueba",
      other_signal: "Otra señal",
    } satisfies Record<RegenerateHint, string>,
    /** Las otras tres pistas, plegadas bajo «Más». */
    mas: "Más",
    menos: "Menos",
    masLabel: "Más pistas para otra versión",
    pistaLabel: (pista: string) => `Pedir otra versión: ${pista.toLowerCase()}`,
    redactando: "Redactando… La IA escribe y revisa el borrador; esta página se actualiza sola.",
    pendienteDe: {
      requested: "En cola",
      generating: "Escribiendo",
      generated: "Revisando",
      reviewing: "Revisando",
    } as Record<string, string>,
    /**
     * Lo que se le dice a la persona cuando el último intento no salió.
     * Recibe el CÓDIGO (outbound_generation.last_error), nunca el texto
     * del error: la jerga y los mensajes del SDK van al registro del worker.
     */
    reintento: (code: string | null): string => {
      if (code === "llm_budget") return "Se agotó el presupuesto de IA de hoy: lo retomamos mañana, o escríbelo tú.";
      // 'aborted' y 'lease_lost' son los códigos de antes de 0063: se leen igual.
      if (code === "interrupted" || code === "aborted" || code?.includes("lease_lost") || code?.includes("touch_not_draft")) {
        return "Se interrumpió; lo retomamos en unos minutos.";
      }
      return "La IA no pudo redactarlo; lo intentamos de nuevo en unos minutos.";
    },
    fallo: "La IA no pudo redactar este correo después de varios intentos. Escríbelo tú, o pide otra versión.",
    editarCancela:
      "Si lo editas mientras tanto, guárdalo: lo tuyo manda y se cancela la redacción. Lo que no guardes se reemplaza por el borrador de la IA cuando llegue.",
    pedido: "Pedido. La IA lo redacta en uno o dos minutos; esta página se actualiza sola.",
    ocupado: "La IA ya está trabajando en este borrador: espera a que termine.",
    necesitaContacto: "Elige a quién le escribes para pedir un borrador.",
    noConfigurada: "La redacción con IA no está disponible ahora. Escribe el pitch tú; la revisión y las cifras funcionan igual.",
    desconocida: "La redacción con IA no responde en este momento. Escribe el pitch tú; la revisión y las cifras funcionan igual.",
  },

  variables: {
    first_name: "Nombre de la persona",
    full_name: "Nombre completo",
    role_title: "Cargo",
    company: "Empresa",
    company_industry: "Sector",
    company_city: "Ciudad",
    signal_headline: "Señal del negocio",
    sender_name: "Tu nombre",
    creator_handle: "Tu usuario",
    creator_niche: "Tu nicho",
    media_kit_url: "Enlace al media kit",
    quote_url: "Enlace a la cotización",
  } satisfies Record<TemplateVariable, string>,

  origen: {
    creator_profile: "Audiencia",
    creator_baseline: "Mediana",
    post_score: "Video",
    media_kit: "Media kit",
    campaign_result: "Campaña",
    signal: "Señal",
    quote: "Tarifario",
  } satisfies Record<ClaimSource, string>,

  vista: {
    titulo: "Vista previa",
    para: (who: string) => `Así lo recibe ${who}`,
    sinDestinatario: "Así lo recibe la marca",
    sinAsunto: "(sin asunto)",
    vacio: "Escribe el mensaje o inserta una cifra para ver cómo queda.",
    citadas: "Cifras citadas",
    ninguna: "Este mensaje no cita cifras.",
  },

  revision: {
    titulo: "Antes de enviar",
    listo: "Listo",
    ok: "Todo en orden: el mensaje pasa las reglas de estilo y cada cifra tiene su origen.",
    bloquea: "Esto impide programarlo",
    calidad: "Nota de la revisión automática",
    /** La nota ya no es de lo que hay escrito: la persona cambió el texto de la IA. */
    calidadEditada: "Nota de la versión de la IA (la editaste)",
    nota: (score: string) => `${score} de 10`,
    generado: "Borrador redactado con IA a partir de tu perfil y de la señal de la marca. Revísalo antes de programarlo.",
    /** Un borrador que la IA escribió para otra persona de la marca (cambió «Para»). */
    otraPersona: (name: string) => `El borrador se escribió para ${name} y va para otra persona: cambia el nombre o elige a ${name} en «Para».`,
    sinDireccion: "Falta la dirección postal del pie de los correos: sin ella no se puede programar.",
    agregarDireccion: "Agregarla en la política",
    sinCorreo: "Todavía no hay un correo conectado: lo que programes saldrá cuando conectes uno.",
    conectarCorreo: "Conectar un correo",
    retenido: (reason: string) => `Retenido: ${reason}.`,
    /** El borrador se copió con cifras sin origen (savePitch lo marcó): se dice al volver a abrirlo. */
    copiadoSinOrigen: (n: number) =>
      n === 1 ? "Se copió con una cifra sin origen en tu perfil." : `Se copió con ${n} cifras sin origen en tu perfil.`,
    /** La línea junto a los botones cuando «Programar» está apagado. */
    /**
     * La línea junto a los botones: solo cuántas cosas lo impiden. El detalle
     * va en «Antes de enviar» (a 400 px las dos quedan en la misma columna y
     * repetirlo era ruido); el primero va además para lectores de pantalla.
     */
    resumen: (n: number) => (n === 1 ? "Una cosa impide programarlo." : `${n} cosas impiden programarlo.`),
    empezar: "Escribe el asunto y el mensaje para poder programarlo.",
    verRevision: "Ver la revisión",
    vacioNeutro: "Cuando escribas, aquí verás si el correo está listo para programar.",
    envioApagado: "El envío está apagado: lo que programes saldrá cuando lo enciendas.",
    encenderEnvio: "Ir al interruptor del envío",
  },

  asunto: {
    subject_missing: "Falta el asunto.",
    subject_placeholders: "El asunto tiene huecos sin rellenar.",
    subject_fake_reply: "Un correo nuevo no empieza con «Re:».",
    subject_too_short: "El asunto necesita al menos dos palabras.",
    subject_too_many_words: "El asunto pasa de doce palabras.",
    subject_too_long: "El asunto tiene 80 caracteres o más.",
    subject_not_allowed: "Este mensaje no lleva asunto.",
  } as Record<string, string>,

  problemas: {
    empty: () => "El mensaje está vacío.",
    placeholders: (d) => `Quedan huecos sin rellenar: ${d}.`,
    too_short: (d) => `Es muy corto (${d} caracteres): cuenta algo concreto de la marca.`,
    too_long: (d) => `Es largo (${d} caracteres): recórtalo.`,
    banned_word: (d) => `«${d}» suena a plantilla de ventas: dilo con tus palabras.`,
    ai_filler: (d) => `«${d}» es una fórmula de relleno: quítala.`,
    long_dash: () => "Cambia los guiones largos por comas o puntos.",
    semicolon: () => "Cambia el punto y coma por un punto.",
    shouting: (d) => `«${d}» va en mayúsculas sostenidas: se lee como un grito.`,
    too_many_questions: (d) => `Tiene ${d} preguntas: deja una sola, al final.`,
    missing_closing_question: () => "Cierra con una sola pregunta.",
    question_not_closing: () => "La pregunta va al final, antes de la firma.",
    calendar_link_first_touch: () => "En el primer correo no pongas un enlace de agenda: primero, que te conozcan.",
    unsourced_figure: (d) => `La cifra «${d}» no tiene origen: insértala desde «Cifras de tu perfil» o quítala.`,
    unknown_claim: (d) => `La referencia «${d}» no es de ninguna cifra de tu perfil.`,
    claim_mismatch: (d) => `La cifra no coincide con su origen (${d}).`,
    claim_not_for_this_angle: (d) => `La cifra «${d}» no va en este tipo de mensaje.`,
    false_urgency: (d) => `«${d}» mete una urgencia que no existe.`,
    pressure: (d) => `«${d}» suena a presión.`,
  } satisfies Record<PreflightCode, (detail: string) => string>,

  acciones: {
    copiar: "Copiar",
    copiarLabel: "Copiar el asunto y el mensaje, sin marcas",
    copiado: "Copiado. También quedó guardado como borrador en la ficha.",
    /** El navegador no dejó copiar (permiso, contexto no seguro): se dice, en vez de «Copiado». */
    noSeCopio: "No se pudo copiar: selecciona el texto de la vista previa y cópialo a mano. El borrador sí quedó guardado.",
    /** Por qué «Copiar» está apagado, con el motivo exacto (vista.ts, copyBlockedBy). Con el mensaje vacío no se dice nada. */
    /** «Copiar» con cifras sin origen: se confirma en línea antes de copiar. */
    confirmarCopia: (n: number) =>
      n === 1
        ? "Este correo tiene una cifra sin origen en tu perfil. ¿Copiarlo igual?"
        : `Este correo tiene ${n} cifras sin origen en tu perfil. ¿Copiarlo igual?`,
    confirmarCopiaConsecuencia: "La marca la leerá como un dato tuyo, y On Cue no puede decir de dónde sale. El borrador quedará marcado.",
    copiarIgual: "Copiar igual",
    noCopiar: "Cancelar",
    copiarBloqueado: {
      holes: "Antes de copiarlo, rellena los huecos.",
      figures: "Antes de copiarlo, quita las cifras cuyo origen no coincide.",
      both: "Antes de copiarlo, rellena los huecos y quita las cifras cuyo origen no coincide.",
    },
    guardar: "Guardar borrador",
    guardado: "Guardado como borrador.",
    programar: "Programar",
    programado: "Programado: sale con el siguiente envío de tu correo.",
    programadoApagado: "Programado. Saldrá cuando enciendas el envío en la política.",
    /** Tras programar, el mensaje queda a la vista pero ya no se edita aquí. */
    yaProgramado: "Este correo ya está programado y no se edita aquí: lo ves en la ficha de la empresa.",
    escribirOtro: "Escribir otro pitch",
    irAPolitica: "Ir a la política de envío",
    verFicha: "Ver la ficha",
  },

  errores: {
    generico: "No pudimos guardar el pitch. Inténtalo de nuevo.",
    contact: "Elige a quién le escribes.",
    no_email: "Esa persona no tiene correo: agrégalo en la ficha.",
    opted_out: "Esa persona pidió no recibir más mensajes o su correo rebotó.",
    preflight: "Corrige lo que marca «Antes de enviar» para programarlo.",
    not_editable: "Ese borrador ya cambió (salió, se aprobó o se canceló). Recarga la página.",
    deal: "Ese negocio no es de esta empresa. Elige otro o ninguno.",
    no_postal_address: "Falta la dirección postal que va en el pie de los correos.",
    /** Un 'viewer' o un 'client' (en una agencia, la marca misma) ve el pitch, no lo guarda, programa ni redacta (PUEDEN_OPERAR_VENTAS). */
    sinPermiso:
      "Tu rol en este espacio puede ver el pitch, pero no guardarlo, programarlo ni pedirle un borrador a la IA. Pídeselo a quien es dueño, administra o es miembro del espacio.",
  },

  cargando: "Cargando el pitch",
  errorFrontera: { eyebrow: "Ventas · Pitch", title: "No pudimos abrir el pitch de esta empresa" },
} as const;
