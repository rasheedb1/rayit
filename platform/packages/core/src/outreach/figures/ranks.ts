/**
 * Los puestos (VEN-12): «#1», «top 3», «número uno», «primer lugar».
 * Ninguna cifra del perfil los respalda (On Cue no guarda rankings): son
 * siempre una cifra sin origen.
 */

/**
 * Un puesto: «soy la creadora #1», «top 3», «número uno», «number one», «nº 1»,
 * «primer lugar», «1er puesto», «la primera creadora», «first place», «the first creator».
 */
export const RANK_RE = new RegExp(
  [
    '(?<![\\p{L}\\p{N}&])#\\s?(\\d+)(?![\\p{L}\\p{N}_])',
    '\\btop[\\s-]?(\\d+)(?!\\d)',
    '\\bn[uú]mero\\s+(?:uno|1)(?![\\p{L}\\p{N}])',
    '\\bnumber\\s+(?:one|1)(?![\\p{L}\\p{N}])',
    '\\bn\\.?\\s?[º°]\\s?1(?!\\d)',
    // «primer lugar», «primera posición», «el primer creador de recetas», «la primera creadora»
    '(?<![\\p{L}])primer(?:a|o)?\\s+(?:lugar|puesto|posici[oó]n|creador|creadora|influencer|influenciador|influenciadora)(?![\\p{L}])',
    // «1er lugar», «1ra posición», «1º puesto», «2do lugar», «1st place»
    '(?<![\\p{L}\\p{N}])\\d+\\s?(?:er|ra|ro|do|da|to|ta|[º°ªo]|st|nd|rd|th)\\.?\\s+(?:lugar|puesto|posici[oó]n|place|creator|influencer)(?![\\p{L}])',
    // «first place», «the first creator»
    '\\bfirst[\\s-]+(?:place|creator|influencer)(?![\\p{L}])',
  ].join('|'),
  'giu',
);
