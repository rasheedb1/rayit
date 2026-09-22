// El tema claro/oscuro. Se decide antes del primer pintado con un script
// inline en <head> (sin destello) y se guarda en localStorage. Aquí vive
// la regla en dos formas que deben coincidir, y una prueba lo garantiza:
// resolveTheme() para el código de la app y themeScript para el <head>.

export type Theme = "light" | "dark";
export const THEME_KEY = "mc.theme";

/** El tema que toca: el guardado si es válido; si no, el del sistema. */
export function resolveTheme(stored: string | null | undefined, prefersDark: boolean): Theme {
  if (stored === "light" || stored === "dark") return stored;
  return prefersDark ? "dark" : "light";
}

/**
 * Misma regla, como texto para <script> en el layout. Corre antes de
 * hidratar, así que no puede importar nada: cualquier cambio en
 * resolveTheme() hay que repetirlo aquí (la prueba de lib/theme.test.ts
 * avisa si se desincronizan). Si no hay almacenamiento, queda claro.
 */
export const themeScript =
  `(function(){try{var t=localStorage.getItem("${THEME_KEY}");` +
  `if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}` +
  `document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme="light"}})()`;
