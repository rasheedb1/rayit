/**
 * Textos de /ventas/aprobaciones (VEN-14): la bandeja de los mensajes que
 * esperan a una persona. Referencias: la bandeja de Linear y la de
 * Superhuman (uno por fila, todo con el teclado) y Stripe Radar para «por
 * qué se retuvo» (la regla que saltó, con su dato).
 *
 * Voz: una creadora que escribe a marcas. Los motivos del motor (el
 * held_reason y los disparadores de riesgo) los pone en palabras
 * @mc/core/outreach/messages en el idioma del workspace; aquí están las
 * etiquetas de la pantalla. Las cifras y las fechas llegan formateadas.
 * Este archivo llega al cliente: no importa nada de @mc/db.
 */
import type { PreflightCode, RegenerateHint } from "@mc/core/outreach/preflight";

const reglas = new Intl.PluralRules("es");
function plural(n: number, one: string, other: string): string {
  return reglas.select(n) === "one" ? one : other;
}

/** De dónde viene la retención: la etiqueta que abre «Por qué quedó retenido». */
export type MotivoCategoria =
  | "preflight"
  | "juez"
  | "calentamiento"
  | "politica"
  | "enfriamiento"
  | "ia"
  | "envio"
  | "persona";

export const MESSAGES = {
  metaTitle: "Aprobaciones",
  header: {
    eyebrow: "Ventas · aprobaciones",
    title: "Lo que espera tu visto bueno",
    description:
      "Los mensajes que la revisión retuvo antes de salir. Apruébalos tal cual, edítalos, pide otra versión o sáltalos: nada sale sin ti.",
    back: "Volver a Ventas",
  },
  loading: { label: "Cargando la bandeja de aprobación" },
  error: "No pudimos cargar la bandeja de aprobación.",

  contador: (n: string, cuantos: number) => `${n} ${plural(cuantos, "mensaje espera", "mensajes esperan")} tu aprobación`,
  vacio: {
    title: "Nada por aprobar",
    description: "Cuando la revisión retenga un mensaje de tus cadencias, aparece aquí con el motivo.",
    action: "Ver tus cadencias",
  },

  /** La ayuda del teclado, debajo del título. */
  atajos: {
    label: "Atajos de teclado",
    items: [
      { key: "j", text: "siguiente" },
      { key: "k", text: "anterior" },
      { key: "a", text: "aprobar" },
      { key: "e", text: "editar y aprobar" },
      { key: "r", text: "regenerar" },
      { key: "s", text: "saltar" },
    ],
  },

  fila: {
    /** La etiqueta de la fila para un lector de pantalla. */
    label: (empresa: string, persona: string) => `Mensaje a ${persona}, de ${empresa}`,
    paso: (secuencia: string, n: string, total: string) => `${secuencia} · paso ${n} de ${total}`,
    pasoSinTotal: (secuencia: string, n: string) => `${secuencia} · paso ${n}`,
    pasoSuelto: "Mensaje suelto",
    sinNombre: "Sin nombre",
    sale: (cuando: string) => `Sale ${cuando}`,
    asunto: "Asunto",
    enElHilo: (asunto: string) => `Responde en el hilo «${asunto}»`,
    enElHiloSinAsunto: "Responde en el hilo del correo anterior",
    sinTexto: "Todavía sin texto.",
    regenerando: "Redactando otra versión…",
    regenerado: "Versión nueva",
  },

  porque: {
    title: "Por qué quedó retenido",
    categorias: {
      preflight: "Reglas de estilo y cifras",
      juez: "Revisión automática",
      calentamiento: "Calentamiento",
      politica: "Revisión humana",
      enfriamiento: "Enfriamiento",
      ia: "Redacción con IA",
      envio: "Antes de enviar",
      persona: "Nota",
    } satisfies Record<MotivoCategoria, string>,
    notaDelJuez: "La revisión dice",
    total: (nota: string) => `${nota} de 10`,
    intentos: (n: string, cuantos: number) => `${n} ${plural(cuantos, "intento", "intentos")}`,
    dimensiones: { relevance: "Relevancia", quality: "Calidad", structure: "Estructura", voice: "Voz" },
    riesgos: "Lo que obliga a revisarlo",
    preflight: "Lo que no pasó las reglas",
    /** Cada regla del pre-vuelo, con su dato («sinergia», «620 caracteres»). */
    reglas: {
      empty: () => "el mensaje quedó vacío",
      placeholders: (d) => `quedan huecos sin rellenar (${d})`,
      too_short: (d) => `es muy corto (${d} caracteres)`,
      too_long: (d) => `es muy largo (${d} caracteres)`,
      banned_word: (d) => `usa una palabra prohibida («${d}»)`,
      ai_filler: (d) => `usa una muletilla de IA («${d}»)`,
      long_dash: () => "usa guiones largos",
      semicolon: () => "usa punto y coma",
      shouting: (d) => `escribe en mayúsculas sostenidas («${d}»)`,
      too_many_questions: (d) => `hace ${d} preguntas; una basta`,
      missing_closing_question: () => "no cierra con una pregunta",
      question_not_closing: () => "la pregunta no va al final",
      calendar_link_first_touch: () => "pone un enlace de agenda en el primer mensaje",
      unsourced_figure: (d) => `cita una cifra sin origen en tu perfil («${d}»)`,
      unknown_claim: () => "cita una cifra que ya no está en tu perfil",
      claim_mismatch: (d) => `una cifra no dice lo mismo que tu perfil (${d})`,
      claim_not_for_this_angle: () => "cita una cifra que el ángulo del paso no usa",
      false_urgency: (d) => `mete una urgencia que no existe («${d}»)`,
      pressure: (d) => `presiona («${d}»)`,
    } satisfies Record<PreflightCode, (detalle: string) => string>,
  },

  acciones: {
    aprobar: "Aprobar",
    aprobarLabel: (persona: string) => `Aprobar el mensaje a ${persona}`,
    editar: "Editar y aprobar",
    regenerar: "Regenerar",
    saltar: "Saltar",
    cancelar: "Cancelar",
    aprobarCambios: "Aprobar con cambios",
    asunto: "Asunto",
    mensaje: "Mensaje",
    pista: "Qué cambiar",
    pistas: {
      shorter: "Más corto",
      more_specific: "Más específico",
      other_angle: "Otro ángulo",
      other_signal: "Otra señal",
      soften: "Más suave",
      add_proof: "Con prueba",
    } satisfies Record<RegenerateHint, string>,
    instrucciones: "Instrucciones (opcional)",
    instruccionesAyuda: "Tono, qué destacar, qué evitar. La IA las lee como indicaciones, no como texto para copiar.",
    pedir: "Pedir otra versión",
    saltarPregunta: "¿Saltar este paso?",
    saltarConsecuencia: "Este mensaje no sale y la cadencia sigue con el siguiente paso. No se puede deshacer.",
    saltarConfirmar: "Sí, saltar",
    resolverEnLaFicha: "Resolver en la ficha",
    resolverAyuda: "No sabemos si el intento anterior salió: dilo en la ficha para no mandarlo dos veces.",
    verFicha: "Ver la ficha",
    noRegenerable: "Solo los correos de una cadencia se pueden pedir de nuevo a la IA.",
  },

  avisos: {
    aprobado: (persona: string) => `Aprobado: el mensaje a ${persona} sale a su hora.`,
    saltado: (persona: string) => `Saltado: el mensaje a ${persona} no sale y la cadencia sigue.`,
    pedido: "Pedimos otra versión. Aparece aquí en cuanto esté lista.",
    iaApagada:
      "La redacción con IA no está encendida en este espacio: la versión nueva no llegará hasta que se configure. Puedes editarlo tú.",
    envioApagado: "El envío está apagado: lo que apruebes sale cuando lo enciendas en la política de envío.",
    irAPolitica: "Ir a la política de envío",
  },

  errores: {
    generico: "No pudimos guardar el cambio. Inténtalo de nuevo.",
    not_found: "Ese mensaje ya no existe.",
    not_held: "Ese mensaje ya no espera aprobación: alguien lo movió.",
    not_skippable: "Ese mensaje ya no se puede saltar: alguien lo movió.",
    regenerating: "La IA está redactando otra versión: espera a que termine.",
    empty: "Escribe el mensaje.",
    empty_subject: "Escribe el asunto del correo.",
    placeholders: (huecos: string) => `Quedan huecos sin rellenar: ${huecos}.`,
    note_too_long: (n: string) => `La nota de la invitación tiene ${n} caracteres; LinkedIn permite 300.`,
    unsourced_figure: (cifras: string) =>
      cifras.includes(",")
        ? `Las cifras ${cifras} no salen de tu perfil: cámbialas por cifras tuyas o quítalas.`
        : `La cifra ${cifras} no sale de tu perfil: cámbiala por una de tus cifras o quítala.`,
    opted_out: "Esa persona pidió no ser contactada: el mensaje no puede salir.",
    no_postal_address: "Falta tu dirección postal para el pie de los correos: guárdala en la política de envío.",
    not_editable: "Este mensaje no se puede pedir de nuevo a la IA.",
    busy: "La IA ya está redactando este mensaje.",
  },
} as const;
