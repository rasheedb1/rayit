# Marco de la app (CIM-4)

- **Agregar un módulo**: una entrada en `content/modules.ts` (slug, nombre, dueño, `group: "producto"`) y su `app/(app)/<slug>/page.tsx`. El menú lo lee de ahí, en ese orden.
- **Agregar una bandera**: la llave en `FLAG_KEYS` y su valor en `content/flags.ts` (mismo nombre que en la tabla `feature_flag`); luego `flag: "<llave>"` en el módulo. Apagada, el módulo sale del menú y `requireModule()` responde 404 en su ruta.
- **Página de módulo**: llama `requireModule(slug)` antes de renderizar (hoy lo hace `ModulePlan`).
- **Tema**: la regla está en `lib/theme.ts` (`resolveTheme` y `themeScript`, que deben coincidir); el script va en `app/layout.tsx`; el botón es `theme-toggle.tsx`; los tokens de color, en `app/globals.css`.
- **Colores**: solo tokens (`bg-surface`, `text-ink`, `border-border`, `text-good`…). Los alias `--fg`, `--line`, `--ok` son temporales.
- **Pruebas**: `pnpm --filter @mc/web test` (vitest + testing-library).
