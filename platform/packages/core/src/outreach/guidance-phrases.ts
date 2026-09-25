/**
 * Las frases con las que el recomendador compone la guía de un paso
 * (composeGuidance) cuando el paso cambió de canal, se suavizó por la
 * política o se añadió a mano. Una tabla por idioma: el recomendador no
 * escribe ni una frase fuera de aquí.
 *
 * Hoy solo hay español. Las plantillas globales (outbound_sequence_template)
 * y outbound_angle.forbidden_es también están en español, así que una
 * guía compuesta en otro idioma dejaría la secuencia mezclada; cuando
 * lleguen plantillas en otro idioma, su tabla entra aquí y
 * `guidanceLocale` la elige por el locale del espacio.
 */
import type { RecommendSignalKind } from './proposal-notes.ts';

/** Los idiomas que tienen tabla. */
export const GUIDANCE_LOCALES = ['es'] as const;
export type GuidanceLocale = (typeof GUIDANCE_LOCALES)[number];

export interface GuidancePhrases {
  /**
   * El idioma de la tabla dicho para el modelo que redacta la guía
   * (el redactor de la web lo pone en su instrucción): la guía del
   * modelo sale en el mismo idioma que la compuesta con estas frases.
   */
  promptLanguage: string;
  /** Cómo se nombra la señal dentro de una guía. */
  signal: Record<RecommendSignalKind, string>;
  /** Con qué abre cada ángulo (sin el canal); recibe la frase de la señal. */
  angleOpening: Record<string, (signal: string) => string>;
  /** La apertura de un ángulo que la tabla no conoce. */
  genericOpening: (signal: string) => string;
  /** Qué no se menciona en cada ángulo (lo más importante de outbound_angle.forbidden_es). */
  angleForbidden: Record<string, string>;
  genericForbidden: string;
  /** Lo que se añade si la señal es la colaboración de un competidor. */
  collabForbidden: string;
  /** La frase de divulgación que el brief pide en el cierre (outbound_brief.requires_disclosure). */
  disclosure: string;
  /** El cierre de un mensaje que espera respuesta. */
  closeWithQuestion: string;
  /** El arranque de cada forma de paso; reciben la apertura del ángulo. */
  lead: {
    publicComment: (opening: string) => string;
    byHand: (opening: string) => string;
    reply: (opening: string) => string;
    connectNote: (opening: string) => string;
    direct: (opening: string) => string;
    email: (opening: string) => string;
  };
}

const ES: GuidancePhrases = {
  promptLanguage: 'español neutro',
  signal: {
    active_campaign: 'su campaña activa',
    launch: 'su lanzamiento',
    season: 'la temporada que viene',
    collab: 'su categoría',
    manual: 'su marca',
  },
  angleOpening: {
    presencia: () => 'algo concreto de su último post, en una o dos frases',
    encaje_audiencia: () => 'la coincidencia entre tu audiencia y su cliente, con una cifra de tu perfil',
    prueba_desempeno: (s) => `un video tuyo parecido a lo que necesita ${s}, con sus views frente a tu mediana`,
    concepto_creativo: (s) => `una idea de video concreta para ${s}`,
    prueba_social: () => 'el resultado medido de una campaña tuya con una marca del mismo sector',
    // El paso de cierre exige el media kit (requires_asset); la cotización solo si la creadora tiene una pública.
    sintesis: () =>
      'un resumen de tres líneas, el enlace al media kit (y a tu cotización pública, si la tienes) y una fecha concreta para hablar',
  },
  genericOpening: (s) => `algo específico de ${s}`,
  angleForbidden: {
    presencia: 'No vendas, no menciones tarifas ni pongas enlaces.',
    encaje_audiencia: 'No menciones precio ni adjuntes el media kit.',
    prueba_desempeno: 'No repitas la demografía ya dicha ni uses cifras sin origen.',
    concepto_creativo: 'Sin cifras de audiencia ni ideas que sirvan para cualquier marca.',
    prueba_social: 'Solo campañas con resultado; no nombres a su competencia directa.',
    sintesis: 'Sin presión ni urgencia falsa.',
  },
  genericForbidden: 'No vendas en el primer párrafo.',
  collabForbidden: 'No nombres la colaboración que viste ni a quien la hizo.',
  disclosure: 'Di que el contenido irá marcado como publicidad.',
  closeWithQuestion: 'Cierra con una sola pregunta.',
  lead: {
    publicComment: (o) => `Comenta ${o}.`,
    byHand: (o) => `Hazlo a mano: reacciona o comenta ${o}.`,
    reply: (o) => `Responde en el mismo hilo con ${o}.`,
    connectNote: (o) => `Nota de conexión de menos de 300 caracteres con ${o}.`,
    direct: (o) => `Mensaje corto con ${o}.`,
    email: (o) => `Abre con ${o}.`,
  },
};

export const GUIDANCE_PHRASES: Record<GuidanceLocale, GuidancePhrases> = { es: ES };

/** El idioma de la tabla para un locale del espacio ('es-CO' → es). Lo que no tiene tabla, español. */
export function guidanceLocale(locale: string | null | undefined): GuidanceLocale {
  const lang = (locale ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
  return (GUIDANCE_LOCALES as readonly string[]).includes(lang) ? (lang as GuidanceLocale) : 'es';
}
