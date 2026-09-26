/**
 * Las monedas que se ofrecen en Ventas (el mínimo del brief, VEN-7).
 *
 * Los códigos salen de Intl (ISO 4217, los que el motor conoce) y los
 * nombres, en el idioma del workspace, de Intl.DisplayNames: ninguna
 * tabla escrita a mano. Se arman en el servidor y viajan como props,
 * como los países (paises.ts), para que la hidratación no cambie el
 * texto con la versión de ICU del navegador.
 *
 * Las que se pasan en `first` (la del workspace y la que ya tenía el
 * brief) van arriba; el resto, por nombre.
 */
export interface CurrencyOption {
  value: string;
  label: string;
}

/** Un respaldo por si el motor no trae Intl.supportedValuesOf (Node < 18). */
const RESPALDO = ["USD", "EUR", "COP", "MXN", "BRL", "ARS", "CLP", "PEN", "GBP", "CAD"];

function codigos(): string[] {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    const lista = intl.supportedValuesOf?.("currency");
    if (lista && lista.length > 0) return lista;
  } catch {
    // Sin la API: el respaldo.
  }
  return RESPALDO;
}

/** La primera letra en mayúscula, con las reglas del idioma (o las del motor si el idioma no sirve). */
function mayuscula(texto: string, locale: string): string {
  let primera: string;
  try {
    primera = texto.charAt(0).toLocaleUpperCase(locale);
  } catch {
    primera = texto.charAt(0).toUpperCase();
  }
  return primera + texto.slice(1);
}

function nombre(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "currency" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * «Peso colombiano»: solo el nombre. El código ya lo dice el campo del
 * monto, que lo lleva de prefijo (MoneyInput): con «COP · peso
 * colombiano» al lado, la moneda salía dos veces en la misma fila.
 */
export function currencyOptions(locale: string, first: string[] = []): CurrencyOption[] {
  const todos = new Set(codigos());
  const arriba = [...new Set(first.map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{3}$/.test(c)))];
  let collator: Intl.Collator;
  try {
    collator = new Intl.Collator(locale, { sensitivity: "base" });
  } catch {
    collator = new Intl.Collator();
  }
  const opcion = (code: string): CurrencyOption => {
    const n = nombre(code, locale);
    return { value: code, label: n === code ? code : mayuscula(n, locale) };
  };
  const resto = [...todos]
    .filter((c) => !arriba.includes(c))
    .map(opcion)
    .sort((a, b) => collator.compare(a.label, b.label));
  return [...arriba.map(opcion), ...resto];
}
