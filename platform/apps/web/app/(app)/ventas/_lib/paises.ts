/**
 * Los países de Ventas: una sola tabla para el formulario («Nueva
 * empresa», «Editar», «Anotar una marca»), la validación del servidor y
 * la lectura del CSV.
 *
 * Antes el formulario aceptaba dos letras cualesquiera («XX» quedaba
 * guardado y la ficha decía «XX · Medellín») mientras el CSV ya entendía
 * el país por su nombre: el mismo dato se comportaba distinto en dos
 * sitios. Ahora los dos parten de ISO_COUNTRY_CODES.
 *
 * Los códigos son una lista fija (ISO 3166-1 alfa-2, más XK, Kosovo, que
 * el ISO no asigna pero usan los bancos y la UE) y NO se sacan de
 * recorrer AA–ZZ con Intl.DisplayNames: esa vuelta trae también «Unión
 * Europea» (EU), «Naciones Unidas» (UN), «Zona del euro» (EZ), códigos
 * retirados (SU, YU, AN…) y seudorregiones (XA, XB, QO), y cambia con la
 * versión de ICU del motor. Los NOMBRES sí son de Intl, en el idioma del
 * workspace: ninguna tabla escrita a mano.
 */
import { formatCountry } from "@/lib/format";

/** ISO 3166-1 alfa-2 (249) y XK. En orden alfabético de código. */
export const ISO_COUNTRY_CODES: readonly string[] = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT " +
  "MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
  "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG " +
  "UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW"
).split(" ");

const CODES = new Set(ISO_COUNTRY_CODES);

/** «CO» (o «co», « co ») es un país de la lista. «XX» no. */
export function isCountryCode(value: string): boolean {
  return CODES.has(value.trim().toUpperCase());
}

export interface CountryOption {
  value: string;
  label: string;
}

const optionsCache = new Map<string, CountryOption[]>();

/**
 * Las opciones del <Select> de país: el código como valor y el nombre en
 * el idioma del workspace, ordenadas por nombre con las reglas de ese
 * idioma («Perú» entre «Paraguay» y «Polonia»). Se arman en el servidor y
 * viajan como props: así el nombre no depende de la versión de ICU del
 * navegador y la hidratación no cambia el texto.
 *
 * El nombre de cada código lo pone formatCountry (lib/format.ts), el
 * mismo que pinta la ficha de empresa y el media kit (pulido r7): una
 * sola forma de decir «CO → Colombia», con un solo respaldo al código
 * cuando Intl no lo conoce. Aquí solo se ordena.
 */
export function countryOptions(locale: string): CountryOption[] {
  const cached = optionsCache.get(locale);
  if (cached) return cached;
  let collator: Intl.Collator;
  try {
    collator = new Intl.Collator(locale, { sensitivity: "base" });
  } catch {
    collator = new Intl.Collator();
  }
  const options = ISO_COUNTRY_CODES.map((code) => ({ value: code, label: formatCountry(code, { locale }) })).sort((a, b) =>
    collator.compare(a.label, b.label),
  );
  optionsCache.set(locale, options);
  return options;
}

/** Los idiomas en los que el CSV reconoce el nombre de un país. */
const COUNTRY_NAME_LOCALES = ["es", "en", "pt"];
/** Los nombres cortos que la gente escribe y Intl no da. */
const COUNTRY_ALIASES: Record<string, string> = { eeuu: "US", eua: "US", usa: "US", uk: "GB" };

/** «México», «MEXICO» y « mexico » son la misma palabra. */
function nameKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

let countryIndex: Map<string, string> | null = null;

/** Nombre de país (sin tildes ni espacios) → código, sobre ISO_COUNTRY_CODES. Se arma una vez. */
function countryNames(): Map<string, string> {
  if (countryIndex) return countryIndex;
  const index = new Map<string, string>(Object.entries(COUNTRY_ALIASES));
  for (const locale of COUNTRY_NAME_LOCALES) {
    let names: Intl.DisplayNames;
    try {
      names = new Intl.DisplayNames([locale], { type: "region", fallback: "none" });
    } catch {
      continue;
    }
    for (const code of ISO_COUNTRY_CODES) {
      let name: string | undefined;
      try {
        name = names.of(code);
      } catch {
        name = undefined;
      }
      if (!name || name === code) continue;
      const key = nameKey(name);
      if (key && !index.has(key)) index.set(key, code);
    }
  }
  countryIndex = index;
  return index;
}

/**
 * Un país escrito como código ISO de dos letras, o null si no es uno de
 * la lista. «co» y «CO» son CO; «Colombia», «Perú» o «Brazil», su
 * código; «XX» o «Narnia», null.
 */
export function countryCode(value: string): string | null {
  const v = value.trim();
  if (/^[A-Za-z]{2}$/.test(v)) {
    const code = v.toUpperCase();
    if (CODES.has(code)) return code;
  }
  return countryNames().get(nameKey(v)) ?? null;
}
