"use client";

import { useEffect } from "react";
import { THEME_KEY, resolveTheme } from "@/lib/theme";

/**
 * El respaldo del script de tema (pulido r8).
 *
 * El tema lo fija themeScript en <head> antes de pintar. Pero cuando una
 * página llama a notFound() (una ficha, un /kit/<slug> o una
 * /cotizacion/<slug> que no existen), Next manda un documento de error
 * (<html id="__next_error__">) y el cliente monta el suyo encima: un
 * <script> que React inserta no se ejecuta, y el <html> nuevo quedaba sin
 * data-theme. Con el tema oscuro, el 404 salía en claro (fondo blanco).
 *
 * Esto vuelve a aplicar la misma regla (resolveTheme) al montar, solo si
 * falta: cuando el script ya corrió no cambia nada, y el botón de tema
 * sigue siendo el único que lo cambia después.
 */
export function ThemeSync() {
  useEffect(() => {
    const root = document.documentElement;
    if (root.dataset.theme === "light" || root.dataset.theme === "dark") return;
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(THEME_KEY);
    } catch {
      // Sin almacenamiento (modo privado estricto): manda el sistema.
    }
    const prefersDark = typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = resolveTheme(stored, prefersDark);
  }, []);
  return null;
}
