import type { ClaimSource } from "@mc/core/outreach/claims";
import type { PreflightCode } from "@mc/core/outreach/preflight";
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
  back: "Volver a la ficha",

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
      "Las marcas [claim:…] dicen de dónde sale cada cifra y no llegan a la marca. Las variables {{…}} se rellenan con los datos de la ficha.",
  },

  fichas: {
    variables: "Variables",
    variablesHelp: "Se rellenan con los datos de la persona, la empresa y tu perfil.",
    cifras: "Cifras de tu perfil",
    cifrasHelp: "Toca una para insertarla con su origen donde está el cursor.",
    sinCifras: "Todavía no hay cifras fiables en tu perfil: conecta tus redes o importa tus métricas para poder citarlas.",
    insertar: (label: string) => `Insertar ${label}`,
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
    quote: "Cotización",
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
    ok: "Todo en orden: el mensaje pasa las reglas de estilo y cada cifra tiene su origen.",
    bloquea: "Esto impide programarlo",
    calidad: "Nota de la revisión automática",
    nota: (score: string) => `${score} de 10`,
    iaNoConfigurada:
      "La redacción con IA no está configurada en este espacio (falta la llave de Anthropic en el servidor): escribe el pitch tú. La revisión y las cifras funcionan igual.",
    generado: "Borrador redactado con IA a partir de tu perfil y de la señal de la marca. Revísalo antes de programarlo.",
    retenido: (reason: string) => `Retenido: ${reason}.`,
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
    unknown_claim: (d) => `La marca «${d}» no es de ninguna cifra de tu perfil.`,
    claim_mismatch: (d) => `La cifra no coincide con su origen (${d}).`,
    claim_not_for_this_angle: (d) => `La cifra «${d}» no va en este tipo de mensaje.`,
    false_urgency: (d) => `«${d}» mete una urgencia que no existe.`,
    pressure: (d) => `«${d}» suena a presión.`,
  } satisfies Record<PreflightCode, (detail: string) => string>,

  acciones: {
    copiar: "Copiar",
    copiarLabel: "Copiar el asunto y el mensaje, sin marcas",
    copiado: "Copiado. También quedó guardado como borrador en la ficha.",
    copiarBloqueado: "Antes de copiarlo, cada cifra tiene que tener su origen y no pueden quedar huecos.",
    guardar: "Guardar borrador",
    guardado: "Guardado como borrador.",
    programar: "Programar",
    programado: "Programado: sale con el siguiente envío de tu correo.",
    programadoApagado: "Programado. Saldrá cuando enciendas el envío en la política.",
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
    no_postal_address: "Falta la dirección postal que va en el pie de los correos.",
  },

  cargando: "Cargando el pitch",
  errorFrontera: "No pudimos abrir el pitch de esta empresa.",
} as const;
