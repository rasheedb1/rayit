import { CLAIM_MARKER_RE } from "@mc/core/outreach/narrativa";
import type { CifraVista } from "./cifras";

/**
 * Las fichas del editor de la narrativa: lo que el creador ve en lugar de
 * cada marca [claim:id]. Guardada, la narrativa sigue con sus marcas (el
 * verificador del servidor no cambia); en el editor, cada una se lee
 * como la cifra que la marca verá: «Mi mediana es de ⟦115,4 mil⟧ views».
 *
 *   · la ficha es el valor ya formateado; si dos cifras tienen el mismo
 *     valor, lleva también qué es («⟦3,0× · Tus otros reels…⟧»), y si
 *     aun así se repiten, el id: cada ficha lleva a una sola cifra;
 *   · una ficha que no es de ninguna cifra (el creador tocó su texto)
 *     vuelve como [claim:<texto>], y el verificador la rechaza como
 *     cualquier marca inventada o mal escrita;
 *   · una marca [claim:id] escrita a mano se deja tal cual.
 *
 * Puro y sin estado: se prueba sin navegador.
 */
export const FICHA_ABRE = "⟦";
export const FICHA_CIERRA = "⟧";
const FICHA_RE = /⟦([^⟦⟧\n]*)⟧/g;

export interface Fichas {
  /** id del claim → texto de su ficha, sin los corchetes. */
  porId: ReadonlyMap<string, string>;
  /** texto de la ficha → id del claim. */
  porFicha: ReadonlyMap<string, string>;
}

/** Quita lo que rompería una ficha: sus propios corchetes y los saltos de línea. */
function limpia(s: string): string {
  return s.replace(/[⟦⟧\n]/g, " ").replace(/\s+/g, " ").trim();
}

export function fichasDe(cifras: Readonly<Record<string, CifraVista>>): Fichas {
  const lista = Object.values(cifras);
  const veces = new Map<string, number>();
  for (const c of lista) veces.set(limpia(c.valor), (veces.get(limpia(c.valor)) ?? 0) + 1);
  const porId = new Map<string, string>();
  const porFicha = new Map<string, string>();
  for (const c of lista) {
    const valor = limpia(c.valor);
    let ficha = veces.get(valor)! > 1 ? `${valor} · ${limpia(c.que)}` : valor;
    if (porFicha.has(ficha)) ficha = `${ficha} · ${c.id}`;
    porId.set(c.id, ficha);
    porFicha.set(ficha, c.id);
  }
  return { porId, porFicha };
}

/** La narrativa guardada, como se edita: cada marca conocida pasa a su ficha. */
export function aEditable(texto: string, fichas: Fichas): string {
  return texto.replace(CLAIM_MARKER_RE, (marca, id: string) => {
    const ficha = fichas.porId.get(id);
    return ficha === undefined ? marca : `${FICHA_ABRE}${ficha}${FICHA_CIERRA}`;
  });
}

/** Lo que se escribió en el editor, como se verifica y se guarda: cada ficha pasa a su marca. */
export function aMarcas(texto: string, fichas: Fichas): string {
  return texto.replace(FICHA_RE, (_, ficha: string) => {
    const id = fichas.porFicha.get(limpia(ficha));
    return id === undefined ? `[claim:${ficha}]` : `[claim:${id}]`;
  });
}

/**
 * Una marca que el verificador rechazó, dicha como el creador la ve: el
 * id o el texto de una marca mal escrita, entre ⟦ ⟧. «[claim: Mediana]»
 * → «⟦Mediana⟧».
 */
export function comoFicha(marcaOId: string): string {
  const dentro = /^\[\s*claim\s*:\s*([^\]]*?)\s*\]?$/i.exec(marcaOId)?.[1] ?? marcaOId;
  return `${FICHA_ABRE}${dentro}${FICHA_CIERRA}`;
}
